/**
 * ==========================================================
 * 🌐 PixelBeav Proxy Server – server.cjs
 * Version: 1.6.0 (vollständig bereinigt & erweitert)
 * Version: 1.7.0 (Auto-SHA Delete + Deep Logging)
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
const path = require("path");
const fs = require("fs");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

try {
  require("dotenv").config();
  console.log("✅ Dotenv geladen.");
} catch (e) {
  console.warn("⚠️ Dotenv konnte nicht geladen werden:", e.message);
}

const {
  APP_ID,
  INSTALLATION_ID,
  REPO_OWNER,
  REPO_NAME,
  BRANCH,
  APP_PRIVATE_KEY,
  API_KEY
} = process.env;

console.log("🔐 Starting PixelBeav Proxy...");
if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !APP_PRIVATE_KEY || !BRANCH) {
  console.error("❌ Fehlende ENV-Variablen. Bitte prüfe APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, APP_PRIVATE_KEY, BRANCH.");
  process.exit(1);
}

let cachedToken = { token: null, expiresAt: 0 };

function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: APP_ID };
  const token = jwt.sign(payload, APP_PRIVATE_KEY, { algorithm: "RS256" });
  return token;
}

async function getInstallationToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.token && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }
  console.log("🔄 Requesting new GitHub Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${makeJwt()}`,
      Accept: "application/vnd.github+json"
    }
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Token Error: ${res.status} ${JSON.stringify(data)}`);

  cachedToken = {
    token: data.token,
    expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000)
  };
  console.log("✅ Installation Token erfolgreich abgerufen.");
  return data.token;
}

const app = express();
app.use(express.json({ limit: "5mb" }));

app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.url} | Body: ${JSON.stringify(req.body || {})}`);
  next();
});

function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.apiKey;
  if (!API_KEY || key !== API_KEY) {
    console.error("🚫 Ungültiger API-Key");
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

async function ghFetch(path, options = {}) {
  const token = await getInstallationToken();
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/${path}`;
  console.log("🌐 GitHub API:", options.method || "GET", url);

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
    console.error(`❌ GitHub Error ${res.status}:`, data);
    throw new Error(`GitHubError ${res.status}: ${res.statusText}`);
  }

  console.log(`✅ GitHub OK (${res.status})`);
  return data;
}

// ==========================================================
// 🩺 Healthcheck
// ==========================================================
app.get("/health", (_req, res) => {
  res.json({ status: "ok", repo: REPO_NAME, branch: BRANCH });
});

// ==========================================================
// 🧪 HEAD Debug Test
// ==========================================================
app.get("/debug/head-test", requireApiKey, async (_req, res) => {
  try {
    const data = await ghFetch(`git/refs/heads/${BRANCH}`);
    res.json({ head: data.object.sha });
  } catch (e) {
    console.error("❌ HEAD-Test:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// 📁 Root Listing
// ==========================================================
app.get("/contents/", requireApiKey, async (_req, res) => {
  try {
    const data = await ghFetch("contents");
    res.json(data);
  } catch (e) {
    console.error("❌ Root Listing:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// 📂 GET – File or Folder
// ==========================================================
app.get("/contents/:path(*)", requireApiKey, async (req, res) => {
  const path = req.params.path;
  console.log("📂 GET:", path);
  try {
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`);
    if (Array.isArray(data)) {
      console.log(`📁 Folder (${data.length} items)`);
      return res.json(data);
    }
    res.json(data);
  } catch (e) {
    console.error("❌ GET:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// ✏️ PUT – Create or Update File
// ==========================================================
app.put("/contents/:path(*)", requireApiKey, async (req, res) => {
  const path = req.params.path;
  const { message, content, branch, sha } = req.body;
  if (!message || !content) return res.status(400).json({ error: "message and content required" });

  try {
    const body = { message, content, branch: branch || BRANCH };
    if (sha) body.sha = sha;
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    console.log("✅ File written:", path);
    res.json(data);
  } catch (e) {
    console.error("❌ PUT:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 🔒 Deprecated Endpoint
 * DELETE /contents/:path
 * 
 * Diese Methode wurde aus Stabilitätsgründen deaktiviert.
 * Verwende stattdessen POST /contents/:path/delete (siehe redirect unten).
 * 
 * Grund: DELETE-Bodies werden in manchen Umgebungen (Render, OpenAI Actions)
 * nicht korrekt übermittelt, daher wurde POST als universelle Variante eingeführt.
 */
// ==========================================================
// 🗑 DELETE – Delete File (Auto-SHA support)
// ==========================================================
/*
app.delete("/contents/:path(*)", requireApiKey, async (req, res) => {
  const path = req.params.path;
  let { message, sha, branch } = req.body;
  branch = branch || BRANCH;
  console.log("🗑 DELETE:", path);

  try {
    // 🔍 SHA auto-detection
    if (!sha) {
      console.log("🔍 Kein SHA angegeben – hole aktuelle Metadaten...");
      try {
        const meta = await ghFetch(`contents/${encodeURIComponent(path)}`);
        sha = meta.sha;
        console.log("✅ SHA automatisch gefunden:", sha);
      } catch {
        console.error("⚠️ Datei nicht gefunden beim SHA-Abruf");
        return res.status(404).json({ error: "File not found for deletion" });
      }
    }

    const body = { message: message || `Delete ${path}`, sha, branch };
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`, {
      method: "DELETE",
      body: JSON.stringify(body)
    });

    console.log("✅ Datei gelöscht:", path);
    res.json(data);
  } catch (e) {
    console.error("❌ DELETE fehlgeschlagen:", e.message);
    res.status(500).json({ error: e.message });
  }
});
*/

// ==========================================================
// 🧩 REDIRECT – DELETE → POST (Safety-Redirect)
// ==========================================================
app.delete("/contents/:path(*)", (req, res, next) => {
  console.log("🔁 Redirecting DELETE → POST /delete");
  req.url = `/contents/${req.params.path}/delete`;
  req.method = "POST";
  app.handle(req, res, next);
});

// ==========================================================
// 🧨 POST – Safe Delete (Auto-SHA support)
// ==========================================================
app.post("/contents/:path(*)/delete", requireApiKey, async (req, res) => {
  const path = req.params.path;
  let { message, sha, branch } = req.body;
  branch = branch || BRANCH;
  console.log("🧨 POST DELETE:", path);

  try {
    if (!sha) {
      console.log("🔍 Kein SHA angegeben – hole aktuelle Metadaten...");
      try {
        const meta = await ghFetch(`contents/${encodeURIComponent(path)}`);
        sha = meta.sha;
        console.log("✅ SHA automatisch gefunden:", sha);
      } catch {
        console.error("⚠️ Datei nicht gefunden beim SHA-Abruf");
        return res.status(404).json({ error: "File not found for deletion" });
      }
    }

    const body = { message: message || `Delete ${path}`, sha, branch };
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`, {
      method: "DELETE",
      body: JSON.stringify(body)
    });

    console.log("✅ Datei via POST gelöscht:", path);
    res.json(data);
  } catch (e) {
    console.error("❌ POST DELETE fehlgeschlagen:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================
// 🚀 Server Start
// ==========================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 PixelBeav Proxy läuft auf Port ${PORT}`);
});
// ================================================================
// 🧩 AUTO-BACKUP-SYSTEM – PixelBeav Proxy
// Führt beim Start des Servers automatisch ein Backup der server.cjs aus
// Erstellt lokale Sicherung + Remote-Upload ins Proxy-Repository
// ================================================================

;(async () => {
  console.log("🧩 [Proxy-Backup] Initialisiere automatisches Backup-System ...");

  try {
    const {
      PROXY_APP_ID,
      PROXY_INSTALLATION_ID,
      PROXY_PRIVATE_KEY,
      PROXY_REPO_OWNER,
      PROXY_REPO_NAME,
      PROXY_BRANCH,
    } = process.env;

    if (
      !PROXY_APP_ID ||
      !PROXY_INSTALLATION_ID ||
      !PROXY_PRIVATE_KEY ||
      !PROXY_REPO_OWNER ||
      !PROXY_REPO_NAME
    ) {
      console.error("❌ [Proxy-Backup] Fehlende Proxy-Variablen. Backup abgebrochen.");
      return;
    }

    const backupDir = path.join(process.cwd(), "backups");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
      console.log("📂 [Proxy-Backup] Neuer Backup-Ordner erstellt:", backupDir);
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .split("Z")[0];

    const localBackupPath = path.join(backupDir, `server_backup_${timestamp}.cjs`);
    const currentFilePath = path.join(process.cwd(), "server.cjs");
    const serverData = fs.readFileSync(currentFilePath, "utf-8");
    fs.writeFileSync(localBackupPath, serverData);
    console.log("💾 [Proxy-Backup] Lokale Sicherung erstellt:", localBackupPath);

    const payload = {
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: PROXY_APP_ID,
    };
    const githubToken = jwt.sign(payload, PROXY_PRIVATE_KEY, { algorithm: "RS256" });

    const { data: { token } } = await octokit.request(
      `POST /app/installations/${PROXY_INSTALLATION_ID}/access_tokens`
    );

    const remotePath = `backups/server_backup_${timestamp}.cjs`;
    const contentEncoded = Buffer.from(serverData, "utf-8").toString("base64");

    await octokit.repos.createOrUpdateFileContents({
      owner: PROXY_REPO_OWNER,
      repo: PROXY_REPO_NAME,
      path: remotePath,
      message: `🔄 Auto-Backup ${timestamp}`,
      content: contentEncoded,
      branch: PROXY_BRANCH || "main",
    });

    console.log("✅ [Proxy-Backup] Backup erfolgreich ins Proxy-Repo hochgeladen.");

  } catch (error) {
    console.error("❌ [Proxy-Backup-Fehler]", error);
  }
})();
