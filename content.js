(function() {
// content.js — stateless clip orchestrator (injected last, after libs + extractors)

// Preserve extractors namespace — extractors load before content.js
window.ClipMD = window.ClipMD || {};
window.ClipMD.extractors = window.ClipMD.extractors || {};

// --- Utility: canonical URL resolution ---

function getCanonicalUrl() {
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && canonical.href) return canonical.href;
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl && ogUrl.content) return ogUrl.content;
  return window.location.href;
}

// --- Utility: best image source ---

function getBestImageSrc(img) {
  // srcset: take largest width descriptor
  if (img.srcset) {
    const candidates = img.srcset
      .split(',')
      .map((s) => {
        const parts = s.trim().split(/\s+/);
        const url = parts[0];
        const width = parseInt(parts[1]) || 0;
        return { url, width };
      })
      .sort((a, b) => b.width - a.width);
    if (candidates.length > 0 && candidates[0].url) return candidates[0].url;
  }
  // Lazy-loaded
  if (img.dataset.src) return img.dataset.src;
  // X/Twitter media: prefer large variant
  if (img.src && img.src.includes('pbs.twimg.com')) {
    const url = new URL(img.src);
    url.searchParams.set('name', 'large');
    return url.toString();
  }
  // Skip data: placeholders when data-src available
  if (img.src && img.src.startsWith('data:') && img.dataset.src) return img.dataset.src;
  return img.src;
}

// --- Shared inline flattener (used by X article + thread extractors) ---

const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'code', 'br', 'sub', 'sup', 'mark']);

function flattenInline(el) {
  const frag = document.createDocumentFragment();
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      frag.appendChild(node.cloneNode(true));
    } else if (node.nodeType === 1) {
      const t = node.tagName.toLowerCase();
      if (t === 'img' && node.alt && node.src && node.src.includes('/emoji/')) {
        frag.appendChild(document.createTextNode(node.alt));
      } else if (t === 'img') {
        frag.appendChild(node.cloneNode(true));
      } else if (INLINE_TAGS.has(t)) {
        frag.appendChild(node.cloneNode(true));
      } else {
        frag.appendChild(flattenInline(node));
      }
    }
  }
  return frag;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function waitForMutation(target, { predicate = () => true, timeoutMs = 2000, observe = { childList: true, subtree: true, characterData: true } } = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    if (predicate()) { resolve(); return; }
    const observer = new MutationObserver(() => { if (predicate()) done(); });
    observer.observe(target, observe);
    const timer = setTimeout(done, timeoutMs);
  });
}

function cloneChildrenInto(target, source) {
  for (const node of source.childNodes) target.appendChild(node.cloneNode(true));
}

window.ClipMD.getCanonicalUrl = getCanonicalUrl;
window.ClipMD.getBestImageSrc = getBestImageSrc;
window.ClipMD.flattenInline = flattenInline;
window.ClipMD.todayISO = todayISO;
window.ClipMD.waitForMutation = waitForMutation;
window.ClipMD.cloneChildrenInto = cloneChildrenInto;

// --- Run lock: prevent double-fire from key repeat ---

let clipInProgress = false;

// --- Turndown factory ---

function makeTurndown() {
  return new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    hr: '---',
    bulletListMarker: '-',
  });
}

// --- clipFullPage ---

async function clipFullPage() {
  // Dispatch to extractors in priority order
  const extractors = Object.values(window.ClipMD.extractors)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  let data = null;
  for (const ext of extractors) {
    if (ext.canHandle()) {
      data = await ext.extract();
      if (data) break;
    }
  }
  if (!data) throw new Error('No extractor could handle this page');

  // Build frontmatter
  const fields = {
    title: data.title,
    url: data.url || getCanonicalUrl(),
    author: data.author,
    date: data.date || todayISO(),
    type: data.type,
    ...(data.meta || {}),
  };
  const frontmatter = window.ClipMD.buildFrontmatter(fields);

  clipLastTitle = data.title || '';

  // If extractor provides raw markdown (e.g. LW API), skip Turndown
  if (data.markdown) {
    return frontmatter + '\n' + data.markdown;
  }

  // Otherwise: preprocess LaTeX + convert HTML to markdown via Turndown
  const processed = window.ClipMD.preprocessLatex(data.content);
  const td = makeTurndown();
  const bodyMarkdown = td.turndown(processed);

  return frontmatter + '\n' + bodyMarkdown;
}

// --- clipSelection ---

async function clipSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) throw new Error('No text selected');

  const range = sel.getRangeAt(0);
  const container = document.createElement('div');
  container.appendChild(range.cloneContents());

  // Pre-process LaTeX if present
  const processed = window.ClipMD.preprocessLatex(container);

  const td = makeTurndown();
  const bodyMarkdown = td.turndown(processed);

  const fields = {
    title: document.title,
    url: getCanonicalUrl(),
    author: '',
    date: todayISO(),
    type: 'selection',
  };
  const frontmatter = window.ClipMD.buildFrontmatter(fields);
  clipLastTitle = document.title;

  return frontmatter + '\n' + bodyMarkdown;
}

// --- handleClip ---

async function handleClip(mode) {
  let markdown;
  if (mode === 'selection') {
    markdown = await clipSelection();
  } else {
    markdown = await clipFullPage();
  }

  // Send to background for clipboard write via offscreen
  const result = await chrome.runtime.sendMessage({ action: 'copy', text: markdown });
  if (!result || !result.success) {
    throw new Error(result?.error || 'Clipboard write failed');
  }

  window.ClipMD.showToast('Clipped: ' + (clipLastTitle || 'page'));
  return { success: true };
}

// Track last clipped title (set during clipFullPage/clipSelection, avoids regex-parsing YAML)
let clipLastTitle = '';

// --- Message listener (guarded against stacking on re-injection) ---

if (!window._clipMDListenerRegistered) {
  window._clipMDListenerRegistered = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action !== 'clip') return;

    if (clipInProgress) {
      sendResponse({ success: false, error: 'Clip already in progress' });
      return true;
    }
    clipInProgress = true;

    handleClip(msg.mode)
      .then(sendResponse)
      .catch((err) => {
        window.ClipMD.showToast('Clip failed: ' + err.message, 3000);
        sendResponse({ success: false, error: err.message });
      })
      .finally(() => {
        clipInProgress = false;
      });

    return true;
  });
}
})();
