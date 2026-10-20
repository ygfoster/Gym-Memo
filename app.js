/* ======================================================================
   1. グローバルエラー監視 & ユーティリティ（エラーの可視化・堅牢設計）
====================================================================== */
window.addEventListener('error', function(event) {
  console.error('[Global Error]', event.message, event.filename, event.lineno);
  if (window.showToast) {
    window.showToast(`システムエラー: ${event.message}`, 'error');
  }
});

window.addEventListener('unhandledrejection', function(event) {
  const reason = event.reason ? (event.reason.message || String(event.reason)) : '不明な非同期エラー';
  console.error('[Unhandled Rejection]', reason);
  if (window.showToast) {
    window.showToast(`通信・処理エラー: ${reason}`, 'error');
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.update();
    }).catch(err => console.warn('[SW Register Warn]', err));
  });
}

// 安全なDOM取得・テキスト更新ヘルパー
function getEl(id) {
  return document.getElementById(id);
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}
function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[JSON Parse Warn]', err);
    return fallback;
  }
}

/* ======================================================================
   2. 定数・グローバル状態管理
====================================================================== */
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
const DATA_CACHE_KEY = "workout_app_data_cache_v207"; // キャッシュ強制リフレッシュ
const OFFLINE_QUEUE_KEY = "workout_app_offline_queue_v1";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_LABELS_SHORT = ["日", "月", "火", "水", "木", "金", "土"];
const DEFAULT_COLORS = { "胸": "#FF453A", "背中": "#0A84FF", "脚": "#30D158", "肩": "#FF9F0A", "腕": "#BF5AF2", "その他": "#8E8E93" };

let partColors = safeJsonParse(localStorage.getItem('workout_app_colors_v1'), null);
if (!partColors || typeof partColors !== 'object') {
  partColors = { ...DEFAULT_COLORS };
}

const DEFAULT_TIMER_PRESETS = [
  { label: "胸", seconds: 180 },
  { label: "背中", seconds: 180 },
  { label: "脚", seconds: 180 },
  { label: "腕", seconds: 120 },
  { label: "肩", seconds: 90 }
];
let timerPresets = safeJsonParse(localStorage.getItem('workout_app_timer_presets_v1'), null);
if (!Array.isArray(timerPresets) || timerPresets.length === 0) {
  timerPresets = [...DEFAULT_TIMER_PRESETS];
}

// ハプティックフィードバック
window.vibrateSmall = function() { if (navigator.vibrate) navigator.vibrate(10); };
window.vibrateMedium = function() { if (navigator.vibrate) navigator.vibrate(20); };
window.vibrateSuccess = function() { if (navigator.vibrate) navigator.vibrate([15, 50, 20]); };
window.vibrateError = function() { if (navigator.vibrate) navigator.vibrate([20, 30, 20, 30, 30]); };
window.vibrateTimerEnd = function() {
  if (navigator.vibrate) {
    navigator.vibrate([500, 500, 500, 500, 500, 500, 500, 500, 500]);
  }
};

// トースト通知（緑色を完全排除・エラー内容を明確に表示）
window.showToast = function(message, type = 'success') {
  const container = getEl('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = type === 'error'
    ? `<svg width="20" height="20" style="flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>${message}</span>`
    : `<svg width="20" height="20" style="flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, 3200);
};

/* ======================================================================
   3. 通信ラッパー（エラー原因を正確にキャッチするAPIクライアント）
====================================================================== */
async function apiFetch(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timerId);
    if (!response.ok) {
      throw new Error(`HTTPエラー (${response.status})`);
    }
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('サーバー応答の解析に失敗しました (JSON形式エラー)');
    }
    if (json && json.error) {
      throw new Error(json.error);
    }
    return json;
  } catch (err) {
    clearTimeout(timerId);
    if (err.name === 'AbortError') {
      throw new Error('通信がタイムアウトしました (15秒経過)');
    }
    throw err;
  }
}

/* ======================================================================
   4. 日付正規化・データ解析ユーティリティ（1日ズレバグの完全修正）
====================================================================== */
// ★修正: GASからISO文字列("2026-10-19T15:00:00.000Z"等)が来た場合でも、
// 必ず日本時間(ローカルタイム)の年月日に変換してから正規化する
function normalizeDateStr(s) {
  if (!s) return "";
  if (s instanceof Date && !isNaN(s.getTime())) {
    return `${s.getFullYear()}/${s.getMonth() + 1}/${s.getDate()}`;
  }
  const str = String(s).trim();
  // ISO 8601形式（Tを含む日時文字列）の場合はDateオブジェクト経由でローカル日付を取得
  if (str.includes('T')) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    }
  }
  const n = str.match(/\d+/g);
  if (n && n.length >= 3) {
    let y = parseInt(n[0], 10);
    let m = parseInt(n[1], 10);
    let d = parseInt(n[2], 10);
    // 万が一 MM/DD/YYYY の順で入っていた場合の補正
    if (y <= 12 && d >= 1900) {
      return `${d}/${y}/${m}`;
    }
    return `${y}/${m}/${d}`;
  }
  return str;
}

function parseDateKeyToObj(s) {
  const norm = normalizeDateStr(s);
  const n = norm.match(/\d+/g);
  if (n && n.length >= 3) {
    return new Date(parseInt(n[0], 10), parseInt(n[1], 10) - 1, parseInt(n[2], 10));
  }
  return new Date();
}

function formatDateKey(d) {
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatWithZeroPad(s) {
  const norm = normalizeDateStr(s);
  const n = norm.match(/\d+/g);
  if (n && n.length >= 3) {
    return `${n[0]}/${String(parseInt(n[1], 10)).padStart(2, '0')}/${String(parseInt(n[2], 10)).padStart(2, '0')}`;
  }
  return String(s);
}

function formatDisplayDateWithDay(s) {
  const norm = normalizeDateStr(s);
  const n = norm.match(/\d+/g);
  if (n && n.length >= 3) {
    const y = parseInt(n[0], 10), m = parseInt(n[1], 10), d = parseInt(n[2], 10);
    return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')} (${DAY_LABELS_SHORT[new Date(y, m - 1, d).getDay()]})`;
  }
  return String(s);
}

function parseDetailsToSets(s) {
  if (!s) return [];
  return String(s).split('\n').filter(l => l.trim() !== '').map(l => {
    const m = l.match(/:\s*([0-9.]+|-)(?:kg)?\s*[×xX✕＊*ﾗ]\s*([0-9.]+|-)(?:回)?/);
    if (m) return { w: m[1] === '-' ? '' : m[1], r: m[2] === '-' ? '' : m[2] };
    return { w: '', r: '' };
  });
}

/* ======================================================================
   5. Googleヘルス（バイタル）データの統合・取得・表示ロジック
====================================================================== */
// データのキー揺れや空判定を安全に吸収するヘルパー
function extractHealthRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // GASのレスポンスが { currentData: {...} } や { data: {...} } でラップされている場合にも対応
  const target = raw.currentData || raw.data || raw;
  const dateVal = target.date || target.targetDate || "";
  const sleep = target.sleep ?? target.sleepTime ?? "";
  const balance = target.balance ?? target.calBalance ?? "";
  const intake = target.intake ?? target.calIntake ?? "";
  const burned = target.burned ?? target.calBurned ?? "";
  const protein = target.protein ?? target.p ?? "";
  const fat = target.fat ?? target.f ?? "";
  const carb = target.carb ?? target.c ?? "";

  return { date: dateVal, sleep, balance, intake, burned, protein, fat, carb };
}

function hasValidHealthMetrics(rec) {
  if (!rec) return false;
  const fields = [rec.sleep, rec.balance, rec.intake, rec.burned, rec.protein, rec.fat, rec.carb];
  return fields.some(v => {
    if (v === undefined || v === null) return false;
    const s = String(v).trim();
    return s !== "" && s !== "-" && s !== "--" && !s.includes("#") && s !== "NaN";
  });
}

function ingestHealthDataFromResponse(data) {
  if (!data) return;
  if (Array.isArray(data.healthHistory)) {
    data.healthHistory.forEach(item => {
      const rec = extractHealthRecord(item);
      if (rec && rec.date) {
        const key = normalizeDateStr(rec.date);
        // 既に有効なデータがある場合は、空データで上書きしない
        if (!globalHealthMap[key] || hasValidHealthMetrics(rec)) {
          globalHealthMap[key] = rec;
        }
      }
    });
  }
  if (data.currentData) {
    const cur = extractHealthRecord(data.currentData);
    if (cur && cur.date) {
      const key = normalizeDateStr(cur.date);
      if (!globalHealthMap[key] || hasValidHealthMetrics(cur)) {
        globalHealthMap[key] = cur;
      }
    }
  }
}

function cleanMetric(v, fallback = "--") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  if (s === "" || s === "-" || s.includes("#") || s === "NaN" || s === "null" || s === "undefined") {
    return fallback;
  }
  return s;
}

function formatCalorieBalance(val, fallback = "--") {
  if (val === undefined || val === null) return fallback;
  const s = String(val).trim();
  if (s === "" || s === "-" || s === "--" || s.includes("#") || s === "NaN") return fallback;
  const num = parseInt(s.replace(/[^-0-9]/g, ""), 10);
  if (isNaN(num)) return s;
  return (num > 0 ? "+" : "") + num.toLocaleString() + " kcal";
}

function renderVitalsToDOM(data, prefix, isLoading = false) {
  const placeholder = isLoading ? "..." : "--";
  const rec = extractHealthRecord(data);

  setText(prefix + "sleep-time", rec ? cleanMetric(rec.sleep, placeholder) : placeholder);
  setText(prefix + "cal-intake", rec ? cleanMetric(rec.intake, placeholder) : placeholder);
  setText(prefix + "cal-burned", rec ? cleanMetric(rec.burned, placeholder) : placeholder);
  setText(prefix + "p-val", rec ? cleanMetric(rec.protein, placeholder) : placeholder);

  const fId = getEl(prefix + "f-val") ? (prefix + "f-val") : (prefix + "f-val-log");
  setText(fId, rec ? cleanMetric(rec.fat, placeholder) : placeholder);

  const cId = getEl(prefix + "c-val") ? (prefix + "c-val") : (prefix + "c-val-log");
  setText(cId, rec ? cleanMetric(rec.carb, placeholder) : placeholder);

  setText(prefix + "cal-balance", rec ? formatCalorieBalance(rec.balance, placeholder) : placeholder);
}

// ★改善: 当日（dateKey）のヘルスデータを確実に取得・表示する
async function loadHealthDataIntoPrefix(dateKey, prefix) {
  const normKey = normalizeDateStr(dateKey);
  const cached = globalHealthMap[normKey];

  // キャッシュに有効な数値がある場合は即座に表示
  if (cached && hasValidHealthMetrics(cached)) {
    renderVitalsToDOM(cached, prefix, false);
  } else {
    renderVitalsToDOM(null, prefix, navigator.onLine);
  }

  if (!navigator.onLine) return;

  // キャッシュが空、または最新値を確認するためバックグラウンドで個別日付データを取得
  try {
    const queryDate = formatWithZeroPad(normKey);
    const url = `${GAS_URL}?action=getDataForDate&date=${encodeURIComponent(queryDate)}&token=${encodeURIComponent(API_TOKEN)}`;
    const resData = await apiFetch(url, {}, 15000);
    const rec = extractHealthRecord(resData);

    if (rec && hasValidHealthMetrics(rec)) {
      globalHealthMap[normKey] = rec;
      // 画面が切り替わっていない場合のみDOMを更新
      const currentTargetKey = prefix === "detail-" ? currentDetailDateKey : normalizeDateStr(currentRecordingDateStr);
      if (currentTargetKey === normKey) {
        renderVitalsToDOM(rec, prefix, false);
      }
    } else if (!cached || !hasValidHealthMetrics(cached)) {
      // ゼロ埋めなしの日付文字列でもう一度だけフォールバック検索
      if (queryDate !== normKey) {
        const retryUrl = `${GAS_URL}?action=getDataForDate&date=${encodeURIComponent(normKey)}&token=${encodeURIComponent(API_TOKEN)}`;
        const retryData = await apiFetch(retryUrl, {}, 12000);
        const retryRec = extractHealthRecord(retryData);
        if (retryRec && hasValidHealthMetrics(retryRec)) {
          globalHealthMap[normKey] = retryRec;
          renderVitalsToDOM(retryRec, prefix, false);
          return;
        }
      }
      renderVitalsToDOM(null, prefix, false);
    }
  } catch (err) {
    console.warn(`[Health Data Fetch Warn] (${normKey}):`, err.message);
    if (!cached || !hasValidHealthMetrics(cached)) {
      renderVitalsToDOM(null, prefix, false);
    }
  }
}

/* ======================================================================
   6. 初期化・オンライン同期処理
====================================================================== */
document.addEventListener("DOMContentLoaded", function() {
  initBrowserHistoryGuard();
  initDetailSwipe();
  initLogSwipe();
  initCalendarSwipe();
  initTimerSheetSwipe();

  makeDraggable(getEl('floating-total'));
  makeDraggable(getEl('floating-rest'));

  renderTimerPresets();
  updateTimerDisplays();
  localStorage.removeItem(STORAGE_VIEW_KEY);

  const cachedData = safeJsonParse(localStorage.getItem(DATA_CACHE_KEY), null);
  if (cachedData) {
    initApp(cachedData);
  } else {
    const loadingEl = getEl("loading");
    if (loadingEl) loadingEl.style.display = "block";
    initApp(null);
  }

  // 最新データの初期同期
  const initUrl = `${GAS_URL}?action=getInitialData&limit=60&offset=0&token=${encodeURIComponent(API_TOKEN)}`;
  apiFetch(initUrl, {}, 15000)
    .then(data => {
      const loadingEl = getEl("loading");
      if (loadingEl) loadingEl.style.display = "none";

      localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(data));
      globalTrainingHistory = data.trainingHistory || [];
      ingestHealthDataFromResponse(data);

      // 現在表示中の画面に合わせて最新データを即時反映
      const cV = getCurrentVisibleView();
      if (cV === 'home') {
        renderHomeCalendar();
        renderWeeklySummary();
      } else if (cV === 'detail' && currentDetailDateKey) {
        loadHealthDataIntoPrefix(currentDetailDateKey, "detail-");
      } else if (cV === 'dashboard' && currentRecordingDateStr) {
        loadHealthDataIntoPrefix(currentRecordingDateStr, "");
      }
    })
    .catch(err => {
      const loadingEl = getEl("loading");
      if (loadingEl) loadingEl.style.display = "none";
      console.warn('[Initial Sync Error]', err);
      showToast(`データ同期エラー: ${err.message}`, 'error');
    });

  document.addEventListener("click", e => {
    if (!e.target.classList.contains("exercise")) {
      document.querySelectorAll(".suggest-box").forEach(b => b.style.display = "none");
    }
    if (!e.target.closest('#graph-select-container')) {
      closeGraphSelect();
    }
  });

  syncOfflineQueue();
});

window.addEventListener('online', () => { showToast('オンラインに復帰しました'); syncOfflineQueue(); });
window.addEventListener('offline', () => { showToast('オフラインになりました', 'error'); });

async function syncOfflineQueue() {
  if (!navigator.onLine) return;
  const queue = safeJsonParse(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
  if (!Array.isArray(queue) || queue.length === 0) return;
  if (window.isSyncing) return;
  window.isSyncing = true;

  let remainingQueue = [...queue];
  showToast('オフライン時の記録を同期中...');

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    try {
      const result = await apiFetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(item.payload)
      });
      if (result.success) {
        if (result.updatedHistory) {
          globalTrainingHistory = result.updatedHistory;
          const cData = safeJsonParse(localStorage.getItem(DATA_CACHE_KEY), {});
          cData.trainingHistory = result.updatedHistory;
          localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(cData));
        }
        remainingQueue = remainingQueue.filter(q => q.id !== item.id);
      }
    } catch (e) {
      console.warn('[Offline Queue Sync Error]', e);
      break;
    }
  }

  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remainingQueue));
  window.isSyncing = false;

  if (queue.length !== remainingQueue.length) {
    showToast('同期が完了しました');
    const cV = getCurrentVisibleView();
    if (cV === 'home') { renderHomeCalendar(); renderWeeklySummary(); }
  }
}

document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === 'visible') {
    const s = safeJsonParse(localStorage.getItem(STORAGE_VIEW_KEY), null);
    if (s && s.timestamp && (Date.now() - s.timestamp > 3600000)) {
      openHomeView();
    }
    syncOfflineQueue();
  } else {
    const s = safeJsonParse(localStorage.getItem(STORAGE_VIEW_KEY), null);
    if (s) {
      s.timestamp = Date.now();
      localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify(s));
    }
  }
});

/* ======================================================================
   7. タイマーシステム
====================================================================== */
let currentPresetSeconds = 180, restRemainingSeconds = 180, isResting = false, restTimerInterval = null, restEndTime = 0;
let totalTimerInterval = null, totalStartTime = 0, totalSeconds = 0, isTotalTimerRunning = false, wakeLock = null;

function renderTimerPresets() {
  const container = getEl('timer-presets-container');
  if (!container) return;
  container.innerHTML = '';
  if (timerPresets && timerPresets.length > 0) {
    currentPresetSeconds = timerPresets[0].seconds;
    if (!isResting) restRemainingSeconds = currentPresetSeconds;
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
    btn.onclick = () => { vibrateSmall(); selectPreset(p.seconds, btn); };
    container.appendChild(btn);
  });
  updateTimerDisplays();
}

function formatTime(s) {
  if (s < 0) s = 0;
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(Math.floor(s) % 60).toString().padStart(2, '0')}`;
}

function updateTimerDisplays() {
  const tStr = formatTime(restRemainingSeconds);
  setText('floating-rest-time', tStr);
  setText('sheet-rest-time', tStr);
  const pbS = getEl('sheet-play-btn'), pbF = getEl('floating-rest-play'), cI = document.querySelector('.timer-circle-iphone');
  if (!pbS || !pbF || !cI) return;
  if (isResting) {
    pbS.innerText = "Stop";
    pbS.className = "sheet-circle-btn stop";
    pbF.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
    cI.className = "timer-circle-iphone running";
  } else {
    pbS.innerText = "Start";
    pbS.className = "sheet-circle-btn play";
    pbF.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    cI.className = "timer-circle-iphone stopped";
  }
}

function selectPreset(s, b) {
  pauseRestTimer();
  currentPresetSeconds = s;
  restRemainingSeconds = s;
  document.querySelectorAll('.preset-btn').forEach(e => e.classList.remove('active'));
  b.classList.add('active');
  updateTimerDisplays();
}

function adjustRestTime(a) {
  vibrateSmall();
  restRemainingSeconds += a;
  if (restRemainingSeconds < 0) restRemainingSeconds = 0;
  if (isResting) restEndTime += a * 1000;
  updateTimerDisplays();
}

function resetRestTimer(isAuto = false) {
  if (!isAuto) vibrateSmall();
  pauseRestTimer();
  restRemainingSeconds = currentPresetSeconds;
  updateTimerDisplays();
}

function toggleRestTimer() {
  vibrateMedium();
  if (isResting) pauseRestTimer(); else startRestTimer();
}

function pauseRestTimer() {
  isResting = false;
  clearInterval(restTimerInterval);
  if (wakeLock !== null) {
    wakeLock.release().then(() => wakeLock = null).catch(() => {});
  }
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
      setText("floating-total-time", formatTime(totalSeconds));
    }, 1000);
  }

  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
  updateTimerDisplays();

  restTimerInterval = setInterval(() => {
    let rem = Math.ceil((restEndTime - Date.now()) / 1000);
    if (rem > 0) {
      restRemainingSeconds = rem;
      updateTimerDisplays();
    } else {
      clearInterval(restTimerInterval);
      isResting = false;
      restRemainingSeconds = 0;
      updateTimerDisplays();

      vibrateTimerEnd();
      showToast("次のセットを開始", 'success');

      if (wakeLock !== null) {
        wakeLock.release().then(() => wakeLock = null).catch(() => {});
      }
      setTimeout(() => { resetRestTimer(true); }, 5000);
    }
  }, 200);
}

function openTimerSheet() {
  getEl('timer-bottom-sheet')?.classList.add('open');
  document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
  getEl('nav-timer')?.classList.add('active');
}

function closeTimerSheet() {
  getEl('timer-bottom-sheet')?.classList.remove('open');
  const cV = getCurrentVisibleView();
  document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
  if (cV === 'home') getEl('nav-home')?.classList.add('active');
  if (cV === 'dashboard' || cV === 'detail') getEl('nav-log')?.classList.add('active');
  if (cV === 'graph') getEl('nav-graph')?.classList.add('active');
}

function initTimerSheetSwipe() {
  const sh = getEl('timer-bottom-sheet');
  if (!sh) return;
  let sY = 0;
  sh.addEventListener('touchstart', e => { sY = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (e.touches[0].clientY > sY) { e.preventDefault(); } }, { passive: false });
  sh.addEventListener('touchend', e => { if (e.changedTouches[0].clientY - sY > 60) closeTimerSheet(); }, { passive: true });
}

function makeDraggable(el) {
  if (!el) return;
  let sX = 0, sY = 0, iX = 0, iY = 0;
  el.addEventListener('touchstart', e => {
    if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button') || e.target.tagName.toLowerCase() === 'svg') return;
    iX = el.getBoundingClientRect().left;
    iY = el.getBoundingClientRect().top;
    sX = e.touches[0].clientX;
    sY = e.touches[0].clientY;
  }, { passive: false });
  el.addEventListener('touchmove', e => {
    if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button') || e.target.tagName.toLowerCase() === 'svg') return;
    e.preventDefault();
    let nL = Math.max(0, Math.min(iX + (e.touches[0].clientX - sX), window.innerWidth - el.offsetWidth));
    let nT = Math.max(0, Math.min(iY + (e.touches[0].clientY - sY), window.innerHeight - el.offsetHeight));
    el.style.left = nL + 'px';
    el.style.top = nT + 'px';
    el.style.bottom = 'auto';
    el.style.right = 'auto';
  }, { passive: false });
}

/* ======================================================================
   8. Alpine.js コンポーネント定義（フォーム・設定）
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
      const eS = Array.from({ length: 5 }, () => ({ w: '', r: '' }));
      if (existingData) {
        this.formExercises.push({ name: existingData.name, memo: existingData.memo, sets: existingData.sets, suggests: [] });
      } else {
        this.formExercises.push({ name: '', memo: '', sets: eS, suggests: [] });
      }
      this.saveDraft();
    },

    removeExercise(idx) {
      this.formExercises.splice(idx, 1);
      this.saveDraft();
    },

    suggest(idx) {
      const val = this.formExercises[idx].name.trim().toLowerCase();
      if (!val) { this.formExercises[idx].suggests = []; return; }
      const cP = this.formPart === 'custom' ? this.formPartCustom.trim() : this.formPart;
      const exMap = new Map();
      globalTrainingHistory.forEach(r => {
        const ex = (r.exercise || "").trim();
        if (!ex || ex === "種目不明") return;
        if (ex.toLowerCase().includes(val) && ex.toLowerCase() !== val) {
          if (!exMap.has(ex) || r.part === cP) exMap.set(ex, r.part || "");
        }
      });
      this.formExercises[idx].suggests = Array.from(exMap.entries())
        .sort((a, b) => (cP && a[1] === cP ? -1 : 1) - (cP && b[1] === cP ? -1 : 1))
        .slice(0, 5)
        .map(([name, part]) => ({ name, part }));
    },

    selectSuggest(idx, name) {
      this.formExercises[idx].name = name;
      this.formExercises[idx].suggests = [];
      this.saveDraft();
    },

    openHistory(exName) {
      const name = exName.trim();
      if (!name) {
        showToast("種目名を入力してから履歴を開いてください", "error");
        return;
      }
      this.historyModal.exercise = name;
      const records = globalTrainingHistory
        .filter(r => (r.exercise || "").trim() === name)
        .sort((a, b) => parseDateKeyToObj(b.date) - parseDateKeyToObj(a.date))
        .map(r => {
          const dObj = parseDateKeyToObj(r.date);
          return {
            dateStr: `${dObj.getFullYear()}/${dObj.getMonth() + 1}/${dObj.getDate()}(${DAY_LABELS_SHORT[dObj.getDay()]})`,
            details: String(r.details || "").replace(/ﾗ/g, "×"),
            memo: r.memo
          };
        });
      this.historyModal.records = records;
      document.querySelector('.history-modal-overlay')?.classList.add('active');
      this.historyModal.isOpen = true;
    },

    closeHistory() {
      document.querySelector('.history-modal-overlay')?.classList.remove('active');
      setTimeout(() => { this.historyModal.isOpen = false; }, 200);
    },

    saveDraft() {
      if (!currentRecordingDateStr) return;
      localStorage.setItem(
        STORAGE_DRAFT_PREFIX + normalizeDateStr(currentRecordingDateStr),
        JSON.stringify({ part: this.formPart, partCustom: this.formPartCustom, exercises: this.formExercises })
      );
      this.hasDraft = true;
    },

    loadDraftAndRecords(dateStr) {
      this.formPart = '';
      this.formPartCustom = '';
      this.formExercises = [];
      this.hasDraft = false;
      this.saveMsg = '';

      const dR = safeJsonParse(localStorage.getItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(dateStr)), null);
      if (dR) {
        this.formPart = dR.part || '';
        this.formPartCustom = dR.partCustom || '';
        if (dR.exercises && dR.exercises.length > 0) {
          dR.exercises.forEach(e => this.addExercise(e));
        } else {
          this.addExercise();
        }
        this.hasDraft = true;
        return;
      }

      const rs = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === normalizeDateStr(dateStr));
      if (rs.length === 0) {
        this.addExercise();
      } else {
        let pt = rs[0].part || '';
        if (pt === "足") pt = "脚";
        if (["胸", "背中", "腕", "肩", "脚"].includes(pt)) {
          this.formPart = pt;
        } else {
          this.formPart = 'custom';
          this.formPartCustom = pt;
        }
        rs.forEach(r => {
          const sets = Array.from({ length: 5 }, () => ({ w: '', r: '' }));
          const parsed = parseDetailsToSets(r.details);
          parsed.forEach((s, i) => {
            if (i < 5) { sets[i].w = s.w; sets[i].r = s.r; }
          });
          this.addExercise({ name: r.exercise, memo: r.memo, sets: sets });
        });
        this.hasDraft = false;
      }
    },

    async saveTraining() {
      vibrateMedium();
      const tD = currentRecordingDateStr || formatWithZeroPad(formatDateKey(new Date()));
      const gP = this.formPart === 'custom' ? this.formPartCustom.trim() : this.formPart;
      if (!gP) {
        showToast("トレーニング部位を選択してください", 'error');
        vibrateError();
        return;
      }
      const tData = [];
      this.formExercises.forEach(ex => {
        const n = ex.name.trim();
        const m = ex.memo.trim();
        let sT = "";
        let hS = false;
        ex.sets.forEach((s, i) => {
          const w = String(s.w).trim();
          const r = String(s.r).trim();
          if (w || r) {
            sT += `${i + 1}セット目: ${w ? w + 'kg' : '-'} × ${r ? r + '回' : '-'}\n`;
            hS = true;
          }
        });
        if (n || hS || m) {
          tData.push({ date: tD, part: gP, exercise: n || "種目不明", details: sT.trim(), memo: m });
        }
      });

      if (tData.length === 0) {
        showToast("種目またはセット内容を入力してください", 'error');
        vibrateError();
        return;
      }

      this.isSaving = true;
      showSavingOverlay();

      const conditionData = {
        sleep: getEl("sleep-time")?.innerText || "",
        balance: getEl("cal-balance")?.innerText || "",
        intake: getEl("cal-intake")?.innerText || "",
        burned: getEl("cal-burned")?.innerText || "",
        protein: getEl("p-val")?.innerText || "",
        fat: getEl("f-val-log")?.innerText || "",
        carb: getEl("c-val-log")?.innerText || ""
      };

      const payload = { action: 'saveTrainingLog', targetDate: tD, trainingData: tData, conditionData: conditionData, token: API_TOKEN };

      const fin = (uH) => {
        if (uH) globalTrainingHistory = uH;
        localStorage.removeItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(tD));
        this.hasDraft = false;
        vibrateSuccess();
        finishSavingOverlay(() => { openHomeView(); });
      };

      const saveOff = () => {
        const q = safeJsonParse(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
        q.push({ id: Date.now(), payload: payload });
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));

        globalTrainingHistory = globalTrainingHistory.filter(r => normalizeDateStr(r.date) !== normalizeDateStr(tD));
        tData.forEach(d => globalTrainingHistory.push(d));

        const cD = safeJsonParse(localStorage.getItem(DATA_CACHE_KEY), {});
        cD.trainingHistory = globalTrainingHistory;
        localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(cD));

        showToast("オフライン保存しました（復帰時に自動同期）");
        setTimeout(() => { this.isSaving = false; fin(null); }, 800);
      };

      if (!navigator.onLine) {
        saveOff();
        return;
      }

      try {
        const r = await apiFetch(GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });
        this.isSaving = false;
        if (r.success) {
          fin(r.updatedHistory);
        } else {
          hideSavingOverlayImmediate();
          showToast("保存エラー: " + (r.error || "不明なエラー"), 'error');
          vibrateError();
        }
      } catch (err) {
        console.warn('[Save Fallback to Offline]', err);
        saveOff();
      }
    },

    confirmDeleteFromLog() {
      if (!currentRecordingDateStr) return;
      vibrateMedium();
      openDeleteModal(currentRecordingDateStr, async () => {
        this.isSaving = true;
        showSavingOverlay();
        const payload = { action: 'saveTrainingLog', targetDate: currentRecordingDateStr, trainingData: [], token: API_TOKEN };
        try {
          const r = await apiFetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
          });
          this.isSaving = false;
          if (r.success) {
            globalTrainingHistory = r.updatedHistory || [];
            localStorage.removeItem(STORAGE_DRAFT_PREFIX + normalizeDateStr(currentRecordingDateStr));
            this.hasDraft = false;
            vibrateSuccess();
            finishSavingOverlay(() => { openHomeView(); });
          } else {
            hideSavingOverlayImmediate();
            showToast("削除エラー: " + (r.error || "失敗しました"), 'error');
            vibrateError();
          }
        } catch (err) {
          this.isSaving = false;
          hideSavingOverlayImmediate();
          showToast(`通信エラー: ${err.message}`, 'error');
          vibrateError();
        }
      });
    },

    adjustTextarea(el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }));

  Alpine.data('settingsForm', () => ({
    colors: partColors,
    palette: ["#FF453A", "#FF9F0A", "#FFD60A", "#30D158", "#66D4CF", "#0A84FF", "#5E5CE6", "#BF5AF2", "#FF375F", "#8E8E93", "#FFFFFF"],
    activePart: null,
    presetList: timerPresets.map(p => ({ label: p.label, min: Math.floor(p.seconds / 60), sec: p.seconds % 60 })),

    openPalette(part) {
      vibrateSmall();
      this.activePart = this.activePart === part ? null : part;
    },

    selectColor(color) {
      if (!this.activePart) return;
      vibrateSmall();
      this.colors[this.activePart] = color;
      this.activePart = null;
      partColors = this.colors;
      localStorage.setItem('workout_app_colors_v1', JSON.stringify(this.colors));
      renderHomeCalendar();
    },

    savePresets() {
      vibrateMedium();
      timerPresets = this.presetList.map(p => ({
        label: String(p.label).trim(),
        seconds: (parseInt(p.min, 10) || 0) * 60 + (parseInt(p.sec, 10) || 0)
      }));
      localStorage.setItem('workout_app_timer_presets_v1', JSON.stringify(timerPresets));
      renderTimerPresets();
      showToast("タイマー設定を保存しました");
    }
  }));
});

/* ======================================================================
   9. 画面遷移・レンダリング管理
====================================================================== */
function initApp(data) {
  if (data) {
    globalTrainingHistory = data.trainingHistory || [];
    globalHealthMap = {};
    ingestHealthDataFromResponse(data);
  }
  if (!window.isAppInitialized) {
    window.isAppInitialized = true;
    openHomeView();
  } else {
    const cV = getCurrentVisibleView();
    if (cV === 'home') {
      renderHomeCalendar();
      renderWeeklySummary();
    } else if (cV === 'dashboard') {
      if (window.alpineWorkoutForm) window.alpineWorkoutForm.loadDraftAndRecords(currentRecordingDateStr);
      loadHealthDataIntoPrefix(currentRecordingDateStr, "");
    } else if (cV === 'detail') {
      openDayDetailView(currentDetailDateKey, getEl("day-detail-title")?.innerText, null, null, true);
    } else if (cV === 'graph') {
      initGraphView();
    }
  }
}

function initBrowserHistoryGuard() {
  try {
    window.history.replaceState({ view: 'root_guard' }, '');
    window.history.pushState({ view: 'home' }, '');
    window.addEventListener('popstate', function(e) {
      const state = e.state;
      if (!state || state.view === 'root_guard') {
        window.history.pushState({ view: 'home' }, '');
        openHomeView(true);
        return;
      }
      applyStateFromHistory(state);
    });
  } catch (err) {}
}

function pushAppHistory(s) {
  try {
    s.timestamp = Date.now();
    localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify(s));
    window.history.pushState(s, '');
  } catch (e) {}
}

function navigateBack() {
  vibrateSmall();
  openHomeView();
}

function getCurrentVisibleView() {
  if (getEl("view-dashboard")?.style.display === "block") return 'dashboard';
  if (getEl("view-day-detail")?.style.display === "block") return 'detail';
  if (getEl("view-graph")?.style.display === "block") return 'graph';
  if (getEl("view-settings")?.style.display === "block") return 'settings';
  return 'home';
}

function applyStateFromHistory(s) {
  if (!s || s.view === 'home') openHomeView(true);
  else if (s.view === 'detail') openDayDetailView(s.dateKey, s.label, s.fromView || 'home', null, true);
  else if (s.view === 'dashboard') openDashboardForDate(s.dateKey || null, true);
  else if (s.view === 'graph') switchTab('graph');
  else if (s.view === 'settings') switchTab('settings');
  else openHomeView(true);
}

function hideAllViews() {
  ['view-home', 'view-day-detail', 'view-dashboard', 'view-graph', 'view-settings'].forEach(id => {
    const el = getEl(id);
    if (el) el.style.display = "none";
  });
  ['nav-home', 'nav-log', 'nav-graph', 'nav-timer'].forEach(id => {
    const el = getEl(id);
    if (el) el.classList.remove("active");
  });
}

function openHomeView(sH) {
  hideAllViews();
  const homeEl = getEl("view-home");
  if (homeEl) homeEl.style.display = "block";
  getEl("nav-home")?.classList.add("active");
  const now = new Date();
  currentCalYear = now.getFullYear();
  currentCalMonth = now.getMonth();
  renderHomeCalendar();
  renderWeeklySummary();
  if (!sH) pushAppHistory({ view: 'home' });
  window.scrollTo(0, 0);
}

window.shiftLogDay = function(offset) {
  if (!currentRecordingDateStr) return;
  vibrateSmall();
  const d = parseDateKeyToObj(currentRecordingDateStr);
  const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  openDashboardForDate(formatDateKey(n), false, offset > 0 ? "slide-anim-from-right" : "slide-anim-from-left");
};

// Morphing Animation (中央の追加ボタンから展開)
function triggerMorphingAnimation(callback) {
  const morph = document.createElement('div');
  morph.className = 'morph-overlay';
  const btn = getEl('nav-add-btn');
  if (!btn) { callback(); return; }
  const rect = btn.getBoundingClientRect();
  const size = 30;
  morph.style.width = size + 'px';
  morph.style.height = size + 'px';
  morph.style.left = (rect.left + rect.width / 2 - size / 2) + 'px';
  morph.style.top = (rect.top + rect.height / 2 - size / 2) + 'px';
  document.body.appendChild(morph);

  void morph.offsetWidth;
  morph.classList.add('active');

  setTimeout(() => {
    callback();
    morph.style.opacity = '0';
    setTimeout(() => morph.remove(), 380);
  }, 320);
}

// ★修正: 当日（dO）のカロリー収支＆今朝の睡眠時間を取得・表示
window.openDashboardForDate = function(tK, sH, slideClass, useMorph = false) {
  const proceed = () => {
    vibrateSmall();
    hideAllViews();
    const v = getEl("view-dashboard");
    if (v) v.style.display = "block";
    if (!useMorph) getEl("nav-log")?.classList.add("active");

    let dO = tK ? parseDateKeyToObj(tK) : new Date();
    const targetDateKey = formatDateKey(dO);
    currentRecordingDateStr = formatWithZeroPad(targetDateKey);
    setText("recording-target-label", `${formatDisplayDateWithDay(currentRecordingDateStr)} の記録`);

    const tStr = `${dO.getMonth() + 1}/${dO.getDate()}(${DAY_LABELS_SHORT[dO.getDay()]})`;
    setText("form-vitals-caption", `当日の栄養・今朝の睡眠: ${tStr}`);

    // 当日のヘルスデータを読み込む
    loadHealthDataIntoPrefix(targetDateKey, "");

    if (window.alpineWorkoutForm) {
      window.alpineWorkoutForm.loadDraftAndRecords(currentRecordingDateStr);
    }

    const dc = getEl("dashboard-content");
    if (dc) {
      dc.classList.remove("slide-anim-from-right", "slide-anim-from-left");
      void dc.offsetWidth;
      dc.classList.add(slideClass || "slide-anim-from-right");
    }

    if (!sH) pushAppHistory({ view: 'dashboard', dateKey: currentRecordingDateStr });
    window.scrollTo(0, 0);
  };

  if (useMorph) {
    triggerMorphingAnimation(proceed);
  } else {
    proceed();
  }
};

function updateHomeStats() {
  if (!globalTrainingHistory) return;
  const ud = new Set(), md = new Set();
  globalTrainingHistory.forEach(r => {
    if (!r.date) return;
    const dStr = normalizeDateStr(r.date);
    ud.add(dStr);
    const d = parseDateKeyToObj(dStr);
    if (d.getFullYear() === currentCalYear && d.getMonth() === currentCalMonth) {
      md.add(dStr);
    }
  });
  setText("home-monthly-days", md.size);
  setText("home-total-days", ud.size);
}

function getDateTrainedParts(dateKey, useFilter) {
  const records = globalTrainingHistory.filter(r => r.date && normalizeDateStr(r.date) === dateKey);
  let filtered = records;
  if (useFilter && activeFilters.length > 0) {
    filtered = records.filter(r => activeFilters.some(f => {
      let pt = String(r.part || "").trim();
      return pt.includes(f) || (f === "脚" && pt.includes("足")) || (f === "その他" && !["胸", "背中", "腕", "肩", "脚", "足"].includes(pt));
    }));
  }
  const parts = new Set();
  filtered.forEach(r => {
    let pt = String(r.part || "").trim();
    if (pt === "足") pt = "脚";
    if (["胸", "背中", "脚", "肩", "腕"].includes(pt)) parts.add(pt);
    else parts.add("その他");
  });
  return Array.from(parts);
}

function renderHomeCalendar() {
  buildCalendarGrid(currentCalYear, currentCalMonth, "home-cal-title", "home-cal-grid", false);
  updateHomeStats();
}

function buildCalendarGrid(y, m, tId, gId, isD) {
  const titleEl = getEl(tId);
  const gridEl = getEl(gId);
  if (!titleEl || !gridEl) return;
  titleEl.innerText = `${MONTH_NAMES[m]} ${y}`;
  gridEl.innerHTML = "";
  const fD = (new Date(y, m, 1).getDay() + 6) % 7;
  const dIM = new Date(y, m + 1, 0).getDate();
  const pDIM = new Date(y, m, 0).getDate();
  const tK = formatDateKey(new Date());
  const frag = document.createDocumentFragment();

  for (let i = fD - 1; i >= 0; i--) {
    const c = document.createElement("div");
    c.className = "cal-cell";
    c.innerHTML = `<div class="cal-day other-month">${pDIM - i}</div>`;
    frag.appendChild(c);
  }
  for (let d = 1; d <= dIM; d++) {
    const c = document.createElement("div");
    c.className = "cal-cell clickable";
    const dK = `${y}/${m + 1}/${d}`;
    const t = isDateTrained(dK, isD);
    let dotsHtml = '';
    if (t) {
      const parts = getDateTrainedParts(dK, isD);
      if (parts.length > 0) {
        dotsHtml = '<div class="cal-dots-wrap">';
        parts.slice(0, 4).forEach(pt => {
          let pc = partColors || DEFAULT_COLORS;
          let color = pc[pt] || pc["その他"] || '#8E8E93';
          dotsHtml += `<div class="cal-dot" style="background-color: ${color};"></div>`;
        });
        dotsHtml += '</div>';
      }
    }
    const cl = (dK === tK && (!isD || activeFilters.length === 0 || t)) ? "cal-day today" : (t ? "cal-day trained" : "cal-day");
    c.innerHTML = `<div class="${cl}">${d}${dotsHtml}</div>`;
    c.onclick = e => {
      vibrateSmall();
      e.stopPropagation();
      openDayDetailView(dK, `${y}/${String(m + 1).padStart(2, '0')}/${String(d).padStart(2, '0')} (${DAY_LABELS_SHORT[new Date(y, m, d).getDay()]})`, 'home');
    };
    frag.appendChild(c);
  }
  for (let i = 1; i <= (7 - ((fD + dIM) % 7)) % 7; i++) {
    const c = document.createElement("div");
    c.className = "cal-cell";
    c.innerHTML = `<div class="cal-day other-month">${i}</div>`;
    frag.appendChild(c);
  }
  gridEl.appendChild(frag);
  setTimeout(renderWeeklySummary, 50);
}

function isDateTrained(dateKey, useFilter) {
  if (!globalTrainingHistory) return false;
  let records = globalTrainingHistory.filter(r => r.date && normalizeDateStr(r.date) === dateKey);
  if (!useFilter || activeFilters.length === 0) return records.length > 0;
  return records.some(r => activeFilters.some(f => {
    let pt = String(r.part || "").trim();
    return pt.includes(f) || (f === "脚" && pt.includes("足")) || (f === "その他" && !["胸", "背中", "腕", "肩", "脚", "足"].includes(pt));
  }));
}

function renderWeeklySummary() {
  const c = getEl("weekly-list");
  if (!c) return;
  c.innerHTML = "";
  const n = new Date(), tK = formatDateKey(n);
  const m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + ((n.getDay() === 0) ? -6 : 1 - n.getDay()));
  for (let i = 0; i < 7; i++) {
    const t = new Date(m.getFullYear(), m.getMonth(), m.getDate() + i), k = formatDateKey(t);
    const rs = globalTrainingHistory.filter(r => r.date && normalizeDateStr(r.date) === k);
    let s = "オフ", cl = "rest";
    if (rs.length > 0) {
      cl = "";
      const pm = {};
      rs.forEach(r => {
        let p = String(r.part || "未指定").trim();
        const setCnt = r.sets || parseDetailsToSets(r.details).length || 0;
        pm[p] = (pm[p] || 0) + setCnt;
      });
      s = Object.keys(pm).map(p => `${p} / ${pm[p]}セット`).join(" , ");
    }
    const rE = document.createElement("div");
    rE.className = `list-row-compact ${k === tK ? 'is-today' : ''}`;
    rE.onclick = () => { vibrateSmall(); openDayDetailView(k, formatDisplayDateWithDay(k), 'home'); };
    rE.innerHTML = `<div class="list-date-col">${t.getMonth() + 1}/${t.getDate()}(${DAY_LABELS_SHORT[t.getDay()]})</div><div class="list-desc-col ${cl}">${s}</div>`;
    c.appendChild(rE);
  }
}

window.changeHomeMonth = function(offset) {
  vibrateSmall();
  currentCalMonth += offset;
  if (currentCalMonth < 0) { currentCalMonth = 11; currentCalYear--; }
  else if (currentCalMonth > 11) { currentCalMonth = 0; currentCalYear++; }
  const v = getEl("home-cal-grid");
  if (v) {
    v.classList.remove("slide-anim-from-right", "slide-anim-from-left");
    void v.offsetWidth;
    v.classList.add(offset > 0 ? "slide-anim-from-right" : "slide-anim-from-left");
  }
  renderHomeCalendar();
};

/* ======================================================================
   10. 削除確認モーダル & 日別詳細画面
====================================================================== */
function openDeleteModal(dateKey, onConfirm) {
  pendingDeleteAction = onConfirm;
  const targetLabel = formatDisplayDateWithDay(dateKey);
  setText("delete-confirm-msg", `${targetLabel} の記録をすべて削除しますか？`);
  const modal = getEl("delete-confirm-modal");
  if (modal) {
    modal.style.display = "flex";
    setTimeout(() => { modal.classList.add("active"); }, 10);
  }
}

window.closeDeleteModal = function() {
  const modal = getEl("delete-confirm-modal");
  if (!modal) return;
  modal.classList.remove("active");
  setTimeout(() => {
    modal.style.display = "none";
    pendingDeleteAction = null;
  }, 200);
};

window.executeDelete = function() {
  vibrateMedium();
  if (pendingDeleteAction) {
    pendingDeleteAction();
    closeDeleteModal();
  }
};

window.confirmDeleteFromDetail = function() {
  if (!currentDetailDateKey) return;
  vibrateMedium();
  openDeleteModal(currentDetailDateKey, async () => {
    showSavingOverlay();
    const payload = { action: 'saveTrainingLog', targetDate: formatWithZeroPad(currentDetailDateKey), trainingData: [], token: API_TOKEN };
    try {
      const result = await apiFetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      if (result.success) {
        globalTrainingHistory = result.updatedHistory || [];
        vibrateSuccess();
        finishSavingOverlay(() => { openHomeView(); });
      } else {
        hideSavingOverlayImmediate();
        showToast("削除エラー: " + (result.error || "失敗しました"), 'error');
        vibrateError();
      }
    } catch (err) {
      hideSavingOverlayImmediate();
      showToast(`通信エラー: ${err.message}`, 'error');
      vibrateError();
    }
  });
};

// ★修正: 詳細画面でも当日（currentDetailDateKey）のヘルスデータを表示する
function openDayDetailView(dK, dL, fV, sC, sH) {
  if (fV) previousViewBeforeDetail = fV;
  currentDetailDateKey = normalizeDateStr(dK);
  hideAllViews();
  const v = getEl("view-day-detail");
  if (v) {
    v.style.display = "block";
    v.classList.remove("slide-anim-from-right", "slide-anim-from-left");
    void v.offsetWidth;
    v.classList.add(sC || "slide-anim-from-right");
  }
  setText("day-detail-title", dL || formatDisplayDateWithDay(currentDetailDateKey));

  const dO = parseDateKeyToObj(currentDetailDateKey);
  const tStr = `${dO.getMonth() + 1}/${dO.getDate()}(${DAY_LABELS_SHORT[dO.getDay()]})`;
  setText("detail-vitals-caption", `当日の栄養・今朝の睡眠: ${tStr}`);

  // 当日のヘルスデータを読み込む
  loadHealthDataIntoPrefix(currentDetailDateKey, "detail-");

  const s = getEl("day-summary-container"), c = getEl("day-detail-content"), b = getEl("day-detail-edit-btn"), del = getEl("day-detail-delete-btn");
  if (!s || !c || !b) return;
  s.innerHTML = "";
  c.innerHTML = "";

  const rs = globalTrainingHistory.filter(r => r.date && normalizeDateStr(r.date) === currentDetailDateKey);
  if (rs.length === 0) {
    s.style.display = "none";
    c.innerHTML = `<div class="empty-state">
      <svg class="empty-state-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 4v16"></path><path d="M18 4v16"></path><path d="M9 12h6"></path><rect x="2" y="8" width="4" height="8" rx="1"></rect><rect x="18" y="8" width="4" height="8" rx="1"></rect>
      </svg>
      <div class="empty-state-title">記録がありません</div>
      <div class="empty-state-sub">中央下のダンベルボタンから<br>最初のワークアウトを追加しましょう</div>
    </div>`;
    b.innerText = "この日のワークアウトを記録";
    if (del) del.style.display = "none";
  } else {
    b.innerText = "この日の記録を編集・追加";
    if (del) del.style.display = "inline-flex";
    const parts = [...new Set(rs.map(r => String(r.part || "未指定").trim()))].join("・") + "の日";
    let vol = 0, sets = 0;
    rs.forEach(r => {
      const ps = parseDetailsToSets(r.details);
      sets += ps.length;
      ps.forEach(st => { vol += (parseFloat(st.w) || 0) * (parseFloat(st.r) || 0); });
    });
    s.style.display = "block";
    s.innerHTML = `<div class="detail-hero"><div><div class="detail-part-Main">${parts}</div><div class="detail-sub-counts">${rs.length}種目 ・ 合計 ${sets}セット</div></div><div class="detail-volume-block"><div class="detail-volume-num">${Number.isInteger(vol) ? vol.toLocaleString() : vol.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}<span class="detail-volume-kg">kg</span></div><div class="detail-volume-unit">TOTAL VOLUME</div></div></div>`;

    rs.forEach(r => {
      const dc = document.createElement("div");
      dc.className = "exercise-detail-card";
      dc.innerHTML = `<div class="exercise-detail-name">${r.exercise || "種目未入力"}</div>`;
      const ps = parseDetailsToSets(r.details);
      if (ps.length > 0) {
        const t = document.createElement("div");
        t.className = "sets-table";
        ps.forEach((st, i) => {
          t.innerHTML += `<div class="set-line"><span class="set-line-idx">SET ${i + 1}</span><span class="set-line-val">${st.w !== '' ? st.w + '<span class="set-line-unit">kg</span>' : '-'} × ${st.r !== '' ? st.r + '<span class="set-line-unit">回</span>' : '-'}</span></div>`;
        });
        dc.appendChild(t);
      } else if (r.details) {
        dc.innerHTML += `<div style="font-size:0.95rem; color:var(--text-secondary); white-space:pre-wrap;">${String(r.details).replace(/ﾗ/g, "×")}</div>`;
      }
      if (r.memo) dc.innerHTML += `<div class="exercise-detail-memo">${r.memo}</div>`;
      c.appendChild(dc);
    });
  }

  b.onclick = () => { vibrateSmall(); openDashboardForDate(currentDetailDateKey); };
  const sO = { view: 'detail', dateKey: currentDetailDateKey, label: getEl("day-detail-title")?.innerText, fromView: previousViewBeforeDetail };
  if (!sH && !sC) pushAppHistory(sO);
  window.scrollTo(0, 0);
}

function shiftDetailDay(o) {
  if (!currentDetailDateKey) return;
  vibrateSmall();
  const d = parseDateKeyToObj(currentDetailDateKey);
  const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + o);
  openDayDetailView(formatDateKey(n), formatDisplayDateWithDay(formatDateKey(n)), null, o > 0 ? "slide-anim-from-right" : "slide-anim-from-left", true);
}

function initDetailSwipe() {
  let sX = 0, sY = 0, isD = false;
  const v = getEl("view-day-detail");
  if (!v) return;
  const h = (dx, dy) => { if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) shiftDetailDay(dx > 0 ? -1 : 1); };
  v.addEventListener("touchstart", e => { if (e.touches.length === 1) { sX = e.touches[0].clientX; sY = e.touches[0].clientY; } }, { passive: true });
  v.addEventListener("touchend", e => { if (e.changedTouches.length === 1) h(e.changedTouches[0].clientX - sX, e.changedTouches[0].clientY - sY); }, { passive: true });
  v.addEventListener("mousedown", e => { isD = true; sX = e.clientX; sY = e.clientY; });
  v.addEventListener("mouseup", e => { if (isD) { isD = false; h(e.clientX - sX, e.clientY - sY); } });
}

function initLogSwipe() {
  let sX = 0, sY = 0, isD = false;
  const v = getEl("view-dashboard");
  if (!v) return;
  const h = (dx, dy) => { if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) shiftLogDay(dx > 0 ? -1 : 1); };
  v.addEventListener("touchstart", e => { if (e.touches.length === 1) { sX = e.touches[0].clientX; sY = e.touches[0].clientY; } }, { passive: true });
  v.addEventListener("touchend", e => { if (e.changedTouches.length === 1) h(e.changedTouches[0].clientX - sX, e.changedTouches[0].clientY - sY); }, { passive: true });
  v.addEventListener("mousedown", e => { isD = true; sX = e.clientX; sY = e.clientY; });
  v.addEventListener("mouseup", e => { if (isD) { isD = false; h(e.clientX - sX, e.clientY - sY); } });
}

function initCalendarSwipe() {
  let sX = 0, sY = 0;
  const v = getEl("home-calendar-swipe-area");
  if (!v) return;
  const h = (dx, dy) => { if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) changeHomeMonth(dx > 0 ? -1 : 1); };
  v.addEventListener("touchstart", e => { if (e.touches.length === 1) { sX = e.touches[0].clientX; sY = e.touches[0].clientY; } }, { passive: true });
  v.addEventListener("touchend", e => { if (e.changedTouches.length === 1) h(e.changedTouches[0].clientX - sX, e.changedTouches[0].clientY - sY); }, { passive: true });
}

function showSavingOverlay() {
  const o = getEl("saving-overlay");
  if (!o) return;
  const sp = getEl("saving-spinner"), ch = getEl("saving-check");
  if (sp) sp.style.display = "block";
  if (ch) ch.style.display = "none";
  setText("saving-text", "SAVING...");
  o.classList.add("active");
}

function finishSavingOverlay(cb) {
  const sp = getEl("saving-spinner"), ch = getEl("saving-check");
  if (sp) sp.style.display = "none";
  if (ch) ch.style.display = "flex";
  setText("saving-text", "COMPLETE!");
  setTimeout(() => {
    getEl("saving-overlay")?.classList.remove("active");
    if (cb) cb();
  }, 1100);
}

function hideSavingOverlayImmediate() {
  getEl("saving-overlay")?.classList.remove("active");
}

window.switchTab = function(t) {
  vibrateSmall();
  hideAllViews();
  if (t === 'home') {
    const v = getEl("view-home");
    if (v) v.style.display = "block";
    getEl("nav-home")?.classList.add("active");
    renderHomeCalendar();
    renderWeeklySummary();
    pushAppHistory({ view: 'home' });
  } else if (t === 'log') {
    openDashboardForDate(formatDateKey(new Date()), false, "slide-anim-from-right");
  } else if (t === 'graph') {
    const v = getEl("view-graph");
    if (v) {
      v.style.display = "block";
      v.classList.remove("slide-anim-from-right", "slide-anim-from-left");
      void v.offsetWidth;
      v.classList.add("slide-anim-from-right");
    }
    getEl("nav-graph")?.classList.add("active");
    pushAppHistory({ view: 'graph' });
    initGraphView();
  } else if (t === 'settings') {
    const v = getEl("view-settings");
    if (v) {
      v.style.display = "block";
      v.classList.remove("slide-anim-from-right", "slide-anim-from-left");
      void v.offsetWidth;
      v.classList.add("slide-anim-from-right");
    }
    pushAppHistory({ view: 'settings' });
  }
  window.scrollTo(0, 0);
};

/* ======================================================================
   11. グラフ機能（Chart.js）
====================================================================== */
let rmChartInstance = null;
let volumeChartInstance = null;
let currentGraphPeriod = 'ALL';

window.setGraphPeriod = function(period) {
  vibrateSmall();
  currentGraphPeriod = period;
  document.querySelectorAll('.period-btn').forEach(btn => btn.classList.remove('active'));
  getEl('period-btn-' + period)?.classList.add('active');
  updateGraphs();
};

window.toggleGraphSelect = function() {
  vibrateSmall();
  const list = getEl('graph-select-list');
  const icon = getEl('graph-select-icon');
  if (!list || !icon) return;
  if (list.style.display === 'none') {
    list.style.display = 'block';
    setTimeout(() => { list.style.opacity = '1'; list.style.transform = 'translateY(0)'; }, 10);
    icon.classList.add('rotated');
  } else {
    closeGraphSelect();
  }
};

window.closeGraphSelect = function() {
  const list = getEl('graph-select-list');
  if (!list || list.style.display === 'none') return;
  getEl('graph-select-icon')?.classList.remove('rotated');
  list.style.opacity = '0';
  list.style.transform = 'translateY(-10px)';
  setTimeout(() => list.style.display = 'none', 200);
};

window.selectGraphExercise = function(val, label) {
  const input = getEl('graph-exercise-select');
  if (input) input.value = val;
  setText('graph-select-label', label);
  closeGraphSelect();
  updateGraphs();
};

function initGraphView() {
  const selInput = getEl("graph-exercise-select");
  const selVal = selInput ? selInput.value : "";
  const pm = { "胸": new Set(), "背中": new Set(), "脚": new Set(), "肩": new Set(), "腕": new Set(), "その他": new Set() };

  globalTrainingHistory.forEach(r => {
    const ex = String(r.exercise || "").trim();
    let pt = String(r.part || "").trim();
    if (!ex || ex === "種目不明") return;
    if (pt === "足") pt = "脚";
    if (!["胸", "背中", "脚", "肩", "腕"].includes(pt)) pt = "その他";
    pm[pt].add(ex);
  });

  let h = `<div class="custom-dropdown-item" onclick="vibrateSmall(); selectGraphExercise('', '選択をクリア...')"><span>選択をクリア...</span></div>`;
  let hasSelectedInHistory = false;

  ["胸", "背中", "脚", "肩", "腕", "その他"].forEach(p => {
    const exs = Array.from(pm[p]).sort();
    if (exs.length > 0) {
      h += `<div class="custom-dropdown-optgroup">【${p}】</div>`;
      exs.forEach(ex => {
        if (ex === selVal) hasSelectedInHistory = true;
        const escapedEx = ex.replace(/'/g, "\\'");
        h += `<div class="custom-dropdown-item sub-item" onclick="vibrateSmall(); selectGraphExercise('${escapedEx}', '${escapedEx}')"><span>${ex}</span></div>`;
      });
    }
  });

  const listEl = getEl("graph-select-list");
  if (listEl) listEl.innerHTML = h;

  if (selVal && hasSelectedInHistory) {
    updateGraphs();
  } else {
    setText('graph-select-label', 'グラフ化する種目を選択...');
    clearGraphs();
  }
}

function clearGraphs() {
  if (rmChartInstance) { rmChartInstance.destroy(); rmChartInstance = null; }
  if (volumeChartInstance) { volumeChartInstance.destroy(); volumeChartInstance = null; }
}

function updateGraphs() {
  const tE = getEl("graph-exercise-select")?.value;
  if (!tE) { clearGraphs(); return; }

  let records = globalTrainingHistory
    .filter(r => r.date && String(r.exercise).trim() === tE)
    .sort((a, b) => parseDateKeyToObj(a.date) - parseDateKeyToObj(b.date));

  if (currentGraphPeriod !== 'ALL') {
    const cutoffDate = new Date();
    if (currentGraphPeriod === '1M') cutoffDate.setMonth(cutoffDate.getMonth() - 1);
    if (currentGraphPeriod === '3M') cutoffDate.setMonth(cutoffDate.getMonth() - 3);
    if (currentGraphPeriod === '6M') cutoffDate.setMonth(cutoffDate.getMonth() - 6);
    records = records.filter(r => parseDateKeyToObj(r.date) >= cutoffDate);
  }

  const lbls = [], rmd = [], vd = [];
  records.forEach(r => {
    const dStr = formatDisplayDateWithDay(normalizeDateStr(r.date)).substring(5, 10);
    const ps = parseDetailsToSets(r.details);
    let dm = 0, dv = 0;
    ps.forEach(s => {
      const w = parseFloat(s.w), rep = parseFloat(s.r);
      if (!isNaN(w) && !isNaN(rep) && rep > 0) {
        dv += (w * rep);
        const cRM = w * (1 + rep / 30);
        if (cRM > dm) dm = cRM;
      }
    });
    if (dm > 0 || dv > 0) {
      lbls.push(dStr);
      rmd.push(Math.round(dm));
      vd.push(Math.round(dv));
    }
  });

  drawChart('rmChart', '推定1RM (kg)', lbls, rmd, '#FF453A');
  drawChart('volumeChart', '総重量 (kg)', lbls, vd, '#0A84FF');
}

function drawChart(cId, lbl, lbls, d, c) {
  const canvas = getEl(cId);
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');
  if (cId === 'rmChart' && rmChartInstance) rmChartInstance.destroy();
  if (cId === 'volumeChart' && volumeChartInstance) volumeChartInstance.destroy();

  const cfg = {
    type: 'line',
    data: {
      labels: lbls,
      datasets: [{
        label: lbl,
        data: d,
        borderColor: c,
        backgroundColor: c + '33',
        borderWidth: 2,
        pointBackgroundColor: c,
        pointRadius: 4,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1C1C1E',
          titleFont: { size: 13, family: 'Inter' },
          bodyFont: { size: 14, weight: 'bold', family: 'Oswald' },
          padding: 10,
          displayColors: false
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255, 255, 255, 0.12)' }, ticks: { color: '#8E8E93', font: { family: 'Inter' } } },
        y: { grid: { color: 'rgba(255, 255, 255, 0.12)' }, ticks: { color: '#8E8E93', font: { family: 'Oswald' } } }
      }
    }
  };

  if (cId === 'rmChart') rmChartInstance = new Chart(ctx, cfg);
  else volumeChartInstance = new Chart(ctx, cfg);
}
