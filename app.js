// SplitTimer Clean v26
function on(sel, evt, fn){
  const el = document.querySelector(sel);
  if (el) el.addEventListener(evt, fn);
}
// SplitTimer PWA (no build tools). Data stored locally in localStorage.
// Features: routes, checkpoints, GPX import (profile), ride timer, results, leaderboard, export/import.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const SCREENS = {
  source: $('#screenSource'),
  routes: $('#screenRoutes'),
  route: $('#screenRouteDetail'),
  ride: $('#screenRide'),
};

const state = {
  screen: 'source',
  source: null, // 'Zwift' | 'Kinomap'

  currentRouteId: null,
  ride: null, // {routeId, startMs, running, marks:[{cpId, ms}], stoppedMs}

  // ✅ NOVÉ: cache pro create-route z GPX
  gpxIndex: null,            // [{file,name}]
  newRouteComputed: null,    // {gpxUrl,totalDistanceKm,totalAscentM,profileStepM,profileEleM,profilePoints}
  newRouteSelectedFile: null // string
};

const STORAGE_KEY = 'splittimer:data:v1';
const SOURCE_KEY = 'splittimer:source:v1';

// ===== Google Sheets Sync (JSONP to avoid CORS) =====
const SHEETS_API_URL = 'https://script.google.com/macros/s/AKfycbwaBWzuDwfU6-xQ4tLjEUSCnaMpvoQBsulvp11wtRokx3xIVsJ3_MZMGp3TRe2_q5KmcQ/exec';
const SHEETS_API_SECRET = 'st_pRrN8e6Lgkh2A5SThDEKpek4qZZL_0pr';
const APP_VERSION = 'pwa-v26-sheets-db';
const PENDING_KEY = 'splittimer:pendingSync:v1';

// ✅ NOVÉ: kde leží GPX v repu
const GPX_INDEX_URL = './Gpx/index.json';
const GPX_BASE_PATH = './Gpx/';
// ===== Profile helpers (MUST be defined before drawProfile) =====


// ===== TV-style profile helpers =====
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function rgba(hex, a){
  // hex: "#rrggbb"
  const h = String(hex).replace('#','').trim();
  const r = parseInt(h.slice(0,2),16)||0;
  const g = parseInt(h.slice(2,4),16)||0;
  const b = parseInt(h.slice(4,6),16)||0;
  return `rgba(${r},${g},${b},${a})`;
}

// grade in % (e.g. 7.5 means +7.5%)
function colorForGrade(gradePct){
  const g = Number(gradePct);
  if (!Number.isFinite(g)) return '#5bd48a';

  // descending
  if (g <= -6) return '#2aa7ff';
  if (g <= -2) return '#46c7ff';

  // flat-ish
  if (g < 2) return '#4fe38b';

  // climbing
  if (g < 5) return '#d8e24a';
  if (g < 8) return '#ffb547';
  return '#ff5b5b';
}

function computeAscentDescent(profilePts){
  let up = 0, down = 0;
  for (let i=1;i<profilePts.length;i++){
    const de = (profilePts[i].elevationM - profilePts[i-1].elevationM);
    if (de>0) up += de; else down += (-de);
  }
  return { up: Math.round(up), down: Math.round(down) };
}
function lerp(a,b,t){ return a + (b-a)*t; }
function getBestRideForRouteId(routeId){
  const rides = getRidesForRoute(routeId).slice();
  // jen dokončené
  const done = rides.filter(r => Number.isFinite(r.finishMs ?? r.totalMs));
  if (!done.length) return null;

  done.sort((a,b)=> (a.finishMs ?? a.totalMs) - (b.finishMs ?? b.totalMs));
  return done[0];
}

function getBestPackForRoute(route){
  const bestRide = getBestRideForRouteId(route.id);
  if (!bestRide) return null;

  const finishMs = bestRide.finishMs ?? bestRide.totalMs;
  if (!Number.isFinite(finishMs) || finishMs <= 0) return null;

  // splity = kumulativní časy na CP
  let splits = Array.isArray(bestRide.splits) ? bestRide.splits.slice() : [];
  if (!splits.length && Array.isArray(bestRide.marks)) {
    splits = bestRide.marks.map(m => m.elapsedMs).filter(Number.isFinite);
  }

  // omez délku na počet CP
  const cpCount = (route.checkpoints || []).length;
  if (cpCount && splits.length > cpCount) splits = splits.slice(0, cpCount);

  return { finishMs, splits };
}

function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }

// lineární interpolace elevace z route.profile (distanceKm/elevationM)
function elevationAtKm(profilePts, km){
  if (!Array.isArray(profilePts) || profilePts.length < 2) return 0;

  // profil musí být setříděný
  const pts = profilePts;
  if (km <= pts[0].distanceKm) return pts[0].elevationM;
  if (km >= pts[pts.length-1].distanceKm) return pts[pts.length-1].elevationM;

  // binární hledání
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1){
    const mid = (lo + hi) >> 1;
    if (pts[mid].distanceKm <= km) lo = mid; else hi = mid;
  }

  const a = pts[lo], b = pts[hi];
  const span = (b.distanceKm - a.distanceKm) || 1e-9;
  const t = (km - a.distanceKm) / span;
  return a.elevationM + (b.elevationM - a.elevationM) * t;
}

// fallback vzdálenosti checkpointů, když nejsou distanceKm
function checkpointKmArray(route){
  const cps = Array.isArray(route.checkpoints) ? route.checkpoints : [];
  const totalKm = Number.isFinite(route.totalDistanceKm) ? route.totalDistanceKm : (cps.length ? (cps[cps.length-1].distanceKm || 0) : 0);
  if (!cps.length) return [];

  const have = cps.every(c => Number.isFinite(c.distanceKm));
  if (have) return cps.map(c => c.distanceKm);

  // fallback rovnoměrně
  const n = cps.length + 1; // + finish
  return cps.map((_, i) => (totalKm > 0 ? ((i+1)/n) * totalKm : (i+1)));
}

// vypočte ghost km podle elapsed a nejlepší jízdy
function ghostKmAtElapsed(route, bestPack, elapsedMs){
  const totalKm = Number.isFinite(route.totalDistanceKm) ? route.totalDistanceKm : null;
  const cpsKm = checkpointKmArray(route);
  const finishKm = totalKm != null ? totalKm : (cpsKm.length ? cpsKm[cpsKm.length-1] : 0);

  const finishMs = bestPack.finishMs;
  const splits = Array.isArray(bestPack.splits) ? bestPack.splits : [];

  const t = clamp(elapsedMs, 0, finishMs);

  // když nemáme split data, jedeme lineárně 0 -> finish
  if (!splits.length || !cpsKm.length){
    const p = finishMs > 0 ? (t / finishMs) : 0;
    return p * finishKm;
  }

  // sestavíme segmenty: start -> CP1 -> ... -> CPn -> finish
  const times = splits.slice(0, cpsKm.length).filter(Number.isFinite);
  const kms   = cpsKm.slice(0, times.length);

  // přidej finish segment
  times.push(finishMs);
  kms.push(finishKm);

  let prevT = 0;
  let prevKm = 0;

  for (let i=0;i<times.length;i++){
    const nextT = times[i];
    const nextKm = kms[i];

    if (t <= nextT){
      const span = Math.max(1, nextT - prevT);
      const p = (t - prevT) / span;
      return prevKm + p * (nextKm - prevKm);
    }

    prevT = nextT;
    prevKm = nextKm;
  }

  return finishKm;
}
// ✅ Best ghost position (smooth) – based on BEST overall time, interpolated between checkpoints
function getBestGhostKmAtElapsed(route, elapsedMs){
  if (!route) return null;
  const totalKm = Number.isFinite(route.totalDistanceKm) ? route.totalDistanceKm : null;
  if (!totalKm || totalKm <= 0) return null;

  const best = getBestTimes(route.id); // {finishMs, splits}
  if (!best || !Number.isFinite(best.finishMs) || best.finishMs <= 0) return null;

  // checkpoint distances -> fractions -> kms
  const cps = Array.isArray(route.checkpoints) ? route.checkpoints : [];
  const fractions = [];
  for (let i=0;i<cps.length;i++){
    fractions.push(ratioForCp(route, i)); // already clamps 0..1
  }

  // times: cumulative at each cp, plus finish
  const times = [];
  for (let i=0;i<cps.length;i++){
    const t = (Array.isArray(best.splits) && Number.isFinite(best.splits[i])) ? best.splits[i] : null;
    times.push(t);
  }
  // finish as last "node"
  fractions.push(1);
  times.push(best.finishMs);

  // if we have no checkpoint times at all, just linear 0..finish
  const hasAny = times.some(x=>Number.isFinite(x) && x>0);
  if (!hasAny){
    const f = clamp(elapsedMs / best.finishMs, 0, 1);
    return totalKm * f;
  }

  // build nodes (0 at start)
  const nodeF = [0];
  const nodeT = [0];

  for (let i=0;i<times.length;i++){
    if (!Number.isFinite(times[i])) continue;
    nodeF.push(fractions[i]);
    nodeT.push(times[i]);
  }

  // ensure last node is finish
  if (nodeF[nodeF.length-1] !== 1){
    nodeF.push(1);
    nodeT.push(best.finishMs);
  }

  // clamp elapsed
  const tNow = clamp(elapsedMs, 0, best.finishMs);

  // find segment
  let seg = 1;
  while (seg < nodeT.length && nodeT[seg] < tNow) seg++;

  if (seg <= 0) return 0;
  if (seg >= nodeT.length) return totalKm;

  const t0 = nodeT[seg-1], t1 = nodeT[seg];
  const f0 = nodeF[seg-1], f1 = nodeF[seg];
  const span = Math.max(1, (t1 - t0));
  const p = clamp((tNow - t0) / span, 0, 1);
  const f = f0 + (f1 - f0) * p;
  return totalKm * clamp(f, 0, 1);
}

function interpEleAtKmFromProfile(profilePts, km){
  if (!Array.isArray(profilePts) || profilePts.length < 2) return null;
  if (km <= profilePts[0].distanceKm) return profilePts[0].elevationM;
  if (km >= profilePts[profilePts.length-1].distanceKm) return profilePts[profilePts.length-1].elevationM;

  let j = 0;
  while (j < profilePts.length-2 && profilePts[j+1].distanceKm < km) j++;
  const a = profilePts[j], b = profilePts[j+1];
  const span = (b.distanceKm - a.distanceKm) || 1e-9;
  const t = (km - a.distanceKm) / span;
  return a.elevationM + (b.elevationM - a.elevationM) * t;
}

function resampleProfileByPixels(pts, xFn, pixelStep=2){
  // pts: [{distanceKm,elevationM}...] sorted by distanceKm
  const out = [];
  const w = xFn(pts[pts.length-1].distanceKm) - xFn(pts[0].distanceKm);
  const steps = Math.max(30, Math.floor(w / pixelStep));

  const totalKm = pts[pts.length-1].distanceKm;
  let j = 0;

  for(let i=0;i<=steps;i++){
    const km = (i/steps) * totalKm;

    while(j < pts.length-2 && pts[j+1].distanceKm < km) j++;

    const a = pts[j], b = pts[j+1];
    const span = (b.distanceKm - a.distanceKm) || 1e-9;
    const t = (km - a.distanceKm) / span;

    out.push({
      distanceKm: km,
      elevationM: lerp(a.elevationM, b.elevationM, t)
    });
  }
  return out;
}

function smoothElevations(pts, window=5){
  // moving average on elevation
  const half = Math.floor(window/2);
  const out = pts.map(p=>({...p}));
  for(let i=0;i<pts.length;i++){
    let s=0, c=0;
    for(let k=-half;k<=half;k++){
      const idx = i+k;
      if(idx>=0 && idx<pts.length){
        s += pts[idx].elevationM;
        c++;
      }
    }
    out[i].elevationM = s / (c||1);
  }
  return out;
}

// Catmull-Rom -> Bezier smooth path
function buildSmoothPath(ctx, points, tension=0.6){
  if(points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for(let i=0;i<points.length-1;i++){
    const p0 = points[i-1] || points[i];
    const p1 = points[i];
    const p2 = points[i+1];
    const p3 = points[i+2] || p2;

    const cp1x = p1.x + (p2.x - p0.x) * (tension/6);
    const cp1y = p1.y + (p2.y - p0.y) * (tension/6);
    const cp2x = p2.x - (p3.x - p1.x) * (tension/6);
    const cp2y = p2.y - (p3.y - p1.y) * (tension/6);

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}


// ✅ NOVÉ: krok profilu (v metrech) – ukládá se do DB
const DEFAULT_PROFILE_STEP_M = 20;

// ✅ NOVÉ: max bodů pro route.profile pro canvas (nezatěžuje UI)
const PROFILE_MAX_POINTS_UI = 350;

function getDeviceId(){
  let id = localStorage.getItem('splittimer:deviceId:v1');
  if(!id){
    id = 'dev_' + Math.random().toString(16).slice(2) + '_' + Date.now();
    localStorage.setItem('splittimer:deviceId:v1', id);
  }
  return id;
}

function loadPending(){
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch(e) {
    return [];
  }
}
function savePending(list){
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
}
function queueRideForSync(ride){
  const list = loadPending();
  // de-dup by ride.id
  if(!list.some(x=>x && x.type==='ride' && x.rideId===ride.id)){
    list.push({ type:'ride', rideId: ride.id, ts: Date.now() });
    savePending(list);
  }
}

function sheetsJsonp(action, payload) {
  return new Promise((resolve, reject) => {
    const cbName = 'st_cb_' + Math.random().toString(36).slice(2);
    let script = null;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Sheets timeout'));
    }, 15000);

    function cleanup(){
      clearTimeout(timer);
      try { delete window[cbName]; } catch(e){ window[cbName] = undefined; }
      if (script && script.parentNode) script.parentNode.removeChild(script);
    }

    window[cbName] = (resp) => {
      cleanup();
      if (!resp || resp.ok !== true) {
        reject(new Error((resp && resp.error) ? resp.error : 'Sheets error'));
        return;
      }
      resolve(resp);
    };

    const payloadStr = encodeURIComponent(JSON.stringify(payload || {}));
    const url =
      SHEETS_API_URL +
      '?callback=' + encodeURIComponent(cbName) +
      '&secret=' + encodeURIComponent(SHEETS_API_SECRET) +
      '&action=' + encodeURIComponent(action) +
      '&payload=' + payloadStr;

    script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onerror = () => {
      cleanup();
      reject(new Error('Sheets network error'));
    };
    document.body.appendChild(script);
  });
}

function safeJsonParse(str, fallback){
  try { return JSON.parse(str); } catch(e){ return fallback; }
}

// ✅ NOVÉ: z DB (profileStepM + profileEleM) vytvoří route.profile pro vykreslení
function buildProfilePointsFromStepEle(totalDistanceKm, profileStepM, profileEleM){
  const stepM = Number(profileStepM);
  const eleArr = Array.isArray(profileEleM) ? profileEleM : [];
  if (!Number.isFinite(stepM) || stepM <= 0 || eleArr.length < 2) return [];

  // Pokud distanceKm neznáme, odvodíme z délky pole
  let totalM = Number.isFinite(totalDistanceKm) ? Math.round(totalDistanceKm * 1000) : ((eleArr.length - 1) * stepM);
  if (!Number.isFinite(totalM) || totalM <= 0) totalM = (eleArr.length - 1) * stepM;

  const out = [];
  for (let i=0;i<eleArr.length;i++){
    const dM = i * stepM;
    if (dM > totalM + stepM) break;
    out.push({ distanceKm: dM / 1000, elevationM: Number(eleArr[i]) });
  }

  // dorovnej poslední bod přesně na totalDistanceKm, pokud je známá
  if (Number.isFinite(totalDistanceKm) && out.length){
    const last = out[out.length - 1];
    last.distanceKm = totalDistanceKm;
  }
  return out;
}

async function refreshFromSheets(source){
  const src = source || state.source || loadSource() || '';
  const resp = await sheetsJsonp('getAll', { source: src });

  const routes = (resp.routes || []).map(r => {
    const totalDistanceKm = (r.totalDistanceKm === '' || r.totalDistanceKm == null) ? null : Number(r.totalDistanceKm);
    const totalAscentM = (r.totalAscentM === '' || r.totalAscentM == null) ? null : Number(r.totalAscentM);

    const gpxUrl = (r.gpxUrl === '' || r.gpxUrl == null) ? null : String(r.gpxUrl);
    const profileStepM = (r.profileStepM === '' || r.profileStepM == null) ? null : Number(r.profileStepM);

    // profileEleM může být:
    // - už pole (když GAS vrací JSON)
    // - nebo string s JSON
    let profileEleM = [];
    if (Array.isArray(r.profileEleM)) {
      profileEleM = r.profileEleM;
    } else if (typeof r.profileEleM === 'string' && r.profileEleM.trim()) {
      profileEleM = safeJsonParse(r.profileEleM, []);
    } else if (typeof r.profileEleM === 'number') {
      profileEleM = [];
    } else if (typeof r.profileEleM === 'object' && r.profileEleM != null) {
      // fallback
      profileEleM = [];
    }

    // route.profile pro UI
    const profilePoints = (profileStepM && profileEleM && profileEleM.length >= 2)
      ? buildProfilePointsFromStepEle(totalDistanceKm, profileStepM, profileEleM)
      : [];

    const uiProfile = profilePoints.length
      ? downsampleProfile(profilePoints, PROFILE_MAX_POINTS_UI).map(p => ({ distanceKm: p.distanceKm, elevationM: p.elevationM }))
      : [];

    return ({
      id: String(r.routeId),
      source: String(r.source || ''),
      name: String(r.name || ''),
      totalDistanceKm: Number.isFinite(totalDistanceKm) ? totalDistanceKm : null,
      totalAscentM: Number.isFinite(totalAscentM) ? totalAscentM : null,
      difficulty: String(r.difficulty || ''),
      gpxUrl,
      profileStepM: Number.isFinite(profileStepM) ? profileStepM : null,
      profileEleM: Array.isArray(profileEleM) ? profileEleM : [],
      checkpoints: [],
      profile: uiProfile
    });
  });

  const byId = new Map(routes.map(r => [r.id, r]));
  (resp.checkpoints || []).forEach(c => {
    const route = byId.get(String(c.routeId));
    if (!route) return;
    route.checkpoints.push({
      id: String(c.checkpointId),
      name: String(c.name || ''),
      distanceKm: (c.distanceKm === '' || c.distanceKm == null) ? null : Number(c.distanceKm),
    });
  });
  routes.forEach(r => r.checkpoints.sort((a,b)=>((a.distanceKm??0)-(b.distanceKm??0)) || a.name.localeCompare(b.name)));

  // ✅ FIX: normalizace z DB -> používáme dateIso, runnerName, totalMs, finishMs, splits
  const rides = (resp.rides || []).map(x => {
    const finishMs = Number(x.finishMs || 0);
    const splits = Array.isArray(x.splits)
      ? x.splits
      : (()=>{ try { return JSON.parse(x.splitsJson || '[]'); } catch(e){ return []; } })();

    const dateIso = String(x.dateISO || x.dateIso || x.createdAt || '');
    const runnerName = String(x.label || x.runnerName || '');
    const note = String(x.note || '');

    return {
      id: String(x.rideId),
      routeId: String(x.routeId),
      source: String(x.source || ''),
      dateIso,
      runnerName: runnerName || null,
      note: note || null,
      totalMs: finishMs || null,
      finishMs: finishMs || null,
      splits: Array.isArray(splits) ? splits : [],
    };
  });

  data.routes = routes;
  data.rides = rides;
  saveData(); // cache mirrors DB
  return { routesCount: routes.length, ridesCount: rides.length };
}

async function syncRideToSheets(rideId){
  const ride = data.rides.find(r=>r.id===rideId);
  if(!ride) return;

  const route = data.routes.find(r=>r.id===ride.routeId);
  if(!route) return;

  // Upsert route
  await sheetsJsonp('upsertRoute', {
    routeId: route.id,
    source: route.source || state.source || '',
    name: route.name || '',
    totalDistanceKm: route.totalDistanceKm ?? '',
    totalAscentM: route.totalAscentM ?? '',
    difficulty: route.difficulty || '',
    // ✅ NOVÉ
    gpxUrl: route.gpxUrl ?? '',
    profileStepM: route.profileStepM ?? '',
    profileEleM: (Array.isArray(route.profile) && route.profile.length)
  ? JSON.stringify(route.profile.map(p => Math.round(p.elevationM || 0)))
  : ''

  });

  // Replace checkpoints
  await sheetsJsonp('replaceCheckpoints', {
    routeId: route.id,
    checkpoints: (route.checkpoints || []).map((cp, idx)=>({
      checkpointId: cp.id || ('cp' + (idx+1)),
      order: idx+1,
      name: cp.name || '',
      distanceKm: (cp.distanceKm ?? '')
    }))
  });

  // Insert ride
  await sheetsJsonp('insertRide', {
    rideId: ride.id,
    routeId: route.id,
    source: route.source || state.source || '',
    dateISO: ride.dateIso || new Date().toISOString(),
    label: ride.runnerName || '',
    note: ride.note || '',
    finishMs: ride.finishMs ?? ride.totalMs ?? 0,
    splits: Array.isArray(ride.splits) ? ride.splits : [],
    deviceId: getDeviceId(),
    appVersion: APP_VERSION
  });
}

async function syncPending() {
  if (!navigator.onLine) return;
  const list = loadPending();
  if (!list.length) return;

  // process sequentially
  const remain = [];
  for (const item of list) {
    if (!item || item.type!=='ride' || !item.rideId) continue;
    try {
      await syncRideToSheets(item.rideId);
    } catch (e) {
      // keep for later retry
      remain.push(item);
    }
  }
  savePending(remain);
}

window.addEventListener('online', ()=>{ syncPending().catch(()=>{}); });


function nowMs(){ return performance.now(); }
function pad2(n){ return String(n).padStart(2,'0'); }
function formatTime(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = s%60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}
function formatSigned(ms){
  const sign = ms < 0 ? '-' : '+';
  return sign + formatTimeShort(Math.abs(ms));
}

function formatTimeShort(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = s%60;
  return h>0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}
function formatKm(km){
  if (km === null || km === undefined || Number.isNaN(km)) return '';
  const v = Math.round(km*10)/10;
  return `${v.toFixed(v % 1 === 0 ? 0 : 1)} km`;
}

function uid(){ return crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36)+Math.random().toString(36).slice(2)); }

function loadData(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw){
    return { routes: [], rides: [] };
  }
  try {
    const obj = JSON.parse(raw);
    // ensure shape
    return {
      routes: Array.isArray(obj.routes) ? obj.routes : [],
      rides: Array.isArray(obj.rides) ? obj.rides : []
    };
  } catch(e){
    return { routes: [], rides: [] };
  }
}

function saveData(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }


function loadSource(){
  const s = localStorage.getItem(SOURCE_KEY);
  return (s === 'Zwift' || s === 'Kinomap') ? s : null;
}
function saveSource(s){
  localStorage.setItem(SOURCE_KEY, s);
  state.source = s;
  const lbl = $('#currentSourceLabel');
  if (lbl) lbl.textContent = s ?? '—';
}

let data = loadData();

// Migration: ensure every route has source
(function migrate(){
  let changed = false;
  for (const r of data.routes){
    if (r.source !== 'Zwift' && r.source !== 'Kinomap'){
      r.source = state.source || 'Zwift';
      changed = true;
    }
    if (!('totalAscentM' in r)) { r.totalAscentM = null; changed = true; }
    if (!Array.isArray(r.profile)) { r.profile = []; changed = true; }
    if (!Array.isArray(r.checkpoints)) { r.checkpoints = []; changed = true; }

    // ✅ NOVÉ: kompatibilita pro staré lokální záznamy
    if (!('gpxUrl' in r)) { r.gpxUrl = null; changed = true; }
    if (!('profileStepM' in r)) { r.profileStepM = null; changed = true; }
    if (!('profileEleM' in r)) { r.profileEleM = []; changed = true; }
  }
  if (changed) saveData();
})();


// ✅ NOVÉ: podle totalAscentM vrátí band pro obrázek dlaždice (podle tvé logiky)
function ascentBand(totalAscentM){
  const asc = Number.isFinite(totalAscentM) ? Math.round(totalAscentM) : null;
  if (asc == null) return 'flat';           // když neznáme, dáme flat (nebo si můžeš změnit na 'unknown')
  if (asc <= 39) return 'flat';
  if (asc <= 99) return 'hilly';
  return 'mountain';
}


// ---------- Navigation ----------
function setTopbar(title, showBack){
  $('#topTitle').textContent = title;
  $('#btnBack').hidden = !showBack;
}
function showScreen(name){
  try{ window.scrollTo(0,0); document.documentElement.scrollTop=0; document.body.scrollTop=0; }catch(e){}
  state.screen = name;
  for (const [k, el] of Object.entries(SCREENS)){
    el.hidden = (k !== name);
  }
  if (name === 'source'){
    setTopbar('Vyber zdroj', false);
    updateSourceUi();
  }
  if (name === 'routes'){
    setTopbar('Moje Trasy', false);
    renderRoutes();
  }
  if (name === 'route'){
    setTopbar(getCurrentRoute()?.name ?? 'Trať', true);
    renderRouteDetail();
  }
  if (name === 'ride'){
    try{ window.scrollTo(0,0); }catch(e){}
    setTopbar(`Jízda: ${getCurrentRoute()?.name ?? ''}`.trim(), true);
    renderRide();
  }
}

on('#btnBack', 'click', ()=>{
  if (state.screen === 'source'){
    return;
  }
  if (state.screen === 'ride'){
    // back to route detail
    showScreen('route');
  } else if (state.screen === 'route'){
    showScreen('routes');
  }
});

// Menu
on('#btnMenu', 'click', ()=> { updateSourceUi(); openModal('modalMenu'); });

function updateSourceUi(){
  const s = state.source ?? loadSource();
  const lbl = $('#currentSourceLabel');
  if (lbl) lbl.textContent = s ?? '—';
}


$('#btnSwitchSource')?.addEventListener('click', ()=>{
  closeModal('modalMenu');
  showScreen('source');

  // Try syncing any pending items
  syncPending().catch(()=>{});
});

on('#btnCloseMenu', 'click', ()=> closeModal('modalMenu'));

// Close modals by backdrop
$$('.backdrop').forEach(b=>{
  b.addEventListener('click', (e)=>{
    const id = e.target.getAttribute('data-close');
    if (id) closeModal(id);
  });
});
$$('[data-close]').forEach(btn=>{
  const id = btn.getAttribute('data-close');
  if (btn.classList.contains('backdrop')) return;
  btn.addEventListener('click', ()=> closeModal(id));
});

function openModal(id){ $('#'+id).hidden = false; }
function closeModal(id){ $('#'+id).hidden = true; }


function bindTap(el, fn){
  if (!el) return;
  const handler = (e)=>{
    // On iOS, touch can prevent click; handle both safely
    try{ e.preventDefault?.(); }catch(_){}
    try{ e.stopPropagation?.(); }catch(_){}
    fn(e);
  };
  el.addEventListener('click', handler, {capture:true});
  el.addEventListener('touchend', handler, {capture:true, passive:false});
  el.addEventListener('pointerup', handler, {capture:true});
}


function bindTapSelector(selector, fn){
  const handler = (e)=>{
    const t = e.target && e.target.closest ? e.target.closest(selector) : null;
    if (!t) return;
    try{ e.preventDefault?.(); }catch(_){}
    try{ e.stopPropagation?.(); }catch(_){}
    fn(e, t);
  };
  document.addEventListener('click', handler, {capture:true});
  document.addEventListener('touchend', handler, {capture:true, passive:false});
  document.addEventListener('pointerup', handler, {capture:true});
}

function wireModalGuards(){
  // Prevent clicks inside sheets from closing the modal on iOS Safari (event bubbling quirks)
  document.querySelectorAll('.modal .sheet').forEach(sheet=>{
    sheet.addEventListener('click', (e)=> e.stopPropagation());
    sheet.addEventListener('pointerdown', (e)=> e.stopPropagation());
    sheet.addEventListener('touchstart', (e)=> e.stopPropagation(), {passive:true});
  });
  // Backdrop closes modal (only)
  document.querySelectorAll('.modal').forEach(modal=>{
    modal.addEventListener('click', (e)=>{
      // if click is on modal container (backdrop area), close
      if (e.target === modal){
        modal.hidden = true;
      }
    });
  });
}

wireModalGuards();

document.querySelectorAll('[data-close]').forEach(el=>{
  el.addEventListener('click', ()=>{
    const id = el.getAttribute('data-close');
    closeModal(id);
  });
});


// Robust iOS tap bindings (delegated)
bindTapSelector('#btnPickZwift', async ()=>{
  saveSource('Zwift');
  showToast('Načítám trasy z databáze…');
  try{ await refreshFromSheets('Zwift'); }catch(e){ console.warn(e); showToast('Nepodařilo se načíst DB – zobrazuji lokální cache'); }
  showScreen('routes');
  window.scrollTo(0,0);
});
bindTapSelector('#btnPickKinomap', async ()=>{
  saveSource('Kinomap');
  showToast('Načítám trasy z databáze…');
  try{ await refreshFromSheets('Kinomap'); }catch(e){ console.warn(e); showToast('Nepodařilo se načíst DB – zobrazuji lokální cache'); }
  showScreen('routes');
  window.scrollTo(0,0);
});

bindTapSelector('#btnStartRide', ()=>{
  const route = getCurrentRoute();
  if (!route) return;
  try{
    startRide(route.id);
    showScreen('ride');
  }catch(e){
    console.error(e);
    alert('Nepodařilo se spustit měření. Zkus stránku obnovit (refresh).');
  }
});

bindTapSelector('#btnRouteLeaderboard', ()=>{
  showLeaderboard(state.currentRouteId);
});

bindTapSelector('#btnSegmentLeaderboard', ()=>{
  showSegmentLeaderboard();
});

// ---------- Routes list ----------

// ✅ NOVÉ: načtení /Gpx/index.json a naplnění dropdownu
async function loadGpxIndex(){
  if (Array.isArray(state.gpxIndex) && state.gpxIndex.length) return state.gpxIndex;
  const res = await fetch(GPX_INDEX_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Nelze načíst /Gpx/index.json');
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('index.json musí být pole');
  // normalize
  state.gpxIndex = json.map(x=>({
    file: String(x.file || '').trim(),
    name: String(x.name || x.file || '').trim()
  })).filter(x=>x.file);
  return state.gpxIndex;
}

function resetCreateRouteComputedUI(){
  state.newRouteComputed = null;
  state.newRouteSelectedFile = null;
  const d1 = $('#newRouteDistanceAuto'); if (d1) d1.value = '';
  const a1 = $('#newRouteAscentAuto'); if (a1) a1.value = '';
  const hiddenDist = $('#newRouteDistance'); if (hiddenDist) hiddenDist.value = '';
}

async function fillCreateRouteGpxDropdown(){
  const sel = $('#newRouteGpx');
  if (!sel) return; // HTML nemusí být ještě upravené

  sel.innerHTML = `<option value="">Načítám seznam…</option>`;
  try{
    const list = await loadGpxIndex();
    if (!list.length){
      sel.innerHTML = `<option value="">Žádné GPX v /Gpx/</option>`;
      return;
    }
    sel.innerHTML = `<option value="">— Vyber GPX —</option>` + list.map(x=>{
      return `<option value="${escapeHtml(x.file)}">${escapeHtml(x.name)}</option>`;
    }).join('');
  }catch(e){
    console.warn(e);
    sel.innerHTML = `<option value="">Nelze načíst seznam GPX</option>`;
  }
}

// ✅ NOVÉ: po výběru GPX spočítat parametry a ukázat v modalu
async function computeAndPreviewNewRouteFromSelectedGpx(){
  const sel = $('#newRouteGpx');
  if (!sel) return;
  const file = (sel.value || '').trim();
  state.newRouteSelectedFile = file || null;
  resetCreateRouteComputedUI();
  if (!file) return;

  const gpxUrl = GPX_BASE_PATH + file;

  showToast('Načítám GPX a počítám profil…', 1600);

  try{
    const res = await fetch(gpxUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Nelze načíst ${gpxUrl}`);
    const text = await res.text();

    const parsed = parseGpx(text); // {totalDistanceKm,totalAscentM,profile}
    const stepM = DEFAULT_PROFILE_STEP_M;

    // resample elevace do profileEleM
    const profileEleM = resampleProfileEleMFromParsedProfile(parsed.profile, parsed.totalDistanceKm, stepM);

    // UI profile points (pro canvas) – z resampled pole
    const profilePoints = buildProfilePointsFromStepEle(parsed.totalDistanceKm, stepM, profileEleM);
    const uiProfile = downsampleProfile(profilePoints, PROFILE_MAX_POINTS_UI);

    state.newRouteComputed = {
      gpxUrl,
      totalDistanceKm: round2(parsed.totalDistanceKm),
      totalAscentM: Math.round(parsed.totalAscentM),
      profileStepM: stepM,
      profileEleM: profileEleM,
      profilePoints: uiProfile
    };

    // vyplň náhledy v modalu
    const d1 = $('#newRouteDistanceAuto'); if (d1) d1.value = String(round2(parsed.totalDistanceKm)).replace('.',',');
    const a1 = $('#newRouteAscentAuto'); if (a1) a1.value = String(Math.round(parsed.totalAscentM));

    // kompatibilita se starým polem, pokud někde čteš #newRouteDistance
    const hiddenDist = $('#newRouteDistance'); if (hiddenDist) hiddenDist.value = String(round2(parsed.totalDistanceKm));

    showToast('GPX připraveno ✅', 1200);
  }catch(e){
    console.error(e);
    showToast('Nepodařilo se načíst / spočítat GPX', 2200);
    resetCreateRouteComputedUI();
  }
}

// ✅ NOVÉ: resample z parsed.profile ({distanceKm,elevationM} v trackpointech) na pravidelný krok stepM -> profileEleM[]
function resampleProfileEleMFromParsedProfile(parsedProfile, totalDistanceKm, stepM){
  if (!Array.isArray(parsedProfile) || parsedProfile.length < 2) return [];
  const totalM = Math.max(1, Math.round((Number.isFinite(totalDistanceKm) ? totalDistanceKm : parsedProfile[parsedProfile.length-1].distanceKm) * 1000));
  const step = Math.max(1, Math.round(stepM));

  // připrav pole vzdáleností v metrech pro rychlou interpolaci
  const distM = parsedProfile.map(p=>Math.round((p.distanceKm || 0) * 1000));
  const eleM  = parsedProfile.map(p=>Number(p.elevationM || 0));

  function interpEleAtM(targetM){
    if (targetM <= distM[0]) return eleM[0];
    if (targetM >= distM[distM.length-1]) return eleM[eleM.length-1];

    // binární vyhledání
    let lo = 0, hi = distM.length - 1;
    while (hi - lo > 1){
      const mid = (lo + hi) >> 1;
      if (distM[mid] <= targetM) lo = mid;
      else hi = mid;
    }
    const d0 = distM[lo], d1 = distM[hi];
    const e0 = eleM[lo],  e1 = eleM[hi];
    const t = (targetM - d0) / Math.max(1e-9, (d1 - d0));
    return e0 + (e1 - e0) * t;
  }

  const out = [];
  for (let m=0; m<=totalM; m+=step){
    out.push(Number(interpEleAtM(m).toFixed(2)));
  }
  // dorovnej poslední bod přesně na totalM (pokud nevychází)
  const lastM = (out.length - 1) * step;
  if (lastM < totalM){
    out.push(Number(interpEleAtM(totalM).toFixed(2)));
  }
  return out;
}

on('#btnCreateRoute', 'click', async ()=>{
  $('#newRouteName').value = '';
  $('#newRouteDistance').value = '';
  $('#newRouteSource').value = state.source || 'Zwift';

  resetCreateRouteComputedUI();
  await fillCreateRouteGpxDropdown();
  // bind onchange jednou (bez duplicit)
  const sel = $('#newRouteGpx');
  if (sel && !sel.dataset.bound){
    sel.dataset.bound = '1';
    sel.addEventListener('change', ()=>{ computeAndPreviewNewRouteFromSelectedGpx().catch(()=>{}); });
  }

  openModal('modalCreateRoute');
});

on('#btnCreateRouteConfirm', 'click', async ()=>{
  const name = $('#newRouteName').value.trim();
  if (!name) return alert('Zadej název tratě.');

  const source = ($('#newRouteSource')?.value) || state.source || 'Zwift';

  // ✅ NOVÉ: vyžadujeme GPX (protože chceš všechno automaticky)
  const gpxFile = ($('#newRouteGpx')?.value || '').trim();
  if (!gpxFile){
    return alert('Vyber GPX soubor v dropdownu.');
  }

  // pokud ještě není spočítáno (např. uživatel rychle klikl), dopočítej
  if (!state.newRouteComputed || state.newRouteSelectedFile !== gpxFile){
    await computeAndPreviewNewRouteFromSelectedGpx();
  }
  if (!state.newRouteComputed){
    return alert('Nepodařilo se spočítat parametry z GPX. Zkus vybrat GPX znovu.');
  }

  const computed = state.newRouteComputed;

  const route = {
    id: uid(),
    source,
    name,
    totalDistanceKm: Number.isFinite(computed.totalDistanceKm) ? computed.totalDistanceKm : null,
    totalAscentM: Number.isFinite(computed.totalAscentM) ? computed.totalAscentM : null,
    difficulty: '',
    checkpoints: [],
    profile: Array.isArray(computed.profilePoints) ? computed.profilePoints : [],

    // ✅ NOVÉ: ukládáme i do lokální cache
    gpxUrl: computed.gpxUrl || (GPX_BASE_PATH + gpxFile),
    profileStepM: computed.profileStepM || DEFAULT_PROFILE_STEP_M,
    profileEleM: Array.isArray(computed.profileEleM) ? computed.profileEleM : []
  };

  // Optimistic UI update
  data.routes.unshift(route);
  saveData();
  closeModal('modalCreateRoute');
  renderRoutes();

  // Persist to DB immediately (DB is source of truth)
  try{
    await sheetsJsonp('upsertRoute', {
      routeId: route.id,
      source: route.source,
      name: route.name,
      totalDistanceKm: route.totalDistanceKm ?? '',
      totalAscentM: route.totalAscentM ?? '',
      difficulty: route.difficulty || '',
      // ✅ NOVÉ
      gpxUrl: route.gpxUrl ?? '',
      profileStepM: route.profileStepM ?? '',
      profileEleM: (Array.isArray(route.profileEleM) && route.profileEleM.length) ? JSON.stringify(route.profileEleM) : ''
    });
    await sheetsJsonp('replaceCheckpoints', {
      routeId: route.id,
      checkpoints: []
    });
    await refreshFromSheets(state.source);
    renderRoutes();
    showToast('Trať uložena do databáze');
  }catch(e){
    console.warn(e);
    showToast('Nepodařilo se uložit do DB – zůstává jen lokálně');
  }
});

function renderRoutes(){
  const list = $('#routesList');
  list.innerHTML = '';

  const routesAll = Array.isArray(data.routes) ? data.routes.slice() : [];

  // 1) filtr zdroje
  const routesFiltered = routesAll.filter(r => !state.source || r.source === state.source);

  // 2) seřazení podle poslední jízdy (nejnovější nahoře)
  routesFiltered.sort((a,b)=>{
    const ta = getLastRideTs(a.id);
    const tb = getLastRideTs(b.id);
    // nejdřív ty co mají jízdy, pak bez jízd
    if (tb !== ta) return tb - ta;
    // fallback: podle názvu
    return String(a.name||'').localeCompare(String(b.name||''), 'cs');
  });

  if (!routesFiltered.length){
    list.innerHTML = `<div class="pad"><div class="hint">Zatím nemáš žádné tratě. Vytvoř si první.</div></div>`;
    return;
  }

  routesFiltered.forEach(route=>{
    const ridesForRoute = data.rides.filter(r=>r.routeId===route.id);
    const count = ridesForRoute.length;

    // distance/ascent
    const distKm = Number.isFinite(route.totalDistanceKm) ? route.totalDistanceKm : null;
    const ascM = Number.isFinite(route.totalAscentM) ? Math.round(route.totalAscentM) : null;

    const distText = distKm!=null ? `${String(distKm).replace('.',',')} km` : '— km';
    const ascText  = ascM!=null ? `${ascM} m` : '— m';

    // difficulty badge from ascentBand
    const band = ascentBand(route.totalAscentM); // flat/hilly/mountain
    const diffLabel = (band==='flat') ? 'Flat' : (band==='hilly' ? 'Hilly' : 'Mountain');
    const diffIcon = (band==='flat') ? '⎯' : (band==='hilly' ? '≈' : '⛰');

    // best time
    const fin = getFinishLeaderboard(route); // používáš už v detailu
    const bestMs = fin.length ? fin[0].t : null;
    const bestText = bestMs!=null ? formatTimeShort(bestMs) : '—';

    const el = document.createElement('div');
    el.className = `route-item route-tile bg-${band}`;
    el.dataset.band = band;

    const svgDist = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20zm1-10.4V6h-2v6.2l5 3 .9-1.5-3.9-2.3z" fill="currentColor"/></svg>`;
const svgUp   = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l6 7h-4v9H10v-9H6l6-7z" fill="currentColor"/></svg>`;
const svgTrophy = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4h-3V2H8v2H5v4a5 5 0 0 0 5 5h.1A6 6 0 0 0 11 16v2H8v2h8v-2h-3v-2a6 6 0 0 0 .9-3H14a5 5 0 0 0 5-5V4zm-2 4a3 3 0 0 1-3 3V6h3v2zM7 8V6h3v5a3 3 0 0 1-3-3z" fill="currentColor"/></svg>`;
const svgPin = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2l-1 7 3 3-4 4-3-3-7 1 8-8 4-4zM5 19l4-1-3-3-1 4z" fill="currentColor"/></svg>`;

el.innerHTML = `
  <div class="route-tile__inner">
    <div class="route-tile__content">
      <div class="route-tile__title">${escapeHtml(route.name || 'Trať')}</div>

      <div class="route-tile__chips">
        <span class="rt-chip">${svgDist}<span>${distText}</span></span>
        <span class="rt-chip">${svgUp}<span>${ascText}</span></span>
        <span class="rt-chip diff"><span style="font-weight:900">${diffIcon}</span><span>${diffLabel}</span></span>
        <span class="rt-chip">${svgTrophy}<span>${bestText}</span></span>
        <span class="rt-chip">${svgPin}<span>${count} záznamů</span></span>
      </div>
    </div>

    <svg class="chev" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
`;

    el.addEventListener('click', ()=>{
      state.currentRouteId = route.id;
      showScreen('route');
    });

    list.appendChild(el);
  });
}

/* pomocná funkce – poslední jízda pro route */
function getLastRideTs(routeId){
  const rides = data.rides.filter(r=>r.routeId===routeId);
  if (!rides.length) return 0;
  let max = 0;
  for (const r of rides){
    const t = Date.parse(r.dateIso || r.dateISO || '');
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}


on('#btnHistoryAll', 'click', ()=>{
  showLeaderboard(null);
});

// ---------- Route detail ----------
function getCurrentRoute(){
  return data.routes.find(r=>r.id===state.currentRouteId) || null;
}
function updateRoute(route){
  const idx = data.routes.findIndex(r=>r.id===route.id);
  if (idx>=0){
    data.routes[idx] = route;
    saveData();
  }
}

function renderRouteDetail(){
  const route = getCurrentRoute();
  if (!route){ showScreen('routes'); return; }

  // Header
  $('#routeName').textContent = route.name || 'Trať';
  const _btnStart = $('#btnStartRide'); if (_btnStart) _btnStart.dataset.routeId = route.id;

  const distKm = Number.isFinite(route.totalDistanceKm) ? route.totalDistanceKm : null;
  const ascM = Number.isFinite(route.totalAscentM) ? Math.round(route.totalAscentM) : null;
// --- HERO background (flat/hilly/mountain) ---
const hero = $('#routeHero');
if (hero){
  hero.classList.remove('hero-flat','hero-hilly','hero-mountain');

  const band = ascentBand(route.totalAscentM); // používáš už pro dlaždice v přehledu
  hero.classList.add(`hero-${band}`);
}

  const distTxt = distKm!=null ? `${String(distKm).replace('.',',')} km` : '— km';
  const ascTxt = ascM!=null ? `${ascM} m` : '— m';

  // (ponecháno původně) Difficulty v detailu – pokud chceš sladit prahy s 0/40/100, řekni a upravím
  let diff = 'Flat';
  if (ascM!=null){
    if (ascM >= 900) diff = 'Mountain';
    else if (ascM >= 350) diff = 'Hilly';
    else diff = 'Flat';
  } else {
    diff = '—';
  }

  // --- HERO pills (no dots, aligned) ---
const pills = $('#routeHeroPills');
if (pills){
  const best = getFinishLeaderboard(route);
  const bestMs = best.length ? best[0].t : null;

  pills.innerHTML = `
    <span class="route-pill">
      ${svgIcon('distance')}
      ${distTxt}
    </span>

    <span class="route-pill">
      ${svgIcon('ascent')}
      ${ascTxt}
    </span>

    <span class="route-pill">
      ${svgIcon('diff')}
      ${diff}
    </span>

    <span class="route-pill">
      ${svgIcon('trophy')}
      ${bestMs!=null ? formatTimeShort(bestMs) : '—'}
    </span>
  `;
}

// starý řádek s tečkama už nechceme:
const rs = $('#routeStats');
if (rs) rs.innerHTML = '';


  // Best time
  const fin = getFinishLeaderboard(route);
  const bestMs = fin.length ? fin[0].t : null;
  $('#routeBest').textContent = `Nejlepší čas: ${bestMs!=null ? formatTimeShort(bestMs) : '—'}`;
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function colorForGrade(gradePct){
  // gradePct: např. +8 znamená 8% stoupání, -6 znamená 6% klesání
  const g = Math.max(-18, Math.min(18, gradePct));
  if (g >= 0){
    // green (uphill) – intenzita dle sklonu
    const t = clamp01(g / 12);
    return `rgba(${Math.round(40 + 20*t)}, ${Math.round(210 - 35*t)}, ${Math.round(110 - 30*t)}, 0.95)`;
  } else {
    // blue (downhill)
    const t = clamp01((-g) / 12);
    return `rgba(${Math.round(80 - 10*t)}, ${Math.round(160 - 20*t)}, ${Math.round(255 - 10*t)}, 0.95)`;
  }
}

  // Profile
  drawProfile(route);

  // Top 5
  const top5 = fin.slice(0,5);
  $('#top5Count').textContent = String(top5.length);
  const top5List = $('#top5List');
  top5List.innerHTML = '';
  if (!top5.length){
    top5List.innerHTML = ``;
  } else {
    top5.forEach((row, i)=>{
      const ride = data.rides.find(r=>r.id===row.rideId);
      const who = ride?.runnerName || formatDateShort(row.dateIso);
      const note = ride?.note ? ride.note : '—';
      const el = document.createElement('div');
      el.className = 'rowitem';
      el.innerHTML = `
        <div class="l">
          <div class="t">${i<3 ? `<span class="medal">${svgRibbon(i+1)}</span>` : ``}#${i+1}  ${escapeHtml(who)}</div>
          <div class="s">${escapeHtml(note)}</div>
        </div>
        <div class="r">${formatTimeShort(row.t)}</div>
      `;
      top5List.appendChild(el);
    });
  }

  // Last 3 (by date)
  const rides = getRidesForRoute(route.id).slice().sort((a,b)=> new Date(b.dateIso) - new Date(a.dateIso));
  const last3 = rides.slice(0,3);
  $('#last3Count').textContent = String(last3.length);
  const last3List = $('#last3List');
  last3List.innerHTML = '';
  if (!last3.length){
    last3List.innerHTML = ``;
  } else {
    last3.forEach((r)=>{
      const who = r.runnerName || formatDateShort(r.dateIso);
      const note = r.note ? r.note : '—';
      const el = document.createElement('div');
      el.className = 'rowitem';
      el.innerHTML = `
        <div class="l">
          <div class="t">${escapeHtml(who)}</div>
          <div class="s">${escapeHtml(note)}</div>
        </div>
        <div class="r">${formatTimeShort(r.totalMs)}</div>
      `;
      last3List.appendChild(el);
    });
  }

  // Checkpoints list (editable)
  const cpList = $('#checkpointList');
  cpList.innerHTML = '';
  if (!route.checkpoints.length){
    cpList.innerHTML = ``;
  } else {
    route.checkpoints.forEach((cp, idx)=>{
      const el = document.createElement('div');
      el.className = 'cp-row';
      const km = Number.isFinite(cp.distanceKm) ? `${String(cp.distanceKm).replace('.',',')} km` : '';
      el.innerHTML = `
        <div class="cp-dot" style="background:${escapeHtml(cp.color||'#7c8db1')}"></div>
        <div class="cp-main">
          <div class="cp-name">${escapeHtml(cp.name || `CP${idx+1}`)}</div>
          <div class="cp-sub">${km}</div>
        </div>
        <div class="cp-actions">
          <button class="cp-mini" data-act="up" ${idx===0?'disabled':''}>↑</button>
          <button class="cp-mini" data-act="down" ${idx===route.checkpoints.length-1?'disabled':''}>↓</button>
          <button class="cp-mini danger" data-act="del">Smazat</button>
        </div>
      `;
      el.querySelectorAll('button').forEach(btn=>{
        btn.addEventListener('click', (ev)=>{
          ev.stopPropagation();
          const act = btn.dataset.act;
          const i = idx;
          if (act==='del'){
            if (!confirm('Smazat checkpoint?')) return;
            route.checkpoints.splice(i,1);
            updateRoute(route); renderRouteDetail(); return;
          }
          if (act==='up' && i>0){
            const tmp = route.checkpoints[i-1]; route.checkpoints[i-1]=route.checkpoints[i]; route.checkpoints[i]=tmp;
            updateRoute(route); renderRouteDetail(); return;
          }
          if (act==='down' && i<route.checkpoints.length-1){
            const tmp = route.checkpoints[i+1]; route.checkpoints[i+1]=route.checkpoints[i]; route.checkpoints[i]=tmp;
            updateRoute(route); renderRouteDetail(); return;
          }
        });
      });
      cpList.appendChild(el);
    });
  }
}

on('#btnAddCheckpoint', 'click', ()=>{
  $('#cpName').value = '';
  $('#cpDistance').value = '';
  openModal('modalAddCheckpoint');
});
on('#btnAddCheckpointConfirm', 'click', ()=>{
  const route = getCurrentRoute(); if (!route) return;
  const name = $('#cpName').value.trim();
  if (!name) return alert('Zadej název checkpointu.');
  const dist = parseFloat(String($('#cpDistance').value).replace(',','.'));
  route.checkpoints.push({
    id: uid(),
    name,
    distanceKm: Number.isFinite(dist) ? dist : null
  });
  updateRoute(route);
  closeModal('modalAddCheckpoint');
  renderRouteDetail();
});

on('#btnImportGpx', 'click', ()=> openModal('modalImportGpx'));
on('#fileGpx', 'change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;
  try{
    const text = await file.text();
    const parsed = parseGpx(text);
    const route = getCurrentRoute(); if (!route) return;

    // ✅ NOVÉ: při ručním importu do existující tratě taky uložíme gpx parametry (ale bez gpxUrl)
    const stepM = DEFAULT_PROFILE_STEP_M;
    const profileEleM = resampleProfileEleMFromParsedProfile(parsed.profile, parsed.totalDistanceKm, stepM);
    route.profileStepM = stepM;
    route.profileEleM = profileEleM;

    route.profile = downsampleProfile(buildProfilePointsFromStepEle(parsed.totalDistanceKm, stepM, profileEleM), PROFILE_MAX_POINTS_UI);
    route.totalDistanceKm = round2(parsed.totalDistanceKm);
    route.totalAscentM = Math.round(parsed.totalAscentM);

    // If there is no Start/Cíl, suggest them (don't overwrite user's checkpoints)
    if (route.checkpoints.length === 0){
      route.checkpoints = [
        {id: uid(), name:'Start', distanceKm:0},
        {id: uid(), name:'Vrchol', distanceKm: round2(route.totalDistanceKm*0.5)},
        {id: uid(), name:'Cíl', distanceKm: route.totalDistanceKm}
      ];
    }

    updateRoute(route);
    closeModal('modalImportGpx');
    renderRouteDetail();
    alert('GPX import hotový ✅');

    // ✅ NOVÉ: pokus o uložení změn do DB (pokud existuje route v DB)
    try{
      await sheetsJsonp('upsertRoute', {
        routeId: route.id,
        source: route.source,
        name: route.name,
        totalDistanceKm: route.totalDistanceKm ?? '',
        totalAscentM: route.totalAscentM ?? '',
        difficulty: route.difficulty || '',
        gpxUrl: route.gpxUrl ?? '',
        profileStepM: route.profileStepM ?? '',
        profileEleM: (Array.isArray(route.profileEleM) && route.profileEleM.length) ? JSON.stringify(route.profileEleM) : ''
      });
      await refreshFromSheets(state.source);
    }catch(_){}
  }catch(err){
    console.error(err);
    alert('Nepodařilo se importovat GPX. Zkus jiný soubor.');
  } finally {
    $('#fileGpx').value = '';
  }
});

const _btnEditRoute = $('#btnEditRoute'); if(_btnEditRoute) _btnEditRoute.addEventListener('click', ()=>{
  const route = getCurrentRoute(); if (!route) return;
  $('#editRouteSource').value = route.source || (state.source||'Zwift');
  $('#editRouteName').value = route.name;
  $('#editRouteDistance').value = route.totalDistanceKm ?? '';
  openModal('modalEditRoute');
});
on('#btnEditRouteSave', 'click', async ()=>{
  const route = getCurrentRoute(); if (!route) return;
  const name = $('#editRouteName').value.trim();
  if (!name) return alert('Zadej název.');
  const dist = parseFloat(String($('#editRouteDistance').value).replace(',','.'));
  const source = ($('#editRouteSource')?.value) || route.source || state.source || 'Zwift';

  route.name = name;
  route.source = source;
  route.totalDistanceKm = Number.isFinite(dist) ? dist : null;

  saveData();
  closeModal('modalEditRoute');
  if (state.currentScreen === 'routes'){
    renderRoutes();
  } else {
    renderRouteDetail();
  }

  // Persist changes to DB
  try{
    await sheetsJsonp('upsertRoute', {
      routeId: route.id,
      source: route.source,
      name: route.name,
      totalDistanceKm: route.totalDistanceKm ?? '',
      totalAscentM: route.totalAscentM ?? '',
      difficulty: route.difficulty || '',
      // ✅ NOVÉ
      gpxUrl: route.gpxUrl ?? '',
      profileStepM: route.profileStepM ?? '',
      profileEleM: (Array.isArray(route.profileEleM) && route.profileEleM.length) ? JSON.stringify(route.profileEleM) : ''
    });
    await sheetsJsonp('replaceCheckpoints', {
      routeId: route.id,
      checkpoints: (route.checkpoints || []).map((cp, idx)=>({
        checkpointId: cp.id,
        order: idx+1,
        name: cp.name || '',
        distanceKm: cp.distanceKm ?? ''
      }))
    });
    await refreshFromSheets(state.source);
    if (state.currentScreen === 'routes'){
      renderRoutes();
    } else {
      renderRouteDetail();
    }
    showToast('Změny uloženy do databáze');
  }catch(e){
    console.warn(e);
    showToast('Nepodařilo se uložit změny do DB');
  }
});
on('#btnDeleteRoute', 'click', async ()=>{
  const route = getCurrentRoute(); if (!route) return;
  if (!confirm('Opravdu smazat celou trať včetně historie jízd?')) return;

  // Optimistic local removal
  data.routes = data.routes.filter(r=>r.id!==route.id);
  data.rides = data.rides.filter(r=>r.routeId!==route.id);
  saveData();
  closeModal('modalEditRoute');
  state.currentRouteId = null;
  showScreen('routes');
  renderRoutes();

  // DB removal
  try{
    await sheetsJsonp('deleteRoute', { routeId: route.id });
    await refreshFromSheets(state.source);
    renderRoutes();
    showToast('Trať smazána z databáze');
  }catch(e){
    console.warn(e);
    showToast('Nepodařilo se smazat v DB – zkontroluj připojení');
  }
});



// ---------- Stats helpers (leaderboards for checkpoints / finish) ----------
function getRidesForRoute(routeId){
  return data.rides.filter(r=>r.routeId===routeId);
}
function getCheckpointLeaderboard(route, cpIndex){
  const rides = getRidesForRoute(route.id);
  const out = [];
  for (const r of rides){
    if (!Array.isArray(r.marks)) continue;
    if (r.marks.length > cpIndex){
      const t = r.marks[cpIndex]?.elapsedMs;
      if (Number.isFinite(t)) out.push({t, dateIso:r.dateIso, rideId:r.id});
    }
  }
  out.sort((a,b)=>a.t-b.t);
  return out;
}
function getFinishLeaderboard(route){
  return getRidesForRoute(route.id)
    .filter(r=>Number.isFinite(r.totalMs))
    .map(r=>({t:r.totalMs, dateIso:r.dateIso, rideId:r.id}))
    .sort((a,b)=>a.t-b.t);
}
function formatDateShort(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleDateString('cs-CZ', {day:'2-digit', month:'2-digit', year:'numeric'});
  }catch{ return '—';}
}
function computeRank(sortedTimes, elapsed){
  // sortedTimes: [{t,...}] ascending
  let pos = 1;
  for (let i=0;i<sortedTimes.length;i++){
    if (elapsed <= sortedTimes[i].t) { pos = i+1; return {pos, total: sortedTimes.length+1}; }
  }
  return {pos: sortedTimes.length+1, total: sortedTimes.length+1};
}
function deltaToBest(sortedTimes, elapsed){
  if (!sortedTimes.length) return null;
  return elapsed - sortedTimes[0].t; // positive => behind
}

function pickTvTarget(sortedTimes, currentElapsed){
  if (!sortedTimes.length) return null;
  for (let i=0;i<sortedTimes.length;i++){
    if (sortedTimes[i].t >= currentElapsed){
      return {rank: i+1, t: sortedTimes[i].t, dateIso: sortedTimes[i].dateIso};
    }
  }
  const last = sortedTimes[sortedTimes.length-1];
  return {rank: sortedTimes.length, t: last.t, dateIso: last.dateIso, behindLast:true};
}


$('#btnCancelRide')?.addEventListener('click', ()=>{
  if (!state.ride) return;
  const ok = confirm('Zrušit jízdu bez uložení?');
  if (!ok) return;
  stopTicker();
  state.ride = null;
  showToast('Jízda zrušena.', 1800);
  showScreen('route');
});

// ---------- Ride logic ----------
let raf = null;

function startRide(routeId){
  // ✅ tvrdý reset render smyčky a UI timeru (fix "58s a přitom Start")
  try { if (raf) cancelAnimationFrame(raf); } catch(e){}
  raf = null;

  const t = $('#rideTimer');
  if (t) t.textContent = '00:00:00';

  // Always start a fresh ride session
  if (state.rideTimer){ clearInterval(state.rideTimer); state.rideTimer=null; }
  state.ride = {
    routeId,
    startMs: null,
    running: false,
    marks: [],
    stoppedMs: null,
    lastRankCp: null,
    visual: { segIdx: 0, segStartMs: 0, offsetPx: 0 }
  };

  // ... zbytek nech jak máš
  try{ const r=getCurrentRoute(); if(r) resetDuelForRide(r);}catch(e){}
  $('#rideNote').value = '';
  $('#rideRunnerName').value = '';

  tick();
}


function tick(){
  if (!state.ride) return;
  // If user left ride screen, stop the timer to avoid stale updates
  if (state.screen !== 'ride') return;
  if (state.ride.running){
    const elapsed = state.ride.startMs==null ? 0 : (nowMs() - state.ride.startMs);
    $('#rideTimer').textContent = formatTime(elapsed);
  } else if (state.ride.stoppedMs != null){
    $('#rideTimer').textContent = formatTime(state.ride.stoppedMs);
  }
    try{
    if (state.screen==='ride'){
      const route = getCurrentRoute();
      if (route){
        const elapsed = (state.ride.startMs==null) ? 0 :
          (state.ride.running ? (nowMs()-state.ride.startMs) : (state.ride.stoppedMs ?? 0));

        const ghostKm = getBestGhostKmAtElapsed(route, elapsed);
        drawMiniProfile(route, ghostKm);
        renderUpcomingCpRank(route, elapsed); // ✅ TV pořadí na NADCHÁZEJÍCÍ CP
      }
    }
  }catch(e){}

  raf = requestAnimationFrame(tick);
}

function stopRide(){
  if (!state.ride) return;
  if (!state.ride.running) return;
  state.ride.running = false;
  state.ride.stoppedMs = nowMs() - state.ride.startMs;
  // no direct save button on ride screen

  // Finish rank toast (TV)
  try{
    const route = getCurrentRoute();
    if (route){
      const finLb = getFinishLeaderboard(route);
      const total = state.ride.stoppedMs;
      const rankInfo = computeRank(finLb, total);
      const dBest = deltaToBest(finLb, total);
      const deltaTxt = (dBest==null) ? '—' : (dBest<=0 ? `-${formatTimeShort(Math.abs(dBest))} před #1` : `+${formatTimeShort(dBest)} za #1`);
      showToast(`Cíl: <b>${formatTimeShort(total)}</b><small>Umístění v cíli: #${rankInfo.pos}/${rankInfo.total} • ${deltaTxt}</small>`, 3200);
    }
  }catch(e){}
}

function rideNextCheckpoint(){
  const route = getCurrentRoute();
  if (!route || !state.ride || !state.ride.running) return;
  const idx = state.ride.marks.length;
  // If all checkpoints done, next is Finish
  if (idx >= route.checkpoints.length){
    stopRide();
    // convenience: open save dialog
    try{ openSaveRide(); }catch(e){}
    return;
  }
  const cp = route.checkpoints[idx];
  const elapsed = state.ride.startMs==null ? 0 : (nowMs() - state.ride.startMs);
  state.ride.marks.push({ checkpointId: cp.id, elapsedMs: elapsed });

  // TV update: rank at this checkpoint
  const lb = getCheckpointLeaderboard(route, idx);
  const rankInfo = computeRank(lb, elapsed);
  const dBest = deltaToBest(lb, elapsed);
  const prevRank = state.ride.lastRankCp;
  state.ride.lastRankCp = rankInfo.pos;

  const deltaTxt = (dBest==null) ? '—' : (dBest<=0 ? `-${formatTimeShort(Math.abs(dBest))} před #1` : `+${formatTimeShort(dBest)} za #1`);
  const changeTxt = (prevRank==null) ? '' : (rankInfo.pos>prevRank ? ` • propad na #${rankInfo.pos}` : (rankInfo.pos<prevRank ? ` • posun na #${rankInfo.pos}` : ` • držíš #${rankInfo.pos}`));

  showToast(
    `${escapeHtml(cp.name)}: <b>${formatTimeShort(elapsed)}</b><small>Umístění na CP: #${rankInfo.pos}/${rankInfo.total}${changeTxt} • ${deltaTxt}</small>`,
    2600
  );

  renderRide();
}

function rideUndo(){
  if (!state.ride) return;
  state.ride.marks.pop();
  renderRide();
}

function renderRide(){
  const route = getCurrentRoute();
  if (!route || !state.ride) return;

  // --- Tile 1: header/meta/progress/profile ---
  const titleEl = $('#rideRouteTitle');
  if (titleEl) titleEl.textContent = route.name;

  const sourcePill = $('#rideSourcePill');
  if (sourcePill) sourcePill.textContent = state.source || route.source || '—';

  const dist = Number.isFinite(route.totalDistanceKm) ? route.totalDistanceKm : null;
  const asc  = Number.isFinite(route.totalAscentM) ? route.totalAscentM : null;
  const distEl = $('#rideMetaDistance');
  const ascEl  = $('#rideMetaAscent');
  if (distEl) distEl.textContent = dist!=null ? `${String(dist).replace('.',',')} km` : '— km';
  if (ascEl)  ascEl.textContent  = asc!=null ? `${Math.round(asc)} m` : '— m';

  const diffIcon = $('#rideDiffIcon');
  if (diffIcon){
    diffIcon.className = 'diff-icon';
    diffIcon.classList.add(((route.difficulty||'flat').toLowerCase()) || 'flat');
  }

  const cps = Array.isArray(route.checkpoints) ? route.checkpoints : [];
  const doneCount = (state.ride.marks||[]).length;

  const dotsEl = $('#rideProgressDots');
  if (dotsEl){
    dotsEl.innerHTML = '';
    for (let i=0;i<cps.length;i++){
      const dot = document.createElement('div');
      dot.className = 'cp-dot2';
      if (i < doneCount) dot.classList.add('done');
      if (i === doneCount) dot.classList.add('next');
      dot.innerHTML = `<span>${i+1}</span>`;
      dotsEl.appendChild(dot);
    }
  }
  const progText = $('#rideProgressText');
  if (progText){
    progText.textContent = `Checkpointy: ${Math.min(doneCount,cps.length)}/${cps.length} • Další: ${cps[doneCount]?.name ?? '—'}`;
  }

  try{ drawMiniProfile(route); }catch(e){}

  // --- Tile 2: timer + button label ---
  const btn = $('#btnNextCheckpoint');
  if (btn){
    btn.classList.add('primary','big','pulse');
    const setBtn = (main, sub, mode)=>{
      if (sub){
        btn.innerHTML = `<div class="btn-main">${escapeHtml(main)}</div><div class="btn-sub">${escapeHtml(sub)}</div>`;
      } else {
        btn.innerHTML = `<div class="btn-main">${escapeHtml(main)}</div>`;
      }
      btn.dataset.mode = mode;
    };

    if (state.ride.startMs==null && !state.ride.running && doneCount===0){
      setBtn('Start', null, 'start');
    } else {
      const cp = cps[doneCount];
      const kmVal = Number.isFinite(cp?.distanceKm) ? cp.distanceKm : null;
      const kmTxt = kmVal!=null ? `${String(kmVal).replace('.',',')} km` : null;
      const isFinish = !cp || (doneCount >= cps.length-1) || ((cp.name||'').toLowerCase().includes('cíl'));
      if (isFinish){
        setBtn('CÍL – Ukončit', kmTxt, 'finish');
      } else {
        setBtn('Další checkpoint', kmTxt, 'next');
      }
    }
  }

  // --- Tile 3 + 4 ---
  try{ renderRideTVCompare(route); }catch(e){}
  try{ renderDuelMarks(route); updateDuelPositions(route); }catch(e){}
}

function drawMiniProfile(route, ghostKm){
  const c = $('#rideMiniProfile');
  if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0,0,w,h);

  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ctx.fillRect(0,0,w,h);

  const prof = Array.isArray(route.profile) ? route.profile : [];
  if (prof.length < 2){
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0,h*0.6); ctx.lineTo(w,h*0.6); ctx.stroke();
    return;
  }

  // ✅ tvoje data v route.profile jsou {distanceKm,elevationM} (v jiných částech máš i d/e – tady sjednotíme)
  const pts = prof.map(p=>({
    distanceKm: Number(p.distanceKm ?? p.d),
    elevationM: Number(p.elevationM ?? p.e)
  })).filter(p=>Number.isFinite(p.distanceKm) && Number.isFinite(p.elevationM))
    .sort((a,b)=>a.distanceKm-b.distanceKm);

  if (pts.length < 2) return;

  const maxD = pts[pts.length-1].distanceKm || 1;

  let minE=Infinity, maxE=-Infinity;
  pts.forEach(p=>{ minE=Math.min(minE,p.elevationM); maxE=Math.max(maxE,p.elevationM); });
  const eSpan = Math.max(1,(maxE-minE));

  ctx.beginPath();
  pts.forEach((p,i)=>{
    const x = (p.distanceKm/maxD)*w;
    const y = h - ((p.elevationM-minE)/eSpan)*(h*0.78) - h*0.08;
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });

  const grad = ctx.createLinearGradient(0,0,w,0);
  grad.addColorStop(0,'rgba(88,255,136,0.28)');
  grad.addColorStop(0.5,'rgba(255,212,87,0.22)');
  grad.addColorStop(1,'rgba(96,166,255,0.24)');
  ctx.lineWidth = 6;
  ctx.strokeStyle = grad;
  ctx.stroke();

  ctx.lineTo(w,h);
  ctx.lineTo(0,h);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0,0,0,h);
  fill.addColorStop(0,'rgba(88,255,136,0.14)');
  fill.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle = fill;
  ctx.fill();

  // checkpoint lines
  const cps = route.checkpoints || [];
  cps.forEach((cp, idx)=>{
    if (!Number.isFinite(cp.distanceKm) || !Number.isFinite(route.totalDistanceKm) || route.totalDistanceKm<=0) return;
    const x = (cp.distanceKm/route.totalDistanceKm)*w;
    ctx.strokeStyle = idx===cps.length-1 ? 'rgba(255,255,255,0.20)' : 'rgba(255,212,87,0.24)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke();
  });

  // ✅ SMOOTH ghost dot (best overall) – draw on the line
  if (Number.isFinite(ghostKm)){
    const gx = (ghostKm / maxD) * w;
    const ge = interpEleAtKmFromProfile(pts, ghostKm);
    if (ge != null){
      const gy = h - ((ge-minE)/eSpan)*(h*0.78) - h*0.08;

      // outer glow
      ctx.save();
      ctx.beginPath();
      ctx.arc(gx, gy, 9, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(64, 170, 255, 0.18)';
      ctx.fill();

      // ring
      ctx.beginPath();
      ctx.arc(gx, gy, 6, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(64, 170, 255, 0.95)';
      ctx.fill();

      // inner
      ctx.beginPath();
      ctx.arc(gx, gy, 3, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.restore();
    }
  }
}



function renderRideTVCompare(route){
  const ride = state.ride;
  const best = getBestTimes(route.id);

  const elapsed = (ride.startMs==null) ? 0 : (ride.running ? (nowMs()-ride.startMs) : (ride.stoppedMs ?? 0));
  const lastIdx = Math.max(0, ride.marks.length-1);

  const yourAtLast = (ride.marks[lastIdx]?.elapsedMs ?? 0);
  const bestAtLast = best?.splits?.[lastIdx] ?? null;

  let lossText = '—';
  if (bestAtLast!=null && yourAtLast>0){
    const diff = yourAtLast - bestAtLast;
    lossText = (diff>=0?'+':'-') + formatTimeShort(Math.abs(diff));
  } else if (best?.finishMs!=null && elapsed>0){
    const diff = elapsed - best.finishMs;
    lossText = (diff>=0?'+':'-') + formatTimeShort(Math.abs(diff));
  }

  const lossEl = $('#cmpLossBest'); if (lossEl) lossEl.textContent = lossText;

  const nextIdx = ride.marks.length;
  const nextBest = best?.splits?.[nextIdx] ?? null;
  const nextName = route.checkpoints?.[nextIdx]?.name ?? '—';
  const finishBest = best?.finishMs ?? null;

  const subEl = $('#cmpLossSub');
  if (subEl){
    const a = (nextBest!=null && elapsed>0) ? `Další CP: ` + ((elapsed-nextBest)>=0?'+':'-') + formatTimeShort(Math.abs(elapsed-nextBest)) : `Další CP: —`;
    const b = (finishBest!=null && elapsed>0) ? `Cíl: ` + ((elapsed-finishBest)>=0?'+':'-') + formatTimeShort(Math.abs(elapsed-finishBest)) : 'Cíl: —';
    subEl.textContent = `${a} • ${b}`;
  }

  const rowsEl = $('#tvRankRows');
  if (rowsEl){
    rowsEl.innerHTML = '';
    const lb = getCheckpointLeaderboard(route.id, lastIdx);
    const yourTime = (yourAtLast>0) ? yourAtLast : elapsed;
    const all = lb.slice(0);
    all.push({label:'Ty', timeMs: yourTime, me:true});
    all.sort((a,b)=>a.timeMs-b.timeMs);

    const meIndex = all.findIndex(x=>x.me);
    const pick = [];
    if (meIndex>0) pick.push(all[meIndex-1]);
    pick.push(all[meIndex]);
    if (meIndex<all.length-1) pick.push(all[meIndex+1]);

    pick.forEach((r)=>{
      const div = document.createElement('div');
      div.className = 'rank-row' + (r.me ? ' me' : '');
      const rank = all.indexOf(r) + 1;
      const who = r.me ? 'Ty' : (r.label || 'Záznam');
      div.innerHTML = `<div class="who"><span class="rank">#${rank}</span> ${escapeHtml(who)}</div><div class="t">${formatTime(r.timeMs)}</div>`;
      rowsEl.appendChild(div);
    });
  }

  const modeEl = $('#compareMode');
  if (modeEl) modeEl.textContent = state.source || route.source || '—';
}

function getBestTimes(routeId){
  const rides = getRidesForRoute(routeId);
  if (!rides.length) return null;

  // Normalize (backward compatible)
  const norm = rides.map(r=>{
    const finishMs = (r.finishMs!=null) ? r.finishMs : (r.totalMs!=null ? r.totalMs : null);
    let splits = r.splits;
    if (!Array.isArray(splits) && Array.isArray(r.marks)){
      splits = r.marks.map(m=>m.elapsedMs);
    }
    return {finishMs, splits: Array.isArray(splits)? splits : [], raw:r};
  }).filter(x=>x.finishMs!=null);

  if (!norm.length) return null;
  norm.sort((a,b)=>a.finishMs-b.finishMs);
  return {finishMs: norm[0].finishMs, splits: norm[0].splits};
}

function getCheckpointLeaderboard(routeId, cpIdx){
  const rides = getRidesForRoute(routeId);
  const rows = [];
  rides.forEach(r=>{
    let splits = r.splits;
    if (!Array.isArray(splits) && Array.isArray(r.marks)){
      splits = r.marks.map(m=>m.elapsedMs);
    }
    const t = (Array.isArray(splits) && splits.length>cpIdx) ? splits[cpIdx] : null;
    if (t!=null){
      const label = r.runnerName || r.label || r.dateLabel || (r.dateIso ? new Date(r.dateIso).toLocaleDateString('cs-CZ') : 'Záznam');
      rows.push({label, timeMs: t});
    }
  });
  rows.sort((a,b)=>a.timeMs-b.timeMs);
  return rows;
}

function renderDuelMarks(route){
  const marksEl = $('#trackMarks');
  if (!marksEl) return;
  marksEl.innerHTML = '';
  const cps = route.checkpoints || [];
  const total = cps.length;
  for (let i=0;i<total;i++){
    const cp = cps[i];
    const ratio = (Number.isFinite(cp.distanceKm) && Number.isFinite(route.totalDistanceKm) && route.totalDistanceKm>0)
      ? (cp.distanceKm/route.totalDistanceKm)
      : (i/(Math.max(1,total-1)));

    const mark = document.createElement('div');
    mark.className = 'mark';
    if (i < (state.ride?.marks?.length||0)) mark.classList.add('done');
    mark.style.left = `${ratio*100}%`;
    marksEl.appendChild(mark);

    const label = document.createElement('div');
    label.className = 'label';
    label.style.left = `${ratio*100}%`;
    label.textContent = (i===0?'START': (i===total-1?'CÍL': `CP${i+1}`));
    marksEl.appendChild(label);
  }
}

function updateDuelPositions(route){
  const ride = state.ride;
  if (!ride) return;
  const best = getBestTimes(route.id);
  const elapsed = (ride.startMs==null) ? 0 : (ride.running ? (nowMs()-ride.startMs) : (ride.stoppedMs ?? 0));

  let bestRatio = 0;
  if (best && Array.isArray(best.splits) && best.splits.length && elapsed>0){
    const times = best.splits.slice(0, (route.checkpoints||[]).length);
    let seg=0; while (seg<times.length && times[seg]<elapsed) seg++;
    if (seg<=0) bestRatio=0;
    else if (seg>=times.length) bestRatio=1;
    else {
      const t0=times[seg-1], t1=times[seg];
      const r0=ratioForCp(route, seg-1), r1=ratioForCp(route, seg);
      bestRatio = r0 + (r1-r0)*clamp((elapsed-t0)/Math.max(1,(t1-t0)),0,1);
    }
  }

  const cps = route.checkpoints || [];
  const nextIdx = ride.marks.length;
  const r0 = ratioForCp(route, Math.max(0,nextIdx-1));
  const r1 = ratioForCp(route, Math.min(cps.length-1,nextIdx));
  let yourRatio = r0;
  if (ride.running && elapsed>0){
    const t0 = (nextIdx-1>=0) ? (ride.marks[nextIdx-1]?.elapsedMs ?? 0) : 0;
    let segDur = 8000;
    if (best && best.splits && best.splits.length>nextIdx){
      const bt0 = (nextIdx-1>=0) ? best.splits[nextIdx-1] : 0;
      segDur = Math.max(1500, best.splits[nextIdx]-bt0);
    }
    yourRatio = r0 + (r1-r0)*clamp((elapsed-t0)/segDur,0,1);
  }

  const track = $('#duelTrack');
  if (!track) return;
  const pad = 12;
  const w = track.clientWidth - pad*2;
  const xBest = pad + w*bestRatio;
  const xYou  = pad + w*yourRatio;

  const rb=$('#riderBest'); const ry=$('#riderYou');
  if (rb) rb.style.left = `${xBest}px`;
  if (ry) ry.style.left = `${xYou}px`;

  const gap=$('#duelGap');
  if (gap){
    if (best?.finishMs!=null && elapsed>0){
      const diff = elapsed - best.finishMs;
      gap.textContent = (diff>=0?'+':'-') + formatTimeShort(Math.abs(diff));
    } else gap.textContent='—';
  }
}

function ratioForCp(route, idx){
  const cps = route.checkpoints || [];
  const total = cps.length;
  const cp = cps[idx];
  if (!cp) return (total<=1?0:idx/(total-1));
  if (Number.isFinite(cp.distanceKm) && Number.isFinite(route.totalDistanceKm) && route.totalDistanceKm>0){
    return clamp(cp.distanceKm/route.totalDistanceKm,0,1);
  }
  return (total<=1?0:idx/(total-1));
}

function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function formatTimeShort(ms){
  const s=Math.round(ms/1000);
  const m=Math.floor(s/60);
  const r=s%60;
  return `${m}:${String(r).padStart(2,'0')}`;
}

$('#btnNextCheckpoint')?.addEventListener('click', ()=>{
  const route = getCurrentRoute();
  if (!route || !state.ride) return;

  // Start (timer starts only after explicit Start)
  if (state.ride.startMs==null && !state.ride.running && (state.ride.marks||[]).length===0){
    state.ride.startMs = nowMs();
    state.ride.running = true;
    renderRide();
    return;
  }

  // Next checkpoint / finish
  rideNextCheckpoint();
  renderRide();
});
$('#btnUndo')?.addEventListener('click', rideUndo);
$('#btnStopRide')?.addEventListener('click', ()=>{
  stopRide();
  renderRide();
  openSaveRide();
});
$('#btnSaveRide')?.addEventListener('click', openSaveRide);

function openSaveRide(){
  if (!state.ride) return;
  if (state.ride.running){
    // stop first
    stopRide();
  }
  const route = getCurrentRoute(); if (!route) return;
  const total = state.ride.stoppedMs ?? (nowMs()-state.ride.startMs);
  const marks = state.ride.marks;

  const lines = [];
  lines.push(`<b>Trať:</b> ${escapeHtml(route.name)}`);
  lines.push(`<b>Čas:</b> ${formatTimeShort(total)}`);
  if (marks.length){
    const last = marks[marks.length-1].elapsedMs;
    lines.push(`<b>Checkpointy:</b> ${marks.length}/${route.checkpoints.length} (poslední ${formatTimeShort(last)})`);
  }
  $('#saveRideSummary').innerHTML = lines.join('<br/>');
  if (!$('#rideRunnerName').value){
    $('#rideRunnerName').value = `Pokus ${new Date().toLocaleDateString('cs-CZ')}`;
  }
  openModal('modalSaveRide');
}

on('#btnSaveRideConfirm', 'click', ()=>{
  const route = getCurrentRoute(); if (!route || !state.ride) return;
  const total = state.ride.stoppedMs ?? (nowMs()-state.ride.startMs);

  // Store ride
  const ride = {
    id: uid(),
    routeId: route.id,
    dateIso: new Date().toISOString(),
    totalMs: Math.round(total),
    finishMs: Math.round(total),
    splits: state.ride.marks.map(m=>Math.round(m.elapsedMs)),
    marks: state.ride.marks.map(m=>({ checkpointId: m.checkpointId, elapsedMs: Math.round(m.elapsedMs) })),
    runnerName: ($('#rideRunnerName').value || '').trim() || null,
    note: $('#rideNote').value.trim() || null,
  };
  data.rides.unshift(ride);
  saveData();
  // Auto-sync to Google Sheets (queued for offline)
  queueRideForSync(ride);
  syncPending().catch(()=>{});

  closeModal('modalSaveRide');

  // cleanup
  state.ride = null;
  if (raf) cancelAnimationFrame(raf);
  raf = null;

  // back to route detail
  showScreen('route');
  alert('Uloženo ✅');
});

// ---------- Leaderboard ----------
function showSegmentLeaderboard(){
  const route = getCurrentRoute();
  if (!route) return;
  const body = $('#segBody');
  body.innerHTML = '';
  $('#segTitle').textContent = `Žebříček checkpointů – ${route.name}`;
  $('#segHint').textContent = 'Top 5 pro každý checkpoint (a cíl). Každý záznam = „závodník“ (název pokusu nebo datum).';

  // For each checkpoint index
  route.checkpoints.forEach((cp, idx)=>{
    const lb = getCheckpointLeaderboard(route, idx);
    const card = document.createElement('div');
    card.className = 'seg-card';
    card.innerHTML = `<div class="h">${escapeHtml(cp.name)} (CP${idx+1})</div>`;
    if (!lb.length){
      card.innerHTML += `<div class="hint">Zatím žádné záznamy.</div>`;
    } else {
      lb.slice(0,5).forEach((row, i)=>{
        const ride = data.rides.find(r=>r.id===row.rideId);
        const who = ride?.runnerName ? escapeHtml(ride.runnerName) : formatDateShort(row.dateIso);
        const note = ride?.note ? escapeHtml(ride.note) : '—';
        const div = document.createElement('div');
        div.className = 'seg-row';
        div.innerHTML = `<div class="seg-rank">#${i+1}</div><div class="seg-name">${who}<span class="seg-sub">${note}</span></div><div class="seg-time">${formatTimeShort(row.t)}</div>`;
        card.appendChild(div);
      });
    }
    body.appendChild(card);
  });

  // Finish
  const fin = getFinishLeaderboard(route);
  const card = document.createElement('div');
  card.className = 'seg-card';
  card.innerHTML = `<div class="h">Cíl</div>`;
  if (!fin.length){
    card.innerHTML += `<div class="hint">Zatím žádné záznamy.</div>`;
  } else {
    fin.slice(0,5).forEach((row, i)=>{
      const ride = data.rides.find(r=>r.id===row.rideId);
      const who = ride?.runnerName ? escapeHtml(ride.runnerName) : formatDateShort(row.dateIso);
      const note = ride?.note ? escapeHtml(ride.note) : '—';
      const div = document.createElement('div');
      div.className = 'seg-row';
      div.innerHTML = `<div class="seg-rank">#${i+1}</div><div class="seg-name">${who}<span class="seg-sub">${note}</span></div><div class="seg-time">${formatTimeShort(row.t)}</div>`;
      card.appendChild(div);
    });
  }
  body.appendChild(card);

  openModal('modalSegmentLeaderboard');
}

function showLeaderboard(routeIdOrNull){
  const list = $('#leaderList');
  list.innerHTML = '';

  let rides = data.rides.slice();
  // Filter by selected source (Zwift/Kinomap)
  if (state.source){
    const routeIds = new Set(data.routes.filter(r=>r.source===state.source).map(r=>r.id));
    rides = rides.filter(r=>routeIds.has(r.routeId));
  }
  let title = 'Historie & Žebříček';
  let hint = 'Seřazeno podle celkového času (nejrychlejší nahoře).';

  if (routeIdOrNull){
    const route = data.routes.find(r=>r.id===routeIdOrNull);
    title = `Žebříček – ${route?.name ?? 'Trať'}`;
    rides = rides.filter(r=>r.routeId===routeIdOrNull);
    hint = `Počet jízd: ${rides.length}. ${hint}`;
  } else {
    hint = `${state.source ? (state.source + ': ') : ''}Všechny tratě. ${hint}`;
  }

  rides.sort((a,b)=>a.totalMs - b.totalMs);

  $('#leaderTitle').textContent = title;
  $('#leaderHint').textContent = hint;

  if (!rides.length){
    list.innerHTML = `<div class="hint">Zatím žádné uložené jízdy.</div>`;
    openModal('modalLeaderboard');
    return;
  }

  rides.slice(0, 60).forEach((r, i)=>{
    const route = data.routes.find(x=>x.id===r.routeId);
    const el = document.createElement('div');
    el.className = 'leader-item';
    const date = new Date(r.dateIso);
    const dateText = date.toLocaleDateString('cs-CZ', {day:'2-digit', month:'2-digit', year:'numeric'});
    const timeText = formatTimeShort(r.totalMs);
    const who = r.runnerName ? escapeHtml(r.runnerName) : dateText;
    el.innerHTML = `
      <div class="rank">#${i+1}</div>
      <div class="main">
        <div class="d">${escapeHtml(route?.name ?? 'Trať')} • ${who}</div>
        <div class="s">${r.note ? escapeHtml(r.note) : '—'}</div>
      </div>
      <div class="time">${timeText}</div>
    `;
    list.appendChild(el);
  });

  openModal('modalLeaderboard');
}

// ---------- Export / Import / Reset ----------
on('#btnExport', 'click', ()=>{
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `splittimer-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
});

on('#fileImportJson', 'change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;
  try{
    const obj = JSON.parse(await file.text());
    if (!obj || !Array.isArray(obj.routes) || !Array.isArray(obj.rides)) throw new Error('bad format');
    data = obj;
    saveData();
    closeModal('modalMenu');
    showScreen('routes');
    alert('Import hotový ✅');
  }catch{
    alert('Neplatný soubor.');
  } finally {
    $('#fileImportJson').value = '';
  }
});

on('#btnReset', 'click', ()=>{
  if (!confirm('Opravdu smazat všechna data?')) return;
  localStorage.removeItem(STORAGE_KEY);
  data = loadData();
  closeModal('modalMenu');
  showScreen('routes');
});



function svgDifficulty(kind){
  if (kind==='Flat'){
    return `<svg class="diffsvg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h16" stroke="#33d17a" stroke-width="3.2" stroke-linecap="round" />
    </svg>`;
  }
  if (kind==='Hilly'){
    return `<svg class="diffsvg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 14c3-6 6 6 9 0s6 6 9 0" fill="none" stroke="#f6d32d" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  if (kind==='Mountain'){
    return `<svg class="diffsvg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 16l5-8 4 6 3-5 4 7" fill="none" stroke="#ff5c5c" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  return `<svg class="diffsvg" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 12h16" stroke="rgba(255,255,255,.35)" stroke-width="3.2" stroke-linecap="round" />
  </svg>`;
}
function svgIcon(kind){
  if (kind==='distance'){
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M7 9v6M17 9v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  }
  if (kind==='ascent'){
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 17l5-10 5 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  if (kind==='diff'){
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 15c3-6 6 6 9 0s6 6 7 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  if (kind==='trophy'){
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4h8v3c0 3-2 5-4 5s-4-2-4-5V4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M10 18h4M9 20h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M8 7H5c0 3 2 5 4 5M16 7h3c0 3-2 5-4 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  }
  return '';
}

function svgRibbon(rank){
  const fill = rank===1 ? "#ffd166" : (rank===2 ? "#cfd8dc" : "#d19a66");
  const stroke = "rgba(0,0,0,.18)";
  return `<svg class="ribbon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 3h8l-1 8-3 2-3-2L8 3z" fill="${fill}" stroke="${stroke}" stroke-width="1"/>
    <path d="M9 13l-2 8 5-3 5 3-2-8" fill="${fill}" opacity=".9" stroke="${stroke}" stroke-width="1"/>
  </svg>`;
}

// ---------- Duel track helpers ----------
function getCheckpointFractions(route){
  const cps = route.checkpoints || [];
  // If checkpoints include distanceKm, use it; else equally spaced.
  const dists = cps.map(c=>Number.isFinite(c.distanceKm)?c.distanceKm:null);
  const have = dists.some(v=>v!=null);
  if (have){
    const max = Math.max(...dists.filter(v=>v!=null));
    const end = Number.isFinite(route.totalDistanceKm) ? route.totalDistanceKm : max;
    const denom = (end && end>0) ? end : (max || 1);
    return cps.map((c,i)=>{
      const v = Number.isFinite(c.distanceKm) ? c.distanceKm/denom : (i/(Math.max(1,cps.length-1)));
      return Math.min(1, Math.max(0, v));
    });
  }
  const n = Math.max(1, cps.length-1);
  return cps.map((_, i)=> i/n);
}

function renderTrackMarks(route){
  const marks = $('#trackMarks');
  if (!marks) return;
  marks.innerHTML = '';
  const fr = getCheckpointFractions(route);
  fr.forEach((f, i)=>{
    const div = document.createElement('div');
    div.className = 'duel-mark';
    div.style.left = `${f*100}%`;
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = (i===0) ? 'START' : (i===fr.length-1 ? 'CÍL' : `CP${i+1}`);
    div.appendChild(lbl);
    marks.appendChild(div);
  });
}

function getBestRideForRoute(route){
  const fin = getFinishLeaderboard(route);
  if (!fin.length) return null;
  const bestId = fin[0].rideId;
  return data.rides.find(r=>r.id===bestId) || null;
}

function getBestCumulativeTimes(route){
  const bestRide = getBestRideForRoute(route);
  const cps = route.checkpoints || [];
  const times = [];
  for (let i=0;i<cps.length;i++){
    let t = null;
    if (bestRide && Array.isArray(bestRide.marks) && bestRide.marks.length>i && Number.isFinite(bestRide.marks[i]?.elapsedMs)){
      t = bestRide.marks[i].elapsedMs;
    } else {
      const lb = getCheckpointLeaderboard(route, i);
      if (lb.length) t = lb[0].t;
    }
    times.push(t);
  }
  const fin = getFinishLeaderboard(route);
  if (times.length && (times[times.length-1]==null) && fin.length) times[times.length-1] = fin[0].t;
  return times;
}

function pxWithinTrack(fraction){
  const track = $('#track');
  if (!track) return 0;
  const pad = 14;
  const w = track.clientWidth - pad*2;
  return pad + w * Math.min(1, Math.max(0, fraction));
}

function setRiderLeft(id, px){
  const el = $('#'+id);
  const track = $('#track');
  if (!el || !track || !track.clientWidth) return;
  const left = (px / track.clientWidth) * 100;
  el.style.left = `${left}%`;
}

function resetDuelForRide(route){
  if (!state.ride) return;
  state.ride.visual = { segIdx: 0, segStartMs: 0, offsetPx: 0 };
  renderTrackMarks(route);
  const p0 = pxWithinTrack(0);
  setRiderLeft('riderBest', p0);
  setRiderLeft('riderYou', p0);
}

function updateOffsetOnCheckpoint(route, checkpointIdx, elapsedAtCp){
  const bestTimes = getBestCumulativeTimes(route);
  const bestAt = bestTimes[checkpointIdx] ?? null;
  if (bestAt == null) return;

  const delta = elapsedAtCp - bestAt; // + behind
  const steps = Math.floor(Math.abs(delta) / 5000); // 5s steps
  const dir = delta > 0 ? -1 : +1; // behind -> back
  const stepPx = 10;
  state.ride.visual.offsetPx = dir * steps * stepPx;

  state.ride.visual.segIdx = checkpointIdx;
  state.ride.visual.segStartMs = elapsedAtCp;
}

function updateDuelPositions(route){
  const ride = state.ride;
  if (!route || !ride) return;
  const fr = getCheckpointFractions(route);
  if (!fr.length) return;

  const bestTimes = getBestCumulativeTimes(route);
  const segIdx = Math.min(ride.visual?.segIdx ?? 0, fr.length-1);
  const segStartF = fr[segIdx] ?? 0;
  const segEndF = fr[Math.min(segIdx+1, fr.length-1)] ?? 1;

  const tStart = segIdx===0 ? 0 : (bestTimes[segIdx-1] ?? 0);
  const tEnd = bestTimes[segIdx] ?? (tStart + 60000);
  const segDur = Math.max(15000, (tEnd - tStart) || 60000);

  const elapsedNow = ride.running ? (nowMs() - ride.startMs) : (ride.stoppedMs ?? 0);
  const segElapsed = Math.max(0, elapsedNow - (ride.visual?.segStartMs ?? 0));
  const p = Math.min(1, segElapsed / segDur);

  const baseF = segStartF + (segEndF - segStartF) * p;
  const basePx = pxWithinTrack(baseF);

  setRiderLeft('riderBest', basePx);
  setRiderLeft('riderYou', basePx + (ride.visual?.offsetPx ?? 0));
}


// ---------- Profile drawing ----------
// ---------- Profile drawing ----------
function drawProfile(route){
  const canvas = $('#profileCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  canvas.width  = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);

  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0,0,w,h);

  const prof = Array.isArray(route.profile) ? route.profile : [];
  if (prof.length < 2){
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.font = '700 14px -apple-system, system-ui, Segoe UI, Roboto';
    ctx.fillText('Profil zatím není (importuj GPX)', 14, 22);
    ctx.restore();
    return;
  }

  // normalize + filter
  let pts0 = prof.map(p=>({
    distanceKm: Number(p.distanceKm),
    elevationM: Number(p.elevationM)
  })).filter(p=>Number.isFinite(p.distanceKm)&&Number.isFinite(p.elevationM));

  if(pts0.length < 2) return;
  pts0.sort((a,b)=>a.distanceKm-b.distanceKm);

  const maxD = pts0[pts0.length-1].distanceKm || 1;

  // min/max elevation
  let minE=Infinity, maxE=-Infinity;
  for(const p of pts0){ minE=Math.min(minE,p.elevationM); maxE=Math.max(maxE,p.elevationM); }
  if(minE===maxE) maxE=minE+1;

  // padding
  const pad = { l: 12, r: 12, t: 26, b: 22 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  const x = (km)=> pad.l + (km/maxD)*innerW;
  const y = (m)=> pad.t + (1 - (m-minE)/(maxE-minE))*innerH;

  // glass rounded background
  roundedRect_(ctx, 6, 6, w-12, h-12, 14, 'rgba(0,0,0,.18)', 'rgba(255,255,255,.10)');

  // subtle grid
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.lineWidth = 1;
  for(let i=0;i<=3;i++){
    const yy = pad.t + innerH*(i/3);
    ctx.beginPath(); ctx.moveTo(pad.l,yy); ctx.lineTo(w-pad.r,yy); ctx.stroke();
  }
  [0, maxD/3, 2*maxD/3, maxD].forEach(t=>{
    const xx=x(t);
    ctx.beginPath(); ctx.moveTo(xx,pad.t); ctx.lineTo(xx,pad.t+innerH); ctx.stroke();
  });
  ctx.restore();

  // resample + smooth
  const xFn = (km)=> x(km);
  let pts = resampleProfileByPixels(pts0, xFn, 2); // ~2px
  pts = smoothElevations(pts, 9);                  // smooth -> prettier

  const P = pts.map(p=>({ x: x(p.distanceKm), y: y(p.elevationM), km:p.distanceKm, ele:p.elevationM }));

  // ascent / descent
  const ad = computeAscentDescent(pts);
  ctx.save();
  ctx.font = '800 13px -apple-system, system-ui, Segoe UI, Roboto';
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.fillText(`+${ad.up} m`, pad.l, 18);
  ctx.fillStyle = 'rgba(255,255,255,.70)';
  ctx.fillText(`-${ad.down} m klesání`, pad.l + 86, 18);
  ctx.restore();

  // "heat" under the line based on grade (soft)
  for(let i=1;i<P.length;i++){
    const a=P[i-1], b=P[i];
    const dxKm = (b.km - a.km);
    if(dxKm<=0) continue;
    const de = (b.ele - a.ele);
    const gradePct = (de / (dxKm*1000)) * 100;
    const col = colorForGrade(gradePct);

    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(a.x,a.y);
    ctx.lineTo(b.x,b.y);
    ctx.lineTo(b.x,pad.t+innerH);
    ctx.lineTo(a.x,pad.t+innerH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // dark fill under curve
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(P[0].x, P[0].y);
  for(const p of P) ctx.lineTo(p.x,p.y);
  ctx.lineTo(P[P.length-1].x, pad.t+innerH);
  ctx.lineTo(P[0].x, pad.t+innerH);
  ctx.closePath();

  const fillGrad = ctx.createLinearGradient(0, pad.t, 0, pad.t+innerH);
  fillGrad.addColorStop(0, 'rgba(0,0,0,.10)');
  fillGrad.addColorStop(1, 'rgba(0,0,0,.35)');
  ctx.fillStyle = fillGrad;
  ctx.fill();
  ctx.restore();

  // smooth white line (nice)
  ctx.save();
  ctx.lineWidth = 3.2;
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // glow
  ctx.shadowColor = 'rgba(255,255,255,.28)';
  ctx.shadowBlur  = 10;

  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  buildSmoothPath(ctx, P, 0.7);
  ctx.stroke();
  ctx.restore();

  // checkpoints markers (if available)
  const cps = Array.isArray(route.checkpoints) ? route.checkpoints : [];
  if (cps.length){
    ctx.save();
    for(const cp of cps){
      const km = Number(cp.distanceKm);
      if (!Number.isFinite(km)) continue;
      const ele = interpEleAtKm_(pts, km);
      const cx = x(km);
      const cy = y(ele);

      // outer ring
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.fill();

      // inner dot
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fill();
    }
    ctx.restore();
  }

  // x-axis labels
  ctx.save();
  ctx.font = '700 12px -apple-system, system-ui, Segoe UI, Roboto';
  ctx.fillStyle = 'rgba(255,255,255,.70)';
  const lab = [0, Math.round(maxD/3), Math.round(2*maxD/3), Math.round(maxD)];
  lab.forEach(km=>{
    const xx = x(km);
    ctx.fillText(`${km} km`, Math.max(6, xx-10), h-6);
  });
  ctx.restore();
}

// ---- helpers used inside drawProfile ----
function roundedRect_(ctx, x, y, w, h, r, fill, stroke){
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
  if (fill){
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke){
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

function interpEleAtKm_(pts, km){
  if (!pts.length) return 0;
  if (km <= pts[0].distanceKm) return pts[0].elevationM;
  if (km >= pts[pts.length-1].distanceKm) return pts[pts.length-1].elevationM;

  let j = 0;
  while (j < pts.length-2 && pts[j+1].distanceKm < km) j++;
  const a = pts[j], b = pts[j+1];
  const span = (b.distanceKm - a.distanceKm) || 1e-9;
  const t = (km - a.distanceKm) / span;
  return a.elevationM + (b.elevationM - a.elevationM)*t;
}
function roundRect(ctx, x,y,w,h,r, fill){
  ctx.beginPath();
  clipRoundRect(ctx,x,y,w,h,r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
function clipRoundRect(ctx, x,y,w,h,r){
  const rr = Math.min(r, w/2, h/2);
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
}

window.addEventListener('resize', ()=>{
  if (state.screen==='route'){
    const route = getCurrentRoute();
    if (route) drawProfile(route);
  }
});

// ---------- GPX parsing (basic) ----------
function parseGpx(xmlText){
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const trkpts = Array.from(doc.getElementsByTagName('trkpt'));
  if (!trkpts.length) throw new Error('no trkpt');

  const pts = [];
  for (const p of trkpts){
    const lat = parseFloat(p.getAttribute('lat'));
    const lon = parseFloat(p.getAttribute('lon'));
    const eleNode = p.getElementsByTagName('ele')[0];
    const ele = eleNode ? parseFloat(eleNode.textContent) : 0;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    pts.push({lat, lon, ele: Number.isFinite(ele) ? ele : 0});
  }
  if (pts.length < 2) throw new Error('too few points');

  // distance + ascent
  let distKm = 0;
  let ascent = 0;
  const profile = [{distanceKm:0, elevationM: pts[0].ele}];

  for (let i=1;i<pts.length;i++){
    const a = pts[i-1], b = pts[i];
    const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
    distKm += d;
    const de = b.ele - a.ele;
    if (de > 0) ascent += de;
    profile.push({distanceKm: distKm, elevationM: b.ele});
  }
  return { totalDistanceKm: distKm, totalAscentM: ascent, profile };
}

function downsampleProfile(profile, maxPoints){
  if (profile.length <= maxPoints) return profile;
  // uniform sampling
  const step = (profile.length-1) / (maxPoints-1);
  const out = [];
  for (let i=0;i<maxPoints;i++){
    const idx = Math.round(i*step);
    out.push(profile[idx]);
  }
  // ensure last point exactly last
  out[out.length-1] = profile[profile.length-1];
  return out;
}

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const toRad = (x)=>x*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}
function round2(x){ return Math.round(x*100)/100; }

function showToast(html, ms=2200){
  const t = $('#toast');
  if (!t) return;
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=>{ t.hidden = true; }, ms);
}

// ---------- Safety: escape HTML ----------
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c)=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ✅ FIX: v kódu se volá stopTicker(), ale nebyl definovaný – přidávám bezpečný no-op
function stopTicker(){
  try{
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }catch(e){}
}

// Initial render
state.source = loadSource();
updateSourceUi();
showScreen('source');
