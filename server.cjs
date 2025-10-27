const express = require("express");
const jwt = require("jsonwebtoken");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
try { require("dotenv").config(); } catch {}

console.log("🔐 SERVER START");
console.log("🔑 API_KEY:", process.env.API_KEY ?? "[NICHT GESETZT]");

const {
  APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, BRANCH,
  GH_APP_PRIVATE_KEY, API_KEY
} = process.env;

if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !GH_APP_PRIVATE_KEY) {
  console.error("[boot] ❌ Fehlende ENV-Variablen!");
  process.exit(1);
}

function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: APP_ID }, GH_APP_PRIVATE_KEY, {
    algorithm: "RS256"
  });
}

async function getInstallationToken() {
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${makeJwt()}`, Accept: "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error(`getInstallationToken: ${res.status} ${res.statusText} :: ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

function requireApiKey(req, res, next) {
  const clientKey = req.query.apiKey || req.headers["x-api-key"];
  console.log("🛂 Angegebener API-Key:", clientKey);
  console.log("🗝️ Erwarteter API-Key:", API_KEY ?? "[nicht gesetzt]");
  if (!API_KEY || clientKey !== API_KEY) {
    console.log("❌ API-Key stimmt NICHT überein!");
    return res.status(401).json({ error: "unauthorized" });
  }
  console.log("✅ API-Key akzeptiert.");
  next();
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

// Health check
app.get("/health", (_req, res) => res.status(200).send("ok"));

// HEAD-Test gegen GitHub-Datei
app.get("/debug/head-test", requireApiKey, async (_req, res) => {
  try {
    const token = await getInstallationToken();
    const gh = await fetch("https://api.github.com/repos/RiseStudio-Backoffice/PixelBeav.App/contents/rules_gpt/repo-interaktion-rules.json", {
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

// Root-Inhalt abfragen
app.get("/contents/", requireApiKey, async (_req, res) => {
  try {
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
    });
    const data = await gh.json();
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET mit verschachteltem Pfad
app.get("/contents/*", requireApiKey, async (req, res) => {
  try {
    const path = req.params[0];
    const token = await getInstallationToken();
    console.log("📁 Zielpfad (GET):", path);
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
    });
    const data = await gh.json();
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT mit verschachteltem Pfad
app.put("/contents/*", requireApiKey, async (req, res) => {
  try {
    const targetPath = req.params[0];
    const allowedWritePaths = ["rules_gpt/", "README.md", "src/", "docs/"];
    if (!allowedWritePaths.some(prefix => targetPath.startsWith(prefix))) {
      return res.status(403).json({ error: `Write access denied for path: ${targetPath}` });
    }

    console.log("📥 PUT in:", targetPath);

    const { message, content, branch, sha } = req.body || {};
    const token = await getInstallationToken();

    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(targetPath)}`, {
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
    console.log("🔁 GitHub PUT-Antwort:", text);

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// DELETE mit verschachteltem Pfad
app.delete("/contents/*", requireApiKey, async (req, res) => {
  try {
    const targetPath = req.params[0];
    const { message, sha, branch } = req.body || {};
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(targetPath)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, sha, branch: branch || BRANCH })
    });
    const data = await gh.json();
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST-Fallback zum Löschen
app.post("/contents/*/delete", requireApiKey, async (req, res) => {
  try {
    const targetPath = req.params[0];
    const { message, sha, branch } = req.body || {};
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(targetPath)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, sha, branch: branch || BRANCH })
    });
    const data = await gh.json();
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ==========================================================
// 🔽 Apply Rules Endpoint (sicherer Zugriff für GPT)
// ==========================================================
app.post("/api/applyRules", requireApiKey, async (req, res) => {
  try {
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: "Missing path" });

    const token = await getInstallationToken();
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BRANCH}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3.raw+json",
        "User-Agent": "PixelBeav-Proxy"
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API Fehler: ${response.status} ${response.statusText} :: ${text}`);
    }

    const data = await response.json();
    res.json({
      allow_apply: true,
      content: data.content ?? null
    });
  } catch (err) {
    console.error("❌ applyRules:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 pixelbeav-proxy listening on :${PORT}`);
});
