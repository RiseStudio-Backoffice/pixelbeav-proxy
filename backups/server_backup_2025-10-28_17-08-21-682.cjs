/**
 * ==========================================================
 * 🌐 PixelBeav Proxy Server – server.cjs (ULTIMATE FIX & FINAL)
 * Version: 1.8.7.S (Bedingtes Backup mit SHA-256 Hash-Prüfung)
 * ==========================================================
 * Die Key-Verarbeitung bleibt robust. Das Backup wird nun nur bei
 * tatsächlicher Inhaltsänderung von server.cjs erstellt.
 * ==========================================================
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs"); 
const crypto = require("crypto"); // NEU: Für die Hash-Berechnung
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

try {
  require("dotenv").config();
  console.log("✅ Dotenv geladen.");
} catch (e) {
  console.warn("⚠️ Dotenv konnte nicht geladen werden:", e.message);
}

// ⚙️ Environment Variablen
const {
  APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, BRANCH, APP_PRIVATE_KEY, API_KEY,
  PROXY_APP_ID, PROXY_INSTALLATION_ID, PROXY_PRIVATE_KEY, PROXY_REPO_OWNER, PROXY_REPO_NAME, PROXY_BRANCH,
} = process.env;

// ==========================================================
// 🔑 ULTIMATIVE PRIVATE KEY VERARBEITUNG (Beibehalten)
// ==========================================================

const processKey = (key) => {
    if (!key) return null;
    let processedKey = key.trim();
    processedKey = processedKey.replace(/\r\n/g, '\n');
    if (!processedKey.includes('\n') && processedKey.includes('\\n')) {
        processedKey = processedKey.replace(/\\n/g, '\n');
    }
    const START_TAG = '-----BEGIN RSA PRIVATE KEY-----';
    const END_TAG = '-----END RSA PRIVATE KEY-----';
    const content = processedKey
        .replace(/-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----/g, '')
        .replace(/-----END ([A-Z0-9]+ )?PRIVATE KEY-----/g, '')
        .trim();
    return `${START_TAG}\n${content}\n${END_TAG}`;
};

const APP_KEY = processKey(APP_PRIVATE_KEY);
const PROXY_KEY = processKey(PROXY_PRIVATE_KEY);

// ==========================================================
// 🧭 REST DES SKRIPTS (Unverändert)
// ==========================================================

console.log("🔐 Starting PixelBeav Proxy...");
if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !APP_KEY || !BRANCH) {
  console.error("❌ Fehlende ENV-Variablen. Bitte prüfen Sie die notwendigen Keys.");
  process.exit(1);
}

let cachedToken = { token: null, expiresAt: 0 };
let cachedBackupToken = { token: null, expiresAt: 0 };

function makeJwt(privateKey, appId) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  return jwt.sign(payload, privateKey, { algorithm: "RS256" });
}

async function getInstallationToken() {
  const { token, expiresAt } = cachedToken;
  const now = Math.floor(Date.now() / 1000);
  if (token && expiresAt > now + 60) return token;

  console.log("🔄 Requesting new GitHub Installation Token (Haupt-App)...");
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${makeJwt(APP_KEY, APP_ID)}`, Accept: "application/vnd.github+json" }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token Error: ${res.status} ${JSON.stringify(data)}`);
  
  cachedToken = { token: data.token, expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000) };
  console.log("✅ Installation Token erfolgreich abgerufen.");
  return data.token;
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
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) { console.error(`❌ GitHub Error ${res.status}:`, data); throw new Error(`GitHubError ${res.status}: ${res.statusText}`); }
  console.log(`✅ GitHub OK (${res.status})`);
  return data;
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

app.get("/health", (_req, res) => res.json({ status: "ok", repo: REPO_NAME, branch: BRANCH }));
app.get("/debug/head-test", requireApiKey, async (_req, res) => {
  try {
    const data = await ghFetch(`git/refs/heads/${BRANCH}`);
    res.json({ head: data.object.sha });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/contents/", requireApiKey, async (_req, res) => {
  try { res.json(await ghFetch("contents")); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/contents/:path(*)", requireApiKey, async (req, res) => {
  const { path: filePath } = req.params;
  try {
    const data = await ghFetch(`contents/${encodeURIComponent(filePath)}`);
    if (Array.isArray(data)) console.log(`📁 Folder (${data.length} items)`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/contents/:path(*)", requireApiKey, async (req, res) => {
  const { path: filePath } = req.params;
  const { message, content, branch, sha } = req.body;
  if (!message || !content) return res.status(400).json({ error: "message and content required" });

  try {
    const contentEncoded = Buffer.from(content, 'utf8').toString('base64');
    const body = { message, content: contentEncoded, branch: branch || BRANCH };
    if (sha) body.sha = sha;
    
    const data = await ghFetch(`contents/${encodeURIComponent(filePath)}`, {
      method: "PUT", body: JSON.stringify(body)
    });
    console.log("✅ File written:", filePath);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/contents/:path(*)", (req, res, next) => {
  console.log("🔁 Redirecting DELETE → POST /delete");
  req.url = `/contents/${req.params.path}/delete`;
  req.method = "POST";
  app.handle(req, res, next);
});

app.post("/contents/:path(*)/delete", requireApiKey, async (req, res) => {
  const { path: filePath } = req.params;
  let { message, sha, branch } = req.body;
  branch = branch || BRANCH;

  try {
    if (!sha) {
      const meta = await ghFetch(`contents/${encodeURIComponent(filePath)}`);
      sha = meta.sha;
      console.log("✅ SHA automatisch gefunden.");
    }

    const body = { message: message || `Delete ${filePath}`, sha, branch };
    const data = await ghFetch(`contents/${encodeURIComponent(filePath)}`, {
      method: "DELETE", body: JSON.stringify(body)
    });
    console.log("✅ Datei via POST gelöscht:", filePath);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================================
// 🚀 Server Start
// ==========================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 PixelBeav Proxy läuft auf Port ${PORT}`));

// ================================================================
// 🧩 AUTO-BACKUP-SYSTEM (BEDINGT DURCH HASH-PRÜFUNG)
// ================================================================

async function getBackupInstallationToken() {
  const { token, expiresAt } = cachedBackupToken;
  const now = Math.floor(Date.now() / 1000);
  if (token && expiresAt > now + 60) return token; 
  
  console.log("🔄 [Proxy-Backup] Requesting new Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${PROXY_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${makeJwt(PROXY_KEY, PROXY_APP_ID)}`, Accept: "application/vnd.github+json" }
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

// Hilfsfunktion zum Abrufen des letzten gespeicherten Hash aus GitHub
async function getLatestRemoteHash(token) {
    const hashPath = 'backups/current_server_cjs_hash.txt';
    const url = `https://api.github.com/repos/${PROXY_REPO_OWNER}/${PROXY_REPO_NAME}/contents/${hashPath}`;

    try {
        // 1. Abrufen des Inhalts (Hash-Wert)
        const res = await fetch(url, {
            headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3.raw" }
        });
        if (res.status === 404) {
            console.log("ℹ️ [Proxy-Backup] Keine vorherige Hash-Datei gefunden (404).");
            return { hash: null, sha: null };
        }
        if (!res.ok) throw new Error(`Hash Fetch Error: ${res.status}`);
        const remoteHash = await res.text();

        // 2. Abrufen der Metadaten (SHA) für die spätere Aktualisierung
        const metaRes = await fetch(url, {
             headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" }
        });
        const metaData = await metaRes.json();
        
        return { hash: remoteHash.trim(), sha: metaData.sha };
        
    } catch (error) {
        console.warn("⚠️ [Proxy-Backup] Fehler beim Abrufen/Verarbeiten des Remote-Hash:", error.message);
        return { hash: null, sha: null }; 
    }
}

;(async () => {
  console.log("🧩 [Proxy-Backup] Initialisiere automatisches Backup-System ...");

  try {
    if (!PROXY_APP_ID || !PROXY_INSTALLATION_ID || !PROXY_KEY || !PROXY_REPO_OWNER || !PROXY_REPO_NAME) {
      console.error("❌ [Proxy-Backup] Fehlende Proxy-Variablen. Backup abgebrochen.");
      return;
    }

    // 1. Lokale Datei lesen und Hash berechnen
    const currentFilePath = path.join(process.cwd(), "server.cjs"); 
    const serverData = fs.readFileSync(currentFilePath, "utf-8");
    const currentFileHash = crypto.createHash('sha256').update(serverData, 'utf8').digest('hex');

    // 2. Token abrufen und Remote-Hash prüfen
    const token = await getBackupInstallationToken(); 
    const { hash: remoteHash, sha: remoteHashSha } = await getLatestRemoteHash(token);

    // 3. Bedingung: Wenn Hash gleich, Backup überspringen
    if (currentFileHash === remoteHash) {
        console.log(`✅ [Proxy-Backup] Inhalt hat sich NICHT geändert (${currentFileHash.substring(0, 10)}...). Backup übersprungen.`);
        return; 
    }

    console.log("🔄 [Proxy-Backup] Änderung im Dateiinhalt festgestellt. Backup wird erstellt...");

    // 4. Lokales Backup (wie gehabt, für maximale Sicherheit)
    const backupDir = path.join(process.cwd(), "backups");
    if (!fs.existsSync(backupDir)) { fs.mkdirSync(backupDir); }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").split("Z")[0];
    fs.writeFileSync(path.join(backupDir, `server_backup_${timestamp}.cjs`), serverData);
    console.log("💾 [Proxy-Backup] Lokale Sicherung erstellt.");

    // 5. Remote Backup (Erstellen der neuen zeitgestempelten Backup-Datei)
    const remoteBackupPath = `backups/server_backup_${timestamp}.cjs`;
    const contentEncoded = Buffer.from(serverData, "utf-8").toString("base64");
    
    const backupUrl = `https://api.github.com/repos/${PROXY_REPO_OWNER}/${PROXY_REPO_NAME}/contents/${remoteBackupPath}`;
    const backupBody = JSON.stringify({
      message: `🔄 Auto-Backup ${timestamp} (Hash: ${currentFileHash.substring(0, 10)})`,
      content: contentEncoded,
      branch: PROXY_BRANCH || "main",
    });

    const uploadRes = await fetch(backupUrl, {
      method: "PUT", // PUT erstellt die Datei, wenn sie nicht existiert
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: backupBody,
    });

    if (!uploadRes.ok) {
        const errorData = await uploadRes.json();
        throw new Error(`Backup Upload Error: ${uploadRes.status} ${JSON.stringify(errorData)}`); 
    }

    console.log("✅ [Proxy-Backup] Backup erfolgreich ins Proxy-Repo hochgeladen.");

    // 6. Hash-Datei aktualisieren (WICHTIG für den nächsten Lauf)
    const hashPath = 'backups/current_server_cjs_hash.txt';
    const hashUpdateUrl = `https://api.github.com/repos/${PROXY_REPO_OWNER}/${PROXY_REPO_NAME}/contents/${hashPath}`;
    const hashUpdateBody = JSON.stringify({
        message: `🤖 Update server.cjs hash to ${currentFileHash.substring(0, 10)}`,
        content: Buffer.from(currentFileHash, "utf-8").toString("base64"),
        branch: PROXY_BRANCH || "main",
        sha: remoteHashSha, // Für die Aktualisierung des bestehenden Hash-Files
    });

    const hashUpdateRes = await fetch(hashUpdateUrl, {
        method: remoteHashSha ? "PUT" : "POST", // PUT/POST basierend darauf, ob die Hash-Datei existiert
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: hashUpdateBody,
    });

    if (!hashUpdateRes.ok) {
        const errorData = await hashUpdateRes.json();
        throw new Error(`Hash Update Error: ${hashUpdateRes.status} ${JSON.stringify(errorData)}`); 
    }
    console.log("✅ [Proxy-Backup] Hash-Datei erfolgreich aktualisiert. Nächster Lauf wird übersprungen, falls keine Änderung.");

  } catch (error) {
    console.error("❌ [Proxy-Backup-Fehler]", error);
  }
})();
