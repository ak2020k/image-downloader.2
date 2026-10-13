"use strict";

const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const messageEl = document.getElementById("message");
const downloadBtn = document.getElementById("download");

const progressEl = document.getElementById("progress");
const progressTextEl = document.getElementById("progress-text");
const progressPercentEl = document.getElementById("progress-percent");
const progressFillEl = document.getElementById("progress-fill");

let currentTab = null;
let currentLinks = [];
let thumbLinksCache = [];
let pollTimer = null;
let dlPollTimer = null;
let pendingSelection = [];
let lastStats = null;
let lastDirectCount = 0;
let lastNextCount = 0;

/* ===== Переключение видов ===== */

function showDownloadsView() {
  document.getElementById("main-view").hidden = true;
  document.getElementById("confirm-view").hidden = true;
  document.getElementById("downloads-view").hidden = false;
  stopDlPoll();
  pollDownloads();
  dlPollTimer = setInterval(pollDownloads, 500);
}

function showMainView() {
  document.getElementById("downloads-view").hidden = true;
  document.getElementById("confirm-view").hidden = true;
  document.getElementById("main-view").hidden = false;
  stopDlPoll();
}

function stopDlPoll() {
  if (dlPollTimer) { clearInterval(dlPollTimer); dlPollTimer = null; }
}

/* ===== Вкладка «Загрузки» ===== */

async function pollDownloads() {
  let items;
  try {
    items = await browser.runtime.sendMessage({ action: "getDownloads" });
  } catch (e) { return; }
  renderDownloads(items || []);
}

function formatBytes(n) {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

function renderDownloads(items) {
  const wrap = document.getElementById("downloads-list");
  wrap.textContent = "";

  let inProgress = 0, complete = 0, failed = 0;

  if (!items.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:12px 10px; color:#888; font-size:12px;";
    empty.textContent = "Загрузок пока не было.";
    wrap.appendChild(empty);
  }

  items.forEach((d) => {
    if (d.state === "in_progress") inProgress++;
    else if (d.state === "complete") complete++;
    else failed++;

    const row = document.createElement("div");
    row.className = "dl-item";

    const icon = document.createElement("span");
    icon.className = "dl-icon " + (d.state === "complete" ? "ok" : d.state === "in_progress" ? "run" : "err");
    icon.textContent = d.state === "complete" ? "✓" : d.state === "in_progress" ? "⏳" : "⚠";

    const name = document.createElement("span");
    name.className = "dl-name";
    const base = d.filename ? d.filename.split(/[\\/]/).pop() : "файл";
    name.textContent = base;
    name.title = d.error ? `${d.filename}\nОшибка: ${d.error}` : d.filename;

    row.append(icon, name);

    if (d.state === "in_progress") {
      if (d.total > 0) {
        const bar = document.createElement("div");
        bar.className = "dl-bar";
        const fill = document.createElement("div");
        fill.className = "dl-bar-fill";
        fill.style.width = Math.round((d.received / d.total) * 100) + "%";
        bar.appendChild(fill);
        row.appendChild(bar);
      }
      const size = document.createElement("span");
      size.className = "dl-size";
      size.textContent = formatBytes(d.received);
      row.appendChild(size);
    } else if (d.state === "complete") {
      const size = document.createElement("span");
      size.className = "dl-size";
      size.textContent = formatBytes(d.total);
      row.appendChild(size);
    }

    wrap.appendChild(row);
  });

  document.getElementById("dl-summary").textContent =
    `⏳ ${inProgress} · ✓ ${complete} · ⚠ ${failed}`;
}

/* ===== Прогрессбар поиска ===== */

function showScanning() {
  progressEl.hidden = false;
  progressFillEl.classList.add("indeterminate");
  progressFillEl.style.width = "";
  progressTextEl.textContent = "Сканирую страницу…";
  progressPercentEl.textContent = "";
  ["stat-count", "stat-found", "stat-fallback", "stat-eta", "progress-current"].forEach((id) => {
    document.getElementById(id).textContent = "";
  });
  document.getElementById("phase-step-1").className = "phase-step";
  document.getElementById("phase-step-2").className = "phase-step";
}

function hideProgress() {
  progressEl.hidden = true;
  progressFillEl.classList.remove("indeterminate");
}

function truncateUrl(url, max) {
  if (!url) return "";
  return url.length <= max ? url : url.slice(0, max - 1) + "…";
}

function formatDuration(sec) {
  if (sec == null || sec < 0) return null;
  if (sec < 60) return `${sec} сек`;
  const m = Math.floor(sec / 60);
  return `${m} мин ${sec % 60} сек`;
}

function estimateEta(state) {
  if (state.phase === 2 && state.phase2StartedAt && state.phase2Done > 0) {
    const elapsed = (Date.now() - state.phase2StartedAt) / 1000;
    const perItem = elapsed / state.phase2Done;
    return formatDuration(Math.ceil((state.phase2Total - state.phase2Done) * perItem));
  }
  if (state.phase === 1 && state.startedAt && state.phase1Processed > 0) {
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const perItem = elapsed / state.phase1Processed;
    return formatDuration(Math.ceil((state.total - state.phase1Processed) * perItem));
  }
  return null;
}

function renderPhaseSteps(state) {
  const s1 = document.getElementById("phase-step-1");
  const s2 = document.getElementById("phase-step-2");
  s1.className = "phase-step";
  s2.className = "phase-step";
  if (state.phase === 1) s1.classList.add("active");
  else { s1.classList.add("done"); s2.classList.add("active"); }
}

function renderProgress(state) {
  progressEl.hidden = false;
  progressFillEl.classList.remove("indeterminate");
  renderPhaseSteps(state);

  const finalized = (state.found || 0) + (state.fallback || 0);
  const total = state.total || 0;
  const pct = total > 0 ? Math.round((finalized / total) * 100) : 0;

  progressFillEl.style.width = pct + "%";
  progressPercentEl.textContent = pct + "%";

  progressTextEl.textContent = state.phase === 1
    ? `Фаза 1 из 2: обработано ${state.phase1Processed || 0} из ${total}`
    : `Фаза 2 из 2: догрузка ${state.phase2Done || 0} из ${state.phase2Total || 0}`;

  document.getElementById("stat-count").textContent = `${finalized} из ${total}`;
  document.getElementById("stat-found").textContent = state.found ? `найдено ${state.found}` : "";
  document.getElementById("stat-fallback").textContent = state.fallback ? `превью ${state.fallback}` : "";
  const eta = estimateEta(state);
  document.getElementById("stat-eta").textContent = eta ? `~${eta}` : "";
  document.getElementById("progress-current").textContent =
    state.currentUrl ? "→ " + truncateUrl(state.currentUrl, 48) : "";
}

/* ===== Список картинок ===== */

function showMessage(text) {
  messageEl.hidden = false;
  messageEl.textContent = text;
  listEl.hidden = true;
  document.querySelector("footer").hidden = true;
}

function fileNameLabel(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split("/").pop() || "") || url;
  } catch (e) { return url; }
}

function updateState() {
  const checked = listEl.querySelectorAll("input:checked").length;
  downloadBtn.disabled = checked === 0;
  downloadBtn.textContent = `Скачать выбранные (${checked})`;
}

function addItems(urls) {
  urls.forEach((url) => {
    const label = document.createElement("label");
    label.className = "item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("change", updateState);
    const thumb = document.createElement("img");
    thumb.src = url;
    thumb.loading = "lazy";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = fileNameLabel(url);
    name.title = url;
    label.append(cb, thumb, name);
    listEl.appendChild(label);
  });
  updateState();
}

function renderResolved(resolved) {
  const set = new Set(currentLinks);
  const fresh = [];
  resolved.forEach((r, i) => {
    const url = r || (thumbLinksCache[i] && thumbLinksCache[i].thumbUrl);
    if (url && !url.startsWith("data:") && !set.has(url)) {
      set.add(url);
      fresh.push(url);
    }
  });
  currentLinks = currentLinks.concat(fresh);
  addItems(fresh);
  statusEl.textContent = `Найдено: ${currentLinks.length}`;
}

/* ===== Опрос состояния разрешения ===== */

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollState, 300);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollState() {
  if (!currentTab) return;
  let state;
  try {
    state = await browser.runtime.sendMessage({ action: "getState", tabId: currentTab.id });
  } catch (e) { return; }

  if (!state || state.status === "idle") return;

  if (state.status === "running") {
    renderProgress(state);
    return;
  }

  if (state.status === "done") {
    stopPolling();
    hideProgress();
    renderResolved(state.resolved);
  }
}

/* ===== Скачивание и проверка дубликатов ===== */

async function startDownload(urls, force) {
  document.getElementById("confirm-view").hidden = true;
  try {
    await browser.runtime.sendMessage({
      action: "triggerDownload",
      tabId: currentTab.id,
      urls,
      force
    });
  } catch (e) {}
  statusEl.textContent = `Скачивается: ${urls.length}`;
  showDownloadsView();
}

function showConfirmView(fresh, duplicates) {
  document.getElementById("main-view").hidden = true;
  const cv = document.getElementById("confirm-view");
  cv.hidden = false;

  const total = fresh.length + duplicates.length;
  const msgEl = document.getElementById("confirm-message");
  msgEl.textContent = duplicates.length === total
    ? `Все ${total} файлов уже скачаны в папку.`
    : `${duplicates.length} из ${total} файлов уже скачаны в папку.`;

  const actionsEl = document.getElementById("confirm-actions");
  actionsEl.textContent = "";

  if (fresh.length) {
    const b1 = document.createElement("button");
    b1.className = "primary";
    b1.textContent = `Скачать только новые (${fresh.length})`;
    b1.addEventListener("click", () => startDownload(fresh, false));
    actionsEl.appendChild(b1);
  }

  const b2 = document.createElement("button");
  b2.className = duplicates.length === total ? "primary" : "secondary";
  b2.textContent = `Повторно скачать картинки (${total})`;
  b2.addEventListener("click", () => startDownload(pendingSelection, true));
  actionsEl.appendChild(b2);

  const b3 = document.createElement("button");
  b3.className = "ghost";
  b3.textContent = "Отмена";
  b3.addEventListener("click", () => {
    cv.hidden = true;
    showMainView();
    downloadBtn.disabled = false;
    updateState();
  });
  actionsEl.appendChild(b3);
}

/* ===== Инициализация ===== */

async function init() {
  [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });

  showScanning();
  progressTextEl.textContent = "Прокручиваю страницу, чтобы подгрузить все превью…";

  let data;
  try {
    data = await browser.tabs.sendMessage(currentTab.id, { action: "getPageData", autoScroll: true });
  } catch (e) {
    hideProgress();
    statusEl.textContent = "Нет доступа";
    showMessage("Не удалось подключиться к странице (служебная страница браузера?).");
    return;
  }

  const direct = (data && data.direct) || [];
  thumbLinksCache = (data && data.thumbLinks) || [];

  lastStats = (data && data.stats) || null;
  lastDirectCount = direct.length;
  lastNextCount = ((data && data.nextPages) || []).length;

  const dbg = document.getElementById("debug-line");
  if (dbg) dbg.textContent = `Собрано: ${direct.length} прямых, ${thumbLinksCache.length} превью-ссылок, страниц пагинации: ${lastNextCount}`;

  currentLinks = [...direct];
  listEl.textContent = "";
  addItems(direct);
  statusEl.textContent = `Найдено: ${currentLinks.length}`;

  if (!thumbLinksCache.length) {
    hideProgress();
    if (!currentLinks.length) {
      statusEl.textContent = "Найдено: 0";
      showMessage("На странице не нашлось картинок с расширениями jpg, png, webp.");
    }
    return;
  }

  let state;
  try {
    state = await browser.runtime.sendMessage({ action: "getState", tabId: currentTab.id });
  } catch (e) { state = null; }

  if (state && state.status === "done") {
    hideProgress();
    renderResolved(state.resolved);
    return;
  }
  if (state && state.status === "running") {
    startPolling();
    return;
  }

  await browser.runtime.sendMessage({
    action: "startResolution",
    tabId: currentTab.id,
    thumbLinks: thumbLinksCache
  });
  startPolling();
}

/* ===== Обработчики ===== */

document.getElementById("select-all").addEventListener("click", () => {
  listEl.querySelectorAll("input").forEach((cb) => { cb.checked = true; });
  updateState();
});

document.getElementById("select-none").addEventListener("click", () => {
  listEl.querySelectorAll("input").forEach((cb) => { cb.checked = false; });
  updateState();
});

document.getElementById("show-downloads").addEventListener("click", showDownloadsView);
document.getElementById("back-to-main").addEventListener("click", showMainView);

document.getElementById("copy-diag").addEventListener("click", async () => {
  const lines = [];
  try { lines.push("URL: " + (currentTab ? currentTab.url : "?")); } catch (e) {}
  lines.push(`Собрано: ${lastDirectCount} прямых, ${thumbLinksCache.length} превью, пагинация: ${lastNextCount}`);
  if (lastStats) lines.push(`На странице: <img> ${lastStats.imgs}, <a> ${lastStats.anchors}`);
  lines.push(`В списке: ${currentLinks.length}`);
  if (lastStats && lastStats.missed && lastStats.missed.length) {
    lines.push("Образцы ПРОПУЩЕННЫХ <img>:");
    lastStats.missed.forEach((m, i) => {
      lines.push(`--- ${i + 1} ---`);
      lines.push(m);
    });
  } else {
    lines.push("Пропущенных <img> не обнаружено (проблема в подгрузке/пагинации, а не в разметке).");
  }
  const text = lines.join("\n");
  const el = document.getElementById("copy-diag");
  try {
    await navigator.clipboard.writeText(text);
    const old = el.textContent;
    el.textContent = "скопировано!";
    setTimeout(() => { el.textContent = old; }, 1500);
  } catch (e) {
    window.prompt("Скопируйте вручную (Ctrl+C):", text);
  }
});

downloadBtn.addEventListener("click", async () => {
  const boxes = listEl.querySelectorAll("input");
  const selected = currentLinks.filter((_, i) => boxes[i].checked);
  if (!selected.length) return;
  pendingSelection = selected;

  downloadBtn.disabled = true;
  downloadBtn.textContent = "Проверяю…";

  let result;
  try {
    result = await browser.runtime.sendMessage({
      action: "checkDuplicates",
      tabId: currentTab.id,
      urls: selected
    });
  } catch (e) {
    result = { fresh: selected, duplicates: [] };
  }

  const fresh = result.fresh || [];
  const duplicates = result.duplicates || [];

  if (duplicates.length === 0) {
    await startDownload(selected, false);
  } else {
    downloadBtn.disabled = false;
    updateState();
    showConfirmView(fresh, duplicates);
  }
});

init();