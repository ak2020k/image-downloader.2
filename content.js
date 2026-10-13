"use strict";

console.log("[img-dl] content-скрипт жив на " + location.href);

async function autoScrollPage() {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const startY = window.scrollY;
  let lastHeight = -1;
  let stable = 0;
  let rounds = 0;

  while (stable < 5 && rounds < 100) {
    window.scrollBy(0, Math.max(700, Math.round(window.innerHeight * 0.9)));
    await delay(500);

    const h = document.body.scrollHeight;
    const atBottom = window.innerHeight + window.scrollY >= h - 8;
    if (atBottom && h === lastHeight) {
      stable += 1;
    } else {
      stable = 0;
    }
    lastHeight = h;
    rounds += 1;
  }

  console.log("[img-dl] автопрокрутка: " + rounds + " шагов, высота " + lastHeight);
  window.scrollTo(0, startY);
  await delay(300);
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getPageData") {
    (async () => {
      if (message.autoScroll) await autoScrollPage();
      const data = collectPageData(EXTENSIONS);

      const extraPages = (data.nextPages || []).slice(0, MAX_EXTRA_PAGES);
      for (const p of extraPages) {
        try {
          const resp = await fetch(p, { credentials: "include" });
          if (!resp.ok) continue;
          const extra = collectFromHtml(await resp.text(), p, EXTENSIONS);

          const dSet = new Set(data.direct);
          extra.direct.forEach((u) => dSet.add(u));
          data.direct = Array.from(dSet);

          const seen = new Set(data.thumbLinks.map((t) => t.pageUrl));
          extra.thumbLinks.forEach((t) => {
            if (!seen.has(t.pageUrl)) { seen.add(t.pageUrl); data.thumbLinks.push(t); }
          });
        } catch (e) { /* страница не открылась — пропускаем */ }
        await new Promise((r) => setTimeout(r, PAGE_FETCH_DELAY_MS));
      }

      console.log("[img-dl] ИТОГО: " + data.direct.length + " прямых, " + data.thumbLinks.length + " превью");
      sendResponse(data);
    })().catch((e) => {
      console.warn("[img-dl] getPageData ошибка:", e);
      sendResponse({ direct: [], thumbLinks: [], nextPages: [], stats: null });
    });
    return true;
  }

  if (message.action === "resolveThumbnails") {
    const onProg = message.reportProgress
      ? (info) => browser.runtime.sendMessage({ action: "phase1Progress", info }).catch(() => {})
      : null;
    resolveThumbnails(message.thumbLinks || [], onProg)
      .then(sendResponse)
      .catch((e) => {
        console.warn("[img-dl] resolveThumbnails ошибка:", e);
        sendResponse((message.thumbLinks || []).map(() => null));
      });
    return true;
  }
});