"use strict";

function flashBadge(text, color) {
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
  setTimeout(() => browser.browserAction.setBadgeText({ text: "" }), 4000);
}

const resolutionState = new Map();
const trackedDownloads = [];
const MAX_TRACKED = 100;

function trackIds(ids) {
  (ids || []).forEach((id) => {
    if (typeof id === "number" && !trackedDownloads.includes(id)) trackedDownloads.push(id);
  });
  while (trackedDownloads.length > MAX_TRACKED) trackedDownloads.shift();
}

async function getDownloadsSnapshot() {
  if (!trackedDownloads.length) return [];
  const idSet = new Set(trackedDownloads);
  try {
    const items = await browser.downloads.search({ orderBy: ["-startTime"], limit: 200 });
    return items
      .filter((d) => idSet.has(d.id))
      .map((d) => ({
        id: d.id,
        filename: d.filename || "",
        state: d.state,
        error: d.error || null,
        received: d.bytesReceived || 0,
        total: d.totalBytes || 0
      }));
  } catch (e) {
    return [];
  }
}

function normPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function buildTargets(tab, urls) {
  const folder = folderForTab(tab);
  return urls.map((url, i) => ({
    url,
    target: `${folder}/${fileNameFromUrl(url, i + 1)}`
  }));
}

async function splitDuplicates(tab, urls) {
  const targets = buildTargets(tab, urls);
  let existing = [];
  try {
    existing = await browser.downloads.search({ exists: true });
  } catch (e) {
    existing = [];
  }
  const fresh = [];
  const duplicates = [];
  targets.forEach((t) => {
    const isDup = existing.some(
      (d) => d.filename && normPath(d.filename).endsWith("/" + normPath(t.target))
    );
    if (isDup) duplicates.push(t.url);
    else fresh.push(t.url);
  });
  return { fresh, duplicates };
}

async function openDownloadsPage() {
  try {
    const tabs = await browser.tabs.query({ url: "about:downloads" });
    if (tabs.length) {
      await browser.tabs.update(tabs[0].id, { active: true });
      await browser.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await browser.tabs.create({ url: "about:downloads" });
    }
  } catch (e) {
    console.warn("[img-dl] Не удалось открыть страницу загрузок:", e);
  }
}

browser.tabs.onRemoved.addListener((tabId) => resolutionState.delete(tabId));
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") resolutionState.delete(tabId);
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "phase1Progress") {
    const tid = sender.tab && sender.tab.id;
    if (tid != null) handlePhase1Progress(tid, message.info);
    return;
  }

  if (message.action === "startResolution") {
    startResolution(message.tabId, message.thumbLinks || [])
      .catch((e) => console.warn("[img-dl] startResolution:", e));
    sendResponse({ ok: true });
    return;
  }

  if (message.action === "getState") {
    sendResponse(resolutionState.get(message.tabId) || { status: "idle" });
    return;
  }

  if (message.action === "checkDuplicates") {
    (async () => {
      let tab;
      try { tab = await browser.tabs.get(message.tabId); }
      catch (e) { tab = { title: "страница", url: "" }; }
      const res = await splitDuplicates(tab, message.urls || []);
      sendResponse(res);
    })().catch(() => sendResponse({ fresh: message.urls || [], duplicates: [] }));
    return true;
  }

  if (message.action === "triggerDownload") {
    triggerDownload(message.tabId, message.urls || [], message.force || false)
      .then((n) => sendResponse({ started: n }))
      .catch(() => sendResponse({ started: 0 }));
    return true;
  }

  if (message.action === "getDownloads") {
    getDownloadsSnapshot().then(sendResponse);
    return true;
  }
});

function handlePhase1Progress(tabId, info) {
  const state = resolutionState.get(tabId);
  if (!state || state.status !== "running" || state.phase !== 1) return;
  if (info.resolved) state.found += 1;
  state.phase1Processed += 1;
  state.currentUrl = info.url || "";
}

async function startResolution(tabId, thumbLinks) {
  const total = thumbLinks.length;
  const state = {
    status: "running",
    phase: 1,
    total,
    found: 0,
    fallback: 0,
    phase1Processed: 0,
    currentUrl: "",
    startedAt: Date.now(),
    phase2StartedAt: null,
    phase2Total: 0,
    phase2Done: 0,
    resolved: thumbLinks.map(() => null),
  };
  resolutionState.set(tabId, state);

  let resolved = thumbLinks.map(() => null);
  try {
    const p1 = await browser.tabs.sendMessage(tabId, {
      action: "resolveThumbnails",
      thumbLinks,
      reportProgress: true
    });
    if (Array.isArray(p1) && p1.length === total) resolved = p1;
  } catch (e) { /* фаза 1 недоступна */ }

  state.found = resolved.filter(Boolean).length;
  state.phase1Processed = total;

  const left = [];
  resolved.forEach((r, i) => { if (!r) left.push(thumbLinks[i]); });
  state.phase2Total = left.length;

  if (left.length) {
    state.phase = 2;
    state.phase2StartedAt = Date.now();
    const p2 = await resolveThumbnails(left, (info) => {
      if (info.resolved) state.found += 1;
      else state.fallback += 1;
      state.phase2Done = info.done;
      state.currentUrl = info.url || "";
    });
    let j = 0;
    resolved = resolved.map((r) => (r ? r : p2[j++]));
  }

  state.resolved = resolved;
  state.currentUrl = "";
  state.status = "done";
}

async function resolveForDownload(tabId, thumbLinks) {
  let resolved = thumbLinks.map(() => null);
  try {
    const p1 = await browser.tabs.sendMessage(tabId, {
      action: "resolveThumbnails",
      thumbLinks,
      reportProgress: false
    });
    if (Array.isArray(p1) && p1.length === thumbLinks.length) resolved = p1;
  } catch (e) {}

  const left = [];
  resolved.forEach((r, i) => { if (!r) left.push(thumbLinks[i]); });
  if (left.length) {
    const p2 = await resolveThumbnails(left);
    let j = 0;
    resolved = resolved.map((r) => (r ? r : p2[j++]));
  }
  return resolved;
}

async function triggerDownload(tabId, urls, force) {
  let tab;
  try { tab = await browser.tabs.get(tabId); }
  catch (e) { tab = { title: "страница", url: "" }; }
  const ids = await downloadImages(tab, urls, force);
  trackIds(ids);
  openDownloadsPage();
  return urls.length;
}

browser.menus.removeAll().then(() => {
  browser.menus.create({
    id: "download-all-images",
    title: "Скачать все картинки со страницы",
    contexts: ["page"]
  });
  browser.menus.create({
    id: "download-one-image",
    title: "Сохранить картинку в папку страницы",
    contexts: ["image"]
  });
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "download-one-image") {
    if (info.srcUrl) {
      const ids = await downloadImages(tab, [info.srcUrl]);
      trackIds(ids);
      openDownloadsPage();
      flashBadge("1", COLOR_OK);
    }
    return;
  }

  if (info.menuItemId === "download-all-images") {
    let data;
    try {
      data = await browser.tabs.sendMessage(tab.id, { action: "getPageData", autoScroll: true });
    } catch (e) {
      flashBadge("!", COLOR_ERR);
      return;
    }

    const direct = (data && data.direct) || [];
    const thumbLinks = (data && data.thumbLinks) || [];

    let resolved = [];
    if (thumbLinks.length) resolved = await resolveForDownload(tab.id, thumbLinks);

    const set = new Set(direct);
    resolved.forEach((r, i) => {
      const url = r || (thumbLinks[i] && thumbLinks[i].thumbUrl);
      if (url && !url.startsWith("data:")) set.add(url);
    });
    const links = Array.from(set);

    if (!links.length) { flashBadge("0", COLOR_ERR); return; }

    const { fresh } = await splitDuplicates(tab, links);
    if (!fresh.length) {
      flashBadge("✓", "#888888");
      return;
    }
    const ids = await downloadImages(tab, fresh, false);
    trackIds(ids);
    openDownloadsPage();
    flashBadge(String(fresh.length), COLOR_OK);
  }
});