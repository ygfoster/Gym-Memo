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
let pendingDeleteAction = null;

const STORAGE_VIEW_KEY = "workout_app_last_view_v1";
const STORAGE_DRAFT_PREFIX = "workout_app_draft_v1_";
// ★修正：キャッシュキーを更新して、確実に古い睡眠データ記憶を破壊する
const DATA_CACHE_KEY = "workout_app_data_cache_v5";
const OFFLINE_QUEUE_KEY = "workout_app_offline_queue_v1";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_LABELS_SHORT = ["日", "月", "火", "水", "木", "金", "土"];
const DEFAULT_COLORS = { "胸": "#FF453A", "背中": "#0A84FF", "脚": "#30D158", "肩": "#FF9F0A", "腕": "#BF5AF2", "その他": "#8E8E93" };

let partColors = null;
try {
  const savedColors = localStorage.getItem('workout_app_colors_v1');
  if (savedColors) { partColors = JSON.parse(savedColors); }
} catch(e) {}
if (!partColors || typeof partColors !== 'object') { partColors = DEFAULT_COLORS; }

const DEFAULT_TIMER_PRESETS = [
  { label: "胸", seconds: 180 },
  { label: "背中", seconds: 180 },
  { label: "脚", seconds: 180 },
  { label: "腕", seconds: 120 },
  { label: "肩", seconds: 90 }
];
let timerPresets = null;
try {
  const savedPresets = localStorage.getItem('workout_app_timer_presets_v1');
  if (savedPresets) { timerPresets = JSON.parse(savedPresets); }
} catch(e) {}
if (!timerPresets || !Array.isArray(timerPresets) || timerPresets.length === 0) { timerPresets = DEFAULT_TIMER_PRESETS; }

document.addEventListener("DOMContentLoaded", function() {
  initBrowserHistoryGuard(); 
  initDetailSwipe(); 
  initLogSwipe(); 
  initCalendarSwipe(); 
  initTimerSheetSwipe();
  makeDraggable(document.getElementById('floating-total')); makeDraggable(document.getElementById('floating-rest'));
  
  renderTimerPresets();
  updateTimerDisplays();
  localStorage.removeItem(STORAGE_VIEW_KEY);
  
  const cachedRaw = localStorage.getItem(DATA_CACHE_KEY);
  if (cachedRaw) { try { initApp(JSON.parse(cachedRaw)); } catch(e) {} }

  fetch(GAS_URL + '?action=getInitialData&limit=45&offset=0&token=' + API_TOKEN)
    .then(r => r.json()).then(data => {
      if(data.error) { if (!cachedRaw) showError(new Error(data.error)); } 
      else { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(data)); initApp(data); }
    }).catch(e => { if (!cachedRaw) showError(e); });

  document.addEventListener("click", e => { 
    if (!e.target.classList.contains("exercise")) document.querySelectorAll(".suggest-box").forEach(b => b.style.display = "none"); 
    if (!e.target.closest('#graph-select-container')) closeGraphSelect();
  });
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

function renderTimerPresets() {
  const container = document.getElementById('timer-presets-container');
  if(!container) return;
  container.innerHTML = '';
  
  if (timerPresets && timerPresets.length > 0) {
    currentPresetSeconds = timerPresets[0].seconds;
    if(!isResting) restRemainingSeconds = currentPresetSeconds;
  }

  timerPresets.forEach((p, idx) => {
    const btn = document.createElement('button');
    btn.className = 'pill-btn preset-btn' + (idx === 0 ? ' active' : '');
    let timeStr = "";
    if (p.seconds >= 60) {
      timeStr += Math.floor(p.seconds / 60) + "分";
      if (p.seconds % 60 > 0) timeStr += (p.seconds % 60) + "秒";
    } else {
      timeStr += p.seconds + "秒";
    }
    btn.innerText = p.label ? `${p.label} ${timeStr}` : timeStr;
    btn.onclick = () => selectPreset(p.seconds, btn);
    container.appendChild(btn);
  });
  updateTimerDisplays();
}

function formatTime(s) { if (s < 0) s = 0; return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(Math.floor(s) % 60).toString().padStart(2, '0')}`; }
function updateTimerDisplays() {
  const tStr = formatTime(restRemainingSeconds);
  document.getElementById('floating-rest-time').innerText = tStr; document.getElementById('sheet-rest-time').innerText = tStr;
  const pbS = document.getElementById('sheet-play-btn'), pbF = document.getElementById('floating-rest-play'), cI = document.querySelector('.timer-circle-iphone');
  if (isResting) { pbS.innerText = "Stop"; pbS.className = "sheet-circle-btn stop"; pbF.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`; cI.className = "timer-circle-iphone running"; }
  else { pbS.innerText = "Start"; pbS.className = "sheet-circle-btn play"; pbF.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`; cI.className = "timer-circle-iphone stopped"; }
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
  if (cV === 'home') document.getElementById('nav-home').classList.add('active'); if (cV === 'dashboard' || cV === 'detail') document.getElementById('nav-log').classList.add('active'); if (cV === 'graph') document.getElementById('nav-graph').classList.add('active'); if (cV === 'settings') document.getElementById('nav-settings').classList.add('active');
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
   Alpine.js
====================================================================== */
document.addEventListener('alpine:init', () => {
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
      this.historyModal.records = records;
      document.querySelector('.history-modal-overlay').classList.add('active');
      this.historyModal.isOpen = true;
    },
    closeHistory() {
      document.querySelector('.history-modal-overlay').classList.remove('active');
      setTimeout(() => { this.historyModal.isOpen = false; }, 200);
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
    confirmDeleteFromLog() {
      if(!currentRecordingDateStr) return;
      openDeleteModal(currentRecordingDateStr, () => {
        this.isSaving = true; showSavingOverlay();
        const payload = { action: 'saveTrainingLog', targetDate: currentRecordingDateStr, trainingData: [], token: API_TOKEN };
        fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })
        .then(res => res.json()).then(r => { 
          this.isSaving = false; 
          if (r.success) { 
            globalTrainingHistory = r.updatedHistory || [];
            localStorage.removeItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(currentRecordingDateStr));
            this.hasDraft = false;
            finishSavingOverlay(() => { openHomeView(); });
          } else { hideSavingOverlayImmediate(); alert("エラー: " + r.error); } 
        })
        .catch(e => { this.isSaving = false; hideSavingOverlayImmediate(); alert("通信エラー"); });
      });
    },
    adjustTextarea(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  }));

  Alpine.data('settingsForm', () => ({
    colors: partColors,
    palette: ["#FF453A", "#FF9F0A", "#FFD60A", "#30D158", "#66D4CF", "#0A84FF", "#5E5CE6", "#BF5AF2", "#FF375F", "#8E8E93", "#FFFFFF"],
    activePart: null,
    
    presetList: timerPresets.map(p => ({ label: p.label, min: Math.floor(p.seconds / 60), sec: p.seconds % 60 })),
    
    openPalette(part) { this.activePart = this.activePart === part ? null : part; },
    selectColor(color) {
      if(!this.activePart) return;
      this.colors[this.activePart] = color; this.activePart = null; partColors = this.colors;
      localStorage.setItem('workout_app_colors_v1', JSON.stringify(this.colors)); renderHomeCalendar();
    },
    savePresets() {
      timerPresets = this.presetList.map(p => ({
        label: String(p.label).trim(),
        seconds: (parseInt(p.min) || 0) * 60 + (parseInt(p.sec) 
