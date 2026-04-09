(function() {
// toast.js — ClipMD toast notification (content script)

function showToast(message, duration = 2000) {
  // Inject styles once
  if (!document.getElementById('clipmd-toast-style')) {
    const style = document.createElement('style');
    style.id = 'clipmd-toast-style';
    style.textContent = `
      .clipmd-toast {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #1a1a2e;
        color: #ffffff;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: -apple-system, system-ui, sans-serif;
        font-size: 14px;
        z-index: 2147483647;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        transform: translateX(120%);
        transition: transform 0.3s ease, opacity 0.3s ease;
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  // Remove any existing toast
  const existing = document.querySelector('.clipmd-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'clipmd-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Slide in via rAF (allows initial transform to apply first)
  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(0)';
  });

  // Slide out after duration
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

window.ClipMD = window.ClipMD || {};
window.ClipMD.showToast = showToast;
})();
