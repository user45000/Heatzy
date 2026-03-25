const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3002;
const BASE_PATH = process.env.BASE_PATH || '/';

const GIZWITS_API = 'https://euapi.gizwits.com/app';
const APP_ID = 'c70a66ff039d41b4a220e198b0fcc8b3';

// ── Credentials Heatzy (côté serveur, jamais en session) ──────────────
const HEATZY_USER = 'francois.ribollet@gmail.com';
const HEATZY_PASS = 'cextun-cuPrev-8befzi';

// ── Token Gizwits partagé (géré côté serveur) ─────────────────────────
let _token = null;
let _tokenExpiry = 0;

async function getHeatzyToken(forceRefresh = false) {
  if (!forceRefresh && _token && Date.now() < _tokenExpiry - 60_000) {
    return _token;
  }
  const result = await gizwitsRequest('POST', '/login', null, {
    username: HEATZY_USER,
    password: HEATZY_PASS,
    lang: 'en'
  });
  _token = result.token;
  _tokenExpiry = result.expire_at * 1000;
  return _token;
}

// Initialiser le token au démarrage (silencieux)
getHeatzyToken().catch(e => console.warn('Heatzy init token failed:', e.error || e));

// ── Cache serveur des modes envoyés ───────────────────────────────────
const sentModes = {};

// ── Exclusions ────────────────────────────────────────────────────────
const EXCLUSIONS_FILE = path.join(__dirname, 'exclusions.json');
function loadExclusions() {
  try { return JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf8')); }
  catch { return []; }
}
function saveExclusions(list) {
  fs.writeFileSync(EXCLUSIONS_FILE, JSON.stringify(list), 'utf8');
}

// ── Session (côté utilisateur) ────────────────────────────────────────
app.use(express.json());
app.use(session({
  store: new FileStore({
    path: path.join(__dirname, 'sessions'),
    ttl: 10 * 365 * 24 * 60 * 60, // 10 ans
    retries: 0,
    logFn: () => {}
  }),
  secret: process.env.SESSION_SECRET || 'heatzy-web-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 10 * 365 * 24 * 60 * 60 * 1000 // 10 ans
  }
}));

app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// ── Requête Gizwits ───────────────────────────────────────────────────
function gizwitsRequest(method, endpoint, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(GIZWITS_API + endpoint);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'X-Gizwits-Application-Id': APP_ID,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    if (token) options.headers['X-Gizwits-User-token'] = token;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject({ status: res.statusCode, ...parsed });
          else resolve(parsed);
        } catch (e) {
          reject({ status: res.statusCode, error: 'Invalid JSON', raw: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject({ error: 'Timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Appel Gizwits avec retry automatique si token expiré
async function gizwitsCall(method, endpoint, body) {
  let token = await getHeatzyToken();
  try {
    return await gizwitsRequest(method, endpoint, token, body);
  } catch (err) {
    if (err.status === 401) {
      token = await getHeatzyToken(true); // force refresh
      return await gizwitsRequest(method, endpoint, token, body);
    }
    throw err;
  }
}

async function sendCommand(did, payload) {
  try {
    await gizwitsCall('POST', `/control/${did}`, payload);
    return true;
  } catch {
    await sleep(1000);
    try {
      await gizwitsCall('POST', `/control/${did}`, payload);
      return true;
    } catch {
      return false;
    }
  }
}

async function sendToAll(devices, payloadFn) {
  let succeeded = 0;
  for (const d of devices) {
    const ok = await sendCommand(d.did, payloadFn(d));
    if (ok) succeeded++;
    await sleep(300);
  }
  return { total: devices.length, succeeded, failed: devices.length - succeeded };
}

async function sendModeToAll(devices, mode) {
  let succeeded = 0;
  for (const d of devices) {
    const ok = await sendCommand(d.did, { attrs: { mode } });
    if (ok) succeeded++;
    sentModes[d.did] = { mode, ts: Date.now() };
    await sleep(300);
  }
  await sleep(2000);
  for (const d of devices) {
    await sendCommand(d.did, { attrs: { mode } });
    await sleep(300);
  }
  return { total: devices.length, succeeded, failed: devices.length - succeeded };
}

// ── Auth middleware ───────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Non authentifie' });
  }
  next();
}

// ── Routes auth ───────────────────────────────────────────────────────

// Login : vérification locale des credentials (pas d'appel API)
app.post(BASE_PATH + 'api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }
  if (username !== HEATZY_USER || password !== HEATZY_PASS) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  req.session.authenticated = true;
  res.json({ success: true });
});

app.post(BASE_PATH + 'api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get(BASE_PATH + 'api/auth', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// ── Routes appareils ──────────────────────────────────────────────────

app.get(BASE_PATH + 'api/devices', requireAuth, async (req, res) => {
  try {
    const result = await gizwitsCall('GET', '/bindings?limit=50&skip=0');
    const devices = (result.devices || []).map(d => ({
      did: d.did,
      name: d.dev_alias || d.product_name || 'Sans nom',
      product_key: d.product_key,
      mac: d.mac,
      is_online: d.is_online
    }));
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: 'Erreur API' });
  }
});

app.get(BASE_PATH + 'api/devices/:did/status', requireAuth, async (req, res) => {
  try {
    const result = await gizwitsCall('GET', `/devdata/${req.params.did}/latest`);
    const attrs = result.attr || result.attrs || {};
    if (result.updated_at) attrs._updated_at = result.updated_at;
    const sent = sentModes[req.params.did];
    if (sent && (Date.now() - sent.ts) < 5 * 60 * 1000) {
      if (attrs.mode !== sent.mode) { attrs.mode = sent.mode; attrs._overridden = true; }
    } else if (sent) {
      delete sentModes[req.params.did];
    }
    res.json(attrs);
  } catch (err) {
    res.status(500).json({ error: 'Erreur API' });
  }
});

app.get(BASE_PATH + 'api/devices/:did/raw', requireAuth, async (req, res) => {
  try {
    const result = await gizwitsCall('GET', `/devdata/${req.params.did}/latest`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Erreur API', details: err });
  }
});

app.post(BASE_PATH + 'api/devices/:did/mode', requireAuth, async (req, res) => {
  try {
    const { mode } = req.body;
    const ok = await sendCommand(req.params.did, { attrs: { mode } });
    if (mode === 'stop') {
      await sleep(1500);
      await sendCommand(req.params.did, { attrs: { mode } });
    }
    sentModes[req.params.did] = { mode, ts: Date.now() };
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: 'Erreur changement de mode' });
  }
});

app.get(BASE_PATH + 'api/exclusions', requireAuth, (req, res) => {
  res.json(loadExclusions());
});

app.post(BASE_PATH + 'api/exclusions', requireAuth, (req, res) => {
  const { excluded } = req.body;
  if (!Array.isArray(excluded)) return res.status(400).json({ error: 'excluded doit etre un tableau' });
  saveExclusions(excluded);
  res.json({ success: true, excluded });
});

app.post(BASE_PATH + 'api/mode-all', requireAuth, async (req, res) => {
  try {
    const { mode, force } = req.body;
    const bindings = await gizwitsCall('GET', '/bindings?limit=50&skip=0');
    let devices = (bindings.devices || []).filter(d => d.is_online);
    if (mode !== 'stop' && !force) {
      const excl = loadExclusions();
      devices = devices.filter(d => !excl.includes(d.did));
    }
    const result = await sendModeToAll(devices, mode);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Erreur mode global' });
  }
});

app.post(BASE_PATH + 'api/timer-all', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const bindings = await gizwitsCall('GET', '/bindings?limit=50&skip=0');
    let devices = bindings.devices || [];
    if (enabled) {
      const excl = loadExclusions();
      devices = devices.filter(d => !excl.includes(d.did));
    }
    const result = await sendToAll(devices, () => ({ attrs: { timer_switch: enabled ? 1 : 0 } }));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Erreur programme global' });
  }
});

app.post(BASE_PATH + 'api/devices/:did/timer', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const ok = await sendCommand(req.params.did, { attrs: { timer_switch: enabled ? 1 : 0 } });
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: 'Erreur planning' });
  }
});

app.post(BASE_PATH + 'api/devices/:did/lock', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const ok = await sendCommand(req.params.did, { attrs: { lock_switch: enabled ? 1 : 0 } });
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: 'Erreur verrouillage' });
  }
});

app.post(BASE_PATH + 'api/devices/:did/boost', requireAuth, async (req, res) => {
  try {
    const { minutes } = req.body;
    const payload = minutes === 0
      ? { attrs: { derog_mode: 0 } }
      : { attrs: { derog_mode: 2, derog_time: minutes || 60 } };
    const ok = await sendCommand(req.params.did, payload);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: 'Erreur boost' });
  }
});

// SPA fallback
app.get(BASE_PATH + '{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Heatzy Web démarré sur le port ${PORT} (base: ${BASE_PATH})`);
});
