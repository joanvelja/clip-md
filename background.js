// background.js — clip.md service worker (MV3). Listeners registered synchronously at top level.
//
// Clip pipeline, one direction:
//   stamp MathJax v3 sources (page world) → inject libs → executeScript(ClipMD.clip) returns
//   { ok, markdown } → offscreen clipboard write → toast. Failures surface as a toast and a
//   "!" badge + tooltip (the badge covers pages where no script can run, e.g. chrome://).

importScripts('inject-files.js');  // self.CLIPMD_FILES

const DEFAULT_TITLE = 'clip.md — Clip page to Markdown';

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'clip-selection', title: 'Clip selection as Markdown', contexts: ['selection'] });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  // Dev loop: re-read the unpacked extension from disk. Keyboard-only, so pages can't trigger it.
  if (command === 'reload-extension') return chrome.runtime.reload();
  if (command !== 'clip-page') return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target) await clipTab(target.id, 'full');
});

chrome.action.onClicked.addListener((tab) => clipTab(tab.id, 'full'));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'clip-selection') clipTab(tab.id, 'selection');
});

async function clipTab(tabId, mode) {
  setStatus(tabId, '…');
  let result;
  try {
    result = await runClip(tabId, mode);
  } catch (err) {
    console.error('[clip.md]', err);
    setStatus(tabId, '!', 'clip.md failed: ' + err.message);
    await notify(tabId, 'clip.md failed: ' + err.message, 6000);
    return;
  }
  setStatus(tabId, '', DEFAULT_TITLE);
  const n = result.warnings.length;
  await notify(tabId, `Clipped: ${result.title}` + (n ? ` — ${n} warning${n > 1 ? 's' : ''} (see clip_warnings)` : ''), n ? 5000 : 2000);
}

// Throws on any failure; resolves only once the markdown is on the clipboard.
async function runClip(tabId, mode) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: stampMathJaxSources });
  await chrome.scripting.executeScript({ target: { tabId }, files: self.CLIPMD_FILES });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m) => window.ClipMD.clip(m),
    args: [mode],
  });
  const result = injection?.result;
  if (!result) throw new Error('clip script returned nothing');
  if (!result.ok) throw new Error(result.error);
  await writeClipboard(result.markdown);
  return result;
}

// Runs in the page's main world: MathJax v3/v4 keep each formula's source TeX in their
// internal math list, invisible to the isolated world. Stamp it onto the rendered node.
function stampMathJaxSources() {
  const list = window.MathJax?.startup?.document?.math;
  if (!list) return 0;
  let n = 0;
  for (const item of list) {
    const node = item.typesetRoot;
    if (node?.setAttribute && typeof item.math === 'string') {
      node.setAttribute('data-clipmd-tex', item.math);
      node.setAttribute('data-clipmd-display', String(!!item.display));
      n++;
    }
  }
  return n;
}

// --- status UI: best effort. The tab may have closed or forbid scripts; that is logged,
// never mistaken for (or allowed to mask) the clip's own outcome. ---

function setStatus(tabId, text, title) {
  Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    title && chrome.action.setTitle({ tabId, title }),
  ]).catch((err) => console.error('[clip.md] badge update failed:', err));
}

async function notify(tabId, message, duration) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['toast.js'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg, ms) => window.ClipMD.showToast(msg, ms),
      args: [message, duration],
    });
  } catch (err) {
    console.error('[clip.md] toast failed:', err);
  }
}

// --- clipboard via offscreen document (service workers have no clipboard) ---

let offscreenLock = Promise.resolve();

function ensureOffscreen() {
  // Serialized: two concurrent clips would both see "no document" and both try to create one.
  const ready = offscreenLock.then(async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!existing.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Write clipped markdown to the clipboard',
      });
    }
  });
  offscreenLock = ready.catch(() => {});  // keep the chain usable; callers still see the rejection
  return ready;
}

async function writeClipboard(text) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ action: 'clipboard-write', text });
  if (!res?.success) throw new Error(res?.error || 'offscreen document did not answer');
}
