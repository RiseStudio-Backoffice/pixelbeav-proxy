/**
 * ==========================================================
 * 🌐 PixelBeav Proxy Server – server.cjs (FINAL SLIM & DEBUGGED)
 * Version: 1.8.3.S (Alle Fehler behoben & Debug-Punkt)
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

// ⚙️ Environment Variablen & Private Key Fix
const {
  APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, BRANCH, APP_PRIVATE_KEY, API_KEY,
  PROXY_APP_ID, PROXY_INSTALLATION_ID, PROXY_PRIVATE_KEY, PROXY_REPO_OWNER, PROXY_REPO_NAME, PROXY_BRANCH,
} = process.env;

// DIESER FIX IST KRITISCH für den secretOrPrivateKey Fehler
const PRIMARY_PRIVATE_KEY_FIXED = APP_PRIVATE_KEY ? APP_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
const PROXY_PRIVATE_KEY_FIXED = PROXY_PRIVATE_KEY ? PROXY_PRIVATE_KEY.replace(/\\n/g, '\n') : null;

console.log("🔐 Starting PixelBeav Proxy...");
if (!APP_ID || !INSTALLATION_ID || !REPO_OWNER || !REPO_NAME || !PRIMARY_PRIVATE_KEY_FIXED || !BRANCH) {
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
  // DEBUG PUNKT: Zeigt, ob der Key korrekt mit Zeilenumbrüchen verarbeitet wurde.
  if (appId === PROXY_APP_ID) {
      console.log(`[Proxy-Backup-Debug] Key-Anfang: ${privateKey.substring(0, 30)}...`); 
      // Der Key MUSS mit '-----BEGIN' beginnen und einen echten Zeilenumbruch enthalten.
      if (!privateKey.includes('\n') || !privateKey.startsWith('-----BEGIN')) {
          console.error("❌ [Proxy-Backup-Fehler] Korrigierter Private Key ist ungültig (keine Zeilenumbrüche/Start-Header).");
      }
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  return jwt.sign(payload, privateKey, { algorithm: "RS256" });
}

/** Holt und cached den Installation Token für die Haupt-App. */
async function getInstallationToken() {
  const { token, expiresAt } = cachedToken;
  const now = Math.floor(Date.now() / 1000);
  if (token && expiresAt > now + 60) return token;

  console.log("🔄 Requesting new GitHub Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
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

// ... (Rest des zentralen ghFetch und der Express-Routen, unverändert zur letzten Slim-Version)

// ==========================================================
// 🌐 Express App & Middleware (wie zuvor)
// ...
// ==========================================================

// ==========================================================
// 🚀 Server Start (wie zuvor)
// ...
// ==========================================================

// ================================================================
// 🧩 AUTO-BACKUP-SYSTEM (Teil mit Token-Abruf)
// ================================================================

async function getBackupInstallationToken() {
  const { token, expiresAt } = cachedBackupToken;
  const now = Math.floor(Date.now() / 1000);
  if (token && expiresAt > now + 60) return token; 
  
  console.log("🔄 [Proxy-Backup] Requesting new Installation Token...");
  const res = await fetch(`https://api.github.com/app/installations/${PROXY_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      // WICHTIG: Hier muss PROXY_PRIVATE_KEY_FIXED verwendet werden
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

// ... (Rest des IIFE Backup-Systems, wie zuvor)
