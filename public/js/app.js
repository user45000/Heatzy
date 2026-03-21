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
// Regroupe les appareils par prefixe avant le tiret
// "Salon - Rad 1" et "Salon - Rad 2" → groupe "Salon" avec 2 appareils
// "Bureau" seul → carte individuelle "Bureau"
function buildCards() {
  const groups = {};
  const order = [];
  for (const d of devices) {
    const name = d.name || 'Sans nom';
    const dashMatch = name.match(/^(.+?)\s*[-–]\s*(.+)$/);
    const groupName = dashMatch ? dashMatch[1].trim() : name;

    if (!groups[groupName]) {
      groups[groupName] = [];
      order.push(groupName);
    }
    groups[groupName].push(d);
  }

  // Construire les cartes : groupe (>1 device) ou individuel
  return order.map(name => {
    const devs = groups[name];
    if (devs.length === 1) {
      return { type: 'single', name: devs[0].name, devices: devs };
    }
    return { type: 'group', name, devices: devs };
  });
}

function renderDevices() {
  const container = document.getElementById('devices');
  const cards = buildCards();

  container.innerHTML = `<div class="device-grid">
    ${cards.map(card => {
      if (card.type === 'single') {
        return renderSingleCard(card.devices[0]);
      }
      return renderGroupCard(card);
    }).join('')}
  </div>`;
}

// Carte individuelle
function renderSingleCard(d) {
  const status = deviceStatuses[d.did] || {};
  const mode = status.mode || 'stop';
  const derogMode = status.derog_mode || 0;
  const derogTime = status.derog_time || 0;
  const timerOn = status.timer_switch === 1;
  const lockOn = status.lock_switch === 1;
  const online = d.is_online;

  const modeClass = online ? `mode-${mode}` : 'mode-stop';
  const labelClass = online ? `label-${mode}` : 'label-offline';
  const labelText = online ? (MODE_LABELS[mode] || mode) : 'Hors ligne';

  let derogBadge = '';
  if (derogMode === 2) {
    derogBadge = `<div class="derog-badge derog-boost">Boost ${derogTime}min</div>`;
  }

  const dids = JSON.stringify([d.did]);
  const isV1s = JSON.stringify([d.is_v1]);

  return `
    <div class="device-card ${modeClass}">
      <div class="device-header">
        <div class="device-name">
          <span class="online-dot ${online ? '' : 'offline'}"></span>
          ${escapeHtml(d.name || 'Sans nom')}
        </div>
        <span class="device-mode-label ${labelClass}">${labelText}</span>
      </div>
      ${renderModeButtons(dids, isV1s, mode, online)}
      ${derogBadge}
      ${renderExtras(dids, timerOn, lockOn, online)}
    </div>
  `;
}

// Carte groupe (plusieurs appareils fusionnes)
function renderGroupCard(card) {
  const devs = card.devices;
  const statuses = devs.map(d => deviceStatuses[d.did] || {});

  // Mode dominant = le plus frequent parmi les appareils en ligne
  const onlineDevs = devs.filter(d => d.is_online);
  const anyOnline = onlineDevs.length > 0;

  const modeCounts = {};
  for (const d of onlineDevs) {
    const m = (deviceStatuses[d.did] || {}).mode || 'stop';
    modeCounts[m] = (modeCounts[m] || 0) + 1;
  }
  const dominantMode = Object.entries(modeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'stop';

  // Tous dans le meme mode ?
  const allSameMode = Object.keys(modeCounts).length <= 1;

  const modeClass = anyOnline ? `mode-${dominantMode}` : 'mode-stop';
  const labelClass = anyOnline ? `label-${dominantMode}` : 'label-offline';
  let labelText = anyOnline ? (MODE_LABELS[dominantMode] || dominantMode) : 'Hors ligne';
  if (anyOnline && !allSameMode) labelText = 'Mixte';

  // Timer : tous ON, tous OFF, ou mixte
  const timerCount = statuses.filter(s => s.timer_switch === 1).length;
  const timerOn = timerCount > statuses.length / 2;
  const lockCount = statuses.filter(s => s.lock_switch === 1).length;
  const lockOn = lockCount > statuses.length / 2;

  const dids = JSON.stringify(devs.map(d => d.did));
  const isV1s = JSON.stringify(devs.map(d => d.is_v1));

  // Sous-noms des appareils du groupe
  const subNames = devs.map(d => {
    const name = d.name || '';
    const dashMatch = name.match(/^.+?\s*[-–]\s*(.+)$/);
    const subName = dashMatch ? dashMatch[1].trim() : name;
    const s = deviceStatuses[d.did] || {};
    const m = s.mode || 'stop';
    const dotClass = d.is_online ? '' : 'offline';
    return `<span class="sub-device"><span class="online-dot-sm ${dotClass}"></span>${escapeHtml(subName)}</span>`;
  }).join('');

  return `
    <div class="device-card ${modeClass}">
      <div class="device-header">
        <div class="device-name">
          ${escapeHtml(card.name)}
          <span class="device-count">${devs.length}</span>
        </div>
        <span class="device-mode-label ${labelClass}">${labelText}</span>
      </div>
      <div class="sub-devices">${subNames}</div>
      ${renderModeButtons(dids, isV1s, allSameMode ? dominantMode : null, anyOnline)}
      ${renderExtras(dids, timerOn, lockOn, anyOnline)}
    </div>
  `;
}

// Boutons de mode (partages entre single et group)
function renderModeButtons(didsJson, isV1sJson, activeMode, online) {
  const modes = ['cft', 'eco', 'fro', 'stop'];
  return `
    <div class="mode-buttons">
      ${modes.map(m => `
        <button class="mode-btn ${activeMode === m ? 'active-' + m : ''}"
                onclick="setModeMulti('${encAttr(didsJson)}', '${encAttr(isV1sJson)}', '${m}')"
                ${!online ? 'disabled' : ''}>
          ${MODE_LABELS[m]}
        </button>
      `).join('')}
    </div>
  `;
}

// Boutons extras (programme, verrou, boost)
function renderExtras(didsJson, timerOn, lockOn, online) {
  return `
    <div class="device-extras">
      <button class="extra-btn ${timerOn ? 'active' : ''}"
              onclick="toggleTimerMulti('${encAttr(didsJson)}', ${!timerOn})"
              ${!online ? 'disabled' : ''}>
        Programme ${timerOn ? 'ON' : 'OFF'}
      </button>
      <button class="extra-btn ${lockOn ? 'active' : ''}"
              onclick="toggleLockMulti('${encAttr(didsJson)}', ${!lockOn})"
              ${!online ? 'disabled' : ''}>
        Verrou ${lockOn ? 'ON' : 'OFF'}
      </button>
      <button class="extra-btn"
              onclick="boostMulti('${encAttr(didsJson)}', 60)"
              ${!online ? 'disabled' : ''}>
        Boost 1h
      </button>
      <button class="extra-btn"
              onclick="boostMulti('${encAttr(didsJson)}', 240)"
              ${!online ? 'disabled' : ''}>
        Boost 4h
      </button>
      <button class="extra-btn"
              onclick="boostMulti('${encAttr(didsJson)}', 480)"
              ${!online ? 'disabled' : ''}>
        Boost 8h
      </button>
    </div>
  `;
}

// Encode JSON pour attributs HTML (evite les problemes de quotes)
function encAttr(jsonStr) {
  return jsonStr.replace(/'/g, '&#39;');
}

// --- Actions multi-appareils ---
async function setModeMulti(didsJson, isV1sJson, mode) {
  const dids = JSON.parse(didsJson);
  const isV1s = JSON.parse(isV1sJson);
  try {
    await Promise.all(dids.map((did, i) =>
      api('POST', `devices/${did}/mode`, { mode, is_v1: isV1s[i] })
    ));
    const name = dids.length === 1 ? getDeviceName(dids[0]) : `${dids.length} appareils`;
    toast(`${name} → ${MODE_LABELS[mode]}`, 'success');
    dids.forEach(did => {
      if (deviceStatuses[did]) deviceStatuses[did].mode = mode;
    });
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.setModeMulti = setModeMulti;

async function toggleTimerMulti(didsJson, enabled) {
  const dids = JSON.parse(didsJson);
  try {
    await Promise.all(dids.map(did =>
      api('POST', `devices/${did}/timer`, { enabled })
    ));
    const name = dids.length === 1 ? getDeviceName(dids[0]) : `${dids.length} appareils`;
    toast(`${name} — Programme ${enabled ? 'active' : 'desactive'}`, 'success');
    dids.forEach(did => {
      if (deviceStatuses[did]) deviceStatuses[did].timer_switch = enabled ? 1 : 0;
    });
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.toggleTimerMulti = toggleTimerMulti;

async function toggleLockMulti(didsJson, enabled) {
  const dids = JSON.parse(didsJson);
  try {
    await Promise.all(dids.map(did =>
      api('POST', `devices/${did}/lock`, { enabled })
    ));
    const name = dids.length === 1 ? getDeviceName(dids[0]) : `${dids.length} appareils`;
    toast(`${name} — Verrou ${enabled ? 'active' : 'desactive'}`, 'success');
    dids.forEach(did => {
      if (deviceStatuses[did]) deviceStatuses[did].lock_switch = enabled ? 1 : 0;
    });
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.toggleLockMulti = toggleLockMulti;

async function boostMulti(didsJson, minutes) {
  const dids = JSON.parse(didsJson);
  try {
    await Promise.all(dids.map(did =>
      api('POST', `devices/${did}/boost`, { minutes })
    ));
    const label = minutes >= 60 ? `${minutes / 60}h` : `${minutes}min`;
    const name = dids.length === 1 ? getDeviceName(dids[0]) : `${dids.length} appareils`;
    toast(`${name} — Boost ${label} active`, 'success');
    dids.forEach(did => {
      if (deviceStatuses[did]) { deviceStatuses[did].derog_mode = 2; deviceStatuses[did].derog_time = minutes; }
    });
    renderDevices();
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}
window.boostMulti = boostMulti;

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
