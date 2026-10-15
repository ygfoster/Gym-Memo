// ★Service Worker の登録（オフライン対応）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.error(err));
  });
}

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
const DATA_CACHE_KEY = "workout_app_data_cache_v1"; // ★追加：ゼロ秒起動のためのローカルキャッシュ
const OFFLINE_QUEUE_KEY = "workout_app_offline_queue_v1"; // ★追加：オフライン保存用キュー
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_LABELS_SHORT = ["日", "月", "火", "水", "木", "金", "土"];

document.addEventListener("DOMContentLoaded", function() {
  initBrowserHistoryGuard();
  initDetailSwipe();
  initTimerSheetSwipe();

  makeDraggable(document.getElementById('floating-total'));
  makeDraggable(document.getElementById('floating-rest'));
  updateTimerDisplays();

  // ★1. フリーズ回避：前回取得したデータがあれば、とりあえずそれを使って「ゼロ秒」で画面を立ち上げる
  const cachedRaw = localStorage.getItem(DATA_CACHE_KEY);
  if (cachedRaw) {
    try { initApp(JSON.parse(cachedRaw)); } catch(e) {}
  }

  // ★2. 裏側でGASから最新データを取得しにいく
  fetch(GAS_URL + '?action=getInitialData&limit=45&offset=0&token=' + API_TOKEN)
    .then(response => response.json())
    .then(data => {
      if(data.error) {
        if (!cachedRaw) showError(new Error(data.error)); // キャッシュもない完全初回だけエラー表示
      } else {
        localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(data)); // 最新データをキャッシュに上書き保存
        initApp(data); // 画面を最新状態に書き換える
      }
    })
    .catch(error => {
      if (!cachedRaw) showError(error); // 圏外かつ完全初回起動の時だけエラー表示
    });

  document.addEventListener("click", function(e) {
    if (!e.target.classList.contains("exercise")) {
      document.querySelectorAll(".suggest-box").forEach(box => box.style.display = "none");
    }
  });

  // ★3. 起動時にオフラインで溜まっていた記録があればGASへ自動送信する
  syncOfflineQueue();
});

// 電波が復活した瞬間に自動送信を発動
window.addEventListener('online', syncOfflineQueue);

// オフラインデータの自動同期関数
async function syncOfflineQueue() {
  if (!navigator.onLine) return; 
  const queueRaw = localStorage.getItem(OFFLINE_QUEUE_KEY);
  if (!queueRaw) return;
  
  let queue = [];
  try { queue = JSON.parse(queueRaw); } catch(e) { return; }
  if (queue.length === 0) return;

  if (window.isSyncing) return;
  window.isSyncing = true;
  let remainingQueue = [...queue];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    try {
      const response = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(item.payload)
      });
      const result = await response.json();
      if (result.success) {
        if (result.updatedHistory) {
          globalTrainingHistory = result.updatedHistory;
          // ローカルキャッシュも最新化
          const cachedRaw = localStorage.getItem(DATA_CACHE_KEY);
          if (cachedRaw) {
             let cData = JSON.parse(cachedRaw);
             cData.trainingHistory = result.updatedHistory;
             localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(cData));
          }
        }
        remainingQueue = remainingQueue.filter(q => q.id !== item.id);
      }
    } catch (e) { break; } // 途中で電波が途切れたら終了
  }

  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remainingQueue));
  window.isSyncing = false;

  // もしデータが送信されて減っていれば、画面を再描画する
  if (queue.length !== remainingQueue.length) {
    initApp(null); 
  }
}

document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === 'visible') {
    try {
      const raw = localStorage.getItem(STORAGE_VIEW_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.timestamp && (Date.now() - saved.timestamp > 3600000)) { openHomeView(); }
      }
    } catch(e){}
    syncOfflineQueue(); // アプリに戻ってきた時にも同期を試みる
  } else {
    try {
      const raw = localStorage.getItem(STORAGE_VIEW_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        saved.timestamp = Date.now();
        localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify(saved));
      }
    } catch(e){}
  }
});

/* ======================================================================
   新タイマーシステム（TOTAL & REST）
====================================================================== */
let currentPresetSeconds = 180;
let restRemainingSeconds = 180;
let isResting = false;
let restTimerInterval = null;
let restEndTime = 0;

let totalTimerInterval = null;
let totalStartTime = 0;
let totalSeconds = 0;
let isTotalTimerRunning = false;
let wakeLock = null;

function formatTime(seconds) {
  if (seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (Math.floor(seconds) % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function updateTimerDisplays() {
  const timeStr = formatTime(restRemainingSeconds);
  document.getElementById('floating-rest-time').innerText = timeStr;
  document.getElementById('sheet-rest-time').innerText = timeStr;
  
  const playBtnSheet = document.getElementById('sheet-play-btn');
  const playBtnFloat = document.getElementById('floating-rest-play');
  const circleIphone = document.querySelector('.timer-circle-iphone');
  
  if (isResting) {
    playBtnSheet.innerText = "一時停止";
    playBtnSheet.className = "sheet-circle-btn stop";
    playBtnFloat.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
    circleIphone.className = "timer-circle-iphone running";
  } else {
    playBtnSheet.innerText = "開始";
    playBtnSheet.className = "sheet-circle-btn play";
    playBtnFloat.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    circleIphone.className = "timer-circle-iphone stopped";
  }
}

function selectPreset(seconds, btn) {
  pauseRestTimer();
  currentPresetSeconds = seconds;
  restRemainingSeconds = seconds;
  document.querySelectorAll('.preset-btn').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  updateTimerDisplays();
}

function adjustRestTime(amount) {
  restRemainingSeconds += amount;
  if (restRemainingSeconds < 0) restRemainingSeconds = 0;
  if (isResting) { restEndTime += amount * 1000; }
  updateTimerDisplays();
}

function resetRestTimer() {
  pauseRestTimer();
  restRemainingSeconds = currentPresetSeconds;
  updateTimerDisplays();
}

function toggleRestTimer() {
  if (isResting) { pauseRestTimer(); } else { startRestTimer(); }
}

function pauseRestTimer() {
  isResting = false;
  clearInterval(restTimerInterval);
  if (wakeLock !== null) wakeLock.release().then(() => wakeLock = null);
  updateTimerDisplays();
}

async function startRestTimer() {
  if (restRemainingSeconds <= 0) return; 
  isResting = true;
  restEndTime = Date.now() + (restRemainingSeconds * 1000);
  
  if (!isTotalTimerRunning) {
    isTotalTimerRunning = true;
    totalStartTime = Date.now() - (totalSeconds * 1000);
    totalTimerInterval = setInterval(() => {
      totalSeconds = Math.floor((Date.now() - totalStartTime) / 1000);
      document.getElementById("floating-total-time").innerText = formatTime(totalSeconds);
    }, 1000);
  }
  
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
  updateTimerDisplays();
  
  restTimerInterval = setInterval(() => {
    let remaining = Math.ceil((restEndTime - Date.now()) / 1000);
    if (remaining > 0) {
      restRemainingSeconds = remaining;
      updateTimerDisplays();
    } else {
      clearInterval(restTimerInterval);
      isResting = false;
      restRemainingSeconds = 0;
      updateTimerDisplays();
      if (navigator.vibrate) navigator.vibrate([500, 500, 500, 500, 500, 500, 500, 500, 500]); 
      if (wakeLock !== null) wakeLock.release().then(() => wakeLock = null);
      setTimeout(() => { resetRestTimer(); }, 1000);
    }
  }, 200);
}

function openTimerSheet() {
  document.getElementById('timer-bottom-sheet').classList.add('open');
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-timer').classList.add('active');
}

function closeTimerSheet() {
  document.getElementById('timer-bottom-sheet').classList.remove('open');
  const currentView = getCurrentVisibleView();
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  if (currentView === 'home' || currentView === 'calendar') document.getElementById('nav-home').classList.add('active');
  if (currentView === 'dashboard' || currentView === 'detail') document.getElementById('nav-log').classList.add('active');
  if (currentView === 'graph') document.getElementById('nav-graph').classList.add('active');
}

function initTimerSheetSwipe() {
  const sheet = document.getElementById('timer-bottom-sheet');
  if (!sheet) return;
  let startY = 0;

  sheet.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    const y = e.touches[0].clientY;
    if (y > startY) { e.preventDefault(); }
  }, { passive: false });

  sheet.addEventListener('touchend', (e) => {
    const y = e.changedTouches[0].clientY;
    if (y - startY > 60) { closeTimerSheet(); }
  }, { passive: true });
}

function makeDraggable(element) {
  if(!element) return;
  let startX = 0, startY = 0, initialX = 0, initialY = 0;
  element.addEventListener('touchstart', dragStart, {passive: false});
  element.addEventListener('touchmove', drag, {passive: false});

  function dragStart(e) {
    if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button') || e.target.tagName.toLowerCase() === 'svg') return; 
    initialX = element.getBoundingClientRect().left;
    initialY = element.getBoundingClientRect().top;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }
  function drag(e) {
    if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button') || e.target.tagName.toLowerCase() === 'svg') return;
    e.preventDefault(); 
    let dx = e.touches[0].clientX - startX;
    let dy = e.touches[0].clientY - startY;
    let newLeft = initialX + dx;
    let newTop = initialY + dy;
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - element.offsetWidth));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - element.offsetHeight));
    element.style.left = newLeft + 'px';
    element.style.top = newTop + 'px';
    element.style.bottom = 'auto'; 
    element.style.right = 'auto';
  }
}

/* ======================================================================
   Alpine.jsによるフォーム ＆ 履歴ポップアップ管理
====================================================================== */
document.addEventListener('alpine:init', () => {
  Alpine.data('workoutForm', () => ({
    formPart: '',
    formPartCustom: '',
    formExercises: [],
    hasDraft: false,
    isSaving: false,
    saveMsg: '',
    saveMsgColor: '',

    historyModal: { isOpen: false, exercise: '', records: [] },

    init() { window.alpineWorkoutForm = this; },

    addExercise(existingData = null) {
      const emptySets = Array.from({ length: 5 }, () => ({ w: '', r: '' }));
      if (existingData) { this.formExercises.push({ name: existingData.name, memo: existingData.memo, sets: existingData.sets, suggests: [] }); } 
      else { this.formExercises.push({ name: '', memo: '', sets: emptySets, suggests: [] }); }
      this.saveDraft();
    },
    removeExercise(idx) { this.formExercises.splice(idx, 1); this.saveDraft(); },

    suggest(idx) {
      const val = this.formExercises[idx].name.trim().toLowerCase();
      if (!val) { this.formExercises[idx].suggests = []; return; }
      const currentPart = this.formPart === 'custom' ? this.formPartCustom.trim() : this.formPart;
      const exMap = new Map();
      globalTrainingHistory.forEach(r => {
        const ex = (r.exercise || "").trim();
        if (!ex || ex === "種目不明") return;
        if (ex.toLowerCase().includes(val) && ex.toLowerCase() !== val) {
          if (!exMap.has(ex) || r.part === currentPart) exMap.set(ex, r.part || "");
        }
      });
      this.formExercises[idx].suggests = Array.from(exMap.entries())
        .sort((a, b) => (currentPart && a[1] === currentPart ? -1 : 1) - (currentPart && b[1] === currentPart ? -1 : 1))
        .slice(0, 5).map(([name, part]) => ({ name, part }));
    },
    selectSuggest(idx, name) { this.formExercises[idx].name = name; this.formExercises[idx].suggests = []; this.saveDraft(); },

    openHistory(exName) {
      const name = exName.trim(); if (!name) return;
      this.historyModal.exercise = name;
      const records = globalTrainingHistory
        .filter(r => (r.exercise || "").trim() === name)
        .sort((a, b) => new Date(normalizeDateStr(b.date)) - new Date(normalizeDateStr(a.date)))
        .map(r => {
          const dObj = parseDateKeyToObj(r.date);
          return { dateStr: `${dObj.getFullYear()}/${dObj.getMonth()+1}/${dObj.getDate()}(${DAY_LABELS_SHORT[dObj.getDay()]})`, details: r.details, memo: r.memo };
        });
      this.historyModal.records = records; this.historyModal.isOpen = true;
    },

    saveDraft() {
      if (!currentRecordingDateStr) return;
      localStorage.setItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(currentRecordingDateStr), JSON.stringify({ part: this.formPart, partCustom: this.formPartCustom, exercises: this.formExercises }));
      this.hasDraft = true;
    },
    
    loadDraftAndRecords(dateStr) {
      this.formPart = ''; this.formPartCustom = ''; this.formExercises = []; this.hasDraft = false; this.saveMsg = '';
      const draftRaw = localStorage.getItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(dateStr));
      if (draftRaw) {
        const draft = JSON.parse(draftRaw);
        this.formPart = draft.part || ''; this.formPartCustom = draft.partCustom || '';
        if (draft.exercises && draft.exercises.length > 0) { draft.exercises.forEach(e => this.addExercise(e)); } else { this.addExercise(); }
        this.hasDraft = true; return;
      }
      const records = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === normalizeDateStr(dateStr));
      if (records.length === 0) { this.addExercise(); } else {
        let pt = records[0].part || ''; if (pt === "足") pt = "脚";
        if (["胸", "背中", "腕", "肩", "脚"].includes(pt)) { this.formPart = pt; } else { this.formPart = 'custom'; this.formPartCustom = pt; }
        records.forEach(r => {
          const sets = Array.from({ length: 5 }, () => ({ w: '', r: '' }));
          const parsed = parseDetailsToSets(r.details);
          parsed.forEach((s, i) => { if (i < 5) { sets[i].w = s.w; sets[i].r = s.r; } });
          this.addExercise({ name: r.exercise, memo: r.memo, sets: sets });
        });
      }
    },

    // ★保存処理（オフライン対応版）
    saveTraining() {
      const targetDate = currentRecordingDateStr || formatWithZeroPad(formatDateKey(new Date()));
      const globalPart = this.formPart === 'custom' ? this.formPartCustom.trim() : this.formPart;
      
      if (!globalPart) { this.saveMsg = "部位を選択してください"; this.saveMsgColor = "#FF453A"; return; }

      const trainingData = [];
      this.formExercises.forEach(ex => {
        const name = ex.name.trim(); const memo = ex.memo.trim();
        let setsText = ""; let hasSets = false;
        ex.sets.forEach((s, i) => {
          const w = String(s.w).trim(); const r = String(s.r).trim();
          if (w || r) { setsText += `${i+1}セット目: ${w ? w+'kg' : '-'} × ${r ? r+'回' : '-'}\n`; hasSets = true; }
        });
        setsText = setsText.trim();
        if (name || hasSets || memo) { trainingData.push({ date: targetDate, part: globalPart, exercise: name || "種目不明", details: setsText, memo: memo }); }
      });

      if (trainingData.length === 0) { this.saveMsg = "内容を入力してください"; this.saveMsgColor = "#FF453A"; return; }

      this.isSaving = true; this.saveMsg = ""; showSavingOverlay();

      const payload = { action: 'saveTrainingLog', targetDate: targetDate, trainingData: trainingData, token: API_TOKEN };

      const finishAndClear = (updatedHistory) => {
        if (updatedHistory) globalTrainingHistory = updatedHistory;
        localStorage.removeItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(targetDate));
        this.hasDraft = false;
        finishSavingOverlay(() => { openHomeView(); });
      };

      // オフライン・エラー時の一時保存ロジック
      const saveToOfflineQueue = () => {
        const queueRaw = localStorage.getItem(OFFLINE_QUEUE_KEY);
        let queue = queueRaw ? JSON.parse(queueRaw) : [];
        queue.push({ id: Date.now(), payload: payload });
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
        
        // ローカルでの表示を即座に更新する
        globalTrainingHistory = globalTrainingHistory.filter(r => normalizeDateStr(r.date) !== normalizeDateStr(targetDate));
        trainingData.forEach(d => globalTrainingHistory.push(d));

        const cachedRaw = localStorage.getItem(DATA_CACHE_KEY);
        if (cachedRaw) {
           let cData = JSON.parse(cachedRaw);
           cData.trainingHistory = globalTrainingHistory;
           localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(cData));
        }

        document.getElementById("saving-text").innerText = "オフライン保存しました";
        setTimeout(() => {
          this.isSaving = false;
          finishAndClear(null);
        }, 1200);
      };

      // 完全にオフラインなら即座に一時保存
      if (!navigator.onLine) {
        saveToOfflineQueue();
        return;
      }

      fetch(GAS_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      })
      .then(res => res.json())
      .then(result => {
        this.isSaving = false;
        if (result.success) { finishAndClear(result.updatedHistory); } 
        else { hideSavingOverlayImmediate(); this.saveMsg = "エラー: " + result.error; this.saveMsgColor = "#FF453A"; }
      })
      .catch(err => { 
        // 途中で電波が途切れた場合もオフラインキューに逃がす
        saveToOfflineQueue();
      });
    },

    adjustTextarea(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  }));
});

/* ======================================================================
   既存のデータ取得・UI管理用ロジック
====================================================================== */
function initApp(data) {
  // ★強制非表示処理：どんな状態でも一度読み込み中文字を消す
  document.getElementById("loading").style.display = "none";
  
  if (data) {
    globalTrainingHistory = data.trainingHistory || [];
    globalHealthMap = {};
    if (data.healthHistory && data.healthHistory.length > 0) {
      data.healthHistory.forEach(item => { if (item && item.date) globalHealthMap[normalizeDateStr(item.date)] = item; });
    } else if (data.currentData && data.currentData.date) {
      globalHealthMap[normalizeDateStr(data.currentData.date)] = data.currentData;
    }
  }
  
  // ★更新時：今開いている画面だけを静かに再描画する
  if (!window.isAppInitialized) {
    window.isAppInitialized = true;
    restoreLastViewState();
  } else {
    const currentView = getCurrentVisibleView();
    if (currentView === 'home') { renderHomeCalendar(); renderWeeklySummary(); }
    else if (currentView === 'calendar') { renderDetailCalendar(); }
    else if (currentView === 'dashboard') { if (window.alpineWorkoutForm) window.alpineWorkoutForm.loadDraftAndRecords(currentRecordingDateStr); }
    else if (currentView === 'detail') { openDayDetailView(currentDetailDateKey, document.getElementById("day-detail-title").innerText, null, null, true); }
    else if (currentView === 'graph') { initGraphView(); }
  }
}

function initBrowserHistoryGuard() {
  try {
    window.history.replaceState({ view: 'root_guard' }, ''); window.history.pushState({ view: 'home' }, '');
    window.addEventListener('popstate', function(e) {
      const state = e.state;
      if (!state || state.view === 'root_guard') { window.history.pushState({ view: 'home' }, ''); openHomeView(true); return; }
      applyStateFromHistory(state);
    });
  } catch (err) {}
}

function pushAppHistory(stateObj) {
  try { stateObj.timestamp = Date.now(); localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify(stateObj)); window.history.pushState(stateObj, ''); } catch (e) {}
}

function navigateBack() {
  const currentView = getCurrentVisibleView();
  if (currentView === 'detail') { if (previousViewBeforeDetail === 'calendar') openCalendarDetailView(); else openHomeView(); } else openHomeView();
}

function getCurrentVisibleView() {
  if (document.getElementById("view-dashboard").style.display === "block") return 'dashboard';
  if (document.getElementById("view-day-detail").style.display === "block") return 'detail';
  if (document.getElementById("view-calendar").style.display === "block") return 'calendar';
  if (document.getElementById("view-graph").style.display === "block") return 'graph';
  return 'home';
}

function applyStateFromHistory(state) {
  if (!state || state.view === 'home') openHomeView(true);
  else if (state.view === 'calendar') { currentCalYear = state.year; currentCalMonth = state.month; openCalendarDetailView(true); }
  else if (state.view === 'detail') openDayDetailView(state.dateKey, state.label, state.fromView || 'home', null, true);
  else if (state.view === 'dashboard') openDashboardForDate(state.dateKey || null, true);
  else if (state.view === 'graph') switchTab('graph');
  else openHomeView(true);
}

function restoreLastViewState() {
  try {
    const raw = localStorage.getItem(STORAGE_VIEW_KEY);
    if (!raw) { openHomeView(); return; }
    const saved = JSON.parse(raw);
    if (saved.timestamp && (Date.now() - saved.timestamp > 3600000)) { openHomeView(); return; }
    if (saved && saved.view && saved.view !== 'home') { applyStateFromHistory(saved); return; }
  } catch (e) {}
  openHomeView();
}

// ★メニュー押下時の強制ローディング非表示を追加
function hideAllViews() {
  document.getElementById("loading").style.display = "none";
  ['view-home','view-calendar','view-day-detail','view-dashboard','view-graph'].forEach(id => document.getElementById(id).style.display = "none");
  ['nav-home','nav-log','nav-graph','nav-timer'].forEach(id => document.getElementById(id).classList.remove("active"));
}

function openHomeView(skipHistory) {
  hideAllViews(); document.getElementById("view-home").style.display = "block"; document.getElementById("nav-home").classList.add("active");
  const now = new Date(); currentCalYear = now.getFullYear(); currentCalMonth = now.getMonth();
  renderHomeCalendar(); renderWeeklySummary();
  if (!skipHistory) pushAppHistory({ view: 'home' }); else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'home', timestamp: Date.now() })); } catch(e){} }
  window.scrollTo(0, 0);
}

function openCalendarDetailView(skipHistory) {
  hideAllViews(); document.getElementById("view-calendar").style.display = "block"; renderDetailCalendar();
  if (!skipHistory) pushAppHistory({ view: 'calendar', year: currentCalYear, month: currentCalMonth }); else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'calendar', year: currentCalYear, month: currentCalMonth, timestamp: Date.now() })); } catch(e){} }
  window.scrollTo(0, 0);
}

function openDashboardForDate(targetDateKey, skipHistory) {
  hideAllViews(); document.getElementById("view-dashboard").style.display = "block"; document.getElementById("nav-log").classList.add("active");
  
  let recordDateObj = targetDateKey ? parseDateKeyToObj(targetDateKey) : new Date();
  currentRecordingDateStr = formatWithZeroPad(formatDateKey(recordDateObj));
  document.getElementById("recording-target-label").innerText = `${formatDisplayDateWithDay(currentRecordingDateStr)} の記録`;
  
  const prevDateObj = new Date(recordDateObj.getFullYear(), recordDateObj.getMonth(), recordDateObj.getDate() - 1);
  document.getElementById("form-vitals-caption").innerText = `前日 ${prevDateObj.getMonth() + 1}/${prevDateObj.getDate()} (${DAY_LABELS_SHORT[prevDateObj.getDay()]}) のコンディション`;

  loadHealthDataIntoPrefix(formatDateKey(prevDateObj), "");
  if (window.alpineWorkoutForm) window.alpineWorkoutForm.loadDraftAndRecords(currentRecordingDateStr);

  if (!skipHistory) pushAppHistory({ view: 'dashboard', dateKey: currentRecordingDateStr });
  else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'dashboard', dateKey: currentRecordingDateStr, timestamp: Date.now() })); } catch(e){} }
  window.scrollTo(0, 0);
}

function loadHealthDataIntoPrefix(dateKey, prefix) {
  const normalized = normalizeDateStr(dateKey);
  if (globalHealthMap[normalized]) { renderVitalsToDOM(globalHealthMap[normalized], prefix); }
  else {
    renderVitalsToDOM(null, prefix);
    fetch(GAS_URL + '?action=getDataForDate&date=' + formatWithZeroPad(normalized) + '&token=' + API_TOKEN)
      .then(res => res.json()).then(data => { if (data && !data.error) { globalHealthMap[normalized] = data; renderVitalsToDOM(data, prefix); } }).catch(()=>{});
  }
}

function renderVitalsToDOM(data, p) {
  document.getElementById(p+"sleep-time").innerText = cleanMetric(data?.sleep, ""); document.getElementById(p+"cal-intake").innerText = cleanMetric(data?.intake, "");
  document.getElementById(p+"cal-burned").innerText = cleanMetric(data?.burned, ""); document.getElementById(p+"p-val").innerText = cleanMetric(data?.protein, "");
  document.getElementById(p+"f-val").innerText = cleanMetric(data?.fat, ""); document.getElementById(p+"c-val").innerText = cleanMetric(data?.carb, "");
  const diff = data ? parseInt(String(data.balance).replace(/[^-0-9]/g, ""), 10) : NaN;
  document.getElementById(p+"cal-balance").innerText = isNaN(diff) ? "" : (diff > 0 ? "+" : "") + diff.toLocaleString() + " kcal";
}

function openDayDetailView(dateKey, displayLabel, fromView, slideClass, skipHistory) {
  if (fromView) previousViewBeforeDetail = fromView;
  currentDetailDateKey = normalizeDateStr(dateKey);
  hideAllViews(); const viewEl = document.getElementById("view-day-detail"); viewEl.style.display = "block";
  if (slideClass) { viewEl.classList.remove("slide-anim-from-right", "slide-anim-from-left"); void viewEl.offsetWidth; viewEl.classList.add(slideClass); }
  document.getElementById("day-detail-title").innerText = displayLabel || formatDisplayDateWithDay(currentDetailDateKey);
  loadHealthDataIntoPrefix(currentDetailDateKey, "detail-");

  const summary = document.getElementById("day-summary-container"); const content = document.getElementById("day-detail-content"); const btn = document.getElementById("day-detail-edit-btn");
  summary.innerHTML = ""; content.innerHTML = "";

  const records = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === currentDetailDateKey);
  if (records.length === 0) {
    summary.style.display = "none"; content.innerHTML = `<div class="empty-state"><div class="empty-state-title">トレーニング記録がありません</div></div>`; btn.innerText = "この日のワークアウトを記録";
  } else {
    btn.innerText = "この日の記録を編集・追加";
    const parts = [...new Set(records.map(r => r.part || "未指定"))].join("・") + "の日";
    let vol = 0, sets = 0;
    records.forEach(r => { const ps = parseDetailsToSets(r.details); sets += ps.length; ps.forEach(s => { vol += (parseFloat(s.w)||0) * (parseFloat(s.r)||0); }); });
    
    summary.style.display = "block";
    summary.innerHTML = `<div class="detail-hero"><div><div class="detail-part-Main">${parts}</div><div class="detail-sub-counts">${records.length}種目 ・ 合計 ${sets}セット</div></div><div class="detail-volume-block"><div class="detail-volume-num">${Number.isInteger(vol) ? vol.toLocaleString() : vol.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}<span class="detail-volume-kg">kg</span></div><div class="detail-volume-unit">TOTAL VOLUME</div></div></div>`;
    
    records.forEach(r => {
      const c = document.createElement("div"); c.className = "exercise-detail-card";
      c.innerHTML = `<div class="exercise-detail-name">${r.exercise || "種目未入力"}</div>`;
      const ps = parseDetailsToSets(r.details);
      if (ps.length > 0) {
        const t = document.createElement("div"); t.className = "sets-table";
        ps.forEach((s, i) => { t.innerHTML += `<div class="set-line"><span class="set-line-idx">SET ${i+1}</span><span class="set-line-val">${s.w !== '' ? s.w+'<span class="set-line-unit">kg</span>' : '-'} × ${s.r !== '' ? s.r+'<span class="set-line-unit">回</span>' : '-'}</span></div>`; });
        c.appendChild(t);
      } else if (r.details) { c.innerHTML += `<div style="font-size:0.9rem; color:var(--text-secondary); white-space:pre-wrap;">${r.details}</div>`; }
      if (r.memo) c.innerHTML += `<div class="exercise-detail-memo">${r.memo}</div>`;
      content.appendChild(c);
    });
  }
  btn.onclick = () => openDashboardForDate(currentDetailDateKey);
  const stateObj = { view: 'detail', dateKey: currentDetailDateKey, label: document.getElementById("day-detail-title").innerText, fromView: previousViewBeforeDetail };
  if (!skipHistory && !slideClass) pushAppHistory(stateObj); else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({...stateObj, timestamp: Date.now()})); } catch(e){} }
  if (!slideClass) window.scrollTo(0, 0);
}

function shiftDetailDay(offset) {
  if (!currentDetailDateKey) return;
  const d = parseDateKeyToObj(currentDetailDateKey);
  const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  openDayDetailView(formatDateKey(n), formatDisplayDateWithDay(formatDateKey(n)), null, offset > 0 ? "slide-anim-from-right" : "slide-anim-from-left", true);
}

function initDetailSwipe() {
  let sX = 0, sY = 0, isDown = false;
  const v = document.getElementById("view-day-detail"); if (!v) return;
  const handle = (dx, dy) => { if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) shiftDetailDay(dx > 0 ? -1 : 1); };
  v.addEventListener("touchstart", e => { if (e.touches.length === 1) { sX = e.touches[0].clientX; sY = e.touches[0].clientY; } }, { passive: true });
  v.addEventListener("touchend", e => { if (e.changedTouches.length === 1) handle(e.changedTouches[0].clientX - sX, e.changedTouches[0].clientY - sY); }, { passive: true });
  v.addEventListener("mousedown", e => { isDown = true; sX = e.clientX; sY = e.clientY; });
  v.addEventListener("mouseup", e => { if (isDown) { isDown = false; handle(e.clientX - sX, e.clientY - sY); }});
}

function showSavingOverlay() { const o = document.getElementById("saving-overlay"); document.getElementById("saving-spinner").style.display="block"; document.getElementById("saving-check").style.display="none"; document.getElementById("saving-text").innerText="記録を保存中..."; o.classList.add("active"); }
function finishSavingOverlay(cb) { document.getElementById("saving-spinner").style.display="none"; document.getElementById("saving-check").style.display="flex"; document.getElementById("saving-text").innerText="保存しました"; setTimeout(()=>{ document.getElementById("saving-overlay").classList.remove("active"); if (cb) cb(); }, 450); }
function hideSavingOverlayImmediate() { document.getElementById("saving-overlay").classList.remove("active"); }

function normalizeDateStr(str) { if (!str) return ""; const n = str.match(/\d+/g); if (n && n.length >= 3) return `${parseInt(n[0],10)}/${parseInt(n[1],10)}/${parseInt(n[2],10)}`; return str.trim(); }
function parseDateKeyToObj(str) { const n = String(str).match(/\d+/g); if (n && n.length >= 3) return new Date(parseInt(n[0],10), parseInt(n[1],10)-1, parseInt(n[2],10)); return new Date(); }
function formatDateKey(d) { return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`; }
function formatWithZeroPad(str) { const n = String(str).match(/\d+/g); if (n && n.length >= 3) return `${n[0]}/${String(parseInt(n[1],10)).padStart(2,'0')}/${String(parseInt(n[2],10)).padStart(2,'0')}`; return str; }
function formatDisplayDateWithDay(str) { const n = String(str).match(/\d+/g); if (n && n.length >= 3) { const y = parseInt(n[0],10), m = parseInt(n[1],10), d = parseInt(n[2],10); return `${y}/${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')} (${DAY_LABELS_SHORT[new Date(y, m-1, d).getDay()]})`; } return str; }
function cleanMetric(val, suf) { if (val === undefined || val === null) return ""; const s = String(val).trim(); if (s === "" || s === "-" || s.includes("#") || s === "NaN") return ""; return suf ? `${s} ${suf}` : s; }
function parseDetailsToSets(str) {
  if (!str) return [];
  return str.split('\n').filter(l => l.trim() !== '').map(l => {
    const m = l.match(/:\s*([0-9.]+|-)(?:kg)?\s*[×xXﾗ]\s*([0-9.]+|-)(?:回)?/);
    if (m) return { w: m[1] === '-' ? '' : m[1], r: m[2] === '-' ? '' : m[2] };
    return { w: '', r: '' };
  });
}

function updateHomeStats() {
  if (!globalTrainingHistory) return;
  const ud = new Set(), md = new Set();
  globalTrainingHistory.forEach(r => {
    const dStr = normalizeDateStr(r.date); ud.add(dStr);
    const d = parseDateKeyToObj(dStr);
    if (d.getFullYear() === currentCalYear && d.getMonth() === currentCalMonth) md.add(dStr);
  });
  if(document.getElementById("home-monthly-days")) document.getElementById("home-monthly-days").innerText = md.size;
  if(document.getElementById("home-total-days")) document.getElementById("home-total-days").innerText = ud.size;
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
    const cl = (dK === tK && (!isD || activeFilters.length === 0 || t)) ? "cal-day today" : (t ? "cal-day trained" : "cal-day");
    c.innerHTML = `<div class="${cl}">${d}</div>`;
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
function switchTab(t) {
  hideAllViews();
  if (t === 'home') { document.getElementById("view-home").style.display = "block"; document.getElementById("nav-home").classList.add("active"); renderHomeCalendar(); renderWeeklySummary(); pushAppHistory({ view: 'home' }); }
  else if (t === 'log') { document.getElementById("view-dashboard").style.display = "block"; document.getElementById("nav-log").classList.add("active"); const n = new Date(); openDashboardForDate(n.getFullYear()+'/'+(n.getMonth()+1)+'/'+n.getDate()); }
  else if (t === 'graph') { document.getElementById("view-graph").style.display = "block"; document.getElementById("nav-graph").classList.add("active"); pushAppHistory({ view: 'graph' }); initGraphView(); }
  window.scrollTo(0, 0);
}

let rmChartInstance = null; let volumeChartInstance = null;
function initGraphView() {
  const sel = document.getElementById("graph-exercise-select"); const cV = sel.value;
  const pm = { "胸": new Set(), "背中": new Set(), "脚": new Set(), "肩": new Set(), "腕": new Set(), "その他": new Set() };
  globalTrainingHistory.forEach(r => {
    const ex = (r.exercise || "").trim(); let pt = (r.part || "").trim();
    if (!ex || ex === "種目不明") return;
    if (pt === "足") pt = "脚"; if (!["胸", "背中", "脚", "肩", "腕"].includes(pt)) pt = "その他";
    pm[pt].add(ex);
  });
  let h = '<option value="">グラフ化する種目を選択...</option>';
  ["胸", "背中", "脚", "肩", "腕", "その他"].forEach(p => {
    const exs = Array.from(pm[p]).sort();
    if (exs.length > 0) { h += `<optgroup label="【${p}】">`; exs.forEach(ex => { h += `<option value="${ex}">${ex}</option>`; }); h += `</optgroup>`; }
  });
  sel.innerHTML = h;
  if (cV && Array.from(sel.options).some(o => o.value === cV)) { sel.value = cV; updateGraphs(); } else clearGraphs();
}
function clearGraphs() { if (rmChartInstance) rmChartInstance.destroy(); if (volumeChartInstance) volumeChartInstance.destroy(); }
function updateGraphs() {
  const tE = document.getElementById("graph-exercise-select").value; if (!tE) { clearGraphs(); return; }
  const rs = globalTrainingHistory.filter(r => r.exercise === tE).sort((a,b) => new Date(normalizeDateStr(a.date)) - new Date(normalizeDateStr(b.date)));
  const lbls = [], rmd = [], vd = [];
  rs.forEach(r => {
    const dStr = formatDisplayDateWithDay(normalizeDateStr(r.date)).substring(5, 10); 
    const ps = parseDetailsToSets(r.details); let dm = 0, dv = 0;
    ps.forEach(s => {
      const w = parseFloat(s.w), rep = parseFloat(s.r);
      if (!isNaN(w) && !isNaN(rep) && rep > 0) { dv += (w * rep); const cRM = w * (1 + rep / 30); if (cRM > dm) dm = cRM; }
    });
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
