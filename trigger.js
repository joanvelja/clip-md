// trigger.js — persistent content script for programmatic triggering
// Listens for a DOM custom event and forwards to the extension background.
document.addEventListener('clipmd-trigger', (e) => {
  chrome.runtime.sendMessage({ action: 'trigger-clip', mode: e.detail?.mode || 'full' });
});
