const express = require("express");
const jwt = require("jsonwebtoken");
const fetch = (...a) => import("node-fetch").then(({default: f}) => f(...a));
require("dotenv").config();

const {
  APP_ID, INSTALLATION_ID, REPO_OWNER, REPO_NAME, BRANCH,
  GH_APP_PRIVATE_KEY, ACTIONS_API_KEY
} = process.env;

function makeJwt() {
  const now = Math.floor(Date.now()/1000);
  return jwt.sign({ iat: now-60, exp: now+9*60, iss: APP_ID }, GH_APP_PRIVATE_KEY, { algorithm: "RS256" });
}
async function getInstallationToken() {
  const res = await fetch(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${makeJwt()}`, Accept: "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error(`getInstallationToken: ${res.status} ${res.statusText}`);
  const { token } = await res.json();
  return token;
}
function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"];
  if (!ACTIONS_API_KEY || k !== ACTIONS_API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/contents/", requireApiKey, async (req, res) => {
  try {
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
    });
    const data = await gh.json();
    res.status(gh.status).json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put("/contents/:path", requireApiKey, async (req, res) => {
  try {
    const { message, content, branch, sha } = req.body || {};
    const token = await getInstallationToken();
    const gh = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(req.params.path)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, content, branch: branch || BRANCH, ...(sha ? { sha } : {}) })
    });
    const data = await gh.json();
    res.status(gh.status).json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`pixelbeav-proxy listening on :${PORT}`));
