/**
 * ==========================================================
 * 🌐 PixelBeav Proxy Server – server.cjs (FINAL & ROBUST)
 * Version: 1.8.5.S (Finaler Fix: Aggressive Trim & Robuste Key-Verarbeitung)
 * ==========================================================
 * Behebt den "secretOrPrivateKey" Fehler durch aggressive Entfernung von
 * Whitespace, was die Kompatibilität mit Render-Environment-Variablen sicherstellt.
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

// ⚙️ Environment Variablen
const {
  APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, BRANCH, APP_PRIVATE_KEY, API_KEY,
  PROXY_APP_ID, PROXY_INSTALLATION_ID, PROXY_PRIVATE_KEY, PROXY_REPO_OWNER, PROXY_REPO_NAME, PROXY_BRANCH,
} = process.env;


// ==========================================================
// 🔑 ROBUSTE PRIVATE KEY VERARBEITUNG (Finaler Fix)
// ==========================================================

/**
 * Verarbeitet den Private Key: Entfernt Whitespace und korrigiert ggf. Escaping.
 */
const processKey = (key) => {
    if (!key) return null;
    const trimmedKey = key.trim();
    
    // Fall 1: Der Key enthält bereits echten Zeilenumbruch (wie in Render)
    if (trimmedKey.includes('\n')) {
        return trimmedKey;
    }
    
    // Fall 2: Der Key enthält escapte Zeilenumbrüche (z.B. in .env-Datei oder als Single-Line-Secret)
    return trimmedKey.replace(/\\n/g, '\n');
};

const APP_KEY = processKey(APP_PRIVATE_KEY);
const PROXY_KEY = processKey(PROXY_PRIVATE_KEY);

// ==========================================================
// ... (Rest des Codes)
// ==========================================================

console.log("🔐 Starting PixelBeav Proxy...");
if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !APP_KEY || !BRANCH) {
  console.error("❌ Fehlende ENV-Variablen. Bitte prüfen Sie die notwendigen Keys.");
  process.exit(1);
}

// Globaler Cache für Haupt- und Backup-Tokens
let cachedToken = { token: null, expiresAt: 0 };
let cachedBackupToken = { token: null, expiresAt: 0 };

// ==========================================================
// 🧩 Zentralisierte Logik
// ==========================================================

/** Erstellt einen JWT für eine gegebene App ID und Private Key. */
function makeJwt(privateKey, appId) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  return jwt.sign(payload, privateKey, { algorithm: "RS256" });
}

/** Holt und cached den Installation Token für die Haupt-App. */
async function getInstallationToken() {
  const { token, expiresAt } = cachedToken;
  const now = Math.floor(Date.now() / 1000);
  if (token && expiresAt > now + 60) return token;

  console.log("🔄 Requesting new GitHub Installation Token (Haupt-App)...");
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${makeJwt(APP_KEY, APP_ID)}`, // Nutzt APP_KEY
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

/**
 * 🌐 Zentralisierte GitHub API Fetch-Funktion
 */
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
// 🌐 Express App & Middleware (unverändert)
// ==========================================================
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

// ==========================================================
// 🚀 REST Routen (unverändert)
// ==========================================================
app.get("/health", (_req, res) => res.json({ status: "ok", repo: REPO_NAME, branch: BRANCH }));

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
    res.json(await ghFetch("contents"));
  } catch (e) {
    console.error("❌ Root Listing:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/contents/:path(*)", requireApiKey, async (req, res) => {
  const { path: filePath } = req.params;
  try {
    const data = await ghFetch(`contents/${encodeURIComponent(filePath)}`);
    if (Array.isArray(data)) console.log(`📁 Folder (${data.length} items)`);
    res.json(data);
  } catch (e) {
    console.error("❌ GET:", e.message);
    res.status(500).json({ error: e.message });
  }
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
      method: "PUT",
      body: JSON.stringify(body)
    });
    console.log("✅ File written:", filePath);
    res.json(data);
  } catch (e) {
    console.error("❌ PUT:", e.message);
    res.status(500).json({ error: e.message });
  }
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
      method: "DELETE",
      body: JSON.stringify(body)
    });
    console.log("✅ Datei via POST gelöscht:", filePath);
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
app.listen(PORT, () => console.log(`🚀 PixelBeav Proxy läuft auf Port ${PORT}`));

// ================================================================
// 🧩 AUTO-BACKUP-SYSTEM 
// ================================================================

async function getBackupInstallationToken() {
  const { token, expiresAt } = cachedBackupToken;
  const now = Math.floor(Date.now() / 1000);
  if (token && expiresAt > now + 60) return token; 
  
  console.log("🔄 [Proxy-Backup] Requesting new Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${PROXY_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${makeJwt(PROXY_KEY, PROXY_APP_ID)}`, // Nutzt PROXY_KEY
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
    if (!PROXY_APP_ID || !PROXY_INSTALLATION_ID || !PROXY_KEY || !PROXY_REPO_OWNER || !PROXY_REPO_NAME) {
      console.error("❌ [Proxy-Backup] Fehlende Proxy-Variablen. Backup abgebrochen.");
      return;
    }

    // 1. Lokales Backup
    const backupDir = path.join(process.cwd(), "backups");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").split("Z")[0];
    const currentFilePath = path.join(process.cwd(), "server.cjs"); 
    const serverData = fs.readFileSync(currentFilePath, "utf-8");
    fs.writeFileSync(path.join(backupDir, `server_backup_${timestamp}.cjs`), serverData);
    console.log("💾 [Proxy-Backup] Lokale Sicherung erstellt.");

    // 2. Remote Backup
    const token = await getBackupInstallationToken(); 
    const remotePath = `backups/server_backup_${timestamp}.cjs`;
    const contentEncoded = Buffer.from(serverData, "utf-8").toString("base64");
    
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
