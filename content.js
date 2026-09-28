(function() {
// content.js — clip orchestrator, injected last. Exposes ClipMD.clip(mode), which the
// service worker calls via chrome.scripting.executeScript and awaits.
//
// Dispatch rule: at most one site extractor may claim a page; if it fails, the clip
// fails with its id in the message. Readability (generic) only runs when no site
// extractor matches — it is never a fallback for a broken site extractor.

const ClipMD = window.ClipMD;

function pickExtractor() {
  const claimed = Object.values(ClipMD.extractors).filter((e) => e.id !== 'generic' && e.matches());
  if (claimed.length > 1) throw new Error(`ambiguous page, claimed by: ${claimed.map((e) => e.id).join(', ')}`);
  return claimed[0] || ClipMD.extractors.generic;
}

async function clipFullPage() {
  const ext = pickExtractor();
  let clip;
  try {
    clip = await ext.extract();
  } catch (err) {
    throw new Error(`[${ext.id}] ${err.message}`, { cause: err });
  }
  return validate(clip, ext.id);
}

function clipSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) throw new Error('No text selected');
  const container = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) container.appendChild(sel.getRangeAt(i).cloneContents());
  const warnings = [];
  return {
    meta: { title: document.title || location.hostname, url: ClipMD.getCanonicalUrl(), type: 'selection' },
    markdown: ClipMD.htmlToMarkdown(container, warnings),
    warnings,
  };
}

function validate(clip, source) {
  for (const field of ['title', 'url', 'type']) {
    if (!clip?.meta?.[field]) throw new Error(`[${source}] no meta.${field}`);
  }
  if (!clip.markdown?.trim()) throw new Error(`[${source}] produced empty markdown`);
  return clip;
}

// Always resolves: { ok: true, markdown, title, warnings } | { ok: false, error }.
// (executeScript's handling of rejected promises is undocumented, so errors travel as data.)
ClipMD.clip = async function(mode) {
  if (ClipMD.busy) return { ok: false, error: 'Clip already in progress' };
  ClipMD.busy = true;
  try {
    const clip = mode === 'selection' ? validate(clipSelection(), 'selection') : await clipFullPage();
    const warnings = clip.warnings || [];
    // `date` is the source's own date (omitted when unknown); `clipped` is when we took it.
    const frontmatter = ClipMD.buildFrontmatter({ ...clip.meta, clipped: ClipMD.todayISO(), clip_warnings: warnings });
    return { ok: true, markdown: frontmatter + '\n' + clip.markdown.trim() + '\n', title: clip.meta.title, warnings };
  } catch (err) {
    console.error('[clip.md]', err);
    return { ok: false, error: err.message };
  } finally {
    ClipMD.busy = false;
  }
};
})();
