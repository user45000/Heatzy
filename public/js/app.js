// Base path detection (/ en local, /heatzy/ sur VPS)
const BASE = document.querySelector('link[rel="manifest"]').href.replace('manifest.json', '');

const MODE_LABELS = {
  cft: 'Confort', eco: 'Eco', fro: 'Hors-gel', stop: 'Off',
  cft1: 'Confort -1', cft2: 'Confort -2'
};

let devices = [];
let deviceStatuses = {};

// --- API helpers ---
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(BASE + 'api/' + path, opts);
  const data = await res.json();

  if (res.status === 401) {
    showLogin();
    throw new Error('Session expiree');
  }
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

// --- Auth ---
async function checkAuth() {
  try {
    const { authenticated } = await api('GET', 'auth');
    if (authenticated) showDashboard();
    else showLogin();
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('dashboard-screen').hidden = true;
}

function showDashboard() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('dashboard-screen').hidden = false;
  loadDevices();
}

// Login form
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Connexion...';

  try {
    await api('POST', 'login', {
      username: document.getElementById('email').value,
      password: document.getElementById('password').value
    });
    showDashboard();
  } catch (err) {
    errEl.textContent = err.message || 'Identifiants incorrects';
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Se connecter';
  }
});

// Logout
document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('POST', 'logout');
  showLogin();
});

// --- Devices ---
async function loadDevices() {
  const loading = document.getElementById('loading');
  loading.hidden = false;

  try {
    devices = await api('GET', 'devices');
    const statuses = await Promise.allSettled(
      devices.map(d => api('GET', `devices/${d.did}/status`))
    );
    deviceStatuses = {};
    devices.forEach((d, i) => {
      deviceStatuses[d.did] = statuses[i].status === 'fulfilled' ? statuses[i].value : {};
    });
    renderDevices();
  } catch (err) {
    toast('Erreur chargement: ' + err.message, 'error');
  } finally {
    loading.hidden = true;
  }
}

// --- Grouping ---
function groupDevices(deviceList) {
  const groups = {};
  for (const d of deviceList) {
    // Grouper par le nom avant le dernier tiret/espace+chiffre, sinon nom complet
    const name = d.name || 'Sans nom';
    let groupName = name;

    // Essayer de trouver un prefixe de groupe
    // "Salon - Rad 1" → "Salon"
    // "Chambre Parents" → "Chambre Parents"
    // "SDB Haut" → "SDB Haut"
    const dashMatch = name.match(/^(.+?)\s*[-–]\s*.+$/);
    if (dashMatch) {
      groupName = dashMatch[1].trim();
    }

    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(d);
  }
  return groups;
}

function renderDevices() {
  const container = document.getElementById('devices');
  const groups = groupDevices(devices);
  const groupNames = Object.keys(groups).sort();
  const isSingleGroup = groupNames.length === devices.length; // Pas de vrai groupement

  if (isSingleGroup) {
    // Pas de groupes detectes, afficher une grille simple
    container.innerHTML = `
      <div class="device-grid">
        ${devices.map(d => renderDeviceCard(d)).join('')}
      </div>
    `;
  } else {
    container.innerHTML = groupNames.map(name => {
      const devs = groups[name];
      return `
        <div class="device-group">
          <div class="group-header">
            <span class="group-name">${escapeHtml(name)}</span>
            <span class="group-count">${devs.length}</span>
          </div>
          <div class="device-grid">
            ${devs.map(d => renderDeviceCard(d)).join('')}
          </div>
        </div>
      `;
    }).join('');
  }
}

function renderDeviceCard(d) {
  const status = deviceStatuses[d.did] || {};
  const mode = status.mode || 'stop';
  const derogMode = status.derog_mode || 0;
  const derogTime = status.derog_time || 0;
  const timerOn = status.timer_switch === 1;
  const lockOn = status.lock_switch === 1;

  let derogBadge = '';
  if (derogMode === 2) {
    derogBadge = `<div class="derog-badge derog-boost">Boost ${derogTime}min</div>`;
  }

  const modeClass = d.is_online ? `mode-${mode}` : 'mode-stop';
  const labelClass = d.is_online ? `label-${mode}` : 'label-offline';
  const labelText = d.is_online ? (MODE_LABELS[mode] || mode) : 'Hors ligne';

  const modes = ['cft', 'eco', 'fro', 'stop'];

  // Nom affiche = nom complet ou partie apres le tiret si groupe
  const displayName = d.name || 'Sans nom';

  return `
    <div class="device-card ${modeClass}" data-did="${d.did}">
      <div class="device-header">
        <div class="device-name">
          <span class="online-dot ${d.is_online ? '' : 'offline'}"></span>
          ${escapeHtml(displayName)}
        </div>
        <span class="device-mode-label ${labelClass}">${labelText}</span>
      </div>
      <div class="mode-buttons">
        ${modes.map(m => `
          <button class="mode-btn ${mode === m ? 'active-' + m : ''}"
                  onclick="setMode('${d.did}', '${m}', ${d.is_v1})"
                  ${!d.is_online ? 'disabled' : ''}>
            ${MODE_LABELS[m]}
          </button>
        `).join('')}
      </div>
      ${derogBadge}
      <div class="device-extras">
        <button class="extra-btn ${timerOn ? 'active' : ''}"
                onclick="toggleTimer('${d.did}', ${!timerOn})"
                ${!d.is_online ? 'disabled' : ''}>
          Programme ${timerOn ? 'ON' : 'OFF'}
        </button>
        <button class="extra-btn ${lockOn ? 'active' : ''}"
                onclick="toggleLock('${d.did}', ${!lockOn})"
                ${!d.is_online ? 'disabled' : ''}>
          Verrou ${lockOn ? 'ON' : 'OFF'}
        </button>
        <button class="extra-btn"
                onclick="boostDevice('${d.did}', 60)"
                ${!d.is_online ? 'disabled' : ''}>
          Boost 1h
        </button>
        <button class="extra-btn"
                onclick="boostDevice('${d.did}', 240)"
                ${!d.is_online ? 'disabled' : ''}>
          Boost 4h
        </button>
        <button class="extra-btn"
                onclick="boostDevice('${d.did}', 480)"
                ${!d.is_online ? 'disabled' : ''}>
          Boost 8h
        </button>
      </div>
    </div>
  `;
}

// --- Actions ---
async function setMode(did, mode, isV1) {
  try {
    await api('POST', `devices/${did}/mode`, { mode, is_v1: isV1 });
    toast(`${getDeviceName(did)} → ${MODE_LABELS[mode]}`, 'success');
    if (deviceStatuses[did]) deviceStatuses[did].mode = mode;
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.setMode = setMode;

async function toggleTimer(did, enabled) {
  try {
    await api('POST', `devices/${did}/timer`, { enabled });
    toast(`${getDeviceName(did)} — Programme ${enabled ? 'active' : 'desactive'}`, 'success');
    if (deviceStatuses[did]) deviceStatuses[did].timer_switch = enabled ? 1 : 0;
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.toggleTimer = toggleTimer;

async function toggleLock(did, enabled) {
  try {
    await api('POST', `devices/${did}/lock`, { enabled });
    toast(`${getDeviceName(did)} — Verrou ${enabled ? 'active' : 'desactive'}`, 'success');
    if (deviceStatuses[did]) deviceStatuses[did].lock_switch = enabled ? 1 : 0;
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.toggleLock = toggleLock;

async function boostDevice(did, minutes = 60) {
  try {
    await api('POST', `devices/${did}/boost`, { minutes });
    const label = minutes >= 60 ? `${minutes / 60}h` : `${minutes}min`;
    toast(`${getDeviceName(did)} — Boost ${label} active`, 'success');
    if (deviceStatuses[did]) { deviceStatuses[did].derog_mode = 2; deviceStatuses[did].derog_time = minutes; }
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.boostDevice = boostDevice;

// --- Programme global ON/OFF ---
document.getElementById('programme-on-btn').addEventListener('click', async () => {
  try {
    const result = await api('POST', 'timer-all', { enabled: true });
    toast(`Programme active — ${result.succeeded}/${result.total} appareils`, 'success');
    await loadDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
});

document.getElementById('programme-off-btn').addEventListener('click', async () => {
  try {
    const result = await api('POST', 'timer-all', { enabled: false });
    toast(`Programme desactive — ${result.succeeded}/${result.total} appareils`, 'success');
    await loadDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
});

// --- Quick mode all ---
document.querySelectorAll('.control-buttons .btn-mode').forEach(btn => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    try {
      const result = await api('POST', 'mode-all', { mode });
      toast(`Tous en ${MODE_LABELS[mode]} — ${result.succeeded}/${result.total}`, 'success');
      await loadDevices();
    } catch (err) {
      toast('Erreur: ' + err.message, 'error');
    }
  });
});

// --- Refresh ---
document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  await loadDevices();
  btn.classList.remove('spinning');
});

// --- Helpers ---
function getDeviceName(did) {
  const d = devices.find(d => d.did === did);
  return d ? d.name : did;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.hidden = true, 300);
  }, type === 'error' ? 5000 : 3000);
}

// --- PWA ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// --- Init ---
checkAuth();
