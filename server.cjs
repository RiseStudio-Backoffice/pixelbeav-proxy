/**
 * ==========================================================
 * 🌐 PixelBeav Proxy Server – server.cjs
 * Version: 1.8.1 (Final - Alle Fehler behoben)
 * ==========================================================
 * Behobene Fehler (kumulativ):
 * 1. SyntaxError: Unerwarteter Bezeichner ('console')
 * 2. JWT: 'secretOrPrivateKey must be an asymmetric key' (Fehlende Zeilenumbrüche im ENV)
 * 3. Fehlt: 'const fs = require("fs")' (für lokales Backup)
 * 4. Bug: PUT-Request vergaß Base64-Kodierung des Inhalts.
 * 5. Bug: Backup-System verwendete nicht existierende 'octokit'-Methoden.
 * 6. Ineffizienz: Backup-System holte Token bei jedem Aufruf neu.
 * ==========================================================
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const path = require("path");
// FEHLERBEHEBUNG 3: fs-Modul für das lokale Backup muss importiert werden
const fs = require("fs"); 
// FEHLERBEHEBUNG 1: Schließende Klammer und Semikolon im fetch-Import korrigiert
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

try {
  require("dotenv").config();
  console.log("✅ Dotenv geladen.");
} catch (e) {
  console.warn("⚠️ Dotenv konnte nicht geladen werden:", e.message);
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
} = process.env;

// FEHLERBEHEBUNG 2: Behebt den 'secretOrPrivateKey' Fehler durch Ersetzen der entkommenen Zeilenumbrüche
const PRIMARY_PRIVATE_KEY_FIXED = APP_PRIVATE_KEY ? APP_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
const PROXY_PRIVATE_KEY_FIXED = PROXY_PRIVATE_KEY ? PROXY_PRIVATE_KEY.replace(/\\n/g, '\n') : null;

console.log("🔐 Starting PixelBeav Proxy...");
if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !PRIMARY_PRIVATE_KEY_FIXED || !BRANCH) {
  console.error("❌ Fehlende ENV-Variablen. Bitte prüfe APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, APP_PRIVATE_KEY, BRANCH.");
  process.exit(1);
}

let cachedToken = { token: null, expiresAt: 0 };

/**
 * Erstellt einen JWT für die Authentifizierung der App.
 */
function makeJwt(privateKey, appId) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const token = jwt.sign(payload, privateKey, { algorithm: "RS256" });
  return token;
}

async function getInstallationToken() {
  const now = Math.floor(Date.now() / 1000);
  // Ineffizienz 6: Token wird nur erneuert, wenn er in weniger als 60 Sekunden abläuft.
  if (cachedToken.token && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }
  console.log("🔄 Requesting new GitHub Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      // FEHLERBEHEBUNG 2: Verwende den korrigierten Primary Key
      Authorization: `Bearer ${makeJwt(PRIMARY_PRIVATE_KEY_FIXED, APP_ID)}`,
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
// 🩺 Healthcheck & Debug Routes
// ==========================================================
app.get("/health", (_req, res) => {
  res.json({ status: "ok", repo: REPO_NAME, branch: BRANCH });
});

app.get("/debug/head-test", requireApiKey, async (_req, res) => {
  try {
    const data = await ghFetch(`git/refs/heads/${BRANCH}`);
    res.json({ head: data.object.sha });
  } catch (e) {
    console.error("❌ HEAD-Test:", e.message);
    res.status(500).json({ error: e.message });
  }
});

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
    // FEHLERBEHEBUNG 4: Base64-Kodierung für den Inhalt ist für die GitHub API zwingend
    const contentEncoded = Buffer.from(content, 'utf8').toString('base64');
    
    const body = { message, content: contentEncoded, branch: branch || BRANCH };
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
// ================================================================

// Ineffizienz 6: Cache für Backup Token
let cachedBackupToken = { token: null, expiresAt: 0 };

async function getBackupInstallationToken() {
  const now = Math.floor(Date.now() / 1000);
  // Ineffizienz 6: Token-Wiederverwendung
  if (cachedBackupToken.token && cachedBackupToken.expiresAt > now + 60) {
    return cachedBackupToken.token;
  }
  
  // Neuer Token-Request
  console.log("🔄 [Proxy-Backup] Requesting new Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${PROXY_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      // FEHLERBEHEBUNG 2: Verwende den korrigierten Proxy Key
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
  console.log("🧩 [Proxy-Backup] Initialisiere automatisches Backup-System ...");

  try {
    if (
      !PROXY_APP_ID ||
      !PROXY_INSTALLATION_ID ||
      !PROXY_PRIVATE_KEY_FIXED || 
      !PROXY_REPO_OWNER ||
      !PROXY_REPO_NAME
    ) {
      console.error("❌ [Proxy-Backup] Fehlende Proxy-Variablen. Backup abgebrochen.");
      return;
    }

    const backupDir = path.join(process.cwd(), "backups");
    // FEHLERBEHEBUNG 3: fs-Methoden sind jetzt verfügbar
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

    // Ineffizienz 6 & FEHLERBEHEBUNG 2: Nutzt die optimierte Cache-Funktion
    const token = await getBackupInstallationToken(); 
    
    const remotePath = `backups/server_backup_${timestamp}.cjs`;
    const contentEncoded = Buffer.from(serverData, "utf-8").toString("base64");
    
    // FEHLERBEHEBUNG 5: octokit durch fetch PUT-Request ersetzt
    const backupUrl = `https://api.github.com/repos/${PROXY_REPO_OWNER}/${PROXY_REPO_NAME}/contents/${remotePath}`;
    const backupBody = JSON.stringify({
      message: `🔄 Auto-Backup ${timestamp}`,
      content: contentEncoded,
      branch: PROXY_BRANCH || "main",
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

    console.log("✅ [Proxy-Backup] Backup erfolgreich ins Proxy-Repo hochgeladen.");

  } catch (error) {
    console.error("❌ [Proxy-Backup-Fehler]", error);
  }
})();
