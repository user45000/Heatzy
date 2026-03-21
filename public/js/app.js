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

  const dids = [d.did];
  const isV1s = [d.is_v1];

  return `
    <div class="device-card ${modeClass}" data-dids="${d.did}">
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

  const dids = devs.map(d => d.did);
  const isV1s = devs.map(d => d.is_v1);

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
    <div class="device-card ${modeClass}" data-dids="${devs.map(d => d.did).join(',')}">
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

// Encode JSON en base64 pour injection sure dans les attributs HTML
function b64(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}
function unb64(str) {
  return JSON.parse(decodeURIComponent(escape(atob(str))));
}

// Boutons de mode (partages entre single et group)
function renderModeButtons(dids, isV1s, activeMode, online) {
  const encoded = b64({ dids, isV1s });
  const modes = ['cft', 'eco', 'fro', 'stop'];
  return `
    <div class="mode-buttons">
      ${modes.map(m => `
        <button class="mode-btn ${activeMode === m ? 'active-' + m : ''}"
                data-action="mode" data-targets="${encoded}" data-mode="${m}"
                ${!online ? 'disabled' : ''}>
          ${MODE_LABELS[m]}
        </button>
      `).join('')}
    </div>
  `;
}

// Boutons extras (programme, verrou, boost)
function renderExtras(dids, timerOn, lockOn, online) {
  const encoded = b64({ dids });
  return `
    <div class="device-extras">
      <button class="extra-btn ${timerOn ? 'active' : ''}"
              data-action="timer" data-targets="${encoded}" data-enabled="${!timerOn}"
              ${!online ? 'disabled' : ''}>
        Programme ${timerOn ? 'ON' : 'OFF'}
      </button>
      <button class="extra-btn ${lockOn ? 'active' : ''}"
              data-action="lock" data-targets="${encoded}" data-enabled="${!lockOn}"
              ${!online ? 'disabled' : ''}>
        Verrou ${lockOn ? 'ON' : 'OFF'}
      </button>
      <button class="extra-btn"
              data-action="boost" data-targets="${encoded}" data-minutes="60"
              ${!online ? 'disabled' : ''}>
        Boost 1h
      </button>
      <button class="extra-btn"
              data-action="boost" data-targets="${encoded}" data-minutes="240"
              ${!online ? 'disabled' : ''}>
        Boost 4h
      </button>
      <button class="extra-btn"
              data-action="boost" data-targets="${encoded}" data-minutes="480"
              ${!online ? 'disabled' : ''}>
        Boost 8h
      </button>
    </div>
  `;
}

// --- Progress bar ---
function showProgress() {
  const bar = document.getElementById('progress-bar');
  bar.hidden = false;
  bar.classList.add('active');
}
function hideProgress() {
  const bar = document.getElementById('progress-bar');
  bar.classList.remove('active');
  // Flash to 100% then hide
  bar.querySelector('.progress-fill').style.width = '100%';
  setTimeout(() => {
    bar.hidden = true;
    bar.querySelector('.progress-fill').style.width = '0%';
  }, 300);
}

// --- Card busy state ---
function setCardBusy(dids, busy) {
  dids.forEach(did => {
    const card = document.querySelector(`.device-card[data-dids*="${did}"]`);
    if (!card) return;
    if (busy) {
      card.classList.add('is-busy');
      if (!card.querySelector('.busy-spinner')) {
        const sp = document.createElement('div');
        sp.className = 'busy-spinner';
        card.appendChild(sp);
      }
    } else {
      card.classList.remove('is-busy');
      const sp = card.querySelector('.busy-spinner');
      if (sp) sp.remove();
    }
  });
}

// Flash card on mode change
function flashCards(dids, mode) {
  dids.forEach(did => {
    const card = document.querySelector(`.device-card[data-dids*="${did}"]`);
    if (!card) return;
    card.classList.remove('flash-cft', 'flash-eco', 'flash-fro', 'flash-stop');
    void card.offsetWidth; // force reflow
    card.classList.add('flash-' + mode);
    setTimeout(() => card.classList.remove('flash-' + mode), 700);
  });
}

// --- Event delegation pour toutes les actions sur les cartes ---
document.getElementById('devices').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;

  const action = btn.dataset.action;
  const { dids } = unb64(btn.dataset.targets);
  const label = dids.length === 1 ? getDeviceName(dids[0]) : `${dids.length} appareils`;

  showProgress();
  setCardBusy(dids, true);

  try {
    if (action === 'mode') {
      const mode = btn.dataset.mode;
      for (const did of dids) {
        await api('POST', `devices/${did}/mode`, { mode });
      }
      dids.forEach(did => {
        if (deviceStatuses[did]) deviceStatuses[did].mode = mode;

      });
      renderDevices();
      flashCards(dids, mode);
      toast(`${label} → ${MODE_LABELS[mode]}`, 'success');

    } else if (action === 'timer') {
      const enabled = btn.dataset.enabled === 'true';
      for (const did of dids) {
        await api('POST', `devices/${did}/timer`, { enabled });
      }
      dids.forEach(did => {
        if (deviceStatuses[did]) deviceStatuses[did].timer_switch = enabled ? 1 : 0;

      });
      renderDevices();
      toast(`${label} — Programme ${enabled ? 'active' : 'desactive'}`, 'success');

    } else if (action === 'lock') {
      const enabled = btn.dataset.enabled === 'true';
      for (const did of dids) {
        await api('POST', `devices/${did}/lock`, { enabled });
      }
      dids.forEach(did => {
        if (deviceStatuses[did]) deviceStatuses[did].lock_switch = enabled ? 1 : 0;

      });
      renderDevices();
      toast(`${label} — Verrou ${enabled ? 'active' : 'desactive'}`, 'success');

    } else if (action === 'boost') {
      const minutes = parseInt(btn.dataset.minutes);
      for (const did of dids) {
        await api('POST', `devices/${did}/boost`, { minutes });
      }
      const dur = minutes >= 60 ? `${minutes / 60}h` : `${minutes}min`;
      dids.forEach(did => {
        if (deviceStatuses[did]) { deviceStatuses[did].derog_mode = 2; deviceStatuses[did].derog_time = minutes; }
      });
      renderDevices();
      toast(`${label} — Boost ${dur} active`, 'success');
    }

  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  } finally {
    hideProgress();
    setCardBusy(dids, false);
  }
});

// --- Programme global ON/OFF ---
document.getElementById('programme-on-btn').addEventListener('click', async () => {
  const btn = document.getElementById('programme-on-btn');
  btn.classList.add('is-busy');
  showProgress();
  try {
    const result = await api('POST', 'timer-all', { enabled: true });
    devices.forEach(d => {
      if (deviceStatuses[d.did]) deviceStatuses[d.did].timer_switch = 1;

    });
    renderDevices();
    toast(`Programme active — ${result.succeeded}/${result.total} appareils`, 'success');
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  } finally {
    btn.classList.remove('is-busy');
    hideProgress();
  }
});

document.getElementById('programme-off-btn').addEventListener('click', async () => {
  const btn = document.getElementById('programme-off-btn');
  btn.classList.add('is-busy');
  showProgress();
  try {
    const result = await api('POST', 'timer-all', { enabled: false });
    devices.forEach(d => {
      if (deviceStatuses[d.did]) deviceStatuses[d.did].timer_switch = 0;

    });
    renderDevices();
    toast(`Programme desactive — ${result.succeeded}/${result.total} appareils`, 'success');
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  } finally {
    btn.classList.remove('is-busy');
    hideProgress();
  }
});

// --- Quick mode all ---
document.querySelectorAll('.control-buttons .btn-mode').forEach(btn => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    btn.classList.add('is-busy');
    showProgress();
    try {
      const result = await api('POST', 'mode-all', { mode });
      devices.forEach(d => {
        if (deviceStatuses[d.did]) deviceStatuses[d.did].mode = mode;

      });
      renderDevices();
      const allDids = devices.map(d => d.did);
      flashCards(allDids, mode);
      if (result.failed > 0) {
        toast(`Tous en ${MODE_LABELS[mode]} — ${result.failed} echec(s)`, 'error');
      } else {
        toast(`Tous en ${MODE_LABELS[mode]}`, 'success');
      }
    } catch (err) {
      toast('Erreur: ' + err.message, 'error');
    } finally {
      btn.classList.remove('is-busy');
      hideProgress();
    }
  });
});

// Refresh silencieux
let refreshTimer;
function delayedRefresh(ms = 5000) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadDevices(), ms);
}

// --- Refresh ---
document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  showProgress();
  await loadDevices();
  btn.classList.remove('spinning');
  hideProgress();
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

// --- PWA : desactiver le service worker (cause des problemes de cache) ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(r => r.unregister());
  });
  // Vider les caches
  if (window.caches) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
}

// --- Init ---
checkAuth();
