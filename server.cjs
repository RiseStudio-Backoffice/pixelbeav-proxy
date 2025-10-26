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
  let key = req.headers["x-api-key"];
  if (!key) {
    const auth = req.headers["authorization"] || "";
    if (auth.toLowerCase().startsWith("bearer ")) key = auth.slice(7).trim();
  }
  if (!ACTIONS_API_KEY || key !== ACTIONS_API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

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
    const text = await gh.text(); let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// Delete (sha optional)
app.delete("/contents/:path", requireApiKey, async (req, res) => {
  try {
    const { message, sha, branch } = req.body || {};
    const token = await getInstallationToken();
    let effectiveSha = sha;
    if (!effectiveSha) {
      const meta = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
      });
      const metaText = await meta.text();
      if (!meta.ok) return res.status(meta.status).send(metaText);
      effectiveSha = JSON.parse(metaText).sha;
    }
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message: message || `Delete ${req.params.path} via Proxy`, sha: effectiveSha, branch: branch || BRANCH })
    });
    const text = await gh.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(gh.status).json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST delete (sicher)
app.post("/contents/:path/delete", requireApiKey, async (req, res) => {
  try {
    const { message, sha, branch } = req.body || {};
    const token = await getInstallationToken();
    let effectiveSha = sha;
    if (!effectiveSha) {
      const meta = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
      });
      const metaText = await meta.text();
      if (!meta.ok) return res.status(meta.status).send(metaText);
      effectiveSha = JSON.parse(metaText).sha;
    }
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message: message || `Delete ${req.params.path} via Proxy (POST)`, sha: effectiveSha, branch: branch || BRANCH })
    });
    const text = await gh.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(gh.status).json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`pixelbeav-proxy listening on :${PORT}`));
