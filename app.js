if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(()=>{}); }); }

const GAS_URL = 'https://script.google.com/macros/s/AKfycbwTreNAF4AVwdAFRIdeVIqR4dYn87RgbSP0-u-0n3_90oCl_7ZlBlwADXWUvCsv4kELrg/exec';
const API_TOKEN = "MyGymAppSecretToken_2026";

let globalTrainingHistory = [];
let globalHealthMap = {};
let activeFilters = [];
let currentCalYear = new Date().getFullYear();
let currentCalMonth = new Date().getMonth();
let previousViewBeforeDetail = 'home';
let currentRecordingDateStr = "";
let currentDetailDateKey = "";

const STORAGE_VIEW_KEY = "workout_app_last_view_v1";
const STORAGE_DRAFT_PREFIX = "workout_app_draft_v1_";
const DATA_CACHE_KEY = "workout_app_data_cache_v1";
const OFFLINE_QUEUE_KEY = "workout_app_offline_queue_v1";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_LABELS_SHORT = ["日", "月", "火", "水", "木", "金", "土"];

// ★追加：部位カラー設定のグローバル管理
const DEFAULT_COLORS = { "胸": "#FF453A", "背中": "#0A84FF", "脚": "#30D158", "肩": "#FF9F0A", "腕": "#BF5AF2", "その他": "#8E8E93" };
let partColors = JSON.parse(localStorage.getItem('workout_app_colors_v1')) || DEFAULT_COLORS;

document.addEventListener("DOMContentLoaded", function() {
  initBrowserHistoryGuard(); initDetailSwipe(); initTimerSheetSwipe();
  makeDraggable(document.getElementById('floating-total')); makeDraggable(document.getElementById('floating-rest'));
  updateTimerDisplays();

  const cachedRaw = localStorage.getItem(DATA_CACHE_KEY);
  if (cachedRaw) { try { initApp(JSON.parse(cachedRaw)); } catch(e) {} }

  fetch(GAS_URL + '?action=getInitialData&limit=45&offset=0&token=' + API_TOKEN)
    .then(r => r.json()).then(data => {
      if(data.error) { if (!cachedRaw) showError(new Error(data.error)); } 
      else { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(data)); initApp(data); }
    }).catch(e => { if (!cachedRaw) showError(e); });

  document.addEventListener("click", e => { if (!e.target.classList.contains("exercise")) document.querySelectorAll(".suggest-box").forEach(b => b.style.display = "none"); });
  syncOfflineQueue();
});

window.addEventListener('online', syncOfflineQueue);

async function syncOfflineQueue() {
  if (!navigator.onLine) return; 
  const queueRaw = localStorage.getItem(OFFLINE_QUEUE_KEY); if (!queueRaw) return;
  let queue = []; try { queue = JSON.parse(queueRaw); } catch(e) { return; }
  if (queue.length === 0) return;
  if (window.isSyncing) return; window.isSyncing = true;
  let remainingQueue = [...queue];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    try {
      const res = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(item.payload) });
      const result = await res.json();
      if (result.success) {
        if (result.updatedHistory) {
          globalTrainingHistory = result.updatedHistory;
          const cachedRaw = localStorage.getItem(DATA_CACHE_KEY);
          if (cachedRaw) { let cData = JSON.parse(cachedRaw); cData.trainingHistory = result.updatedHistory; localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(cData)); }
        }
        remainingQueue = remainingQueue.filter(q => q.id !== item.id);
      }
    } catch (e) { break; } 
  }
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remainingQueue)); window.isSyncing = false;
  if (queue.length !== remainingQueue.length) { initApp(null); }
}

document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === 'visible') {
    try { const raw = localStorage.getItem(STORAGE_VIEW_KEY); if (raw) { const s = JSON.parse(raw); if (s.timestamp && (Date.now() - s.timestamp > 3600000)) openHomeView(); } } catch(e){}
    syncOfflineQueue();
  } else {
    try { const raw = localStorage.getItem(STORAGE_VIEW_KEY); if (raw) { const s = JSON.parse(raw); s.timestamp = Date.now(); localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify(s)); } } catch(e){}
  }
});

/* ======================================================================
   タイマーシステム
====================================================================== */
let currentPresetSeconds = 180, restRemainingSeconds = 180, isResting = false, restTimerInterval = null, restEndTime = 0;
let totalTimerInterval = null, totalStartTime = 0, totalSeconds = 0, isTotalTimerRunning = false, wakeLock = null;

function formatTime(s) { if (s < 0) s = 0; return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(Math.floor(s) % 60).toString().padStart(2, '0')}`; }
function updateTimerDisplays() {
  const tStr = formatTime(restRemainingSeconds);
  document.getElementById('floating-rest-time').innerText = tStr; document.getElementById('sheet-rest-time').innerText = tStr;
  const pbS = document.getElementById('sheet-play-btn'), pbF = document.getElementById('floating-rest-play'), cI = document.querySelector('.timer-circle-iphone');
  if (isResting) { pbS.innerText = "一時停止"; pbS.className = "sheet-circle-btn stop"; pbF.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`; cI.className = "timer-circle-iphone running"; }
  else { pbS.innerText = "開始"; pbS.className = "sheet-circle-btn play"; pbF.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`; cI.className = "timer-circle-iphone stopped"; }
}
function selectPreset(s, b) { pauseRestTimer(); currentPresetSeconds = s; restRemainingSeconds = s; document.querySelectorAll('.preset-btn').forEach(e => e.classList.remove('active')); b.classList.add('active'); updateTimerDisplays(); }
function adjustRestTime(a) { restRemainingSeconds += a; if (restRemainingSeconds < 0) restRemainingSeconds = 0; if (isResting) restEndTime += a * 1000; updateTimerDisplays(); }
function resetRestTimer() { pauseRestTimer(); restRemainingSeconds = currentPresetSeconds; updateTimerDisplays(); }
function toggleRestTimer() { if (isResting) pauseRestTimer(); else startRestTimer(); }
function pauseRestTimer() { isResting = false; clearInterval(restTimerInterval); if (wakeLock !== null) wakeLock.release().then(() => wakeLock = null); updateTimerDisplays(); }
async function startRestTimer() {
  if (restRemainingSeconds <= 0) return; isResting = true; restEndTime = Date.now() + (restRemainingSeconds * 1000);
  if (!isTotalTimerRunning) { isTotalTimerRunning = true; totalStartTime = Date.now() - (totalSeconds * 1000); totalTimerInterval = setInterval(() => { totalSeconds = Math.floor((Date.now() - totalStartTime) / 1000); document.getElementById("floating-total-time").innerText = formatTime(totalSeconds); }, 1000); }
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
  updateTimerDisplays();
  restTimerInterval = setInterval(() => {
    let rem = Math.ceil((restEndTime - Date.now()) / 1000);
    if (rem > 0) { restRemainingSeconds = rem; updateTimerDisplays(); } else {
      clearInterval(restTimerInterval); isResting = false; restRemainingSeconds = 0; updateTimerDisplays();
      if (navigator.vibrate) navigator.vibrate([500, 500, 500, 500, 500, 500, 500, 500, 500]); 
      if (wakeLock !== null) wakeLock.release().then(() => wakeLock = null);
      setTimeout(() => { resetRestTimer(); }, 1000);
    }
  }, 200);
}

function openTimerSheet() { document.getElementById('timer-bottom-sheet').classList.add('open'); document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active')); document.getElementById('nav-timer').classList.add('active'); }
function closeTimerSheet() {
  document.getElementById('timer-bottom-sheet').classList.remove('open'); const cV = getCurrentVisibleView(); document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
  if (cV === 'home' || cV === 'calendar') document.getElementById('nav-home').classList.add('active'); if (cV === 'dashboard' || cV === 'detail') document.getElementById('nav-log').classList.add('active'); if (cV === 'graph') document.getElementById('nav-graph').classList.add('active'); if (cV === 'settings') document.getElementById('nav-settings').classList.add('active');
}
function initTimerSheetSwipe() {
  const sh = document.getElementById('timer-bottom-sheet'); if (!sh) return; let sY = 0;
  sh.addEventListener('touchstart', e => { sY = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (e.touches[0].clientY > sY) { e.preventDefault(); } }, { passive: false });
  sh.addEventListener('touchend', e => { if (e.changedTouches[0].clientY - sY > 60) closeTimerSheet(); }, { passive: true });
}
function makeDraggable(el) {
  if(!el) return; let sX=0, sY=0, iX=0, iY=0;
  el.addEventListener('touchstart', e => { if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button') || e.target.tagName.toLowerCase() === 'svg') return; iX = el.getBoundingClientRect().left; iY = el.getBoundingClientRect().top; sX = e.touches[0].clientX; sY = e.touches[0].clientY; }, {passive: false});
  el.addEventListener('touchmove', e => {
    if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button') || e.target.tagName.toLowerCase() === 'svg') return;
    e.preventDefault(); let nL = Math.max(0, Math.min(iX + (e.touches[0].clientX - sX), window.innerWidth - el.offsetWidth)); let nT = Math.max(0, Math.min(iY + (e.touches[0].clientY - sY), window.innerHeight - el.offsetHeight));
    el.style.left = nL + 'px'; el.style.top = nT + 'px'; el.style.bottom = 'auto'; el.style.right = 'auto';
  }, {passive: false});
}

/* ======================================================================
   Alpine.js (フォーム ＆ 新設設定画面)
====================================================================== */
document.addEventListener('alpine:init', () => {
  // 1. ワークアウト入力フォーム
  Alpine.data('workoutForm', () => ({
    formPart: '', formPartCustom: '', formExercises: [], hasDraft: false, isSaving: false, saveMsg: '', saveMsgColor: '', historyModal: { isOpen: false, exercise: '', records: [] },
    init() { window.alpineWorkoutForm = this; },
    addExercise(existingData = null) {
      const eS = Array.from({ length: 5 }, () => ({ w: '', r: '' }));
      if (existingData) { this.formExercises.push({ name: existingData.name, memo: existingData.memo, sets: existingData.sets, suggests: [] }); } else { this.formExercises.push({ name: '', memo: '', sets: eS, suggests: [] }); }
      this.saveDraft();
    },
    removeExercise(idx) { this.formExercises.splice(idx, 1); this.saveDraft(); },
    suggest(idx) {
      const val = this.formExercises[idx].name.trim().toLowerCase(); if (!val) { this.formExercises[idx].suggests = []; return; }
      const cP = this.formPart === 'custom' ? this.formPartCustom.trim() : this.formPart; const exMap = new Map();
      globalTrainingHistory.forEach(r => { const ex = (r.exercise || "").trim(); if (!ex || ex === "種目不明") return; if (ex.toLowerCase().includes(val) && ex.toLowerCase() !== val) { if (!exMap.has(ex) || r.part === cP) exMap.set(ex, r.part || ""); } });
      this.formExercises[idx].suggests = Array.from(exMap.entries()).sort((a, b) => (cP && a[1] === cP ? -1 : 1) - (cP && b[1] === cP ? -1 : 1)).slice(0, 5).map(([name, part]) => ({ name, part }));
    },
    selectSuggest(idx, name) { this.formExercises[idx].name = name; this.formExercises[idx].suggests = []; this.saveDraft(); },
    openHistory(exName) {
      const name = exName.trim(); if (!name) return; this.historyModal.exercise = name;
      const records = globalTrainingHistory.filter(r => (r.exercise || "").trim() === name).sort((a, b) => new Date(normalizeDateStr(b.date)) - new Date(normalizeDateStr(a.date))).map(r => { const dObj = parseDateKeyToObj(r.date); return { dateStr: `${dObj.getFullYear()}/${dObj.getMonth()+1}/${dObj.getDate()}(${DAY_LABELS_SHORT[dObj.getDay()]})`, details: r.details, memo: r.memo }; });
      this.historyModal.records = records; this.historyModal.isOpen = true;
    },
    saveDraft() { if (!currentRecordingDateStr) return; localStorage.setItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(currentRecordingDateStr), JSON.stringify({ part: this.formPart, partCustom: this.formPartCustom, exercises: this.formExercises })); this.hasDraft = true; },
    loadDraftAndRecords(dateStr) {
      this.formPart = ''; this.formPartCustom = ''; this.formExercises = []; this.hasDraft = false; this.saveMsg = '';
      const dR = localStorage.getItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(dateStr));
      if (dR) { const d = JSON.parse(dR); this.formPart = d.part || ''; this.formPartCustom = d.partCustom || ''; if (d.exercises && d.exercises.length > 0) { d.exercises.forEach(e => this.addExercise(e)); } else { this.addExercise(); } this.hasDraft = true; return; }
      const rs = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === normalizeDateStr(dateStr));
      if (rs.length === 0) { this.addExercise(); } else {
        let pt = rs[0].part || ''; if (pt === "足") pt = "脚"; if (["胸", "背中", "腕", "肩", "脚"].includes(pt)) { this.formPart = pt; } else { this.formPart = 'custom'; this.formPartCustom = pt; }
        rs.forEach(r => { const sets = Array.from({ length: 5 }, () => ({ w: '', r: '' })); const parsed = parseDetailsToSets(r.details); parsed.forEach((s, i) => { if (i < 5) { sets[i].w = s.w; sets[i].r = s.r; } }); this.addExercise({ name: r.exercise, memo: r.memo, sets: sets }); });
      }
    },
    saveTraining() {
      const tD = currentRecordingDateStr || formatWithZeroPad(formatDateKey(new Date())); const gP = this.formPart === 'custom' ? this.formPartCustom.trim() : this.formPart;
      if (!gP) { this.saveMsg = "部位を選択してください"; this.saveMsgColor = "#FF453A"; return; }
      const tData = [];
      this.formExercises.forEach(ex => {
        const n = ex.name.trim(); const m = ex.memo.trim(); let sT = ""; let hS = false;
        ex.sets.forEach((s, i) => { const w = String(s.w).trim(); const r = String(s.r).trim(); if (w || r) { sT += `${i+1}セット目: ${w ? w+'kg' : '-'} × ${r ? r+'回' : '-'}\n`; hS = true; } });
        if (n || hS || m) { tData.push({ date: tD, part: gP, exercise: n || "種目不明", details: sT.trim(), memo: m }); }
      });
      if (tData.length === 0) { this.saveMsg = "内容を入力してください"; this.saveMsgColor = "#FF453A"; return; }
      this.isSaving = true; this.saveMsg = ""; showSavingOverlay();
      const payload = { action: 'saveTrainingLog', targetDate: tD, trainingData: tData, token: API_TOKEN };
      const fin = (uH) => { if (uH) globalTrainingHistory = uH; localStorage.removeItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(tD)); this.hasDraft = false; finishSavingOverlay(() => { openHomeView(); }); };
      const saveOff = () => {
        const qR = localStorage.getItem(OFFLINE_QUEUE_KEY); let q = qR ? JSON.parse(qR) : []; q.push({ id: Date.now(), payload: payload }); localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
        globalTrainingHistory = globalTrainingHistory.filter(r => normalizeDateStr(r.date) !== normalizeDateStr(tD)); tData.forEach(d => globalTrainingHistory.push(d));
        const cR = localStorage.getItem(DATA_CACHE_KEY); if (cR) { let cD = JSON.parse(cR); cD.trainingHistory = globalTrainingHistory; localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(cD)); }
        document.getElementById("saving-text").innerText = "オフライン保存しました"; setTimeout(() => { this.isSaving = false; fin(null); }, 1200);
      };
      if (!navigator.onLine) { saveOff(); return; }
      fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })
      .then(res => res.json()).then(r => { this.isSaving = false; if (r.success) { fin(r.updatedHistory); } else { hideSavingOverlayImmediate(); this.saveMsg = "エラー: " + r.error; this.saveMsgColor = "#FF453A"; } })
      .catch(e => { saveOff(); });
    },
    adjustTextarea(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  }));

  // ★2. 設定用フォーム
  Alpine.data('settingsForm', () => ({
    colors: partColors,
    palette: ["#FF453A", "#FF9F0A", "#FFD60A", "#30D158", "#66D4CF", "#0A84FF", "#5E5CE6", "#BF5AF2", "#FF375F", "#8E8E93", "#FFFFFF"],
    activePart: null,
    openPalette(part) { this.activePart = this.activePart === part ? null : part; },
    selectColor(color) {
      if(!this.activePart) return;
      this.colors[this.activePart] = color;
      this.activePart = null;
      partColors = this.colors;
      localStorage.setItem('workout_app_colors_v1', JSON.stringify(this.colors));
      renderHomeCalendar(); // カレンダーのドット色を即時反映
    }
  }));
});

/* ======================================================================
   既存のデータ取得・UI管理用ロジック
====================================================================== */
function initApp(data) {
  document.getElementById("loading").style.display = "none";
  if (data) {
    globalTrainingHistory = data.trainingHistory || []; globalHealthMap = {};
    if (data.healthHistory && data.healthHistory.length > 0) { data.healthHistory.forEach(item => { if (item && item.date) globalHealthMap[normalizeDateStr(item.date)] = item; }); } else if (data.currentData && data.currentData.date) { globalHealthMap[normalizeDateStr(data.currentData.date)] = data.currentData; }
  }
  if (!window.isAppInitialized) { window.isAppInitialized = true; restoreLastViewState(); } else {
    const cV = getCurrentVisibleView();
    if (cV === 'home') { renderHomeCalendar(); renderWeeklySummary(); } else if (cV === 'calendar') { renderDetailCalendar(); } else if (cV === 'dashboard') { if (window.alpineWorkoutForm) window.alpineWorkoutForm.loadDraftAndRecords(currentRecordingDateStr); } else if (cV === 'detail') { openDayDetailView(currentDetailDateKey, document.getElementById("day-detail-title").innerText, null, null, true); } else if (cV === 'graph') { initGraphView(); }
  }
}
function initBrowserHistoryGuard() { try { window.history.replaceState({ view: 'root_guard' }, ''); window.history.pushState({ view: 'home' }, ''); window.addEventListener('popstate', function(e) { const state = e.state; if (!state || state.view === 'root_guard') { window.history.pushState({ view: 'home' }, ''); openHomeView(true); return; } applyStateFromHistory(state); }); } catch (err) {} }
function pushAppHistory(s) { try { s.timestamp = Date.now(); localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify(s)); window.history.pushState(s, ''); } catch (e) {} }
function navigateBack() { const cV = getCurrentVisibleView(); if (cV === 'detail') { if (previousViewBeforeDetail === 'calendar') openCalendarDetailView(); else openHomeView(); } else openHomeView(); }
function getCurrentVisibleView() { if (document.getElementById("view-dashboard").style.display === "block") return 'dashboard'; if (document.getElementById("view-day-detail").style.display === "block") return 'detail'; if (document.getElementById("view-calendar").style.display === "block") return 'calendar'; if (document.getElementById("view-graph").style.display === "block") return 'graph'; if (document.getElementById("view-settings").style.display === "block") return 'settings'; return 'home'; }
function applyStateFromHistory(s) { if (!s || s.view === 'home') openHomeView(true); else if (s.view === 'calendar') { currentCalYear = s.year; currentCalMonth = s.month; openCalendarDetailView(true); } else if (s.view === 'detail') openDayDetailView(s.dateKey, s.label, s.fromView || 'home', null, true); else if (s.view === 'dashboard') openDashboardForDate(s.dateKey || null, true); else if (s.view === 'graph') switchTab('graph'); else if (s.view === 'settings') switchTab('settings'); else openHomeView(true); }
function restoreLastViewState() { try { const r = localStorage.getItem(STORAGE_VIEW_KEY); if (!r) { openHomeView(); return; } const s = JSON.parse(r); if (s.timestamp && (Date.now() - s.timestamp > 3600000)) { openHomeView(); return; } if (s && s.view && s.view !== 'home') { applyStateFromHistory(s); return; } } catch (e) {} openHomeView(); }
function hideAllViews() { document.getElementById("loading").style.display = "none"; ['view-home','view-calendar','view-day-detail','view-dashboard','view-graph','view-settings'].forEach(id => document.getElementById(id).style.display = "none"); ['nav-home','nav-log','nav-graph','nav-timer','nav-settings'].forEach(id => document.getElementById(id).classList.remove("active")); }
function openHomeView(sH) { hideAllViews(); document.getElementById("view-home").style.display = "block"; document.getElementById("nav-home").classList.add("active"); const now = new Date(); currentCalYear = now.getFullYear(); currentCalMonth = now.getMonth(); renderHomeCalendar(); renderWeeklySummary(); if (!sH) pushAppHistory({ view: 'home' }); else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'home', timestamp: Date.now() })); } catch(e){} } window.scrollTo(0, 0); }
function openCalendarDetailView(sH) { hideAllViews(); document.getElementById("view-calendar").style.display = "block"; renderDetailCalendar(); if (!sH) pushAppHistory({ view: 'calendar', year: currentCalYear, month: currentCalMonth }); else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'calendar', year: currentCalYear, month: currentCalMonth, timestamp: Date.now() })); } catch(e){} } window.scrollTo(0, 0); }
function openDashboardForDate(tK, sH) {
  hideAllViews(); document.getElementById("view-dashboard").style.display = "block"; document.getElementById("nav-log").classList.add("active");
  let dO = tK ? parseDateKeyToObj(tK) : new Date(); currentRecordingDateStr = formatWithZeroPad(formatDateKey(dO)); document.getElementById("recording-target-label").innerText = `${formatDisplayDateWithDay(currentRecordingDateStr)} の記録`;
  const pO = new Date(dO.getFullYear(), dO.getMonth(), dO.getDate() - 1); document.getElementById("form-vitals-caption").innerText = `前日 ${pO.getMonth() + 1}/${pO.getDate()} (${DAY_LABELS_SHORT[pO.getDay()]}) のコンディション`;
  loadHealthDataIntoPrefix(formatDateKey(pO), ""); if (window.alpineWorkoutForm) window.alpineWorkoutForm.loadDraftAndRecords(currentRecordingDateStr);
  if (!sH) pushAppHistory({ view: 'dashboard', dateKey: currentRecordingDateStr }); else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'dashboard', dateKey: currentRecordingDateStr, timestamp: Date.now() })); } catch(e){} } window.scrollTo(0, 0);
}
function loadHealthDataIntoPrefix(dK, p) { const n = normalizeDateStr(dK); if (globalHealthMap[n]) { renderVitalsToDOM(globalHealthMap[n], p); } else { renderVitalsToDOM(null, p); fetch(GAS_URL + '?action=getDataForDate&date=' + formatWithZeroPad(n) + '&token=' + API_TOKEN).then(res => res.json()).then(data => { if (data && !data.error) { globalHealthMap[n] = data; renderVitalsToDOM(data, p); } }).catch(()=>{}); } }
function renderVitalsToDOM(data, p) { document.getElementById(p+"sleep-time").innerText = cleanMetric(data?.sleep, ""); document.getElementById(p+"cal-intake").innerText = cleanMetric(data?.intake, ""); document.getElementById(p+"cal-burned").innerText = cleanMetric(data?.burned, ""); document.getElementById(p+"p-val").innerText = cleanMetric(data?.protein, ""); document.getElementById(p+"f-val").innerText = cleanMetric(data?.fat, ""); document.getElementById(p+"c-val").innerText = cleanMetric(data?.carb, ""); const d = data ? parseInt(String(data.balance).replace(/[^-0-9]/g, ""), 10) : NaN; document.getElementById(p+"cal-balance").innerText = isNaN(d) ? "" : (d > 0 ? "+" : "") + d.toLocaleString() + " kcal"; }
function openDayDetailView(dK, dL, fV, sC, sH) {
  if (fV) previousViewBeforeDetail = fV; currentDetailDateKey = normalizeDateStr(dK); hideAllViews(); const v = document.getElementById("view-day-detail"); v.style.display = "block";
  if (sC) { v.classList.remove("slide-anim-from-right", "slide-anim-from-left"); void v.offsetWidth; v.classList.add(sC); }
  document.getElementById("day-detail-title").innerText = dL || formatDisplayDateWithDay(currentDetailDateKey); loadHealthDataIntoPrefix(currentDetailDateKey, "detail-");
  const s = document.getElementById("day-summary-container"), c = document.getElementById("day-detail-content"), b = document.getElementById("day-detail-edit-btn"); s.innerHTML = ""; c.innerHTML = "";
  const rs = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === currentDetailDateKey);
  if (rs.length === 0) { s.style.display = "none"; c.innerHTML = `<div class="empty-state"><div class="empty-state-title">トレーニング記録がありません</div></div>`; b.innerText = "この日のワークアウトを記録"; } else {
    b.innerText = "この日の記録を編集・追加"; const pts = [...new Set(rs.map(r => r.part || "未指定"))].join("・") + "の日"; let vol = 0, sets = 0;
    rs.forEach(r => { const ps = parseDetailsToSets(r.details); sets += ps.length; ps.forEach(s => { vol += (parseFloat(s.w)||0) * (parseFloat(s.r)||0); }); });
    s.style.display = "block"; s.innerHTML = `<div class="detail-hero"><div><div class="detail-part-Main">${pts}</div><div class="detail-sub-counts">${rs.length}種目 ・ 合計 ${sets}セット</div></div><div class="detail-volume-block"><div class="detail-volume-num">${Number.isInteger(vol) ? vol.toLocaleString() : vol.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}<span class="detail-volume-kg">kg</span></div><div class="detail-volume-unit">TOTAL VOLUME</div></div></div>`;
    rs.forEach(r => {
      const dc = document.createElement("div"); dc.className = "exercise-detail-card"; dc.innerHTML = `<div class="exercise-detail-name">${r.exercise || "種目未入力"}</div>`; const ps = parseDetailsToSets(r.details);
      if (ps.length > 0) { const t = document.createElement("div"); t.className = "sets-table"; ps.forEach((s, i) => { t.innerHTML += `<div class="set-line"><span class="set-line-idx">SET ${i+1}</span><span class="set-line-val">${s.w !== '' ? s.w+'<span class="set-line-unit">kg</span>' : '-'} × ${s.r !== '' ? s.r+'<span class="set-line-unit">回</span>' : '-'}</span></div>`; }); dc.appendChild(t); } else if (r.details) { dc.innerHTML += `<div style="font-size:0.9rem; color:var(--text-secondary); white-space:pre-wrap;">${r.details}</div>`; }
      if (r.memo) dc.innerHTML += `<div class="exercise-detail-memo">${r.memo}</div>`; c.appendChild(dc);
    });
  }
  b.onclick = () => openDashboardForDate(currentDetailDateKey); const sO = { view: 'detail', dateKey: currentDetailDateKey, label: document.getElementById("day-detail-title").innerText, fromView: previousViewBeforeDetail };
  if (!sH && !sC) pushAppHistory(sO); else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({...sO, timestamp: Date.now()})); } catch(e){} } if (!sC) window.scrollTo(0, 0);
}
function shiftDetailDay(o) { if (!currentDetailDateKey) return; const d = parseDateKeyToObj(currentDetailDateKey); const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + o); openDayDetailView(formatDateKey(n), formatDisplayDateWithDay(formatDateKey(n)), null, o > 0 ? "slide-anim-from-right" : "slide-anim-from-left", true); }
function initDetailSwipe() { let sX = 0, sY = 0, isD = false; const v = document.getElementById("view-day-detail"); if (!v) return; const h = (dx, dy) => { if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) shiftDetailDay(dx > 0 ? -1 : 1); }; v.addEventListener("touchstart", e => { if (e.touches.length === 1) { sX = e.touches[0].clientX; sY = e.touches[0].clientY; } }, { passive: true }); v.addEventListener("touchend", e => { if (e.changedTouches.length === 1) h(e.changedTouches[0].clientX - sX, e.changedTouches[0].clientY - sY); }, { passive: true }); v.addEventListener("mousedown", e => { isD = true; sX = e.clientX; sY = e.clientY; }); v.addEventListener("mouseup", e => { if (isD) { isD = false; h(e.clientX - sX, e.clientY - sY); }}); }
function showSavingOverlay() { const o = document.getElementById("saving-overlay"); document.getElementById("saving-spinner").style.display="block"; document.getElementById("saving-check").style.display="none"; document.getElementById("saving-text").innerText="記録を保存中..."; o.classList.add("active"); }
function finishSavingOverlay(cb) { document.getElementById("saving-spinner").style.display="none"; document.getElementById("saving-check").style.display="flex"; document.getElementById("saving-text").innerText="保存しました"; setTimeout(()=>{ document.getElementById("saving-overlay").classList.remove("active"); if (cb) cb(); }, 450); }
function hideSavingOverlayImmediate() { document.getElementById("saving-overlay").classList.remove("active"); }
function normalizeDateStr(s) { if (!s) return ""; const n = s.match(/\d+/g); if (n && n.length >= 3) return `${parseInt(n[0],10)}/${parseInt(n[1],10)}/${parseInt(n[2],10)}`; return s.trim(); }
function parseDateKeyToObj(s) { const n = String(s).match(/\d+/g); if (n && n.length >= 3) return new Date(parseInt(n[0],10), parseInt(n[1],10)-1, parseInt(n[2],10)); return new Date(); }
function formatDateKey(d) { return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`; }
function formatWithZeroPad(s) { const n = String(s).match(/\d+/g); if (n && n.length >= 3) return `${n[0]}/${String(parseInt(n[1],10)).padStart(2,'0')}/${String(parseInt(n[2],10)).padStart(2,'0')}`; return s; }
function formatDisplayDateWithDay(s) { const n = String(s).match(/\d+/g); if (n && n.length >= 3) { const y = parseInt(n[0],10), m = parseInt(n[1],10), d = parseInt(n[2],10); return `${y}/${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')} (${DAY_LABELS_SHORT[new Date(y, m-1, d).getDay()]})`; } return s; }
function cleanMetric(v, suf) { if (v === undefined || v === null) return ""; const s = String(v).trim(); if (s === "" || s === "-" || s.includes("#") || s === "NaN") return ""; return suf ? `${s} ${suf}` : s; }
function parseDetailsToSets(s) { if (!s) return []; return s.split('\n').filter(l => l.trim() !== '').map(l => { const m = l.match(/:\s*([0-9.]+|-)(?:kg)?\s*[×xXﾗ]\s*([0-9.]+|-)(?:回)?/); if (m) return { w: m[1] === '-' ? '' : m[1], r: m[2] === '-' ? '' : m[2] }; return { w: '', r: '' }; }); }

function updateHomeStats() {
  if (!globalTrainingHistory) return; const ud = new Set(), md = new Set();
  globalTrainingHistory.forEach(r => { const dStr = normalizeDateStr(r.date); ud.add(dStr); const d = parseDateKeyToObj(dStr); if (d.getFullYear() === currentCalYear && d.getMonth() === currentCalMonth) md.add(dStr); });
  if(document.getElementById("home-monthly-days")) document.getElementById("home-monthly-days").innerText = md.size;
  if(document.getElementById("home-total-days")) document.getElementById("home-total-days").innerText = ud.size;
}

// ★修正：動的に設定されたカラーを読み込んでドットを描画
function getDateTrainedParts(dateKey, useFilter) {
  const records = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === dateKey);
  let filtered = records;
  if (useFilter && activeFilters.length > 0) {
    filtered = records.filter(r => activeFilters.some(f => (r.part||"").includes(f) || (f==="脚" && (r.part||"").includes("足")) || (f==="その他" && !["胸","背中","腕","肩","脚","足"].includes(r.part))));
  }
  const parts = new Set();
  filtered.forEach(r => {
    let pt = (r.part || "").trim(); if (pt === "足") pt = "脚";
    if (["胸", "背中", "脚", "肩", "腕"].includes(pt)) parts.add(pt); else parts.add("その他");
  });
  return Array.from(parts);
}

function renderHomeCalendar() { const n = new Date(); buildCalendarGrid(n.getFullYear(), n.getMonth(), "home-cal-title", "home-cal-grid", false); updateHomeStats(); }
function renderDetailCalendar() { buildCalendarGrid(currentCalYear, currentCalMonth, "detail-cal-title", "detail-cal-grid", true); }
function changeMonth(o) { currentCalMonth += o; if (currentCalMonth < 0) { currentCalMonth = 11; currentCalYear--; } else if (currentCalMonth > 11) { currentCalMonth = 0; currentCalYear++; } renderDetailCalendar(); }

function buildCalendarGrid(y, m, tId, gId, isD) {
  document.getElementById(tId).innerText = `${MONTH_NAMES[m]} ${y}`;
  const g = document.getElementById(gId); g.innerHTML = "";
  const fD = (new Date(y, m, 1).getDay() + 6) % 7, dIM = new Date(y, m+1, 0).getDate(), pDIM = new Date(y, m, 0).getDate(), tK = formatDateKey(new Date());

  for (let i = fD - 1; i >= 0; i--) { g.innerHTML += `<div class="cal-cell"><div class="cal-day other-month">${pDIM - i}</div></div>`; }
  for (let d = 1; d <= dIM; d++) {
    const c = document.createElement("div"); c.className = "cal-cell clickable";
    const dK = `${y}/${m+1}/${d}`; const t = isDateTrained(dK, isD);
    
    let dotsHtml = '';
    if (t) {
      const parts = getDateTrainedParts(dK, isD);
      if (parts.length > 0) {
        dotsHtml = '<div class="cal-dots-wrap">';
        parts.slice(0, 4).forEach(pt => {
          let color = partColors[pt] || partColors["その他"];
          dotsHtml += `<div class="cal-dot" style="background-color: ${color};"></div>`;
        });
        dotsHtml += '</div>';
      }
    }

    const cl = (dK === tK && (!isD || activeFilters.length === 0 || t)) ? "cal-day today" : (t ? "cal-day trained" : "cal-day");
    c.innerHTML = `<div class="${cl}">${d}${dotsHtml}</div>`;
    c.onclick = e => { e.stopPropagation(); if(isD) openDayDetailView(dK, `${y}/${String(m+1).padStart(2,'0')}/${String(d).padStart(2,'0')} (${DAY_LABELS_SHORT[new Date(y,m,d).getDay()]})`, 'calendar'); else openCalendarDetailView(); };
    g.appendChild(c);
  }
  for (let i = 1; i <= (7 - ((fD + dIM) % 7)) % 7; i++) { g.innerHTML += `<div class="cal-cell"><div class="cal-day other-month">${i}</div></div>`; }
}
function toggleFilter(p, b) { const i = activeFilters.indexOf(p); if (i > -1) { activeFilters.splice(i, 1); b.classList.remove("active"); } else { activeFilters.push(p); b.classList.add("active"); } renderDetailCalendar(); }
function isDateTrained(d, u) { const rs = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === d); if (rs.length === 0) return false; if (!u || activeFilters.length === 0) return true; return rs.some(r => activeFilters.some(f => (r.part||"").includes(f) || (f==="脚" && (r.part||"").includes("足")) || (f==="その他" && !["胸","背中","腕","肩","脚","足"].includes(r.part)))); }

function renderWeeklySummary() {
  const c = document.getElementById("weekly-list"); c.innerHTML = "";
  const n = new Date(), tK = formatDateKey(n), m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + ((n.getDay()===0)?-6:1-n.getDay()));
  for (let i = 0; i < 7; i++) {
    const t = new Date(m.getFullYear(), m.getMonth(), m.getDate() + i), k = formatDateKey(t);
    const rs = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === k);
    let s = "オフ", cl = "rest";
    if (rs.length > 0) {
      cl = ""; const pm = {}; rs.forEach(r => { pm[r.part||"未指定"] = (pm[r.part||"未指定"]||0) + (r.sets||0); });
      s = Object.keys(pm).map(p => `${p} / ${pm[p]}セット`).join(" , ");
    }
    const rE = document.createElement("div"); rE.className = `list-row-compact ${k === tK ? 'is-today' : ''}`;
    rE.onclick = () => openDayDetailView(k, formatDisplayDateWithDay(k), 'home');
    rE.innerHTML = `<div class="list-date-col">${t.getMonth()+1}/${t.getDate()}(${DAY_LABELS_SHORT[t.getDay()]})</div><div class="list-desc-col ${cl}">${s}</div>`;
    c.appendChild(rE);
  }
}

function showError(err) { const l = document.getElementById("loading"); l.style.display = "block"; l.innerText = "エラー: " + err.message; l.style.color = "#FF453A"; }

// ★追加：SETTINGSへのタブ切り替えを許可
function switchTab(t) {
  hideAllViews();
  if (t === 'home') { document.getElementById("view-home").style.display = "block"; document.getElementById("nav-home").classList.add("active"); renderHomeCalendar(); renderWeeklySummary(); pushAppHistory({ view: 'home' }); }
  else if (t === 'log') { document.getElementById("view-dashboard").style.display = "block"; document.getElementById("nav-log").classList.add("active"); const n = new Date(); openDashboardForDate(n.getFullYear()+'/'+(n.getMonth()+1)+'/'+n.getDate()); }
  else if (t === 'graph') { document.getElementById("view-graph").style.display = "block"; document.getElementById("nav-graph").classList.add("active"); pushAppHistory({ view: 'graph' }); initGraphView(); }
  else if (t === 'settings') { document.getElementById("view-settings").style.display = "block"; document.getElementById("nav-settings").classList.add("active"); pushAppHistory({ view: 'settings' }); }
  window.scrollTo(0, 0);
}

let rmChartInstance = null; let volumeChartInstance = null;
let currentGraphPeriod = 'ALL';
window.setGraphPeriod = function(period) { currentGraphPeriod = period; document.querySelectorAll('.period-btn').forEach(btn => btn.classList.remove('active')); document.getElementById('period-btn-' + period).classList.add('active'); updateGraphs(); };

function initGraphView() {
  const sel = document.getElementById("graph-exercise-select"); const cV = sel.value;
  const pm = { "胸": new Set(), "背中": new Set(), "脚": new Set(), "肩": new Set(), "腕": new Set(), "その他": new Set() };
  globalTrainingHistory.forEach(r => { const ex = (r.exercise || "").trim(); let pt = (r.part || "").trim(); if (!ex || ex === "種目不明") return; if (pt === "足") pt = "脚"; if (!["胸", "背中", "脚", "肩", "腕"].includes(pt)) pt = "その他"; pm[pt].add(ex); });
  let h = '<option value="">グラフ化する種目を選択...</option>';
  ["胸", "背中", "脚", "肩", "腕", "その他"].forEach(p => { const exs = Array.from(pm[p]).sort(); if (exs.length > 0) { h += `<optgroup label="【${p}】">`; exs.forEach(ex => { h += `<option value="${ex}">${ex}</option>`; }); h += `</optgroup>`; } });
  sel.innerHTML = h; if (cV && Array.from(sel.options).some(o => o.value === cV)) { sel.value = cV; updateGraphs(); } else clearGraphs();
}
function clearGraphs() { if (rmChartInstance) rmChartInstance.destroy(); if (volumeChartInstance) volumeChartInstance.destroy(); }
function updateGraphs() {
  const tE = document.getElementById("graph-exercise-select").value; if (!tE) { clearGraphs(); return; }
  let records = globalTrainingHistory.filter(r => r.exercise === tE).sort((a,b) => new Date(normalizeDateStr(a.date)) - new Date(normalizeDateStr(b.date)));
  if (currentGraphPeriod !== 'ALL') { const cutoffDate = new Date(); if (currentGraphPeriod === '1M') cutoffDate.setMonth(cutoffDate.getMonth() - 1); if (currentGraphPeriod === '3M') cutoffDate.setMonth(cutoffDate.getMonth() - 3); if (currentGraphPeriod === '6M') cutoffDate.setMonth(cutoffDate.getMonth() - 6); records = records.filter(r => new Date(normalizeDateStr(r.date)) >= cutoffDate); }
  const lbls = [], rmd = [], vd = [];
  records.forEach(r => {
    const dStr = formatDisplayDateWithDay(normalizeDateStr(r.date)).substring(5, 10); const ps = parseDetailsToSets(r.details); let dm = 0, dv = 0;
    ps.forEach(s => { const w = parseFloat(s.w), rep = parseFloat(s.r); if (!isNaN(w) && !isNaN(rep) && rep > 0) { dv += (w * rep); const cRM = w * (1 + rep / 30); if (cRM > dm) dm = cRM; } });
    if (dm > 0 || dv > 0) { lbls.push(dStr); rmd.push(Math.round(dm)); vd.push(Math.round(dv)); }
  });
  drawChart('rmChart', '推定1RM (kg)', lbls, rmd, '#FF453A'); drawChart('volumeChart', '総重量 (kg)', lbls, vd, '#0A84FF');
}
function drawChart(cId, lbl, lbls, d, c) {
  const ctx = document.getElementById(cId).getContext('2d');
  if (cId === 'rmChart' && rmChartInstance) rmChartInstance.destroy(); if (cId === 'volumeChart' && volumeChartInstance) volumeChartInstance.destroy();
  const cfg = { type: 'line', data: { labels: lbls, datasets: [{ label: lbl, data: d, borderColor: c, backgroundColor: c+'33', borderWidth: 2, pointBackgroundColor: c, pointRadius: 4, fill: true, tension: 0.3 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1C1C1E', titleFont: { size: 13, family: 'Inter' }, bodyFont: { size: 14, weight: 'bold', family: 'Oswald' }, padding: 10, displayColors: false } }, scales: { x: { grid: { color: 'rgba(255, 255, 255, 0.08)' }, ticks: { color: '#8E8E93', font: { family: 'Inter' } } }, y: { grid: { color: 'rgba(255, 255, 255, 0.08)' }, ticks: { color: '#8E8E93', font: { family: 'Oswald' } } } } } };
  if (cId === 'rmChart') rmChartInstance = new Chart(ctx, cfg); else volumeChartInstance = new Chart(ctx, cfg);
}
