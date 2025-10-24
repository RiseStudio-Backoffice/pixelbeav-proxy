// server.cjs — PixelBeav Proxy (Render Free compatible)
// Lädt Env, prüft API-Key-Header, holt GitHub Installation Tokens über deine GitHub App
// Endpunkte:
//   GET    /contents/             -> Root-Dateien auflisten
//   GET    /contents/:path        -> Metadaten (inkl. sha) einer Datei
//   PUT    /contents/:path        -> Datei anlegen/aktualisieren (content base64, optional sha)
//   DELETE /contents/:path        -> Datei löschen (sha optional; wird sonst automatisch geholt)

const express = require("express");
const jwt = require("jsonwebtoken");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
require("dotenv").config();

// --- Env ---
const {
  APP_ID,                // z.B. 2170199
  INSTALLATION_ID,       // z.B. 91397736
  REPO_OWNER,            // z.B. RiseStudio-Backoffice
  REPO_NAME,             // z.B. PixelBeav.App
  BRANCH,                // z.B. main
  GH_APP_PRIVATE_KEY,    // kompletter PEM-Inhalt (BEGIN/END inklusive)
  ACTIONS_API_KEY        // dein geheimer Proxy-API-Key (Header X-API-Key)
} = process.env;

if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !GH_APP_PRIVATE_KEY) {
  console.error("[boot] Missing required environment variables.");
  process.exit(1);
}

// --- Helpers ---
function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 9 * 60, iss: APP_ID },
    GH_APP_PRIVATE_KEY,
    { algorithm: "RS256" }
  );
}

async function getInstallationToken() {
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${makeJwt()}`, Accept: "application/vnd.github+json" }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getInstallationToken: ${res.status} ${res.statusText} :: ${text}`);
  }
  const { token } = await res.json();
  return token;
}

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"];
  if (!ACTIONS_API_KEY || k !== ACTIONS_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// --- App ---
const app = express();
app.use(express.json({ limit: "2mb" }));

// sehr schlichtes Request-Logging (hilft beim Debuggen)
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

// Healthcheck (optional)
app.get("/health", (_req, res) => res.status(200).send("ok"));

// GET /contents/  -> Root-Inhalt listen
app.get("/contents/", requireApiKey, async (_req, res) => {
  try {
    const token = await getInstallationToken();
    const gh = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
    );
    const data = await gh.json();
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /contents/:path  -> Metadaten (inkl. sha) einer Datei
app.get("/contents/:path", requireApiKey, async (req, res) => {
  try {
    const token = await getInstallationToken();
    const gh = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
    );
    const data = await gh.json();
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /contents/:path  -> Datei anlegen/aktualisieren
app.put("/contents/:path", requireApiKey, async (req, res) => {
  try {
    const { message, content, branch, sha } = req.body || {};
    const token = await getInstallationToken();
    const gh = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        body: JSON.stringify({ message, content, branch: branch || BRANCH, ...(sha ? { sha } : {}) })
      }
    );
    const text = await gh.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// DELETE /contents/:path  -> Datei löschen (sha optional; wird sonst automatisch geholt)
app.delete("/contents/:path", requireApiKey, async (req, res) => {
  try {
    const { message, sha, branch } = req.body || {};
    const token = await getInstallationToken();

    // sha automatisch besorgen, falls nicht mitgegeben
    let effectiveSha = sha;
    if (!effectiveSha) {
      const meta = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
      );
      const metaText = await meta.text();
      if (!meta.ok) {
        console.log(`[gh] GET sha ${req.params.path} -> ${meta.status} ${meta.statusText} :: ${metaText.slice(0,200)}`);
        return res.status(meta.status).send(metaText);
      }
      const metaJson = JSON.parse(metaText);
      effectiveSha = metaJson.sha;
    }

    const gh = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        body: JSON.stringify({
          message: message || `Delete ${req.params.path} via Proxy`,
          sha: effectiveSha,
          branch: branch || BRANCH
        })
      }
    );
    const text = await gh.text();
    console.log(`[gh] DELETE ${req.params.path} -> ${gh.status} ${gh.statusText} :: ${text.slice(0,200)}`);
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(gh.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Start
const PORT = process.env.PORT || 3000; // Render setzt PORT automatisch (z.B. 10000)
app.listen(PORT, () => console.log(`pixelbeav-proxy listening on :${PORT}`));
