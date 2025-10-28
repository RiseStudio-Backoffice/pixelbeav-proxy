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

    // 🔑 NEUE LOGIK FÜR LOKALISIERTEN ZEITSTEMPEL (CET/CEST)
    const cetDate = new Date().toLocaleString("sv-SE", { 
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23', 
        timeZone: 'Europe/Berlin' // Festlegung der Mitteleuropäischen Zeit
    });
    // Konvertiert z.B. "2025-10-28 17:07:00" zu "2025-10-28_17-07-00"
    const timestamp = cetDate.replace(' ', '_').replace(/:/g, '-').replace(',', '');


    // 4. Lokales Backup (wie gehabt, für maximale Sicherheit)
    const backupDir = path.join(process.cwd(), "backups");
    if (!fs.existsSync(backupDir)) { fs.mkdirSync(backupDir); }
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
