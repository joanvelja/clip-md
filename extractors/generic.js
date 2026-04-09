(function() {
// extractors/generic.js — fallback extractor using Readability

window.ClipMD = window.ClipMD || { extractors: {} };
window.ClipMD.extractors = window.ClipMD.extractors || {};

window.ClipMD.extractors.generic = {
  canHandle: () => true,
  priority: 0,

  extract: async () => {
    const doc = document.cloneNode(true);
    const article = new Readability(doc).parse();

    if (!article || article.textContent.length < 200) return null;

    const container = document.createElement('div');
    container.innerHTML = article.content;

    return {
      title: article.title || document.title,
      author: article.byline || '',
      date: extractDate(),
      type: 'article',
      url: window.ClipMD.getCanonicalUrl(),
      meta: {},
      content: container
    };
  }
};

function extractDate() {
  const timeEl = document.querySelector('time[datetime]');
  if (timeEl) {
    const parsed = new Date(timeEl.getAttribute('datetime'));
    if (!isNaN(parsed)) return formatDate(parsed);
  }

  const metaDate = document.querySelector('meta[property="article:published_time"]');
  if (metaDate && metaDate.content) {
    const parsed = new Date(metaDate.content);
    if (!isNaN(parsed)) return formatDate(parsed);
  }

  return window.ClipMD.todayISO();
}

function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
})();
