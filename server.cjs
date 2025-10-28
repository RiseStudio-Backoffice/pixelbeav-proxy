/**
 * ==========================================================
 * 🌐 PixelBeav Proxy Server – server.cjs
 * Version: 1.6.0 (vollständig bereinigt & erweitert)
 * ==========================================================
 * Enthaltene Routen:
 *   ✔ /health                       – Systemstatus
 *   ✔ /debug/head-test              – Header & Token-Test
 *   ✔ /contents/                    – Root-Listing
 *   ✔ /contents/:path(*)            – Datei- oder Ordnerabruf
 *   ✔ /contents/:path(*) (PUT)      – Datei erstellen/aktualisieren
 *   ✔ /contents/:path(*) (DELETE)   – Datei löschen
 *   ✔ /contents/:path(*)/delete     – Alternative Löschroute
 *
 * Entfernt:
 *   ✖ /contents/rules_gpt/          – Alte GPT-Hilfsroute (nicht mehr benötigt)
 * ==========================================================
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

try {
  require("dotenv").config();
  console.log("✅ Dotenv geladen.");
} catch (e) {
  console.warn("⚠️ Dotenv konnte nicht geladen werden:", e.message);
}

console.log("🔐 SERVER START");
const {
  APP_ID,
  INSTALLATION_ID,
  REPO_OWNER,
  REPO_NAME,
  BRANCH,
  GH_APP_PRIVATE_KEY,
  API_KEY
} = process.env;

// ==========================================================
// 🧩 Initiale Prüfung
// ==========================================================
if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !GH_APP_PRIVATE_KEY || !BRANCH) {
  console.error("❌ Fehlende ENV-Variablen! APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, GH_APP_PRIVATE_KEY und BRANCH erforderlich.");
  process.exit(1);
} else {
  console.log(`✅ ENV-Check bestanden – Repository: ${REPO_OWNER}/${REPO_NAME} | Branch: ${BRANCH}`);
}

// ==========================================================
// 🔑 Tokenmanagement (JWT + Installation Token)
// ==========================================================
let cachedToken = { token: null, expiresAt: 0 };

function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: APP_ID };
  const token = jwt.sign(payload, GH_APP_PRIVATE_KEY, { algorithm: "RS256" });
  console.log("🔏 JWT erzeugt:", new Date(now * 1000).toISOString());
  return token;
}

async function getInstallationToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.token && cachedToken.expiresAt > now + 60) {
    console.log("🔁 Verwende gecachten Installation Token (gültig bis):", new Date(cachedToken.expiresAt * 1000).toISOString());
    return cachedToken.token;
  }

  console.log("🌍 Fordere neuen Installation Token von GitHub an...");
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${makeJwt()}`,
      Accept: "application/vnd.github+json"
    }
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("❌ Fehler beim Tokenabruf:", data);
    throw new Error(`TokenError: ${res.status} ${res.statusText}`);
  }

  cachedToken = {
    token: data.token,
    expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000)
  };

  console.log("✅ Neuer Installation Token abgerufen:", new Date(cachedToken.expiresAt * 1000).toISOString());
  return data.token;
}

// ==========================================================
// 🧱 Middleware & App-Setup
// ==========================================================
const app = express();
app.use(express.json({ limit: "5mb" }));

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url} | Body: ${JSON.stringify(req.body || {})}`);
  next();
});

function requireApiKey(req, res, next) {
  const key = req.query.apiKey || req.headers["x-api-key"];
  if (!API_KEY || key !== API_KEY) {
    console.error("❌ Ungültiger oder fehlender API-Key:", key);
    return res.status(401).json({ error: "unauthorized", message: "API-Key ungültig" });
  }
  console.log("🛡️ API-Key validiert.");
  next();
}

// ==========================================================
// 🔧 Helper: GitHub API Call
// ==========================================================
async function ghFetch(path, options = {}) {
  const token = await getInstallationToken();
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/${path}`;
  console.log("🌐 GitHub Request:", options.method || "GET", url);

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    console.error(`❌ GitHub Fehler (${res.status}):`, data);
    throw new Error(`GitHubError ${res.status} ${res.statusText}`);
  }

  console.log(`✅ GitHub OK (${res.status}) →`, Array.isArray(data) ? `[${data.length} Elemente]` : data.name || "Objekt");
  return data;
}

// ==========================================================
// 💓 HEALTH-CHECK
// ==========================================================
app.get("/health", (_req, res) => {
  console.log("💓 Health-Check ausgeführt");
  res.status(200).json({ status: "ok", repo: REPO_NAME, branch: BRANCH });
});

// ==========================================================
// 🧪 DEBUG: HEAD-Test
// ==========================================================
app.get("/debug/head-test", requireApiKey, async (_req, res) => {
  console.log("🧪 HEAD-Test gestartet...");
  try {
    const data = await ghFetch("git/refs/heads/" + BRANCH);
    res.status(200).json({ head: data.object.sha });
  } catch (e) {
    console.error("❌ HEAD-Test fehlgeschlagen:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// 📜 ROOT: Inhalte im Repo-Root
// ==========================================================
app.get("/contents/", requireApiKey, async (_req, res) => {
  console.log("📁 Root-Listing angefordert");
  try {
    const data = await ghFetch("contents");
    res.status(200).json(data);
  } catch (e) {
    console.error("❌ Root-Listing fehlgeschlagen:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// 📂 GET /contents/:path(*) – Datei oder Ordner
// ==========================================================
app.get("/contents/:path(*)", requireApiKey, async (req, res) => {
  const path = req.params.path;
  console.log("📂 GET Request für:", path);

  try {
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`);
    if (Array.isArray(data)) {
      console.log(`📁 Ordner erkannt (${data.length} Elemente):`, path);
      return res.status(200).json({
        type: "dir",
        path,
        entries: data
      });
    }
    console.log("📄 Datei erkannt:", data.name);
    res.status(200).json({ type: "file", ...data });
  } catch (e) {
    console.error("❌ Fehler beim Abruf von", path, "→", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// ✏️ PUT /contents/:path(*) – Datei erstellen/aktualisieren
// ==========================================================
app.put("/contents/:path(*)", requireApiKey, async (req, res) => {
  const path = req.params.path;
  const { message, content, branch, sha } = req.body;
  console.log("✏️ PUT Request:", path, "| SHA:", sha);

  if (!message || !content)
    return res.status(400).json({ error: "message und content erforderlich" });

  try {
    const body = { message, content, branch: branch || BRANCH };
    if (sha) body.sha = sha;

    const data = await ghFetch(`contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });

    console.log("✅ Datei geschrieben:", path);
    res.status(200).json(data);
  } catch (e) {
    console.error("❌ PUT fehlgeschlagen:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// ❌ DELETE /contents/:path(*) – Datei löschen
// ==========================================================
app.delete("/contents/:path(*)", requireApiKey, async (req, res) => {
  const path = req.params.path;
  const { message, sha, branch } = req.body;
  console.log("🗑️ DELETE Request:", path);

  if (!sha) return res.status(400).json({ error: "sha erforderlich" });

  try {
    const body = { message: message || `Delete ${path}`, sha, branch: branch || BRANCH };
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`, {
      method: "DELETE",
      body: JSON.stringify(body)
    });
    console.log("✅ Datei gelöscht:", path);
    res.status(200).json(data);
  } catch (e) {
    console.error("❌ DELETE fehlgeschlagen:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// 🧨 POST /contents/:path(*)/delete – Alternative Löschmethode
// ==========================================================
app.post("/contents/:path(*)/delete", requireApiKey, async (req, res) => {
  const path = req.params.path;
  const { message, sha, branch } = req.body;
  console.log("🧨 POST Delete Request:", path);

  if (!sha) return res.status(400).json({ error: "sha erforderlich" });

  try {
    const body = { message: message || `Delete ${path}`, sha, branch: branch || BRANCH };
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`, {
      method: "DELETE",
      body: JSON.stringify(body)
    });
    console.log("✅ Datei via POST gelöscht:", path);
    res.status(200).json(data);
  } catch (e) {
    console.error("❌ POST Delete fehlgeschlagen:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// 🚀 Serverstart
// ==========================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 PixelBeav Proxy läuft auf Port ${PORT}`);
});
