// Base path detection (/ en local, /heatzy/ sur VPS)
const BASE = document.querySelector('link[rel="manifest"]').href.replace('manifest.json', '');

const MODE_LABELS = {
  cft: 'Confort', eco: 'Éco', fro: 'Hors-gel', stop: 'Off',
  cft1: 'Confort -1', cft2: 'Confort -2'
};

const DEROG_LABELS = { 0: null, 1: 'Vacances', 2: 'Boost', 3: 'Présence' };

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
    throw new Error('Session expirée');
  }
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

// --- Auth ---
async function checkAuth() {
  try {
    const { authenticated } = await api('GET', 'auth');
    if (authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
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
    // Fetch all statuses in parallel
    const statuses = await Promise.allSettled(
      devices.map(d => api('GET', `devices/${d.did}/status`))
    );
    deviceStatuses = {};
    devices.forEach((d, i) => {
      deviceStatuses[d.did] = statuses[i].status === 'fulfilled' ? statuses[i].value : {};
    });
    renderDevices();
    updateVacationButton();
  } catch (err) {
    toast('Erreur chargement: ' + err.message, 'error');
  } finally {
    loading.hidden = true;
  }
}

function renderDevices() {
  const grid = document.getElementById('devices');
  grid.innerHTML = devices.map(d => {
    const status = deviceStatuses[d.did] || {};
    const mode = status.mode || 'stop';
    const derogMode = status.derog_mode || 0;
    const derogTime = status.derog_time || 0;
    const timerOn = status.timer_switch === 1;
    const lockOn = status.lock_switch === 1;

    let derogBadge = '';
    if (derogMode === 1) {
      derogBadge = `<div class="derog-badge derog-vacation">Vacances — ${derogTime}j restants</div>`;
    } else if (derogMode === 2) {
      derogBadge = `<div class="derog-badge derog-boost">Boost — ${derogTime}min</div>`;
    }

    const modes = ['cft', 'eco', 'fro', 'stop'];

    return `
      <div class="device-card" data-did="${d.did}" data-v1="${d.is_v1}">
        <div class="device-header">
          <div class="device-name">
            <span class="online-dot ${d.is_online ? '' : 'offline'}"></span>
            ${escapeHtml(d.name)}
          </div>
          <div class="device-status">${d.is_online ? MODE_LABELS[mode] || mode : 'Hors ligne'}</div>
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
            Planning ${timerOn ? 'ON' : 'OFF'}
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
  }).join('');
}

// --- Actions ---
async function setMode(did, mode, isV1) {
  try {
    await api('POST', `devices/${did}/mode`, { mode, is_v1: isV1 });
    toast(`${getDeviceName(did)} → ${MODE_LABELS[mode]}`, 'success');
    // Update local status
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
    toast(`${getDeviceName(did)} — Planning ${enabled ? 'activé' : 'désactivé'}`, 'success');
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
    toast(`${getDeviceName(did)} — Verrou ${enabled ? 'activé' : 'désactivé'}`, 'success');
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
    toast(`${getDeviceName(did)} — Boost ${label} activé`, 'success');
    if (deviceStatuses[did]) { deviceStatuses[did].derog_mode = 2; deviceStatuses[did].derog_time = minutes; }
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.boostDevice = boostDevice;

// --- Vacation ---
function updateVacationButton() {
  const anyVacation = devices.some(d => {
    const s = deviceStatuses[d.did];
    return s && s.derog_mode === 1;
  });
  document.getElementById('cancel-vacation-btn').hidden = !anyVacation;
}

document.getElementById('vacation-btn').addEventListener('click', () => {
  document.getElementById('vacation-modal').hidden = false;
});

document.getElementById('vacation-cancel').addEventListener('click', () => {
  document.getElementById('vacation-modal').hidden = true;
});

document.getElementById('vacation-confirm').addEventListener('click', async () => {
  const days = parseInt(document.getElementById('vacation-days').value) || 7;
  document.getElementById('vacation-modal').hidden = true;

  try {
    const result = await api('POST', 'vacation-all', { days });
    toast(`Mode vacances activé (${days}j) — ${result.succeeded}/${result.total} appareils`, 'success');
    await loadDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
});

document.getElementById('cancel-vacation-btn').addEventListener('click', async () => {
  try {
    const result = await api('POST', 'vacation-all', { days: 0 });
    toast(`Vacances annulées — ${result.succeeded}/${result.total} appareils`, 'success');
    await loadDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
});

// --- Quick mode all ---
document.querySelectorAll('.quick-buttons .btn-mode').forEach(btn => {
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
