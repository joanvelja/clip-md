(function() {
// lib/util.js — shared helpers for extractors and the orchestrator.
//
// Extractor contract (see content.js):
//   window.ClipMD.extractors[key] = {
//     id: string,                       // also the frontmatter `type` unless meta overrides
//     matches(): boolean,               // cheap; at most one non-generic extractor may match a page
//     async extract(): { meta, markdown, warnings }  // throw on failure — never return partial junk
//   }
//   meta: { title, url, author?, date?, type, ...extra }  (key order = frontmatter order)

const ClipMD = (window.ClipMD = window.ClipMD || {});
ClipMD.extractors = ClipMD.extractors || {};

ClipMD.getCanonicalUrl = function() {
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical?.href) return canonical.href;
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl?.content) return ogUrl.content;
  return location.href;
};

ClipMD.todayISO = () => new Date().toISOString().slice(0, 10);

// ISO timestamp / epoch-ms / Date → YYYY-MM-DD. Throws on garbage instead of emitting "Invalid Date".
ClipMD.isoDate = function(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) throw new Error(`invalid date: ${JSON.stringify(value)}`);
  return d.toISOString().slice(0, 10);
};

ClipMD.getBestImageSrc = function(img) {
  if (img.srcset) {
    // Candidates are separated by ", " — URLs themselves may contain commas (e.g. CDN transforms).
    const best = img.srcset.split(/,\s+/)
      .map((s) => { const [url, w] = s.trim().split(/\s+/); return { url, width: parseInt(w) || 0 }; })
      .sort((a, b) => b.width - a.width)[0];
    if (best?.url) return best.url;
  }
  if (img.dataset.src) return img.dataset.src;
  if (img.src.includes('pbs.twimg.com')) {
    const url = new URL(img.src);
    url.searchParams.set('name', 'large');
    return url.toString();
  }
  return img.src;
};

// Flatten an element to inline content (used by X extractors whose DOM is div soup).
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'code', 'br', 'sub', 'sup', 'mark']);
ClipMD.flattenInline = function flattenInline(el) {
  const frag = document.createDocumentFragment();
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      frag.appendChild(node.cloneNode(true));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const t = node.tagName.toLowerCase();
      if (t === 'img' && node.alt && node.src.includes('/emoji/')) {
        frag.appendChild(document.createTextNode(node.alt));
      } else if (t === 'img' || INLINE_TAGS.has(t)) {
        frag.appendChild(node.cloneNode(true));
      } else {
        frag.appendChild(flattenInline(node));
      }
    }
  }
  return frag;
};

// Text rendered with `white-space: pre-wrap` carries raw "\n" that Turndown collapses to
// spaces. Make the breaks structural. Operates in place (call on a clone).
ClipMD.newlinesToBr = function(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes('\n')) texts.push(walker.currentNode);
  for (const t of texts) {
    const frag = document.createDocumentFragment();
    t.nodeValue.split('\n').forEach((line, i) => {
      if (i > 0) frag.appendChild(document.createElement('br'));
      if (line) frag.appendChild(document.createTextNode(line));
    });
    t.replaceWith(frag);
  }
  return root;
};

const TURNDOWN_OPTIONS = { headingStyle: 'atx', codeBlockStyle: 'fenced', hr: '---', bulletListMarker: '-' };

// HTML element → markdown, with math kept verbatim (see lib/latex.js).
// Does not mutate `el`. Pushes human-readable problems onto `warnings`.
ClipMD.htmlToMarkdown = function(el, warnings) {
  const clone = el.cloneNode(true);
  const math = ClipMD.createMathStash();
  math.protect(clone, warnings);
  return ClipMD.markdownFromProtected(clone, math);
};

// Second half of htmlToMarkdown, for callers that had to protect math earlier
// (the generic extractor protects before Readability strips the math markup).
ClipMD.markdownFromProtected = function(root, math) {
  for (const junk of root.querySelectorAll('script, style, noscript')) junk.remove();
  return math.restore(new TurndownService(TURNDOWN_OPTIONS).turndown(root)).trim();
};
})();
