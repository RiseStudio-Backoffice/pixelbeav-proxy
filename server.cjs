// server.cjs — PixelBeav Proxy (X-API-Key ODER Bearer möglich)
const express = require("express");
const jwt = require("jsonwebtoken");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
require("dotenv").config();

const {
  APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, BRANCH,
  GH_APP_PRIVATE_KEY, ACTIONS_API_KEY
} = process.env;

if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !GH_APP_PRIVATE_KEY) {
  console.error("[boot] Missing required environment variables."); process.exit(1);
}

function makeJwt() {
  const now = Math.floor(Date.now()/1000);
  return jwt.sign({ iat: now-60, exp: now+9*60, iss: APP_ID }, GH_APP_PRIVATE_KEY, { algorithm: "RS256" });
}
async function getInstallationToken() {
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${makeJwt()}`, Accept: "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error(`getInstallationToken: ${res.status} ${res.statusText} :: ${await res.text()}`);
  const { token } = await res.json(); return token;
}

// akzeptiert X-API-Key oder Authorization: Bearer <key>
function requireApiKey(req, res, next) {
  const key = req.query.apiKey || req.headers["x-api-key"];
  console.log("🛂 Angegebener API-Key:", key);
  console.log("🔑 Erwarteter API-Key:", process.env.API_KEY);
  if (key !== process.env.API_KEY) {
    console.log("❌ API-Key stimmt NICHT überein!");
    return res.status(401).json({ error: "unauthorized" });
  }
  console.log("✅ API-Key akzeptiert.");
  next();
}

console.log("🔐 Geladener API_KEY ist:", process.env.API_KEY);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => { console.log(`[req] ${req.method} ${req.url}`); next(); });
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Root
app.get("/contents/", requireApiKey, async (_req, res) => {
  try {
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
    });
    const data = await gh.json(); res.status(gh.status).json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// File-Meta
app.get("/contents/:path", requireApiKey, async (req, res) => {
  try {
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
    });
    const data = await gh.json(); res.status(gh.status).json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Create/Update
app.put("/contents/:path", requireApiKey, async (req, res) => {
  try {
    const allowedWritePaths = [
      "RULES_GPT/",
      "README.md",
      "src/",
      "docs/"
    ];
    const targetPath = decodeURIComponent(req.params.path || "");
    if (!allowedWritePaths.some(prefix => targetPath.startsWith(prefix))) {
      return res.status(403).json({ error: `Write access denied for path: ${targetPath}` });
    }

    const { message, content, branch, sha } = req.body || {};
    const token = await getInstallationToken();

    console.log("📤 Upload an GitHub gestartet:", targetPath);
    console.log("📦 Message:", message);
    console.log("🔢 Content length:", (content || "").length);
    console.log("🐛 SHA:", sha);

    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      },
      body: JSON.stringify({
        message,
        content,
        branch: branch || BRANCH,
        ...(sha ? { sha } : {})
      })
    });

    const text = await gh.text();
    console.log("📥 Antwort von GitHub:", text);

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(gh.status).json(data);
  } catch (e) {
    console.error("❌ Fehler beim Upload:", e);
    res.status(500).json({ error: String(e) });
  }
});

// Delete
app.delete("/contents/:path", requireApiKey, async (req, res) => {
  try {
    const { message, sha, branch } = req.body || {};
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, sha, branch: branch || BRANCH })
    });
    const data = await gh.json(); res.status(gh.status).json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST-safe delete (workaround)
app.post("/contents/:path/delete", requireApiKey, async (req, res) => {
  try {
    const { message, sha, branch } = req.body || {};
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, sha, branch: branch || BRANCH })
    });
    const data = await gh.json(); res.status(gh.status).json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DEBUG: HEAD-Test für GitHub-Zugriff
app.get("/debug/head-test", requireApiKey, async (req, res) => {
  try {
    const token = await getInstallationToken();
    const gh = await fetch("https://api.github.com/repos/RiseStudio-Backoffice/PixelBeav.App/contents/RULES_GPT/repo-interaktion-rules.json", {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      }
    });
    res.status(gh.status).send(`GitHub HEAD response: ${gh.status}`);
  } catch (e) {
    res.status(500).send("HEAD failed: " + e.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 pixelbeav-proxy listening on :${PORT}`);
});
