const express = require("express");
const jwt = require("jsonwebtoken");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
try { require("dotenv").config(); console.log("✅ Dotenv geladen."); } catch (e) { console.warn("⚠️ Dotenv nicht verfügbar oder Fehler:", e.message); }

console.log("🔐 SERVER START");
console.log("🔑 API_KEY:", process.env.API_KEY ?? "[NICHT GESETZT]");
const {
  APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, BRANCH,
  GH_APP_PRIVATE_KEY, API_KEY
} = process.env;

// Überprüfung auf BRANCH hinzufügen, auch wenn "main" der Standard ist
if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !GH_APP_PRIVATE_KEY || !BRANCH) {
  console.error("[boot] ❌ Fehlende ENV-Variablen! APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, GH_APP_PRIVATE_KEY und BRANCH sind erforderlich.");
  process.exit(1);
} else {
    console.log(`✅ Alle erforderlichen ENV-Variablen vorhanden. Branch: ${BRANCH}`);
}


// ==========================================================
// 1. TOKEN CACHING IMPLEMENTIERUNG
// ==========================================================
let cachedToken = {
    token: null,
    expiresAt: 0 // Unix-Timestamp in Sekunden
};

function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: APP_ID }, GH_APP_PRIVATE_KEY, {
    algorithm: "RS256"
  });
  console.log("✅ JWT für App-Authentifizierung erstellt.");
  return token;
}

async function getInstallationToken() {
  const now = Math.floor(Date.now() / 1000);
  // Prüfe, ob das gecachte Token noch mindestens 60 Sekunden gültig ist
  if (cachedToken.token && cachedToken.expiresAt > now + 60) {
      console.log("✅ Verwende gecachten Installation Token.");
      return cachedToken.token;
  }
  
  const url = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
  console.log("🚨 API Request URL: ", url);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${makeJwt()}`, Accept: "application/vnd.github+json" }
    });
    
    const responseData = await res.json();
    
    if (!res.ok) {
      const errorText = JSON.stringify(responseData);
      console.error(`❌ getInstallationToken-Fehler: ${res.status} ${res.statusText} :: ${errorText}`);
      throw new Error(`getInstallationToken: ${res.status} ${res.statusText} :: ${errorText}`);
    }
    
    const { token, expires_at } = responseData;
    // Die GitHub-API gibt 'expires_at' als ISO 8601 String zurück
    const expiresAt = Math.floor(new Date(expires_at).getTime() / 1000); 
    cachedToken = { token: token, expiresAt: expiresAt };
    console.log("✅ Installation Token erfolgreich abgerufen und gecacht. Läuft ab:", new Date(expiresAt * 1000).toISOString());
    return token;
  } catch (e) {
    console.error("❌ Fehler beim Abrufen des Installation Tokens:", e.message);
    throw e;
  }
}

function requireApiKey(req, res, next) {
  const clientKey = req.query.apiKey || req.headers["x-api-key"];
  console.log("🛂 Angegebener API-Key:", clientKey);
  console.log("🗝️ Erwarteter API-Key:", API_KEY ?? "[nicht gesetzt]");
  if (!API_KEY || clientKey !== API_KEY) {
    console.log("❌ API-Key stimmt NICHT überein! Zugriff verweigert.");
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


// ==========================================================
// HILFSFUNKTIONEN
// ==========================================================

// Funktion zur robusteren Fehlerbehandlung bei GitHub-Responses
async function handleGitHubResponse(gh) {
    const text = await gh.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        // Wenn kein JSON, den rohen Text als 'raw' zurückgeben
        data = { raw: text, message: `GitHub returned non-JSON data with status ${gh.status}` };
    }
    return { data, text };
}


// ==========================================================
// ENDPUNKTE
// ==========================================================

// Health check
app.get("/health", (_req, res) => {
    console.log("✅ Health Check erfolgreich.");
    res.status(200).send("ok");
});

// HEAD-Test gegen GitHub-Datei (Debugging-Endpunkt beibehalten)
app.get("/debug/head-test", requireApiKey, async (_req, res) => {
  console.log("▶️ Starte /debug/head-test");
  try {
    const token = await getInstallationToken();
    const ghUrl = "https://api.github.com/repos/RiseStudio-Backoffice/PixelBeav.App/contents/rules_gpt/repo-interaktion-rules.json";
    const gh = await fetch(ghUrl, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      }
    });
    console.log(`✅ GitHub HEAD response: ${gh.status} ${gh.statusText}`);
    res.status(gh.status).send(`GitHub HEAD response: ${gh.status}`);
  } catch (e) {
    console.error("❌ HEAD failed:", e.message);
    res.status(500).send("HEAD failed: " + e.message);
  }
});

// Root-Inhalt abfragen (Ordnerinhalte)
app.get("/contents/", requireApiKey, async (_req, res) => {
  console.log("▶️ Starte GET /contents/");
  try {
    const token = await getInstallationToken();
    // Branch explizit angeben
    const ghUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/?ref=${BRANCH}`;
    
    const gh = await fetch(ghUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
    });
    
    const { data, text } = await handleGitHubResponse(gh);
    
    if (!gh.ok) {
        console.error(`❌ GitHub GET /contents/ Fehler: ${gh.status} ${gh.statusText} :: ${text}`);
    } else {
        console.log(`✅ GitHub GET /contents/ erfolgreich: ${gh.status}`);
    }
    res.status(gh.status).json(data);
  } catch (e) {
    console.error("❌ GET /contents/ Fehler:", e.message);
    res.status(500).json({ error: String(e) });
  }
});


// GET mit verschachteltem Pfad
// 2. RAW-Content-Support durch Query-Parameter 'raw' (z.B. ?raw=true)
app.get("/contents/*", requireApiKey, async (req, res) => {
  const path = req.params[0];
  const { raw } = req.query; // Query-Parameter für RAW-Modus
  console.log("▶️ Starte GET /contents/*");
  console.log("📁 Zielpfad (GET):", path, raw ? "(RAW-Format)" : "(JSON-Format/Metadaten)");
  
  try {
    const token = await getInstallationToken();
    // Branch explizit angeben
    const ghUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`;
    
    // Setze den Accept-Header basierend auf dem 'raw' Query-Parameter
    const acceptHeader = raw 
      ? "application/vnd.github.v3.raw" 
      : "application/vnd.github+json";

    const gh = await fetch(ghUrl, {
      headers: { 
          Authorization: `Bearer ${token}`, 
          Accept: acceptHeader,
          'User-Agent': 'PixelBeav-Proxy' // User-Agent für GitHub-Best-Practice
      }
    });
    
    if (raw) {
        // Bei RAW-Anfragen den Text direkt senden
        const rawContent = await gh.text();
        if (!gh.ok) {
             console.error(`❌ GitHub GET /contents/${path} Fehler (RAW): ${gh.status} ${gh.statusText}`);
             // Bei RAW-Fehlern oft nur der reine Fehlermessage-Text von GitHub
             return res.status(gh.status).send(rawContent || gh.statusText);
        }
        console.log(`✅ GitHub GET /contents/${path} erfolgreich (RAW): ${gh.status}`);
        res.status(gh.status).send(rawContent);
        return;
    }

    // Standard-JSON-Response (Metadaten + Base64)
    const { data, text } = await handleGitHubResponse(gh);
    
    if (!gh.ok) {
        console.error(`❌ GitHub GET /contents/${path} Fehler: ${gh.status} ${gh.statusText} :: ${text}`);
    } else {
        console.log(`✅ GitHub GET /contents/${path} erfolgreich: ${gh.status}`);
    }
    res.status(gh.status).json(data);
    
  } catch (e) {
    console.error(`❌ GET /contents/${path} Fehler:`, e.message);
    res.status(500).json({ error: String(e) });
  }
});


// PUT mit verschachteltem Pfad (Erstellen/Überschreiben)
app.put("/contents/*", requireApiKey, async (req, res) => {
  const targetPath = req.params[0];
  console.log("▶️ Starte PUT /contents/* (Create/Update)");
  console.log("📥 Zielpfad (PUT):", targetPath);
  
  try {
    // 3. Entfernung der Pfad-Prüfung, um maximale Flexibilität zu gewährleisten
    // const allowedWritePaths = ["rules_gpt/", "README.md", "src/", "docs/"];
    // if (!allowedWritePaths.some(prefix => targetPath.startsWith(prefix))) {
    //   console.error(`❌ Schreibzugriff verweigert für Pfad: ${targetPath}`);
    //   return res.status(403).json({ error: `Write access denied for path: ${targetPath}` });
    // }
    // console.log("✅ Schreibzugriff für Pfad erlaubt (Pfad-Prüfung entfernt).");

    const { message, content, branch, sha } = req.body || {};
    if (!message || !content) {
        console.error("❌ Fehlende body-Parameter: 'message' oder 'content'.");
        return res.status(400).json({ error: "Missing required body parameters (message, content)" });
    }
    
    const token = await getInstallationToken();
    const ghUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(targetPath)}`;
    const targetBranch = branch || BRANCH;

    const gh = await fetch(ghUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      },
      body: JSON.stringify({
        message,
        content,
        branch: targetBranch,
        ...(sha ? { sha } : {})
      })
    });

    const { data, text } = await handleGitHubResponse(gh);

    if (!gh.ok) {
        console.error(`❌ GitHub PUT /contents/${targetPath} Fehler: ${gh.status} ${gh.statusText} :: ${text}`);
    } else {
        console.log(`✅ GitHub PUT /contents/${targetPath} erfolgreich: ${gh.status}. Commit-Branch: ${targetBranch}`);
    }

    res.status(gh.status).json(data);
  } catch (e) {
    console.error(`❌ PUT /contents/${targetPath} Fehler:`, e.message);
    res.status(500).json({ error: String(e) });
  }
});


// DELETE mit verschachteltem Pfad
app.delete("/contents/*", requireApiKey, async (req, res) => {
  const targetPath = req.params[0];
  console.log("▶️ Starte DELETE /contents/*");
  console.log("🗑️ Löschen von:", targetPath);
  try {
    const { message, sha, branch } = req.body || {};
    if (!message || !sha) {
        console.error("❌ Fehlende body-Parameter: 'message' oder 'sha' (SHA der Datei ist zum Löschen erforderlich).");
        return res.status(400).json({ error: "Missing required body parameters (message, sha)" });
    }

    const token = await getInstallationToken();
    const ghUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(targetPath)}`;
    const targetBranch = branch || BRANCH;

    const gh = await fetch(ghUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, sha, branch: targetBranch })
    });

    const { data, text } = await handleGitHubResponse(gh);
    
    if (!gh.ok) {
        console.error(`❌ GitHub DELETE /contents/${targetPath} Fehler: ${gh.status} ${gh.statusText} :: ${text}`);
    } else {
        console.log(`✅ GitHub DELETE /contents/${targetPath} erfolgreich: ${gh.status}. Commit-Branch: ${targetBranch}`);
    }
    res.status(gh.status).json(data);
  } catch (e) {
    console.error(`❌ DELETE /contents/${targetPath} Fehler:`, e.message);
    res.status(500).json({ error: String(e) });
  }
});

// POST-Fallback zum Löschen
// HINWEIS: Beibehalten für die Kompatibilität, aber DELETE ist präferiert
app.post("/contents/*/delete", requireApiKey, async (req, res) => {
  const targetPath = req.params[0];
  console.log("▶️ Starte POST /contents/*/delete (DELETE Fallback)");
  console.log("🗑️ Löschen von:", targetPath);
  try {
    const { message, sha, branch } = req.body || {};
     if (!message || !sha) {
        console.error("❌ Fehlende body-Parameter: 'message' oder 'sha'.");
        return res.status(400).json({ error: "Missing required body parameters (message, sha)" });
    }

    const token = await getInstallationToken();
    const ghUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(targetPath)}`;
    const targetBranch = branch || BRANCH;

    const gh = await fetch(ghUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, sha, branch: targetBranch })
    });
    
    const { data, text } = await handleGitHubResponse(gh);
    
    if (!gh.ok) {
        console.error(`❌ GitHub DELETE (Fallback) /contents/${targetPath} Fehler: ${gh.status} ${gh.statusText} :: ${text}`);
    } else {
        console.log(`✅ GitHub DELETE (Fallback) /contents/${targetPath} erfolgreich: ${gh.status}. Commit-Branch: ${targetBranch}`);
    }
    res.status(gh.status).json(data);
  } catch (e) {
    console.error(`❌ POST /contents/*/delete Fehler:`, e.message);
    res.status(500).json({ error: String(e) });
  }
});


// ==========================================================
// 4. /api/applyRules ENDPUNKT ENTFERNT/INTEGRIERT
// Dessen Funktionalität (RAW-Content-Abruf) wurde in 
// app.get("/contents/*") über den Query-Parameter ?raw=true integriert.
// ==========================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 pixelbeav-proxy listening on :${PORT}`);
  console.log("✅ Server gestartet.");
});
