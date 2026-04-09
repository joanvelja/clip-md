(function() {
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== 'clipboard-write') {
    return false;
  }

  if (typeof message.text !== 'string') {
    sendResponse({ success: false, error: `clipboard-write requires text as a string, got ${typeof message.text}` });
    return true;
  }

  // Use execCommand('copy') — navigator.clipboard.writeText requires
  // document focus, which offscreen documents don't have.
  try {
    const textarea = document.createElement('textarea');
    textarea.value = message.text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error('execCommand copy returned false');
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }

  return true;
});
})();
