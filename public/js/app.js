const BASE = document.querySelector('link[rel="manifest"]').href.replace('manifest.json', '');
const MODE_LABELS = { cft:'Confort', eco:'Nuit', fro:'Hors-gel', stop:'Off' };
const MODE_EMOJI = { cft:'🔥', eco:'🌙', fro:'❄️', stop:'⭕' };

let devices = [], deviceStatuses = {};

async function api(method, path, body) {
  const opts = { method, headers:{'Content-Type':'application/json'} };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + 'api/' + path, opts);
  const data = await res.json();
  if (res.status === 401) { showLogin(); throw new Error('Session expiree'); }
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

// Auth
async function checkAuth() {
  try { const { authenticated } = await api('GET','auth'); authenticated ? showDashboard() : showLogin(); }
  catch { showLogin(); }
}
const SIMPLE_MODE_KEY = 'heatzy_simple_mode';
function isSimpleMode() { return localStorage.getItem(SIMPLE_MODE_KEY) !== 'advanced'; }
function setSimpleMode(simple) { localStorage.setItem(SIMPLE_MODE_KEY, simple ? 'simple' : 'advanced'); }

function hideAllScreens() {
  document.getElementById('login-screen').hidden=true;
  document.getElementById('dashboard-screen').hidden=true;
  document.getElementById('simple-screen').hidden=true;
}
function showLogin() { hideAllScreens(); document.getElementById('login-screen').hidden=false; }
function showDashboard() {
  hideAllScreens();
  if (isSimpleMode()) {
    document.getElementById('simple-screen').hidden=false;
    loadDevicesSimple();
  } else {
    document.getElementById('dashboard-screen').hidden=false;
    loadDevices();
  }
}
function switchToAdvanced() { setSimpleMode(false); showDashboard(); }
function switchToSimple() { setSimpleMode(true); showDashboard(); }

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn'), err = document.getElementById('login-error');
  err.hidden=true; btn.disabled=true; btn.textContent='Connexion...';
  try { await api('POST','login',{ username:document.getElementById('email').value, password:document.getElementById('password').value }); showDashboard(); }
  catch(e) { err.textContent=e.message||'Identifiants incorrects'; err.hidden=false; }
  finally { btn.disabled=false; btn.textContent='Se connecter'; }
});
document.getElementById('logout-btn').addEventListener('click', async()=>{ await api('POST','logout'); showLogin(); });

// Devices — lecture sequentielle pour eviter les reponses obsoletes de l'API
async function loadDevices() {
  document.getElementById('loading').hidden=false;
  try {
    devices = await api('GET','devices');
    deviceStatuses = {};
    // Lecture sequentielle avec 200ms entre chaque (l'API retourne des donnees obsoletes en parallele)
    for (const d of devices) {
      try {
        deviceStatuses[d.did] = await api('GET',`devices/${d.did}/status`);
      } catch(e) {
        deviceStatuses[d.did] = {};
      }
      await new Promise(r=>setTimeout(r,200));
    }
    render();
    updateOfflineAlert();
    updateLastRefresh();
  } catch(e) { toast('Erreur: '+e.message,'error'); }
  finally { document.getElementById('loading').hidden=true; }
}

// Grouping & Rendering
function buildCards() {
  const groups={}, order=[];
  for (const d of devices) {
    const name=d.name||'Sans nom', m=name.match(/^(.+?)\s*[-–]\s*(.+)$/), g=m?m[1].trim():name;
    if (!groups[g]) { groups[g]=[]; order.push(g); }
    groups[g].push(d);
  }
  return order.map(n => groups[n].length===1 ? {type:'single',name:groups[n][0].name,devices:groups[n]} : {type:'group',name:n,devices:groups[n]});
}

function render() {
  const cards = buildCards();
  document.getElementById('devices').innerHTML = `<div class="device-grid">${cards.map(c => c.type==='single' ? singleCard(c.devices[0]) : groupCard(c)).join('')}</div>`;
}

function singleCard(d) {
  const s=deviceStatuses[d.did]||{}, mode=s.mode||'stop', on=d.is_online;
  const timerOn=s.timer_switch===1, lockOn=s.lock_switch===1;
  const mc=on?`m-${mode}`:'m-stop', bc=on?`badge-${mode}`:'badge-offline';
  const label=on?`${MODE_EMOJI[mode]||''} ${MODE_LABELS[mode]||mode}`:'Hors ligne';
  const boosting = s.derog_mode===2;
  const derog = boosting ? `<div class="derog">⚡ Boost ${s.derog_time>=60?Math.round(s.derog_time/60)+'h':s.derog_time+'min'}</div>` : '';
  const enc=b64({dids:[d.did]});
  return `<div class="card ${mc}" data-dids="${d.did}">
    <div class="card-head">
      <div class="card-name"><span class="dot ${on?'':'off'}"></span>${esc(d.name||'Sans nom')}</div>
      <span class="badge ${bc}">${label}</span>
    </div>
    ${modeButtons(enc,mode,on)}
    ${derog}
    ${extras(enc,timerOn,lockOn,on,boosting)}
  </div>`;
}

function groupCard(card) {
  const devs=card.devices, sts=devs.map(d=>deviceStatuses[d.did]||{});
  const onDevs=devs.filter(d=>d.is_online), anyOn=onDevs.length>0;
  const mc={}; onDevs.forEach(d=>{const m=(deviceStatuses[d.did]||{}).mode||'stop';mc[m]=(mc[m]||0)+1;});
  const dom=Object.entries(mc).sort((a,b)=>b[1]-a[1])[0]?.[0]||'stop';
  const same=Object.keys(mc).length<=1;
  const mClass=anyOn?`m-${dom}`:'m-stop';
  let bc, label;
  if (!anyOn) { bc='badge-offline'; label='Hors ligne'; }
  else if (!same) { bc='badge-mixed'; label='⚠️ Mixte'; }
  else { bc=`badge-${dom}`; label=`${MODE_EMOJI[dom]||''} ${MODE_LABELS[dom]||dom}`; }
  const timerOn=sts.filter(s=>s.timer_switch===1).length>sts.length/2;
  const lockOn=sts.filter(s=>s.lock_switch===1).length>sts.length/2;
  const boosting=sts.some(s=>s.derog_mode===2);
  const enc=b64({dids:devs.map(d=>d.did)});
  const subs=devs.map(d=>{
    const nm=d.name||'',m2=nm.match(/^.+?\s*[-–]\s*(.+)$/),sub=m2?m2[1].trim():nm;
    return `<span class="sub-item"><span class="dot-sm ${d.is_online?'':'off'}"></span>${esc(sub)}</span>`;
  }).join('');
  return `<div class="card ${mClass}" data-dids="${devs.map(d=>d.did).join(',')}">
    <div class="card-head">
      <div class="card-name">${esc(card.name)} <span class="card-count">${devs.length}</span></div>
      <span class="badge ${bc}">${label}</span>
    </div>
    <div class="sub-list">${subs}</div>
    ${modeButtons(enc,same?dom:null,anyOn)}
    ${extras(enc,timerOn,lockOn,anyOn,boosting)}
  </div>`;
}

function b64(o){return btoa(unescape(encodeURIComponent(JSON.stringify(o))))}
function unb64(s){return JSON.parse(decodeURIComponent(escape(atob(s))))}

function modeButtons(enc, active, on) {
  return `<div class="modes">${['cft','eco','fro','stop'].map(m=>
    `<button class="m-btn ${active===m?'on-'+m:''}" data-action="mode" data-targets="${enc}" data-mode="${m}" ${!on?'disabled':''}>${MODE_EMOJI[m]}</button>`
  ).join('')}</div>`;
}

function extras(enc, timerOn, lockOn, on, boosting) {
  const boostBtn = boosting
    ? `<button class="x-btn on" data-action="boost-cancel" data-targets="${enc}" ${!on?'disabled':''}>⚡ Annuler</button>`
    : `<button class="x-btn" data-action="boost-pick" data-targets="${enc}" ${!on?'disabled':''}>⚡ Boost</button>`;
  return `<div class="extras">
    <button class="x-btn ${timerOn?'on':''}" data-action="timer" data-targets="${enc}" data-enabled="${!timerOn}" ${!on?'disabled':''}>📅 ${timerOn?'ON':'OFF'}</button>
    <button class="x-btn ${lockOn?'on':''}" data-action="lock" data-targets="${enc}" data-enabled="${!lockOn}" ${!on?'disabled':''}>🔒 ${lockOn?'ON':'OFF'}</button>
    ${boostBtn}
  </div>`;
}

// Progress
function showProgress(){const b=document.getElementById('progress-bar');b.hidden=false;b.classList.add('active')}
function hideProgress(){const b=document.getElementById('progress-bar');b.classList.remove('active');b.querySelector('.progress-fill').style.width='100%';setTimeout(()=>{b.hidden=true;b.querySelector('.progress-fill').style.width='0%'},300)}

function setCardBusy(dids,busy){
  dids.forEach(did=>{
    const c=document.querySelector(`.card[data-dids*="${did}"]`);if(!c)return;
    if(busy){c.classList.add('is-busy');if(!c.querySelector('.busy-spinner')){const s=document.createElement('div');s.className='busy-spinner';c.appendChild(s)}}
    else{c.classList.remove('is-busy');const s=c.querySelector('.busy-spinner');if(s)s.remove()}
  });
}
function flashCards(dids,mode){
  dids.forEach(did=>{
    const c=document.querySelector(`.card[data-dids*="${did}"]`);if(!c)return;
    c.classList.remove('flash-cft','flash-eco','flash-fro','flash-stop');void c.offsetWidth;
    c.classList.add('flash-'+mode);setTimeout(()=>c.classList.remove('flash-'+mode),600);
  });
}

// Event delegation
document.getElementById('devices').addEventListener('click', async(e)=>{
  const btn=e.target.closest('[data-action]');if(!btn||btn.disabled)return;
  const action=btn.dataset.action,{dids}=unb64(btn.dataset.targets);
  const label=dids.length===1?getName(dids[0]):`${dids.length} appareils`;
  showProgress();setCardBusy(dids,true);
  try{
    if(action==='mode'){
      const mode=btn.dataset.mode;
      for(const did of dids) await api('POST',`devices/${did}/mode`,{mode});
      dids.forEach(d=>{if(deviceStatuses[d])deviceStatuses[d].mode=mode});
      render();flashCards(dids,mode);
      toast(`${MODE_EMOJI[mode]} ${label} → ${MODE_LABELS[mode]}`,'success');
    }else if(action==='timer'){
      const en=btn.dataset.enabled==='true';
      for(const did of dids) await api('POST',`devices/${did}/timer`,{enabled:en});
      dids.forEach(d=>{if(deviceStatuses[d])deviceStatuses[d].timer_switch=en?1:0});
      render();toast(`📅 ${label} — Programme ${en?'ON':'OFF'}`,'success');
    }else if(action==='lock'){
      const en=btn.dataset.enabled==='true';
      for(const did of dids) await api('POST',`devices/${did}/lock`,{enabled:en});
      dids.forEach(d=>{if(deviceStatuses[d])deviceStatuses[d].lock_switch=en?1:0});
      render();toast(`🔒 ${label} — Verrou ${en?'ON':'OFF'}`,'success');
    }else if(action==='boost-cancel'){
      for(const did of dids) await api('POST',`devices/${did}/boost`,{minutes:0});
      dids.forEach(d=>{if(deviceStatuses[d]){deviceStatuses[d].derog_mode=0;deviceStatuses[d].derog_time=0}});
      render();toast(`⚡ ${label} — Boost annule`,'success');
    }else if(action==='boost-pick'){
      hideProgress();setCardBusy(dids,false);openBoost(dids);return;
    }
    delayedRefresh(8000);
  }catch(e){toast('❌ '+e.message,'error')}
  finally{hideProgress();setCardBusy(dids,false)}
});

// Boost modal
let boostDids=[];
function openBoost(dids){boostDids=dids;document.getElementById('boost-hours').value=2;document.getElementById('boost-modal').hidden=false}
document.getElementById('boost-cancel').addEventListener('click',()=>{document.getElementById('boost-modal').hidden=true});
document.querySelectorAll('.boost-btn').forEach(b=>b.addEventListener('click',()=>{document.getElementById('boost-hours').value=b.dataset.hours}));
document.getElementById('boost-confirm').addEventListener('click',async()=>{
  const h=parseFloat(document.getElementById('boost-hours').value)||2,min=Math.round(h*60);
  document.getElementById('boost-modal').hidden=true;
  const label=boostDids.length===1?getName(boostDids[0]):`${boostDids.length} appareils`;
  showProgress();setCardBusy(boostDids,true);
  try{
    for(const did of boostDids) await api('POST',`devices/${did}/boost`,{minutes:min});
    boostDids.forEach(d=>{if(deviceStatuses[d]){deviceStatuses[d].derog_mode=2;deviceStatuses[d].derog_time=min}});
    render();toast(`⚡ ${label} — Boost ${h}h`,'success');delayedRefresh(8000);
  }catch(e){toast('❌ '+e.message,'error')}
  finally{hideProgress();setCardBusy(boostDids,false)}
});

// Global actions
document.getElementById('programme-on-btn').addEventListener('click',async()=>{
  const btn=document.getElementById('programme-on-btn');btn.classList.add('is-busy');showProgress();
  try{const r=await api('POST','timer-all',{enabled:true});devices.forEach(d=>{if(deviceStatuses[d.did])deviceStatuses[d.did].timer_switch=1});render();toast(`📅 Programme ON — ${r.succeeded}/${r.total}`,'success');delayedRefresh(8000)}
  catch(e){toast('❌ '+e.message,'error')}finally{btn.classList.remove('is-busy');hideProgress()}
});
document.getElementById('programme-off-btn').addEventListener('click',async()=>{
  const btn=document.getElementById('programme-off-btn');btn.classList.add('is-busy');showProgress();
  try{const r=await api('POST','timer-all',{enabled:false});devices.forEach(d=>{if(deviceStatuses[d.did])deviceStatuses[d.did].timer_switch=0});render();toast(`📅 Programme OFF — ${r.succeeded}/${r.total}`,'success');delayedRefresh(8000)}
  catch(e){toast('❌ '+e.message,'error')}finally{btn.classList.remove('is-busy');hideProgress()}
});
document.querySelectorAll('.quick-actions .qa-btn[data-mode]').forEach(btn=>{
  btn.addEventListener('click',async()=>{
    const mode=btn.dataset.mode;btn.classList.add('is-busy');showProgress();
    try{const r=await api('POST','mode-all',{mode});devices.forEach(d=>{if(deviceStatuses[d.did])deviceStatuses[d.did].mode=mode});render();flashCards(devices.map(d=>d.did),mode);
      r.failed>0?toast(`${MODE_EMOJI[mode]} Tous en ${MODE_LABELS[mode]} — ${r.failed} echec(s)`,'error'):toast(`${MODE_EMOJI[mode]} Tous en ${MODE_LABELS[mode]}`,'success');delayedRefresh(8000)}
    catch(e){toast('❌ '+e.message,'error')}finally{btn.classList.remove('is-busy');hideProgress()}
  });
});

// Refresh
let refreshTimer;
function delayedRefresh(ms=8000){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>loadDevices(),ms)}
document.getElementById('refresh-btn').addEventListener('click',async()=>{
  const btn=document.getElementById('refresh-btn');btn.classList.add('spinning');showProgress();
  await loadDevices();btn.classList.remove('spinning');hideProgress();
});

// Helpers
function getName(did){const d=devices.find(d=>d.did===did);return d?d.name:did}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

let toastTimer;
function toast(msg,type=''){
  const el=document.getElementById('toast');el.textContent=msg;el.className='toast show'+(type?' '+type:'');el.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.classList.remove('show');setTimeout(()=>el.hidden=true,300)},type==='error'?5000:3000);
}

// --- Scenarios ---
// Je pars : Prog OFF + OFF sur TOUS (force=true, pas d'exclusions)
document.getElementById('scene-leave').addEventListener('click', async()=>{
  const btn=document.getElementById('scene-leave');
  btn.classList.add('is-busy'); showProgress();
  try {
    // D'abord prog off sur tous
    await api('POST','timer-all',{enabled:false});
    // Puis off sur tous (force=true ignore les exclusions)
    const r = await api('POST','mode-all',{mode:'stop',force:true});
    devices.forEach(d=>{if(deviceStatuses[d.did]){deviceStatuses[d.did].mode='stop';deviceStatuses[d.did].timer_switch=0}});
    render(); flashCards(devices.map(d=>d.did),'stop');
    r.failed>0 ? toast(`🧳 Depart — ${r.failed} echec(s)`,'error') : toast('🧳 Depart active','success');
    delayedRefresh(8000);
  } catch(e) { toast('❌ '+e.message,'error'); }
  finally { btn.classList.remove('is-busy'); hideProgress(); }
});

// Je rentre : Prog ON sur les non-exclus uniquement
document.getElementById('scene-home').addEventListener('click', async()=>{
  const btn=document.getElementById('scene-home');
  btn.classList.add('is-busy'); showProgress();
  try {
    const r = await api('POST','timer-all',{enabled:true});
    const excl = await api('GET','exclusions');
    devices.forEach(d=>{if(deviceStatuses[d.did] && !excl.includes(d.did)) deviceStatuses[d.did].timer_switch=1});
    render();
    r.failed>0 ? toast(`🏠 Retour — ${r.failed} echec(s)`,'error') : toast('🏠 Retour — Prog ON','success');
    delayedRefresh(8000);
  } catch(e) { toast('❌ '+e.message,'error'); }
  finally { btn.classList.remove('is-busy'); hideProgress(); }
});

// Mode nuit : Nuit sur les non-exclus
document.getElementById('scene-night').addEventListener('click', async()=>{
  const btn=document.getElementById('scene-night');
  btn.classList.add('is-busy'); showProgress();
  try {
    const r = await api('POST','mode-all',{mode:'eco'});
    const excl = await api('GET','exclusions');
    devices.forEach(d=>{if(deviceStatuses[d.did] && !excl.includes(d.did)) deviceStatuses[d.did].mode='eco'});
    render(); flashCards(devices.filter(d=>!excl.includes(d.did)).map(d=>d.did),'eco');
    r.failed>0 ? toast(`🌙 Mode nuit — ${r.failed} echec(s)`,'error') : toast('🌙 Mode nuit active','success');
    delayedRefresh(8000);
  } catch(e) { toast('❌ '+e.message,'error'); }
  finally { btn.classList.remove('is-busy'); hideProgress(); }
});

// --- Config exclusions ---
document.getElementById('config-btn').addEventListener('click', async()=>{
  try {
    const excl = await api('GET','exclusions');
    const list = document.getElementById('config-list');
    list.innerHTML = devices.map(d => {
      const isExcl = excl.includes(d.did);
      return `<div class="config-item">
        <span class="config-item-name">${esc(d.name)}</span>
        <div style="display:flex;align-items:center">
          <span class="config-toggle-label">${isExcl?'Exclu':'Inclus'}</span>
          <button class="config-toggle ${isExcl?'excluded':''}" data-did="${d.did}"></button>
        </div>
      </div>`;
    }).join('');
    document.getElementById('config-modal').hidden = false;
  } catch(e) { toast('❌ '+e.message,'error'); }
});

document.getElementById('config-cancel').addEventListener('click',()=>{
  document.getElementById('config-modal').hidden=true;
});

// Toggle exclusion
document.getElementById('config-list').addEventListener('click', async(e)=>{
  const toggle = e.target.closest('.config-toggle');
  if (!toggle) return;
  const did = toggle.dataset.did;
  try {
    const excl = await api('GET','exclusions');
    let newExcl;
    if (excl.includes(did)) {
      newExcl = excl.filter(d=>d!==did);
    } else {
      newExcl = [...excl, did];
    }
    await api('POST','exclusions',{excluded:newExcl});
    // Mettre a jour le toggle visuellement
    toggle.classList.toggle('excluded');
    const label = toggle.previousElementSibling;
    label.textContent = toggle.classList.contains('excluded') ? 'Exclu' : 'Inclus';
    toast('⚙️ Exclusions mises a jour','success');
  } catch(e) { toast('❌ '+e.message,'error'); }
});

// --- Offline alert ---
function updateOfflineAlert() {
  const offline = devices.filter(d=>!d.is_online);
  const el = document.getElementById('offline-alert');
  if (offline.length === 0) {
    el.hidden = true;
  } else {
    el.hidden = false;
    el.innerHTML = `⚠️ ${offline.length} appareil(s) hors ligne : ${offline.map(d=>'<strong>'+esc(d.name)+'</strong>').join(', ')}`;
  }
}

// --- Last update timestamp ---
let lastRefreshTime = null;
function updateLastRefresh() {
  lastRefreshTime = Date.now();
  updateLastRefreshDisplay();
}
function updateLastRefreshDisplay() {
  if (!lastRefreshTime) return;
  const sec = Math.round((Date.now()-lastRefreshTime)/1000);
  let txt;
  if (sec < 5) txt = 'a l\'instant';
  else if (sec < 60) txt = `${sec}s`;
  else txt = `${Math.round(sec/60)}min`;
  document.getElementById('last-update').textContent = txt;
}
setInterval(updateLastRefreshDisplay, 10000);

// --- Simple mode ---
async function loadDevicesSimple() {
  const statusEl = document.getElementById('simple-status');
  statusEl.textContent = 'Chargement...';
  try {
    devices = await api('GET','devices');
    const online = devices.filter(d=>d.is_online).length;
    const offline = devices.filter(d=>!d.is_online).length;
    let txt = `<span class="s-ok">${online} en ligne</span>`;
    if (offline > 0) txt += ` · <span class="s-warn">${offline} hors ligne</span>`;
    statusEl.innerHTML = txt;
  } catch(e) { statusEl.textContent = ''; }
}

// Simple mode buttons
document.getElementById('simple-leave').addEventListener('click', async()=>{
  const btn = document.getElementById('simple-leave');
  const statusEl = document.getElementById('simple-status');
  btn.classList.add('is-busy');
  statusEl.innerHTML = '⏳ Extinction en cours...';
  try {
    await api('POST','timer-all',{enabled:false});
    await api('POST','mode-all',{mode:'stop',force:true});
    statusEl.innerHTML = '<span class="s-ok">✅ Tout est eteint</span>';
  } catch(e) {
    statusEl.innerHTML = '<span class="s-warn">❌ Erreur: '+esc(e.message)+'</span>';
  } finally { btn.classList.remove('is-busy'); }
});

document.getElementById('simple-home').addEventListener('click', async()=>{
  const btn = document.getElementById('simple-home');
  const statusEl = document.getElementById('simple-status');
  btn.classList.add('is-busy');
  statusEl.innerHTML = '⏳ Activation en cours...';
  try {
    await api('POST','timer-all',{enabled:true});
    statusEl.innerHTML = '<span class="s-ok">✅ Programme active</span>';
  } catch(e) {
    statusEl.innerHTML = '<span class="s-warn">❌ Erreur: '+esc(e.message)+'</span>';
  } finally { btn.classList.remove('is-busy'); }
});

// Toggle entre modes
document.getElementById('simple-to-advanced').addEventListener('click', switchToAdvanced);
document.getElementById('simple-mode-btn').addEventListener('click', switchToSimple);

// SW cleanup
if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(r=>r.forEach(r=>r.unregister()));if(window.caches)caches.keys().then(k=>k.forEach(k=>caches.delete(k)))}

checkAuth();
