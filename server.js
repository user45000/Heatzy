const express = require('express');
const session = require('express-session');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3002;
const BASE_PATH = process.env.BASE_PATH || '/';

const GIZWITS_API = 'https://euapi.gizwits.com/app';
const APP_ID = 'c70a66ff039d41b4a220e198b0fcc8b3';

// Product keys pour détecter V1 vs V2+
const V1_PRODUCT_KEYS = ['9420ae048da545c88fc6274d204dd25f'];

// Modes V1 (raw commands)
const V1_MODES = {
  cft:  [1, 1, 0],
  eco:  [1, 1, 1],
  fro:  [1, 1, 2],
  stop: [1, 1, 3]
};

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'heatzy-web-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 jours
}));

// Servir les fichiers statiques
app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// Helper : requête vers l'API Gizwits
function gizwitsRequest(method, endpoint, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(GIZWITS_API + endpoint);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'X-Gizwits-Application-Id': APP_ID,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    if (token) {
      options.headers['X-Gizwits-User-token'] = token;
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject({ status: res.statusCode, ...parsed });
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject({ status: res.statusCode, error: 'Invalid JSON', raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Middleware : vérifier l'authentification
function requireAuth(req, res, next) {
  if (!req.session.token) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

// --- Routes API ---

// Login
app.post(BASE_PATH + 'api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    const result = await gizwitsRequest('POST', '/login', null, {
      username, password, lang: 'en'
    });
    req.session.token = result.token;
    req.session.expireAt = result.expire_at;
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: 'Identifiants incorrects' });
  }
});

// Logout
app.post(BASE_PATH + 'api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Auth status
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
      product_name: d.product_name,
      mac: d.mac,
      is_online: d.is_online,
      is_v1: V1_PRODUCT_KEYS.includes(d.product_key)
    }));
    res.json(devices);
  } catch (err) {
    if (err.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expirée' });
    }
    res.status(500).json({ error: 'Erreur API' });
  }
});

// Statut d'un appareil
app.get(BASE_PATH + 'api/devices/:did/status', requireAuth, async (req, res) => {
  try {
    const result = await gizwitsRequest('GET', `/devdata/${req.params.did}/latest`, req.session.token);
    res.json(result.attr || result.attrs || {});
  } catch (err) {
    if (err.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expirée' });
    }
    res.status(500).json({ error: 'Erreur API' });
  }
});

// Changer le mode d'un appareil
app.post(BASE_PATH + 'api/devices/:did/mode', requireAuth, async (req, res) => {
  try {
    const { mode, is_v1 } = req.body;
    let payload;
    if (is_v1 && V1_MODES[mode]) {
      payload = { raw: V1_MODES[mode] };
    } else {
      payload = { attrs: { mode } };
    }
    await gizwitsRequest('POST', `/control/${req.params.did}`, req.session.token, payload);
    res.json({ success: true });
  } catch (err) {
    if (err.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expirée' });
    }
    res.status(500).json({ error: 'Erreur lors du changement de mode' });
  }
});

// Programme global (tous les appareils)
// Programme global (tous les appareils)
app.post(BASE_PATH + 'api/timer-all', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const bindings = await gizwitsRequest('GET', '/bindings?limit=50&skip=0', req.session.token);
    const devices = bindings.devices || [];

    const results = await Promise.allSettled(
      devices.map(d => {
        const payload = { attrs: { timer_switch: enabled ? 1 : 0 } };
        return gizwitsRequest('POST', `/control/${d.did}`, req.session.token, payload);
      })
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    res.json({ success: true, total: devices.length, succeeded, failed });
  } catch (err) {
    if (err.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expirée' });
    }
    res.status(500).json({ error: 'Erreur programme global' });
  }
});

// Mode global (tous les appareils au même mode)
app.post(BASE_PATH + 'api/mode-all', requireAuth, async (req, res) => {
  try {
    const { mode } = req.body;
    const bindings = await gizwitsRequest('GET', '/bindings?limit=50&skip=0', req.session.token);
    const devices = bindings.devices || [];

    const results = await Promise.allSettled(
      devices.map(d => {
        let payload;
        if (V1_PRODUCT_KEYS.includes(d.product_key) && V1_MODES[mode]) {
          payload = { raw: V1_MODES[mode] };
        } else {
          payload = { attrs: { mode } };
        }
        return gizwitsRequest('POST', `/control/${d.did}`, req.session.token, payload);
      })
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    res.json({ success: true, total: devices.length, succeeded, failed });
  } catch (err) {
    if (err.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expirée' });
    }
    res.status(500).json({ error: 'Erreur mode global' });
  }
});

// Planning on/off
app.post(BASE_PATH + 'api/devices/:did/timer', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const payload = { attrs: { timer_switch: enabled ? 1 : 0 } };
    await gizwitsRequest('POST', `/control/${req.params.did}`, req.session.token, payload);
    res.json({ success: true });
  } catch (err) {
    if (err.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expirée' });
    }
    res.status(500).json({ error: 'Erreur planning' });
  }
});

// Verrouillage on/off
app.post(BASE_PATH + 'api/devices/:did/lock', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const payload = { attrs: { lock_switch: enabled ? 1 : 0 } };
    await gizwitsRequest('POST', `/control/${req.params.did}`, req.session.token, payload);
    res.json({ success: true });
  } catch (err) {
    if (err.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expirée' });
    }
    res.status(500).json({ error: 'Erreur verrouillage' });
  }
});

// Boost
app.post(BASE_PATH + 'api/devices/:did/boost', requireAuth, async (req, res) => {
  try {
    const { minutes } = req.body; // 0 = annuler
    let payload;
    if (minutes === 0) {
      payload = { attrs: { derog_mode: 0 } };
    } else {
      payload = { attrs: { derog_mode: 2, derog_time: minutes || 60 } };
    }
    await gizwitsRequest('POST', `/control/${req.params.did}`, req.session.token, payload);
    res.json({ success: true });
  } catch (err) {
    if (err.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expirée' });
    }
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
