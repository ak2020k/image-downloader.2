"use strict";

const EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const COLOR_OK = "#2a7a2a";
const COLOR_ERR = "#cc2a2a";

/* ===== Настройки поведения ===== */
const MAX_CONCURRENT = 1;
const DELAY_BETWEEN_MS = 600;
const FETCH_TIMEOUT_MS = 15000;
const RETRY_COUNT = 1;
const RETRY_DELAY_MS = 1200;
const MAX_EXTRA_PAGES = 9;
const PAGE_FETCH_DELAY_MS = 400;

/* Атрибуты ленивой загрузки КАРТИНОК */
const LAZY_ATTRS = [
  "data-src", "data-lazy-src", "data-original", "data-image", "data-full",
  "data-zoom-image", "data-large_image", "data-thumb", "data-bg",
  "data-background", "data-background-image"
];

/* Регулярки для фильтрации */
const PROFILE_PATH_RE = /\/(user|users|profile|member|channel|author|artist|account)\/?/i;
const DECORATIVE_PATH_RE = /\/(avatar|avatars|icon|icons|thumb|thumbs|thumbnail|thumbnails|logo|logos|sprite|sprites)\/?/i;
const DECORATIVE_URL_RE = /(avatar|logo|icon|sprite|button|advert|banner)\./i;

/* ========== УНИВЕРСАЛЬНЫЙ СБОР ========== */

function collectFromDoc(doc, baseHref, exts, live) {
  const direct = new Set();
  const thumbLinks = [];
  const nextPages = [];
  const seenPages = new Set();

  const baseNoHash = baseHref.split("#")[0];
  let baseOrigin = "";
  try { baseOrigin = new URL(baseHref).origin; } catch (e) {}

  const resolveUrl = (raw) => {
    if (!raw || typeof raw !== "string") return null;
    try {
      const u = new URL(raw.trim(), baseHref);
      if (u.protocol === "http:" || u.protocol === "https:") return u;
    } catch (e) {}
    return null;
  };

  const extOf = (u) => u.pathname.toLowerCase().split(".").pop() || "";

  const addIfImage = (raw) => {
    const u = resolveUrl(raw);
    if (!u) return;
    if (!exts.includes(extOf(u))) return;
    if (DECORATIVE_URL_RE.test(u.href) || DECORATIVE_PATH_RE.test(u.pathname)) return;
    direct.add(u.href);
  };

  const parseSrcset = (raw) => {
    const out = [];
    if (!raw) return out;
    raw.split(",").forEach((p) => {
      const cand = p.trim().split(/\s+/)[0];
      if (cand) out.push(cand);
    });
    return out;
  };

  const imgCandidates = (img) => {
    const out = [img.getAttribute("src")];
    LAZY_ATTRS.forEach((attr) => out.push(img.getAttribute(attr)));
    parseSrcset(img.getAttribute("srcset")).forEach((u) => out.push(u));
    parseSrcset(img.getAttribute("data-srcset")).forEach((u) => out.push(u));
    if (live && img.currentSrc) out.push(img.currentSrc);
    return out;
  };

  const inlineBgUrl = (el) => {
    const style = el.getAttribute && el.getAttribute("style");
    if (!style) return null;
    const m = /background(?:-image)?\s*:\s*[^;]*url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(style);
    return m ? m[1] : null;
  };

  const computedBgUrl = (el) => {
    if (!live) return null;
    try {
      const bg = getComputedStyle(el).backgroundImage;
      const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(bg || "");
      if (m && !m[1].startsWith("data:")) return m[1];
    } catch (e) {}
    return null;
  };

  const addThumbLink = (pageHref, candidates) => {
    const pageUrl = resolveUrl(pageHref);
    if (!pageUrl) return;
    if (exts.includes(extOf(pageUrl))) { addIfImage(pageUrl.href); return; }
    if (pageUrl.href.split("#")[0] === baseNoHash) return;
    if (seenPages.has(pageUrl.href)) return;
    if (PROFILE_PATH_RE.test(pageUrl.pathname)) return;
    if (DECORATIVE_PATH_RE.test(pageUrl.pathname)) return;

    seenPages.add(pageUrl.href);

    let thumb = null;
    let anyResolved = null;
    for (const c of candidates || []) {
      const u = resolveUrl(c);
      if (!u) continue;
      if (!anyResolved) anyResolved = u.href;
      if (exts.includes(extOf(u))) { thumb = u.href; break; }
    }
    thumbLinks.push({ pageUrl: pageUrl.href, thumbUrl: thumb || anyResolved });
  };

  /* 1) <img> */
  doc.querySelectorAll("img").forEach((img) => {
    const candidates = imgCandidates(img);
    const anchor = img.closest("a[href]");
    if (anchor) {
      const pageUrl = resolveUrl(anchor.getAttribute("href"));
      if (pageUrl) {
        if (exts.includes(extOf(pageUrl))) { addIfImage(pageUrl.href); return; }
        if (pageUrl.href.split("#")[0] === baseNoHash) { candidates.forEach(addIfImage); return; }
        addThumbLink(anchor.getAttribute("href"), candidates);
        return;
      }
    }
    candidates.forEach(addIfImage);
  });

  /* 2) <a> без <img> */
  doc.querySelectorAll("a[href]").forEach((a) => {
    if (a.querySelector("img")) return;
    const hrefU = resolveUrl(a.getAttribute("href"));
    if (!hrefU) return;
    if (exts.includes(extOf(hrefU))) { addIfImage(hrefU.href); return; }
    if (hrefU.href.split("#")[0] === baseNoHash) return;

    const cands = [];
    const bgSelf = inlineBgUrl(a) || computedBgUrl(a);
    if (bgSelf) cands.push(bgSelf);
    a.querySelectorAll("[style]").forEach((el) => {
      const bg = inlineBgUrl(el);
      if (bg) cands.push(bg);
    });
    if (cands.length) addThumbLink(a.getAttribute("href"), cands);
  });

  /* 3) <picture> / <source> */
  doc.querySelectorAll("source").forEach((s) => {
    addIfImage(s.getAttribute("src"));
    parseSrcset(s.getAttribute("srcset")).forEach(addIfImage);
    parseSrcset(s.getAttribute("data-srcset")).forEach(addIfImage);
  });

  /* 4) Редкие места */
  doc.querySelectorAll("video[poster]").forEach((v) => addIfImage(v.getAttribute("poster")));
  doc.querySelectorAll('input[type="image"]').forEach((i) => addIfImage(i.getAttribute("src")));
  doc.querySelectorAll("area[href]").forEach((ar) => addIfImage(ar.getAttribute("href")));

  /* 5) Фоновые картинки вне ссылок */
  doc.querySelectorAll("[style]").forEach((el) => {
    if (el.closest && el.closest("a[href]")) return;
    addIfImage(inlineBgUrl(el));
  });

  /* 6) Пагинация */
  const isPageLink = (a, u) => {
    if ((a.getAttribute("rel") || "") === "next") return true;
    const text = (a.textContent || "").trim();
    if (/^(\d{1,4}|[»›→]|next|вперёд|вперед|далее|следующая|след\.?)$/i.test(text)) return true;
    if (/([?&](page|p|pg|offset|start)=\d+|\/page\/\d+|\/stranica\/\d+)/i.test(u.href)) return true;
    const cls = String(a.getAttribute("class") || "") + " " + String(a.id || "");
    if (/pagination|pager|pages|next/i.test(cls)) return true;
    return false;
  };

  doc.querySelectorAll("a[href]").forEach((a) => {
    const u = resolveUrl(a.getAttribute("href"));
    if (!u || u.origin !== baseOrigin) return;
    if (u.href.split("#")[0] === baseNoHash) return;
    if (!isPageLink(a, u)) return;
    if (!nextPages.includes(u.href)) nextPages.push(u.href);
  });

  /* ===== Диагностика: что НЕ попало в выборку ===== */
  const stats = { imgs: 0, anchors: 0, missed: [] };
  const allImgs = doc.querySelectorAll("img");
  stats.imgs = allImgs.length;
  stats.anchors = doc.querySelectorAll("a[href]").length;
  const thumbPageSet = new Set(thumbLinks.map((t) => t.pageUrl));
  allImgs.forEach((img) => {
    if (stats.missed.length >= 5) return;
    const cands = imgCandidates(img).map(resolveUrl).filter(Boolean);
    const inDirect = cands.some((u) => direct.has(u.href));
    const anchor = img.closest("a[href]");
    let registered = false;
    if (anchor) {
      const pu = resolveUrl(anchor.getAttribute("href"));
      if (pu && (thumbPageSet.has(pu.href) || direct.has(pu.href))) registered = true;
    }
    if (!inDirect && !registered) {
      stats.missed.push(String(img.outerHTML || "").slice(0, 400));
    }
  });

  return { direct: Array.from(direct), thumbLinks, nextPages, stats };
}

function collectPageData(exts) {
  const res = collectFromDoc(document, location.href, exts, true);
  console.log(`[img-dl] Собрано: ${res.direct.length} прямых, ${res.thumbLinks.length} превью-ссылок, страниц пагинации: ${res.nextPages.length}`);
  if (res.thumbLinks.length) console.log("[img-dl] Пример превью-ссылки:", res.thumbLinks[0]);
  return res;
}

function collectFromHtml(html, baseHref, exts) {
  let doc;
  try { doc = new DOMParser().parseFromString(html, "text/html"); }
  catch (e) { return { direct: [], thumbLinks: [], nextPages: [], stats: null }; }
  return collectFromDoc(doc, baseHref, exts, false);
}

/* ========== ИЗВЛЕЧЕНИЕ ПОЛНОГО ФОТО ========== */

function extractFullImageFromPage(html, pageUrl, exts, thumbUrlHint) {
  let doc;
  try { doc = new DOMParser().parseFromString(html, "text/html"); }
  catch (e) { return null; }

  const resolve = (raw) => {
    if (!raw) return null;
    try {
      const u = new URL(String(raw).trim(), pageUrl);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (e) {}
    return null;
  };

  const extOf = (href) => {
    try { return new URL(href).pathname.toLowerCase().split(".").pop() || ""; }
    catch (e) { return ""; }
  };

  const srcsetMax = (raw) => {
    if (!raw) return null;
    let best = null, bestW = -1;
    raw.split(",").forEach((part) => {
      const tokens = part.trim().split(/\s+/);
      const url = resolve(tokens[0]);
      if (!url) return;
      let w = 0;
      tokens.slice(1).forEach((t) => {
        const m = /^(\d+)w$/.exec(t);
        if (m) w = parseInt(m[1], 10);
      });
      if (w > bestW) { bestW = w; best = url; }
    });
    return best;
  };

  let thumbHost = "";
  try { thumbHost = new URL(thumbUrlHint || "").host; } catch (e) {}

  const score = (href, el) => {
    let s = 0;
    const sizeMatch = /\/(\d+)x(\d+)\//.exec(href);
    s += sizeMatch ? parseInt(sizeMatch[1], 10) * parseInt(sizeMatch[2], 10) : 1e7;

    if (el && el.getAttribute) {
      const w = parseInt(el.getAttribute("width"), 10) || 0;
      const h = parseInt(el.getAttribute("height"), 10) || 0;
      s += w * h;
    }

    if (DECORATIVE_URL_RE.test(href)) s -= 5e6;
    try {
      if (DECORATIVE_PATH_RE.test(new URL(href).pathname)) s -= 5e6;
    } catch (e) {}

    if (el && el.getAttribute) {
      const cls = String(el.getAttribute("class") || "").toLowerCase();
      if (/(lazyload|lazyloaded|main|full|primary|hero|viewer|photo)/.test(cls)) s += 1e8;
      if (/(thumb|thumbnail|preview|small|mini|avatar)/.test(cls)) s -= 1e8;
    }

    if (el && el.closest) {
      const container = el.closest("[class]");
      if (container) {
        const ccls = String(container.getAttribute("class") || "").toLowerCase();
        if (/(image-viewer|photo-viewer|gallery-viewer|viewer|photo-wrap|image-wrap)/.test(ccls)) s += 5e7;
      }
    }

    if (thumbHost) {
      try {
        const candHost = new URL(href).host;
        if (thumbHost === candHost) s += 1e7;
      } catch (e) {}
    }

    return s;
  };

  const candidates = [];
  const push = (href, el) => {
    if (href && exts.includes(extOf(href))) candidates.push({ href, s: score(href, el) });
  };

  doc.querySelectorAll("img").forEach((img) => {
    push(
      resolve(img.getAttribute("src")) ||
      resolve(img.getAttribute("data-src")) ||
      resolve(img.getAttribute("data-lazy-src")) ||
      resolve(img.getAttribute("data-original")) ||
      srcsetMax(img.getAttribute("srcset") || img.getAttribute("data-srcset")),
      img
    );
  });
  doc.querySelectorAll("source").forEach((s) => {
    push(srcsetMax(s.getAttribute("srcset")) || resolve(s.getAttribute("src")), s);
  });
  doc.querySelectorAll("a[href]").forEach((a) => push(resolve(a.getAttribute("href")), null));

  if (!candidates.length) {
    console.warn(`[img-dl] Не найдено ни одной картинки в HTML: ${pageUrl}`);
    return null;
  }

  // Главное фото по классу lazyload/lazyloaded
  const allImgs = doc.querySelectorAll("img");
  for (const img of allImgs) {
    const cls = String(img.getAttribute("class") || "").toLowerCase();
    if (cls.indexOf("lazyload") === -1) continue;
    if (/(thumb|thumbnail|preview|small|mini)/.test(cls)) continue;
    const src = resolve(img.getAttribute("src"))
      || resolve(img.getAttribute("data-src"))
      || srcsetMax(img.getAttribute("srcset") || img.getAttribute("data-srcset"));
    if (src && exts.includes(extOf(src))) {
      console.log(`[img-dl] Извлечено (класс lazyload) из ${pageUrl}: ${src}`);
      return src;
    }
  }

  // Совпадение по ID из URL страницы
  const ids = pageUrl.match(/\d{4,}/g) || [];
  if (ids.length) {
    const matched = candidates.filter((c) => ids.some((id) => c.href.includes(id)));
    if (matched.length) {
      matched.sort((a, b) => b.s - a.s);
      return matched[0].href;
    }
  }

  // og:image / twitter:image
  const metas = doc.querySelectorAll(
    'meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]'
  );
  for (const mt of metas) {
    const url = resolve(mt.getAttribute("content"));
    if (url && exts.includes(extOf(url))) return url;
  }

  const sorted = candidates.slice().sort((a, b) => b.s - a.s);
  console.log(`[img-dl] Кандидаты в ${pageUrl}:`, sorted.slice(0, 3).map((c) => c.href));
  return sorted[0].href;
}

/* ========== ЗАГРУЗКА И РАЗРЕШЕНИЕ ========== */

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndExtract(pageUrl, exts, thumbUrlHint) {
  try {
    const resp = await fetchWithTimeout(pageUrl, { credentials: "include" });
    if (!resp.ok) {
      console.warn(`[img-dl] HTTP ${resp.status} для ${pageUrl}`);
      return null;
    }
    const html = await resp.text();
    console.log(`[img-dl] HTML получен для ${pageUrl}: ${html.length} байт`);
    return extractFullImageFromPage(html, pageUrl, exts, thumbUrlHint);
  } catch (e) {
    console.warn(`[img-dl] Ошибка fetch для ${pageUrl}:`, e.name === "AbortError" ? "таймаут" : e.message);
    return null;
  }
}

async function verifyDerived(thumbUrl) {
  if (!thumbUrl) return null;
  try {
    const u = new URL(thumbUrl);
    if (/\/\d+x\d+\//.test(u.pathname)) {
      const cand = u.origin + u.pathname.replace(/\/\d+x\d+\//, "/") + u.search;
      const resp = await fetchWithTimeout(cand, { method: "HEAD" }, 5000);
      if (resp.ok) return cand;
    }
  } catch (e) {}
  return null;
}

async function tryResolveOne(t) {
  let full = await fetchAndExtract(t.pageUrl, EXTENSIONS, t.thumbUrl);
  if (!full) full = await verifyDerived(t.thumbUrl);
  return full;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) {
    workers.push((async () => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i], i);
        } catch (e) {
          console.warn(`[img-dl] mapLimit: элемент ${i} завершился ошибкой:`, e);
          results[i] = null;
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

async function resolveThumbnails(thumbLinks, onProgress) {
  let done = 0;
  return mapLimit(thumbLinks, MAX_CONCURRENT, async (t) => {
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_MS));

    let full = await tryResolveOne(t);
    if (!full) {
      console.warn(`[img-dl] Не удалось извлечь фото из ${t.pageUrl} (thumbUrl: ${t.thumbUrl})`);
    }

    let attempt = 0;
    while (!full && attempt < RETRY_COUNT) {
      attempt += 1;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      full = await tryResolveOne(t);
    }

    done += 1;
    if (onProgress) {
      onProgress({ done, total: thumbLinks.length, url: t.pageUrl, resolved: full });
    }
    return full;
  });
}

/* ========== ИМЕНА И СКАЧИВАНИЕ ========== */

function sanitizeName(raw, fallback) {
  const name = String(raw || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "")
    .slice(0, 120);
  return name || fallback;
}

function folderForTab(tab) {
  let fallback = "страница";
  try {
    const host = new URL(tab.url).hostname;
    if (host) fallback = host;
  } catch (e) {}
  return sanitizeName(tab.title, fallback);
}

function fileNameFromUrl(urlString, index) {
  try {
    const url = new URL(urlString);
    const cleaned = sanitizeName(decodeURIComponent(url.pathname.split("/").pop() || ""), "");
    if (cleaned) return cleaned;
    const ext = url.pathname.toLowerCase().split(".").pop() || "img";
    return `image_${index}.${ext}`;
  } catch (e) {
    return `image_${index}`;
  }
}

function downloadImages(tab, urls, force) {
  const folder = folderForTab(tab);
  return Promise.all(
    urls.map((url, i) =>
      browser.downloads.download({
        url,
        filename: `${folder}/${fileNameFromUrl(url, i + 1)}`,
        conflictAction: force ? "overwrite" : "uniquify",
        saveAs: false
      }).catch(() => null)
    )
  );
}