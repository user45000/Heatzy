const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3002;
const BASE_PATH = process.env.BASE_PATH || '/';

const GIZWITS_API = 'https://euapi.gizwits.com/app';
const APP_ID = 'c70a66ff039d41b4a220e198b0fcc8b3';

app.use(express.json());
app.use(session({
  store: new FileStore({
    path: path.join(__dirname, 'sessions'),
    ttl: 365 * 24 * 60 * 60, // 1 an en secondes
    retries: 0,
    logFn: () => {}
  }),
  secret: process.env.SESSION_SECRET || 'heatzy-web-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 365 * 24 * 60 * 60 * 1000 } // 1 an
}));

app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// --- Requete Gizwits ---
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

// Envoyer une commande a un appareil (simple, 1 retry si erreur)
async function sendCommand(did, token, payload) {
  try {
    await gizwitsRequest('POST', `/control/${did}`, token, payload);
    return true;
  } catch (err) {
    // 1 retry apres 1s
    await sleep(1000);
    try {
      await gizwitsRequest('POST', `/control/${did}`, token, payload);
      return true;
    } catch (err2) {
      return false;
    }
  }
}

// Envoyer une commande a plusieurs appareils sequentiellement (300ms entre chaque)
async function sendToAll(devices, token, payloadFn) {
  let succeeded = 0;
  for (const d of devices) {
    const payload = payloadFn(d);
    const ok = await sendCommand(d.did, token, payload);
    if (ok) succeeded++;
    await sleep(300);
  }
  return { total: devices.length, succeeded, failed: devices.length - succeeded };
}

// Envoyer un mode a tous : commande atomique mode + timer_switch en un seul appel
async function sendModeToAll(devices, token, mode) {
  let succeeded = 0;
  for (const d of devices) {
    // Envoyer mode + desactiver programme en UNE seule commande (evite les race conditions)
    const ok = await sendCommand(d.did, token, { attrs: { mode, timer_switch: 0 } });
    if (ok) succeeded++;
    await sleep(400);
  }

  return { total: devices.length, succeeded, failed: devices.length - succeeded };
}

// Re-login automatique si le token Gizwits a expire
async function refreshTokenIfNeeded(req) {
  if (!req.session.credentials) return false;
  try {
    const result = await gizwitsRequest('POST', '/login', null, {
      username: req.session.credentials.username,
      password: req.session.credentials.password,
      lang: 'en'
    });
    req.session.token = result.token;
    req.session.expireAt = result.expire_at;
    return true;
  } catch (e) {
    return false;
  }
}

async function requireAuth(req, res, next) {
  if (!req.session.token) {
    // Tenter un re-login si on a les credentials
    if (req.session.credentials) {
      const ok = await refreshTokenIfNeeded(req);
      if (ok) return next();
    }
    return res.status(401).json({ error: 'Non authentifie' });
  }
  next();
}

// --- Routes ---

app.post(BASE_PATH + 'api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
    const result = await gizwitsRequest('POST', '/login', null, { username, password, lang: 'en' });
    req.session.token = result.token;
    req.session.expireAt = result.expire_at;
    req.session.credentials = { username, password };
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: 'Identifiants incorrects' });
  }
});

app.post(BASE_PATH + 'api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get(BASE_PATH + 'api/auth', (req, res) => {
  res.json({ authenticated: !!req.session.token });
});

// Lister les appareils
app.get(BASE_PATH + 'api/devices', requireAuth, async (req, res) => {
  try {
    const result = await gizwitsRequest('GET', '/bindings?limit=50&skip=0', req.session.token);
    const devices = (result.devices || []).map(d => ({
      did: d.did,
      name: d.dev_alias || d.product_name || 'Sans nom',
      product_key: d.product_key,
      mac: d.mac,
      is_online: d.is_online
    }));
    res.json(devices);
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur API' });
  }
});

// Statut d'un appareil
app.get(BASE_PATH + 'api/devices/:did/status', requireAuth, async (req, res) => {
  try {
    const result = await gizwitsRequest('GET', `/devdata/${req.params.did}/latest`, req.session.token);
    const attrs = result.attr || result.attrs || {};
    // Inclure le timestamp de mise a jour pour detecter les donnees obsoletes
    if (result.updated_at) attrs._updated_at = result.updated_at;
    res.json(attrs);
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur API' });
  }
});

// Debug raw
app.get(BASE_PATH + 'api/devices/:did/raw', requireAuth, async (req, res) => {
  try {
    const result = await gizwitsRequest('GET', `/devdata/${req.params.did}/latest`, req.session.token);
    res.json(result);
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur API', details: err });
  }
});

// Changer le mode d'un appareil
app.post(BASE_PATH + 'api/devices/:did/mode', requireAuth, async (req, res) => {
  try {
    const { mode } = req.body;
    // Commande atomique : mode + desactiver programme
    const ok = await sendCommand(req.params.did, req.session.token, { attrs: { mode, timer_switch: 0 } });
    res.json({ success: ok });
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur changement de mode' });
  }
});

// Mode global — envoi + verification + re-essai
app.post(BASE_PATH + 'api/mode-all', requireAuth, async (req, res) => {
  try {
    const { mode } = req.body;
    const bindings = await gizwitsRequest('GET', '/bindings?limit=50&skip=0', req.session.token);
    const devices = (bindings.devices || []).filter(d => d.is_online);
    const result = await sendModeToAll(devices, req.session.token, mode);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur mode global' });
  }
});

// Programme global
app.post(BASE_PATH + 'api/timer-all', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const bindings = await gizwitsRequest('GET', '/bindings?limit=50&skip=0', req.session.token);
    const devices = bindings.devices || [];
    const result = await sendToAll(devices, req.session.token, () => ({ attrs: { timer_switch: enabled ? 1 : 0 } }));
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur programme global' });
  }
});

// Planning individuel
app.post(BASE_PATH + 'api/devices/:did/timer', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const ok = await sendCommand(req.params.did, req.session.token, { attrs: { timer_switch: enabled ? 1 : 0 } });
    res.json({ success: ok });
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur planning' });
  }
});

// Verrouillage
app.post(BASE_PATH + 'api/devices/:did/lock', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const ok = await sendCommand(req.params.did, req.session.token, { attrs: { lock_switch: enabled ? 1 : 0 } });
    res.json({ success: ok });
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur verrouillage' });
  }
});

// Boost
app.post(BASE_PATH + 'api/devices/:did/boost', requireAuth, async (req, res) => {
  try {
    const { minutes } = req.body;
    let payload;
    if (minutes === 0) {
      payload = { attrs: { derog_mode: 0 } };
    } else {
      payload = { attrs: { derog_mode: 2, derog_time: minutes || 60 } };
    }
    const ok = await sendCommand(req.params.did, req.session.token, payload);
    res.json({ success: ok });
  } catch (err) {
    if (err.status === 401) {
      const ok = await refreshTokenIfNeeded(req);
      if (!ok) { req.session.destroy(); return res.status(401).json({ error: 'Session expiree' }); }
      return res.status(503).json({ error: 'Token renouvele, reessayez' });
    }
    res.status(500).json({ error: 'Erreur boost' });
  }
});

// SPA fallback
app.get(BASE_PATH + '{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Heatzy Web demarre sur le port ${PORT} (base: ${BASE_PATH})`);
});
