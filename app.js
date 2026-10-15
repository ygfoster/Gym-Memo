// ★Service Worker の登録（オフライン対応）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('PWA ServiceWorker ready:', reg.scope))
      .catch(err => console.error('PWA ServiceWorker failed:', err));
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
let isSuppressingDraftSave = false;

const STORAGE_VIEW_KEY = "workout_app_last_view_v1";
const STORAGE_DRAFT_PREFIX = "workout_app_draft_v1_";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_LABELS_SHORT = ["日", "月", "火", "水", "木", "金", "土"];

document.addEventListener("DOMContentLoaded", function() {
  initBrowserHistoryGuard();
  initDetailSwipe();

  fetch(GAS_URL + '?action=getInitialData&limit=45&offset=0&token=' + API_TOKEN)
    .then(response => response.json())
    .then(data => {
      if(data.error) { showError(new Error(data.error)); } else { initApp(data); }
    })
    .catch(error => showError(error));

  document.addEventListener("click", function(e) {
    if (!e.target.classList.contains("exercise")) {
      document.querySelectorAll(".suggest-box").forEach(box => box.style.display = "none");
    }
  });
});

function initApp(data) {
  document.getElementById("loading").style.display = "none";
  if (data) {
    globalTrainingHistory = data.trainingHistory || [];
    if (data.healthHistory && data.healthHistory.length > 0) {
      data.healthHistory.forEach(item => { if (item && item.date) globalHealthMap[normalizeDateStr(item.date)] = item; });
    } else if (data.currentData && data.currentData.date) {
      globalHealthMap[normalizeDateStr(data.currentData.date)] = data.currentData;
    }
  }
  renderHomeCalendar();
  renderDetailCalendar();
  renderWeeklySummary();
  restoreLastViewState();
}

function initBrowserHistoryGuard() {
  try {
    window.history.replaceState({ view: 'root_guard' }, '');
    window.history.pushState({ view: 'home' }, '');
    window.addEventListener('popstate', function(e) {
      const state = e.state;
      if (!state || state.view === 'root_guard') { window.history.pushState({ view: 'home' }, ''); openHomeView(true); return; }
      applyStateFromHistory(state);
    });
  } catch (err) {}
}

function pushAppHistory(stateObj) {
  try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify(stateObj)); window.history.pushState(stateObj, ''); } catch (e) {}
}

function navigateBack() {
  const currentView = getCurrentVisibleView();
  if (currentView === 'detail') {
    if (previousViewBeforeDetail === 'calendar') openCalendarDetailView(); else openHomeView();
  } else openHomeView();
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
  else if (state.view === 'calendar') {
    if (typeof state.year === 'number') currentCalYear = state.year;
    if (typeof state.month === 'number') currentCalMonth = state.month;
    openCalendarDetailView(true);
  } else if (state.view === 'detail') openDayDetailView(state.dateKey, state.label, state.fromView || 'home', null, true);
  else if (state.view === 'dashboard') openDashboardForDate(state.dateKey || null, true);
  else if (state.view === 'graph') switchTab('graph');
  else openHomeView(true);
}

function restoreLastViewState() {
  try {
    const raw = localStorage.getItem(STORAGE_VIEW_KEY);
    if (!raw) { openHomeView(); return; }
    const saved = JSON.parse(raw);
    if (saved && saved.view && saved.view !== 'home') { applyStateFromHistory(saved); return; }
  } catch (e) {}
  openHomeView();
}

function hideAllViews() {
  document.getElementById("view-home").style.display = "none";
  document.getElementById("view-calendar").style.display = "none";
  document.getElementById("view-day-detail").style.display = "none";
  document.getElementById("view-dashboard").style.display = "none";
  document.getElementById("view-graph").style.display = "none";
  document.getElementById("nav-home").classList.remove("active");
  document.getElementById("nav-log").classList.remove("active");
  document.getElementById("nav-graph").classList.remove("active");
}

function openHomeView(skipHistory) {
  hideAllViews();
  document.getElementById("view-home").style.display = "block";
  document.getElementById("nav-home").classList.add("active");
  const now = new Date(); currentCalYear = now.getFullYear(); currentCalMonth = now.getMonth();
  renderHomeCalendar(); renderWeeklySummary();
  if (!skipHistory) pushAppHistory({ view: 'home' });
  else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'home' })); } catch(e){} }
  window.scrollTo(0, 0);
}

function openCalendarDetailView(skipHistory) {
  hideAllViews();
  document.getElementById("view-calendar").style.display = "block";
  renderDetailCalendar();
  if (!skipHistory) pushAppHistory({ view: 'calendar', year: currentCalYear, month: currentCalMonth });
  else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'calendar', year: currentCalYear, month: currentCalMonth })); } catch(e){} }
  window.scrollTo(0, 0);
}

function openDashboardForDate(targetDateKey, skipHistory) {
  hideAllViews();
  document.getElementById("view-dashboard").style.display = "block";
  document.getElementById("nav-log").classList.add("active");
  document.getElementById("save-msg").innerText = "";

  let recordDateObj = targetDateKey ? parseDateKeyToObj(targetDateKey) : new Date();
  const recordDateKey = formatDateKey(recordDateObj);
  currentRecordingDateStr = formatWithZeroPad(recordDateKey);
  document.getElementById("recording-target-label").innerText = `${formatDisplayDateWithDay(currentRecordingDateStr)} の記録`;
  
  const prevDateObj = new Date(recordDateObj.getFullYear(), recordDateObj.getMonth(), recordDateObj.getDate() - 1);
  const prevDateKey = formatDateKey(prevDateObj);
  const prevDateShort = `${prevDateObj.getMonth() + 1}/${prevDateObj.getDate()} (${DAY_LABELS_SHORT[prevDateObj.getDay()]})`;
  document.getElementById("form-vitals-caption").innerText = `前日 ${prevDateShort} のコンディション`;

  loadHealthDataIntoPrefix(prevDateKey, "");
  loadTrainingFormForDate(currentRecordingDateStr);

  if (!skipHistory) pushAppHistory({ view: 'dashboard', dateKey: currentRecordingDateStr });
  else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify({ view: 'dashboard', dateKey: currentRecordingDateStr })); } catch(e){} }
  window.scrollTo(0, 0);
}

function loadHealthDataIntoPrefix(dateKey, prefix) {
  const normalized = normalizeDateStr(dateKey);
  if (globalHealthMap[normalized]) {
    renderVitalsToDOM(globalHealthMap[normalized], prefix);
  } else {
    renderVitalsToDOM(null, prefix);
    const paddedDate = formatWithZeroPad(normalized);
    fetch(GAS_URL + '?action=getDataForDate&date=' + paddedDate + '&token=' + API_TOKEN)
      .then(response => response.json())
      .then(data => { if (data && !data.error) { globalHealthMap[normalized] = data; renderVitalsToDOM(data, prefix); } })
      .catch(err => console.error(err));
  }
}

function renderVitalsToDOM(data, prefix) {
  const p = prefix || "";
  const sleepEl = document.getElementById(p + "sleep-time"); const intakeEl = document.getElementById(p + "cal-intake");
  const burnedEl = document.getElementById(p + "cal-burned"); const pEl = document.getElementById(p + "p-val");
  const fEl = document.getElementById(p + "f-val"); const cEl = document.getElementById(p + "c-val");
  const balEl = document.getElementById(p + "cal-balance");

  if (!data) {
    sleepEl.innerText = ""; intakeEl.innerText = ""; burnedEl.innerText = "";
    pEl.innerText = ""; fEl.innerText = ""; cEl.innerText = ""; balEl.innerText = "";
    return;
  }
  sleepEl.innerText = cleanMetric(data.sleep, ""); intakeEl.innerText = cleanMetric(data.intake, ""); burnedEl.innerText = cleanMetric(data.burned, "");
  pEl.innerText = cleanMetric(data.protein, ""); fEl.innerText = cleanMetric(data.fat, ""); cEl.innerText = cleanMetric(data.carb, "");

  const diff = parseInt(String(data.balance).replace(/[^-0-9]/g, ""), 10);
  if (isNaN(diff)) balEl.innerText = ""; else balEl.innerText = (diff > 0 ? "+" : "") + diff.toLocaleString() + " kcal";
}

function openDayDetailView(dateKey, displayLabel, fromView, slideClass, skipHistory) {
  if (fromView) previousViewBeforeDetail = fromView;
  currentDetailDateKey = normalizeDateStr(dateKey);
  const resolvedLabel = displayLabel || formatDisplayDateWithDay(currentDetailDateKey);

  hideAllViews();
  const viewEl = document.getElementById("view-day-detail");
  viewEl.style.display = "block";
  if (slideClass) {
    viewEl.classList.remove("slide-anim-from-right", "slide-anim-from-left");
    void viewEl.offsetWidth; viewEl.classList.add(slideClass);
  }
  document.getElementById("day-detail-title").innerText = resolvedLabel;
  loadHealthDataIntoPrefix(currentDetailDateKey, "detail-");

  const summaryContainer = document.getElementById("day-summary-container");
  const contentDiv = document.getElementById("day-detail-content");
  const editBtn = document.getElementById("day-detail-edit-btn");
  summaryContainer.innerHTML = ""; contentDiv.innerHTML = "";

  const records = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === currentDetailDateKey);
  if (records.length === 0) {
    summaryContainer.style.display = "none";
    contentDiv.innerHTML = `<div class="empty-state"><div class="empty-state-title">トレーニング記録がありません</div><div class="empty-state-sub">左右にスワイプして前後の記録を見るか、下のボタンから記録できます</div></div>`;
    editBtn.innerText = "この日のワークアウトを記録";
  } else {
    editBtn.innerText = "この日の記録を編集・追加";
    const partsList = [...new Set(records.map(r => r.part || "未指定"))];
    const partTitleText = partsList.join("・") + "の日";

    let totalExercises = records.length; let totalSets = 0; let totalVolume = 0;
    records.forEach(r => {
      const parsedSets = parseDetailsToSets(r.details);
      totalSets += parsedSets.length;
      parsedSets.forEach(s => { const w = parseFloat(s.w) || 0; const reps = parseFloat(s.r) || 0; totalVolume += (w * reps); });
    });
    const formattedVolume = Number.isInteger(totalVolume) ? totalVolume.toLocaleString() : totalVolume.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    
    summaryContainer.style.display = "block";
    summaryContainer.innerHTML = `
      <div class="detail-hero">
        <div><div class="detail-part-Main">${partTitleText}</div><div class="detail-sub-counts">${totalExercises}種目 ・ 合計 ${totalSets}セット</div></div>
        <div class="detail-volume-block"><div class="detail-volume-num">${formattedVolume}<span class="detail-volume-kg">kg</span></div><div class="detail-volume-unit">TOTAL VOLUME</div></div>
      </div>`;
    records.forEach(r => {
      const card = document.createElement("div"); card.className = "exercise-detail-card";
      const title = document.createElement("div"); title.className = "exercise-detail-name"; title.innerText = r.exercise || "種目未入力"; card.appendChild(title);
      const parsedSets = parseDetailsToSets(r.details);
      if (parsedSets.length > 0) {
        const table = document.createElement("div"); table.className = "sets-table";
        parsedSets.forEach((s, idx) => {
          const line = document.createElement("div"); line.className = "set-line";
          const wDisp = s.w !== '' ? `${s.w}<span class="set-line-unit">kg</span>` : `-`; const rDisp = s.r !== '' ? `${s.r}<span class="set-line-unit">回</span>` : `-`;
          line.innerHTML = `<span class="set-line-idx">SET ${idx + 1}</span><span class="set-line-val">${wDisp} ﾗ ${rDisp}</span>`; table.appendChild(line);
        });
        card.appendChild(table);
      } else if (r.details) {
        const fallback = document.createElement("div"); fallback.style.cssText = "font-size:0.9rem; color:var(--text-secondary); white-space:pre-wrap;"; fallback.innerText = r.details; card.appendChild(fallback);
      }
      if (r.memo) { const memoBox = document.createElement("div"); memoBox.className = "exercise-detail-memo"; memoBox.innerText = r.memo; card.appendChild(memoBox); }
      contentDiv.appendChild(card);
    });
  }
  editBtn.onclick = function() { openDashboardForDate(currentDetailDateKey); };
  const stateObj = { view: 'detail', dateKey: currentDetailDateKey, label: resolvedLabel, fromView: previousViewBeforeDetail };
  if (!skipHistory && !slideClass) pushAppHistory(stateObj);
  else { try { localStorage.setItem(STORAGE_VIEW_KEY, JSON.stringify(stateObj)); } catch(e){} }
  if (!slideClass) window.scrollTo(0, 0);
}

function shiftDetailDay(offset) {
  if (!currentDetailDateKey) return;
  const dObj = parseDateKeyToObj(currentDetailDateKey);
  const nextObj = new Date(dObj.getFullYear(), dObj.getMonth(), dObj.getDate() + offset);
  const nextKey = formatDateKey(nextObj);
  const nextLabel = formatDisplayDateWithDay(nextKey);
  const animClass = offset > 0 ? "slide-anim-from-right" : "slide-anim-from-left";
  openDayDetailView(nextKey, nextLabel, null, animClass, true);
}

function initDetailSwipe() {
  let startX = 0; let startY = 0; let isMouseDown = false;
  const detailView = document.getElementById("view-day-detail");
  if (!detailView) return;
  function handleDelta(dx, dy) {
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) { if (dx > 0) shiftDetailDay(-1); else shiftDetailDay(1); }
  }
  detailView.addEventListener("touchstart", function(e) { if (e.touches.length !== 1) return; startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
  detailView.addEventListener("touchend", function(e) { if (e.changedTouches.length !== 1) return; handleDelta(e.changedTouches[0].clientX - startX, e.changedTouches[0].clientY - startY); }, { passive: true });
  detailView.addEventListener("mousedown", function(e) { isMouseDown = true; startX = e.clientX; startY = e.clientY; });
  detailView.addEventListener("mouseup", function(e) { if (!isMouseDown) return; isMouseDown = false; handleDelta(e.clientX - startX, e.clientY - startY); });
}

function getDraftKey(dateStr) { return STORAGE_DRAFT_PREFIX + normalizeDateStr(dateStr); }
function saveDraftForCurrentDate() {
  if (isSuppressingDraftSave || !currentRecordingDateStr) return;
  try {
    const partSelect = document.getElementById("global-part"); const partCustom = document.getElementById("global-part-custom");
    const rows = document.querySelectorAll("#exerciseList .exercise-row"); const exercises = [];
    rows.forEach(row => {
      const exName = row.querySelector(".exercise").value; const memo = row.querySelector(".memo").value; const sets = [];
      for (let i = 1; i <= 5; i++) {
        const setRow = row.querySelector(`.set-row[data-set="${i}"]`);
        if (setRow && setRow.style.display !== "none") {
          sets.push({ w: setRow.querySelector(".weight-input").value, r: setRow.querySelector(".reps-input").value, visible: true });
        }
      }
      exercises.push({ exercise: exName, memo: memo, sets: sets });
    });
    localStorage.setItem(getDraftKey(currentRecordingDateStr), JSON.stringify({ partSelect: partSelect.value, partCustom: partCustom.value, exercises: exercises, updatedAt: Date.now() }));
    const badge = document.getElementById("draft-status-badge"); if (badge) badge.style.display = "inline-block";
  } catch (e) {}
}

function clearDraftForDate(dateStr) { try { localStorage.removeItem(getDraftKey(dateStr)); const badge = document.getElementById("draft-status-badge"); if (badge) badge.style.display = "none"; } catch (e) {} }
function loadDraftForDate(dateStr) { try { const raw = localStorage.getItem(getDraftKey(dateStr)); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

function loadTrainingFormForDate(dateStr) {
  isSuppressingDraftSave = true;
  const container = document.getElementById("exerciseList"); container.innerHTML = "";
  const partSelect = document.getElementById("global-part"); const partCustom = document.getElementById("global-part-custom");
  const badge = document.getElementById("draft-status-badge");
  partSelect.value = ""; partSelect.style.borderColor = "transparent"; partCustom.style.display = "none"; partCustom.style.borderColor = "transparent"; partCustom.value = "";
  if (badge) badge.style.display = "none";

  const draft = loadDraftForDate(dateStr);
  if (draft && draft.exercises && draft.exercises.length > 0) {
    partSelect.value = draft.partSelect || "";
    if (draft.partSelect === "custom") { partCustom.style.display = "block"; partCustom.value = draft.partCustom || ""; }
    draft.exercises.forEach(exItem => addExerciseRowFromDraft(exItem));
    if (badge) badge.style.display = "inline-block";
    isSuppressingDraftSave = false; return;
  }

  const key = normalizeDateStr(dateStr);
  const records = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === key);
  if (records.length === 0) addExerciseRow();
  else {
    const firstPart = records[0].part;
    if (firstPart && firstPart !== "未指定") {
      const normalizedPart = firstPart === "足" ? "脚" : firstPart;
      const standardParts = ["胸", "背中", "腕", "肩", "脚"];
      if (standardParts.includes(normalizedPart)) partSelect.value = normalizedPart;
      else { partSelect.value = "custom"; partCustom.style.display = "block"; partCustom.value = firstPart; }
    }
    records.forEach(r => addExerciseRow(r));
  }
  isSuppressingDraftSave = false;
}

function addExerciseRowFromDraft(draftItem) {
  addExerciseRow();
  const rowDiv = document.getElementById("exerciseList").lastElementChild; if (!rowDiv) return;
  rowDiv.querySelector(".exercise").value = draftItem.exercise || "";
  if (draftItem.memo) { const memoEl = rowDiv.querySelector(".memo"); memoEl.value = draftItem.memo; setTimeout(() => autoResize(memoEl), 0); }
  if (draftItem.sets && draftItem.sets.length > 0) {
    draftItem.sets.forEach((s, idx) => {
      const setNum = idx + 1;
      if (setNum <= 5) {
        const setRow = rowDiv.querySelector(`.set-row[data-set="${setNum}"]`);
        if (setRow) { setRow.style.display = "flex"; setRow.querySelector(".weight-input").value = s.w || ""; setRow.querySelector(".reps-input").value = s.r || ""; }
        if ((s.w || s.r) && setNum < 5) { const nextRow = rowDiv.querySelector(`.set-row[data-set="${setNum + 1}"]`); if (nextRow) nextRow.style.display = "flex"; }
      }
    });
  }
}

function addExerciseRow(existingRecord) {
  const container = document.getElementById("exerciseList"); const cardIndex = container.children.length + 1;
  const rowDiv = document.createElement("div"); rowDiv.className = "form-card exercise-row";
  let setsHTML = "";
  for (let i = 1; i <= 5; i++) {
    const displayStyle = (i === 1) ? "display: flex;" : "display: none;";
    setsHTML += `
    <div class="set-input-row set-row" data-set="${i}" style="${displayStyle}">
      <span class="set-badge">#${i}</span>
      <div class="unit-input-wrap"><input type="number" step="any" inputmode="decimal" class="weight-input" placeholder="0" oninput="handleSetInput(this)"><span class="unit-suffix">kg</span></div>
      <div class="set-multiply">ﾗ</div>
      <div class="unit-input-wrap"><input type="number" step="1" inputmode="numeric" class="reps-input" placeholder="0" oninput="handleSetInput(this)"><span class="unit-suffix">回</span></div>
      <button type="button" class="btn-clear-set" onclick="removeSet(this)" title="クリア"></button>
    </div>`;
  }
  rowDiv.innerHTML = `
    <div class="form-card-header"><span class="form-card-num">EXERCISE ${cardIndex}</span>${(cardIndex > 1) ? `<button type="button" class="btn-remove-card" onclick="removeExerciseCard(this)">削除</button>` : ``}</div>
    <div class="autocomplete-wrapper"><input type="text" class="input-field exercise" placeholder="種目名を入力" autocomplete="off" oninput="handleExerciseSuggest(this); saveDraftForCurrentDate();" onfocus="handleExerciseSuggest(this)"><div class="suggest-box"></div></div>
    <div style="margin-bottom: 10px;">${setsHTML}</div>
    <textarea class="textarea-field memo" rows="1" placeholder="メモ・フォームの意識など" style="overflow: hidden; resize: none;" oninput="autoResize(this); saveDraftForCurrentDate();"></textarea>
  `;
  container.appendChild(rowDiv);
  if (existingRecord) {
    if (existingRecord.exercise && existingRecord.exercise !== "種目不明") rowDiv.querySelector(".exercise").value = existingRecord.exercise;
    if (existingRecord.memo) { const memoEl = rowDiv.querySelector(".memo"); memoEl.value = existingRecord.memo; setTimeout(() => autoResize(memoEl), 0); }
    const parsedSets = parseDetailsToSets(existingRecord.details);
    parsedSets.forEach((s, idx) => {
      const setNum = idx + 1;
      if (setNum <= 5) {
        const setRow = rowDiv.querySelector(`.set-row[data-set="${setNum}"]`);
        if (setRow) { setRow.style.display = "flex"; setRow.querySelector(".weight-input").value = s.w; setRow.querySelector(".reps-input").value = s.r; }
        if (setNum < 5) { const nextRow = rowDiv.querySelector(`.set-row[data-set="${setNum + 1}"]`); if (nextRow) nextRow.style.display = "flex"; }
      }
    });
  }
}

function removeExerciseCard(btn) {
  const row = btn.closest(".exercise-row"); if (row) row.remove();
  document.querySelectorAll("#exerciseList .exercise-row").forEach((el, idx) => { const label = el.querySelector(".form-card-num"); if (label) label.innerText = `EXERCISE ${idx + 1}`; });
  saveDraftForCurrentDate();
}

function handleExerciseSuggest(inputElem) {
  const val = inputElem.value.trim(); const box = inputElem.parentElement.querySelector(".suggest-box");
  if (!val) { box.style.display = "none"; return; }
  const partSelect = document.getElementById("global-part");
  const currentPart = partSelect.value === "custom" ? document.getElementById("global-part-custom").value.trim() : partSelect.value;
  const exerciseMap = new Map();
  globalTrainingHistory.forEach(r => {
    const ex = (r.exercise || "").trim();
    if (!ex || ex === "種目不明") return;
    if (ex.toLowerCase().includes(val.toLowerCase()) && ex !== val) { if (!exerciseMap.has(ex) || r.part === currentPart) exerciseMap.set(ex, r.part || ""); }
  });
  const candidates = Array.from(exerciseMap.entries()).sort((a, b) => { const aMatch = (currentPart && a[1] === currentPart) ? -1 : 1; const bMatch = (currentPart && b[1] === currentPart) ? -1 : 1; return aMatch - bMatch; }).slice(0, 5);
  if (candidates.length === 0) { box.style.display = "none"; return; }
  box.innerHTML = "";
  candidates.forEach(([exName, partName]) => {
    const item = document.createElement("div"); item.className = "suggest-item";
    item.innerHTML = `<span>${exName}</span>${partName ? `<span class="suggest-part-tag">${partName}</span>` : ""}`;
    item.onclick = function() { inputElem.value = exName; box.style.display = "none"; saveDraftForCurrentDate(); };
    box.appendChild(item);
  });
  box.style.display = "block";
}

function handlePartChange(selectElement) {
  const customInput = document.getElementById("global-part-custom");
  selectElement.style.borderColor = "transparent"; document.getElementById("save-msg").innerText = "";
  if (selectElement.value === "custom") { customInput.style.display = "block"; customInput.focus(); } else { customInput.style.display = "none"; customInput.value = ""; }
  saveDraftForCurrentDate();
}

function handleSetInput(element) {
  const currentSetRow = element.closest('.set-row'); if (!currentSetRow) return;
  const currentSetNum = parseInt(currentSetRow.getAttribute('data-set'), 10);
  if (currentSetNum < 5 && element.value !== "") {
    const exerciseRow = currentSetRow.closest('.exercise-row');
    const nextSetRow = exerciseRow.querySelector('.set-row[data-set="' + (currentSetNum + 1) + '"]');
    if (nextSetRow) nextSetRow.style.display = "flex";
  }
  saveDraftForCurrentDate();
}

function removeSet(button) {
  const setRow = button.closest('.set-row'); const inputs = setRow.querySelectorAll('input[type="number"]');
  inputs.forEach(input => input.value = "");
  const setNum = parseInt(setRow.getAttribute('data-set'), 10);
  if (setNum > 1) setRow.style.display = "none";
  saveDraftForCurrentDate();
}

function autoResize(textarea) { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; }
function showSavingOverlay() { const overlay = document.getElementById("saving-overlay"); document.getElementById("saving-spinner").style.display = "block"; document.getElementById("saving-check").style.display = "none"; document.getElementById("saving-text").innerText = "記録を保存中..."; overlay.classList.add("active"); }
function finishSavingOverlay(callback) { document.getElementById("saving-spinner").style.display = "none"; document.getElementById("saving-check").style.display = "flex"; document.getElementById("saving-text").innerText = "保存しました"; setTimeout(function() { document.getElementById("saving-overlay").classList.remove("active"); if (callback) callback(); }, 450); }
function hideSavingOverlayImmediate() { document.getElementById("saving-overlay").classList.remove("active"); }

function saveTraining() {
  const targetDate = currentRecordingDateStr || formatWithZeroPad(formatDateKey(new Date()));
  const rows = document.querySelectorAll(".exercise-row"); const msg = document.getElementById("save-msg");
  let trainingData = [];
  const partSelect = document.getElementById("global-part"); const partCustom = document.getElementById("global-part-custom");
  const globalPart = (partSelect.value === "custom") ? partCustom.value.trim() : partSelect.value;

  if (!globalPart) {
    msg.innerText = "トレーニング部位を選択してください"; msg.style.color = "#FF453A";
    if (partSelect.value === "custom") { partCustom.style.borderColor = "#FF453A"; partCustom.focus(); } else { partSelect.style.borderColor = "#FF453A"; partSelect.scrollIntoView({ behavior: "smooth", block: "center" }); }
    return;
  }
  partSelect.style.borderColor = "transparent"; partCustom.style.borderColor = "transparent";

  rows.forEach(row => {
    const exercise = row.querySelector(".exercise").value.trim(); const memo = row.querySelector(".memo").value.trim();
    let hasSets = false; let setsText = "";
    for (let i = 1; i <= 5; i++) {
      const setRow = row.querySelector('.set-row[data-set="' + i + '"]');
      if (setRow && setRow.style.display !== "none") {
        const w = setRow.querySelector('.weight-input').value.trim(); const r = setRow.querySelector('.reps-input').value.trim();
        if (w || r) { setsText += `${i}セット目: ${w ? w + 'kg' : '-'} ﾗ ${r ? r + '回' : '-'}\n`; hasSets = true; }
      }
    }
    setsText = setsText.trim();
    if (exercise || hasSets || memo) trainingData.push({ date: targetDate, part: globalPart, exercise: exercise || "種目不明", details: setsText, memo: memo });
  });

  if (trainingData.length === 0) { msg.innerText = "トレーニング内容を入力してください"; msg.style.color = "#FF453A"; return; }

  const btn = document.getElementById("save-btn"); btn.disabled = true; msg.innerText = "";
  showSavingOverlay();

  fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'saveTrainingLog', targetDate: targetDate, trainingData: trainingData, token: API_TOKEN })
  })
  .then(response => response.json())
  .then(result => {
    btn.disabled = false;
    if (result.success) { if (result.updatedHistory) globalTrainingHistory = result.updatedHistory; clearDraftForDate(targetDate); finishSavingOverlay(function() { openHomeView(); }); }
    else { hideSavingOverlayImmediate(); msg.innerText = "エラー: " + (result.error || "保存に失敗しました"); msg.style.color = "#FF453A"; }
  })
  .catch(error => { btn.disabled = false; hideSavingOverlayImmediate(); msg.innerText = "通信エラー: " + error.message; msg.style.color = "#FF453A"; });
}

function normalizeDateStr(str) { if (!str) return ""; const nums = str.match(/\d+/g); if (nums && nums.length >= 3) return `${parseInt(nums[0], 10)}/${parseInt(nums[1], 10)}/${parseInt(nums[2], 10)}`; return str.trim(); }
function parseDateKeyToObj(dateKeyStr) { const nums = String(dateKeyStr).match(/\d+/g); if (nums && nums.length >= 3) return new Date(parseInt(nums[0], 10), parseInt(nums[1], 10) - 1, parseInt(nums[2], 10)); return new Date(); }
function formatDateKey(dateObj) { return `${dateObj.getFullYear()}/${dateObj.getMonth() + 1}/${dateObj.getDate()}`; }
function formatWithZeroPad(dateKeyStr) { const nums = String(dateKeyStr).match(/\d+/g); if (nums && nums.length >= 3) { return `${nums[0]}/${String(parseInt(nums[1], 10)).padStart(2, '0')}/${String(parseInt(nums[2], 10)).padStart(2, '0')}`; } return dateKeyStr; }
function formatDisplayDateWithDay(dateStr) { const nums = String(dateStr).match(/\d+/g); if (nums && nums.length >= 3) { const y = parseInt(nums[0], 10); const m = parseInt(nums[1], 10); const d = parseInt(nums[2], 10); const dow = DAY_LABELS_SHORT[new Date(y, m - 1, d).getDay()]; return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')} (${dow})`; } return dateStr; }
function cleanMetric(val, suffix) { if (val === undefined || val === null) return ""; const s = String(val).trim(); if (s === "" || s === "-" || s === "" || s.includes("#") || s === "NaN") return ""; return suffix ? `${s} ${suffix}` : s; }

function parseDetailsToSets(detailsStr) {
  if (!detailsStr) return [];
  return detailsStr.split('\n').filter(l => l.trim() !== '').map(line => {
    const match = line.match(/:\s*([0-9.]+|-)(?:kg)?\s*[ﾗxXﾗ]\s*([0-9.]+|-)(?:回)?/);
    if (match) return { w: match[1] === '-' ? '' : match[1], r: match[2] === '-' ? '' : match[2] };
    return { w: '', r: '' };
  });
}

function matchPartFilter(recordPart, filterName) {
  const p = recordPart || "";
  if (filterName === "脚") return p.includes("脚") || p.includes("足");
  if (filterName === "その他") { const isStandard = ["胸", "背中", "腕", "肩", "脚", "足"].some(sp => p === sp); return !isStandard && p !== "" && p !== "未指定"; }
  return p.includes(filterName);
}
function isDateTrained(dateKey, useFilter) {
  const records = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === dateKey);
  if (records.length === 0) return false;
  if (!useFilter || activeFilters.length === 0) return true;
  return records.some(r => activeFilters.some(f => matchPartFilter(r.part, f)));
}

function updateHomeStats() {
  if (!globalTrainingHistory) return;
  const uniqueDates = new Set(); const monthlyDates = new Set();
  globalTrainingHistory.forEach(r => {
    const dateStr = normalizeDateStr(r.date); uniqueDates.add(dateStr);
    const dObj = parseDateKeyToObj(dateStr);
    if (dObj.getFullYear() === currentCalYear && dObj.getMonth() === currentCalMonth) { monthlyDates.add(dateStr); }
  });
  const mElem = document.getElementById("home-monthly-days"); const tElem = document.getElementById("home-total-days");
  if (mElem) mElem.innerText = monthlyDates.size; if (tElem) tElem.innerText = uniqueDates.size;
}

function renderHomeCalendar() { const now = new Date(); buildCalendarGrid(now.getFullYear(), now.getMonth(), "home-cal-title", "home-cal-grid", false); updateHomeStats(); }
function renderDetailCalendar() { buildCalendarGrid(currentCalYear, currentCalMonth, "detail-cal-title", "detail-cal-grid", true); }
function changeMonth(offset) { currentCalMonth += offset; if (currentCalMonth < 0) { currentCalMonth = 11; currentCalYear--; } else if (currentCalMonth > 11) { currentCalMonth = 0; currentCalYear++; } renderDetailCalendar(); }

function buildCalendarGrid(year, month, titleId, gridId, isDetailView) {
  document.getElementById(titleId).innerText = `${MONTH_NAMES[month]} ${year}`;
  const grid = document.getElementById(gridId); grid.innerHTML = "";
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDaysInMonth = new Date(year, month, 0).getDate();
  const todayKey = formatDateKey(new Date());

  for (let i = firstDay - 1; i >= 0; i--) { const cell = document.createElement("div"); cell.className = "cal-cell"; cell.innerHTML = `<div class="cal-day other-month">${prevDaysInMonth - i}</div>`; grid.appendChild(cell); }
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement("div"); cell.className = "cal-cell clickable";
    const circle = document.createElement("div"); circle.className = "cal-day"; circle.innerText = d;
    const dateKey = `${year}/${month + 1}/${d}`; const trained = isDateTrained(dateKey, isDetailView);
    if (dateKey === todayKey) { if (!isDetailView || activeFilters.length === 0 || trained) circle.classList.add("today"); } else if (trained) circle.classList.add("trained");
    if (isDetailView) { cell.onclick = function(e) { e.stopPropagation(); const dow = DAY_LABELS_SHORT[new Date(year, month, d).getDay()]; openDayDetailView(dateKey, `${year}/${String(month + 1).padStart(2, '0')}/${String(d).padStart(2, '0')} (${dow})`, 'calendar'); }; } 
    else { cell.onclick = function(e) { e.stopPropagation(); openCalendarDetailView(); }; }
    cell.appendChild(circle); grid.appendChild(cell);
  }
  const nextDays = (7 - ((firstDay + daysInMonth) % 7)) % 7;
  for (let i = 1; i <= nextDays; i++) { const cell = document.createElement("div"); cell.className = "cal-cell"; cell.innerHTML = `<div class="cal-day other-month">${i}</div>`; grid.appendChild(cell); }
}

function toggleFilter(partName, btnElem) {
  const idx = activeFilters.indexOf(partName);
  if (idx > -1) { activeFilters.splice(idx, 1); btnElem.classList.remove("active"); } else { activeFilters.push(partName); btnElem.classList.add("active"); }
  renderDetailCalendar();
}

function renderWeeklySummary() {
  const listContainer = document.getElementById("weekly-list"); listContainer.innerHTML = "";
  const now = new Date(); const todayKey = formatDateKey(now); const dayOfWeek = now.getDay();
  const diffToMonday = (dayOfWeek === 0) ? -6 : (1 - dayOfWeek);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  const dayLabels = ["日", "月", "火", "水", "木", "金", "土"];

  for (let i = 0; i < 7; i++) {
    const target = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const key = formatDateKey(target); const isToday = (key === todayKey);
    const records = globalTrainingHistory.filter(r => normalizeDateStr(r.date) === key);
    let summaryText = ""; let isRest = true;
    if (records.length > 0) {
      isRest = false; const partMap = {};
      records.forEach(r => { const p = r.part || "未指定"; partMap[p] = (partMap[p] || 0) + (r.sets || 0); });
      summaryText = Object.keys(partMap).map(p => `${p} / ${partMap[p]}セット`).join(" , ");
    }
    const row = document.createElement("div"); row.className = `list-row-compact ${isToday ? 'is-today' : ''}`;
    row.onclick = function() { openDayDetailView(key, formatDisplayDateWithDay(key), 'home'); };
    const dowStr = dayLabels[target.getDay()]; const dateStr = `${target.getMonth() + 1}/${target.getDate()}(${dowStr})`;
    row.innerHTML = `<div class="list-date-col">${dateStr}</div><div class="list-desc-col ${isRest ? 'rest' : ''}">${isRest ? 'オフ' : summaryText}</div>`;
    listContainer.appendChild(row);
  }
}

function showError(error) { const loadElem = document.getElementById("loading"); loadElem.style.display = "block"; loadElem.innerText = "エラー: " + error.message; loadElem.style.color = "#FF453A"; }

document.addEventListener('focus', function(e) { if (e.target.tagName === 'INPUT') { const val = e.target.value; e.target.value = ''; e.target.value = val; } }, true);
document.addEventListener('touchend', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') && document.activeElement !== e.target) { e.preventDefault(); e.target.focus(); setTimeout(function() { e.target.focus(); }, 50); }
  }
}, { passive: false });

document.addEventListener("DOMContentLoaded", function() {
  const dashboardView = document.getElementById("view-dashboard"); if (!dashboardView) return;
  let dashStartX = 0; let dashStartY = 0;
  dashboardView.addEventListener("touchstart", function(e) { if (e.touches.length !== 1) return; dashStartX = e.touches[0].clientX; dashStartY = e.touches[0].clientY; }, { passive: true });
  dashboardView.addEventListener("touchend", function(e) {
    if (e.changedTouches.length !== 1) return;
    if (Math.abs(e.changedTouches[0].clientX - dashStartX) > 45 && Math.abs(e.changedTouches[0].clientX - dashStartX) > Math.abs(e.changedTouches[0].clientY - dashStartY) * 1.3) navigateBack();
  }, { passive: true });
});

let totalTimerInterval = null, totalStartTime = 0, totalSeconds = 0, isTotalTimerRunning = false;
let restTimerInterval = null, restEndTime = 0, defaultRestSeconds = 80, currentRestSeconds = 80, isResting = false, wakeLock = null;

function formatTime(seconds) { if (seconds < 0) seconds = 0; return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(Math.floor(seconds) % 60).toString().padStart(2, '0')}`; }
function startTotalTimer() { if (isTotalTimerRunning) return; isTotalTimerRunning = true; totalStartTime = Date.now() - (totalSeconds * 1000); totalTimerInterval = setInterval(() => { totalSeconds = Math.floor((Date.now() - totalStartTime) / 1000); document.getElementById("total-time-display").innerText = formatTime(totalSeconds); }, 1000); }
function adjustRestTime(amount) { if (isResting) return; defaultRestSeconds += amount; if (defaultRestSeconds < 10) defaultRestSeconds = 10; currentRestSeconds = defaultRestSeconds; document.getElementById("rest-time-display").innerText = formatTime(currentRestSeconds); }

async function toggleRestTimer() {
  const btn = document.getElementById("rest-toggle-btn"); const bar = document.getElementById("workout-timer-bar");
  if (!isTotalTimerRunning) startTotalTimer();
  if (isResting) {
    clearInterval(restTimerInterval); isResting = false; btn.innerText = "START"; btn.style.backgroundColor = "var(--danger)";
    currentRestSeconds = defaultRestSeconds; document.getElementById("rest-time-display").innerText = formatTime(currentRestSeconds);
    bar.classList.remove("timer-active");
    if (wakeLock !== null) wakeLock.release().then(() => wakeLock = null);
  } else {
    isResting = true; btn.innerText = "STOP"; btn.style.backgroundColor = "var(--text-secondary)";
    restEndTime = Date.now() + (currentRestSeconds * 1000);
    bar.classList.add("timer-active");
    
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { console.log("Wake Lockエラー:", err); }
    restTimerInterval = setInterval(() => {
      let remaining = Math.ceil((restEndTime - Date.now()) / 1000);
      if (remaining > 0) { currentRestSeconds = remaining; document.getElementById("rest-time-display").innerText = formatTime(currentRestSeconds); } 
      else {
        clearInterval(restTimerInterval); isResting = false;
        if (navigator.vibrate) navigator.vibrate([1000, 500, 1000, 500, 1000]); 
        let flashCount = 0; let originalBg = bar.style.backgroundColor;
        let flashInterval = setInterval(() => { bar.style.backgroundColor = (flashCount % 2 === 0) ? "var(--danger)" : originalBg; flashCount++; if (flashCount > 10) { clearInterval(flashInterval); bar.style.backgroundColor = originalBg; } }, 500);
        btn.innerText = "START"; btn.style.backgroundColor = "var(--danger)"; currentRestSeconds = defaultRestSeconds; document.getElementById("rest-time-display").innerText = formatTime(currentRestSeconds);
        bar.classList.remove("timer-active");
        if (wakeLock !== null) wakeLock.release().then(() => wakeLock = null);
      }
    }, 200); 
  }
}

function switchTab(tabName) {
  hideAllViews();
  if (tabName === 'home') {
    document.getElementById("view-home").style.display = "block"; document.getElementById("nav-home").classList.add("active");
    renderHomeCalendar(); renderWeeklySummary(); pushAppHistory({ view: 'home' });
  } else if (tabName === 'log') {
    document.getElementById("view-dashboard").style.display = "block"; document.getElementById("nav-log").classList.add("active");
    const today = new Date(); openDashboardForDate(today.getFullYear() + '/' + (today.getMonth() + 1) + '/' + today.getDate());
  } else if (tabName === 'graph') {
    document.getElementById("view-graph").style.display = "block"; document.getElementById("nav-graph").classList.add("active");
    pushAppHistory({ view: 'graph' }); initGraphView();
  }
  window.scrollTo(0, 0);
}

let rmChartInstance = null; let volumeChartInstance = null;
function initGraphView() {
  const select = document.getElementById("graph-exercise-select"); const currentVal = select.value;
  const uniqueExercises = [...new Set(globalTrainingHistory.map(r => r.exercise).filter(e => e && e !== "種目不明"))].sort();
  select.innerHTML = '<option value="">グラフ化する種目を選択...</option>';
  uniqueExercises.forEach(ex => { const opt = document.createElement("option"); opt.value = ex; opt.innerText = ex; select.appendChild(opt); });
  if (currentVal && uniqueExercises.includes(currentVal)) { select.value = currentVal; updateGraphs(); } else clearGraphs();
}
function clearGraphs() { if (rmChartInstance) rmChartInstance.destroy(); if (volumeChartInstance) volumeChartInstance.destroy(); }
function updateGraphs() {
  const targetExercise = document.getElementById("graph-exercise-select").value;
  if (!targetExercise) { clearGraphs(); return; }
  const records = globalTrainingHistory.filter(r => r.exercise === targetExercise).sort((a, b) => new Date(normalizeDateStr(a.date)) - new Date(normalizeDateStr(b.date)));
  const labels = []; const rmData = []; const volumeData = [];
  records.forEach(r => {
    const dateStr = formatDisplayDateWithDay(normalizeDateStr(r.date)).substring(5, 10); 
    const parsedSets = parseDetailsToSets(r.details);
    let dayMaxRM = 0; let dayVolume = 0;
    parsedSets.forEach(s => {
      const w = parseFloat(s.w); const reps = parseFloat(s.r);
      if (!isNaN(w) && !isNaN(reps) && reps > 0) { dayVolume += (w * reps); const currentRM = w * (1 + reps / 30); if (currentRM > dayMaxRM) dayMaxRM = currentRM; }
    });
    if (dayMaxRM > 0 || dayVolume > 0) { labels.push(dateStr); rmData.push(Math.round(dayMaxRM)); volumeData.push(Math.round(dayVolume)); }
  });
  drawChart('rmChart', '推定1RM (kg)', labels, rmData, '#FF453A'); drawChart('volumeChart', '総重量 (kg)', labels, volumeData, '#0A84FF');
}
function drawChart(canvasId, labelText, labels, data, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (canvasId === 'rmChart' && rmChartInstance) rmChartInstance.destroy(); if (canvasId === 'volumeChart' && volumeChartInstance) volumeChartInstance.destroy();
  const chartConfig = {
    type: 'line', data: { labels: labels, datasets: [{ label: labelText, data: data, borderColor: color, backgroundColor: color + '33', borderWidth: 2, pointBackgroundColor: color, pointRadius: 4, fill: true, tension: 0.3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1C1C1E', titleFont: { size: 13, family: 'Inter' }, bodyFont: { size: 14, weight: 'bold', family: 'Oswald' }, padding: 10, displayColors: false } }, scales: { x: { grid: { color: 'rgba(255, 255, 255, 0.08)' }, ticks: { color: '#8E8E93', font: { family: 'Inter' } } }, y: { grid: { color: 'rgba(255, 255, 255, 0.08)' }, ticks: { color: '#8E8E93', font: { family: 'Oswald' } } } } }
  };
  if (canvasId === 'rmChart') rmChartInstance = new Chart(ctx, chartConfig); else volumeChartInstance = new Chart(ctx, chartConfig);
}
