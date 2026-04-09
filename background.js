// background.js — ClipMD service worker (MV3)
// All listeners registered synchronously at top level.

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: 'clip-selection',
    title: 'Clip selection as Markdown',
    contexts: ['selection']
  });
  // Close stale offscreen documents from previous version
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) {
    await chrome.offscreen.closeDocument();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'clip-page') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await injectAndClip(tab.id, 'full');
  }
});

// Toolbar icon click also triggers full-page clip
chrome.action.onClicked.addListener(async (tab) => {
  await injectAndClip(tab.id, 'full');
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'clip-selection') {
    await injectAndClip(tab.id, 'selection');
  }
});

async function injectAndClip(tabId, mode) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'lib/turndown.min.js',
        'lib/readability.min.js',
        'lib/latex.js',
        'lib/yaml.js',
        'extractors/twitter-article.js',
        'extractors/twitter-thread.js',
        'extractors/lesswrong.js',
        'extractors/substack.js',
        'extractors/generic.js',
        'toast.js',
        'content.js'
      ]
    });
    await chrome.tabs.sendMessage(tabId, { action: 'clip', mode });
  } catch (err) {
    console.error('[clip.md] injectAndClip failed:', err);
    // Surface error to user via injected toast (best-effort)
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (msg) => {
          if (window.ClipMD?.showToast) window.ClipMD.showToast(msg, 3000);
        },
        args: ['Clip failed: ' + err.message]
      });
    } catch (_) { /* tab may not support injection (chrome:// etc) */ }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'trigger-clip') {
    injectAndClip(sender.tab.id, msg.mode || 'full');
    return false;
  }
  if (msg.action === 'copy') {
    handleCopy(msg.text).then(sendResponse);
    return true;
  }
});

async function handleCopy(text) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Write clipped markdown to clipboard'
    });
  }
  const result = await chrome.runtime.sendMessage({
    action: 'clipboard-write',
    text
  });
  return result;
}
