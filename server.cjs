/**
 * ==========================================================
 * 🌐 PixelBeav Proxy Server – server.cjs
 * Version: 1.8.0 (Final - Fehlerbereinigt)
 * ==========================================================
 * Behobene Fehler:
 * 1. JWT: 'secretOrPrivateKey must be an asymmetric key' (Fehlende Zeilenumbrüche im ENV)
 * 2. Fehlt: 'const fs = require("fs")' (für lokales Backup)
 * 3. Bug: PUT-Request vergaß Base64-Kodierung des Inhalts.
 * 4. Bug: Backup-System verwendete nicht existierende 'octokit'-Methoden.
 * 5. Ineffizienz: Backup-System holte Token bei jedem Aufruf neu.
 * ==========================================================
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const path = require("path");
// FEHLERBEHEBUNG 2: fs-Modul für das lokale Backup muss importiert werden
const fs = require("fs"); 
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

try {
  require("dotenv").config();
  [cite_start]console.log("✅ Dotenv geladen."); [cite: 4]
} catch (e) {
  [cite_start]console.warn("⚠️ Dotenv konnte nicht geladen werden:", e.message); [cite: 4, 5]
}

// ==========================================================
// ⚙️ Environment Variablen & Private Key Fix
// ==========================================================
const {
  APP_ID,
  INSTALLATION_ID,
  REPO_OWNER,
  REPO_NAME,
  BRANCH,
  APP_PRIVATE_KEY,
  API_KEY,
  // Backup-Variablen
  PROXY_APP_ID,
  PROXY_INSTALLATION_ID,
  PROXY_PRIVATE_KEY,
  PROXY_REPO_OWNER,
  PROXY_REPO_NAME,
  PROXY_BRANCH,
[cite_start]} = process.env; [cite: 5]

// FEHLERBEHEBUNG 1: Behebt den 'secretOrPrivateKey' Fehler durch Ersetzen der entkommenen Zeilenumbrüche
const PRIMARY_PRIVATE_KEY_FIXED = APP_PRIVATE_KEY ? APP_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
const PROXY_PRIVATE_KEY_FIXED = PROXY_PRIVATE_KEY ? PROXY_PRIVATE_KEY.replace(/\\n/g, '\n') : null;

[cite_start]console.log("🔐 Starting PixelBeav Proxy..."); [cite: 6]
// FEHLERBEHEBUNG 1: Nutzt den korrigierten Key für die Prüfung
if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !PRIMARY_PRIVATE_KEY_FIXED || !BRANCH) {
  [cite_start]console.error("❌ Fehlende ENV-Variablen. Bitte prüfe APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, APP_PRIVATE_KEY, BRANCH."); [cite: 6]
  [cite_start]process.exit(1); [cite: 7]
}

let cachedToken = { token: null, expiresAt: 0 };

/**
 * Erstellt einen JWT für die Authentifizierung der App.
 * @param {string} privateKey Der korrigierte Private Key (mit \n).
 * @param {string} appId Die App ID.
 */
function makeJwt(privateKey, appId) {
  const now = Math.floor(Date.now() / 1000);
  [cite_start]const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId }; [cite: 8]
  // FEHLERBEHEBUNG 1: Verwendung des korrigierten Schlüssels
  [cite_start]const token = jwt.sign(payload, privateKey, { algorithm: "RS256" }); [cite: 9]
  [cite_start]return token; [cite: 10]
}

async function getInstallationToken() {
  const now = Math.floor(Date.now() / 1000);
  // Ineffizienz 5: Token wird nur erneuert, wenn er in weniger als 60 Sekunden abläuft.
  if (cachedToken.token && cachedToken.expiresAt > now + 60) {
    [cite_start]return cachedToken.token; [cite: 11, 12]
  }
  console.log("🔄 Requesting new GitHub Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      // FEHLERBEHEBUNG 1: Verwende den korrigierten Primary Key
      Authorization: `Bearer ${makeJwt(PRIMARY_PRIVATE_KEY_FIXED, APP_ID)}`,
      Accept: "application/vnd.github+json"
    }
  });
  [cite_start]const data = await res.json(); [cite: 13]
  [cite_start]if (!res.ok) throw new Error(`Token Error: ${res.status} ${JSON.stringify(data)}`); [cite: 13]
  cachedToken = {
    token: data.token,
    expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000)
  [cite_start]}; [cite: 14]
  [cite_start]console.log("✅ Installation Token erfolgreich abgerufen."); [cite: 15]
  return data.token;
}

const app = express();
[cite_start]app.use(express.json({ limit: "5mb" })); [cite: 16]
app.use((req, _res, next) => {
  [cite_start]console.log(`➡️  ${req.method} ${req.url} | Body: ${JSON.stringify(req.body || {})}`); [cite: 16]
  next();
});

function requireApiKey(req, res, next) {
  [cite_start]const key = req.headers["x-api-key"] || req.query.apiKey; [cite: 17]
  if (!API_KEY || key !== API_KEY) {
    [cite_start]console.error("🚫 Ungültiger API-Key"); [cite: 18]
    [cite_start]return res.status(401).json({ error: "unauthorized" }); [cite: 18]
  }
  [cite_start]next(); [cite: 19]
}

async function ghFetch(path, options = {}) {
  const token = await getInstallationToken();
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/${path}`;
  [cite_start]console.log("🌐 GitHub API:", options.method || "GET", url); [cite: 20]

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  [cite_start]const text = await res.text(); [cite: 21]
  let data;
  try {
    [cite_start]data = JSON.parse(text); [cite: 21]
  } catch {
    [cite_start]data = { raw: text }; [cite: 22, 23]
  }

  if (!res.ok) {
    [cite_start]console.error(`❌ GitHub Error ${res.status}:`, data); [cite: 24]
    [cite_start]throw new Error(`GitHubError ${res.status}: ${res.statusText}`); [cite: 24]
  }

  [cite_start]console.log(`✅ GitHub OK (${res.status})`); [cite: 24]
  return data;
}

// ==========================================================
// 🩺 Healthcheck & Debug Routes
// ==========================================================
app.get("/health", (_req, res) => {
  [cite_start]res.json({ status: "ok", repo: REPO_NAME, branch: BRANCH }); [cite: 25]
});

app.get("/debug/head-test", requireApiKey, async (_req, res) => {
  try {
    const data = await ghFetch(`git/refs/heads/${BRANCH}`);
    [cite_start]res.json({ head: data.object.sha }); [cite: 25]
  } catch (e) {
    [cite_start]console.error("❌ HEAD-Test:", e.message); [cite: 25]
    [cite_start]res.status(500).json({ error: e.message }); [cite: 25]
  }
});

app.get("/contents/", requireApiKey, async (_req, res) => {
  try {
    const data = await ghFetch("contents");
    [cite_start]res.json(data); [cite: 26]
  } catch (e) {
    [cite_start]console.error("❌ Root Listing:", e.message); [cite: 26]
    [cite_start]res.status(500).json({ error: e.message }); [cite: 26]
  }
});

// ==========================================================
// 📂 GET – File or Folder
// ==========================================================
app.get("/contents/:path(*)", requireApiKey, async (req, res) => {
  const path = req.params.path;
  [cite_start]console.log("📂 GET:", path); [cite: 27]
  try {
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`);
    if (Array.isArray(data)) {
      [cite_start]console.log(`📁 Folder (${data.length} items)`); [cite: 27]
      return res.json(data);
    }
    [cite_start]res.json(data); [cite: 27]
  } catch (e) {
    [cite_start]console.error("❌ GET:", e.message); [cite: 27]
    [cite_start]res.status(500).json({ error: e.message }); [cite: 27]
  }
});

// ==========================================================
// ✏️ PUT – Create or Update File
// ==========================================================
app.put("/contents/:path(*)", requireApiKey, async (req, res) => {
  [cite_start]const path = req.params.path; [cite: 28]
  [cite_start]const { message, content, branch, sha } = req.body; [cite: 28]
  [cite_start]if (!message || !content) return res.status(400).json({ error: "message and content required" }); [cite: 28]

  try {
    // FEHLERBEHEBUNG 3: Base64-Kodierung für den Inhalt ist für die GitHub API zwingend
    const contentEncoded = Buffer.from(content, 'utf8').toString('base64');
    
    // FEHLERBEHEBUNG 3: Nutzt den Base64-kodierten Inhalt
    const body = { message, content: contentEncoded, branch: branch || BRANCH };
    [cite_start]if (sha) body.sha = sha; [cite: 28]
    
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    [cite_start]}); [cite: 28]
    [cite_start]console.log("✅ File written:", path); [cite: 29]
    [cite_start]res.json(data); [cite: 28]
  } catch (e) {
    [cite_start]console.error("❌ PUT:", e.message); [cite: 29]
    [cite_start]res.status(500).json({ error: e.message }); [cite: 29]
  }
});

// ==========================================================
// 🧩 REDIRECT – DELETE → POST (Safety-Redirect)
// ==========================================================
app.delete("/contents/:path(*)", (req, res, next) => {
  [cite_start]console.log("🔁 Redirecting DELETE → POST /delete"); [cite: 36]
  req.url = `/contents/${req.params.path}/delete`;
  req.method = "POST";
  app.handle(req, res, next);
});

// ==========================================================
// 🧨 POST – Safe Delete (Auto-SHA support)
// ==========================================================
// FEHLERBEHEBUNG: Der Code wurde aus dem auskommentierten DELETE-Block hierher verschoben und korrigiert
app.post("/contents/:path(*)/delete", requireApiKey, async (req, res) => {
  [cite_start]const path = req.params.path; [cite: 36]
  [cite_start]let { message, sha, branch } = req.body; [cite: 36]
  branch = branch || BRANCH;
  [cite_start]console.log("🧨 POST DELETE:", path); [cite: 36]

  try {
    if (!sha) {
      [cite_start]console.log("🔍 Kein SHA angegeben – hole aktuelle Metadaten..."); [cite: 37]
      try {
        const meta = await ghFetch(`contents/${encodeURIComponent(path)}`);
        sha = meta.sha;
        [cite_start]console.log("✅ SHA automatisch gefunden:", sha); [cite: 37]
      } catch {
        [cite_start]console.error("⚠️ Datei nicht gefunden beim SHA-Abruf"); [cite: 37]
        [cite_start]return res.status(404).json({ error: "File not found for deletion" }); [cite: 37]
      }
    }

    const body = { message: message || [cite_start]`Delete ${path}`, sha, branch }; [cite: 37]
    const data = await ghFetch(`contents/${encodeURIComponent(path)}`, {
      method: "DELETE",
      body: JSON.stringify(body)
    [cite_start]}); [cite: 38]
    [cite_start]console.log("✅ Datei via POST gelöscht:", path); [cite: 38]
    [cite_start]res.json(data); [cite: 38]
  } catch (e) {
    [cite_start]console.error("❌ POST DELETE fehlgeschlagen:", e.message); [cite: 39]
    [cite_start]res.status(500).json({ error: e.message }); [cite: 39]
  }
});

// ==========================================================
// 🚀 Server Start
// ==========================================================
const PORT = process.env.PORT || [cite_start]8080; [cite: 40]
app.listen(PORT, () => {
  [cite_start]console.log(`🚀 PixelBeav Proxy läuft auf Port ${PORT}`); [cite: 40]
});

// ================================================================
// 🧩 AUTO-BACKUP-SYSTEM – PixelBeav Proxy
// ================================================================

// Ineffizienz 5: Cache für Backup Token
let cachedBackupToken = { token: null, expiresAt: 0 };

async function getBackupInstallationToken() {
  const now = Math.floor(Date.now() / 1000);
  // Ineffizienz 5: Token-Wiederverwendung
  if (cachedBackupToken.token && cachedBackupToken.expiresAt > now + 60) {
    return cachedBackupToken.token;
  }
  
  // Neuer Token-Request
  console.log("🔄 [Proxy-Backup] Requesting new Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${PROXY_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      // FEHLERBEHEBUNG 1: Verwende den korrigierten Proxy Key
      Authorization: `Bearer ${makeJwt(PROXY_PRIVATE_KEY_FIXED, PROXY_APP_ID)}`,
      Accept: "application/vnd.github+json"
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Backup Token Error: ${res.status} ${JSON.stringify(data)}`);
  
  cachedBackupToken = {
    token: data.token,
    expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000)
  };
  console.log("✅ [Proxy-Backup] Installation Token erfolgreich abgerufen.");
  return data.token;
}

;(async () => {
  [cite_start]console.log("🧩 [Proxy-Backup] Initialisiere automatisches Backup-System ..."); [cite: 41]

  try {
    // Variablen sind oben definiert.
    if (
      !PROXY_APP_ID ||
      [cite_start]!PROXY_INSTALLATION_ID || [cite: 42]
      !PROXY_PRIVATE_KEY_FIXED || // FEHLERBEHEBßUNG 1: Prüfung des korrigierten Keys
      [cite_start]!PROXY_REPO_OWNER || [cite: 42]
      !PROXY_REPO_NAME
    ) {
      [cite_start]console.error("❌ [Proxy-Backup] Fehlende Proxy-Variablen. Backup abgebrochen."); [cite: 42]
      return;
    }

    const backupDir = path.join(process.cwd(), "backups");
    // FEHLERBEHEBUNG 2: fs-Methoden sind jetzt verfügbar
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
      [cite_start]console.log("📂 [Proxy-Backup] Neuer Backup-Ordner erstellt:", backupDir); [cite: 43]
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      [cite_start].split("Z")[0]; [cite: 44]
    [cite_start]const localBackupPath = path.join(backupDir, `server_backup_${timestamp}.cjs`); [cite: 44]
    
    const currentFilePath = path.join(process.cwd(), "server.cjs"); 
    [cite_start]const serverData = fs.readFileSync(currentFilePath, "utf-8"); [cite: 45]
    [cite_start]fs.writeFileSync(localBackupPath, serverData); [cite: 45]
    [cite_start]console.log("💾 [Proxy-Backup] Lokale Sicherung erstellt:", localBackupPath); [cite: 45]

    // Ineffizienz 5 & FEHLERBEHEBUNG 1: Nutzt die optimierte Cache-Funktion
    const token = await getBackupInstallationToken(); 
    
    [cite_start]const remotePath = `backups/server_backup_${timestamp}.cjs`; [cite: 47]
    [cite_start]const contentEncoded = Buffer.from(serverData, "utf-8").toString("base64"); [cite: 47]
    
    // FEHLERBEHEBUNG 4: octokit durch fetch PUT-Request ersetzt
    const backupUrl = `https://api.github.com/repos/${PROXY_REPO_OWNER}/${PROXY_REPO_NAME}/contents/${remotePath}`;
    const backupBody = JSON.stringify({
      message: `🔄 Auto-Backup ${timestamp}`,
      content: contentEncoded,
      [cite_start]branch: PROXY_BRANCH || "main", [cite: 47]
    });

    const uploadRes = await fetch(backupUrl, {
      method: "PUT",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: backupBody,
    });

    if (!uploadRes.ok) {
        const errorData = await uploadRes.json();
        throw new Error(`Backup Upload Error: ${uploadRes.status} ${JSON.stringify(errorData)}`);
    }

    [cite_start]console.log("✅ [Proxy-Backup] Backup erfolgreich ins Proxy-Repo hochgeladen."); [cite: 48]

  } catch (error) {
    [cite_start]console.error("❌ [Proxy-Backup-Fehler]", error); [cite: 48]
  }
})();
