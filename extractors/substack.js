(function() {
// extractors/substack.js — Substack extractor (supports custom domains)

window.ClipMD = window.ClipMD || { extractors: {} };
window.ClipMD.extractors = window.ClipMD.extractors || {};

window.ClipMD.extractors.substack = {
  canHandle() {
    let score = 0;
    if (document.querySelector('.body.markup')) score++;
    if (document.querySelector('.single-post')) score++;
    if (document.querySelector('meta[content*="Substack"]')) score++;
    if (document.querySelector('link[href*="substackcdn"]')) score++;
    try { if (window.__NEXT_DATA__?.props?.pageProps?.post) score++; } catch (e) {}
    if (document.querySelector('meta[property="article:publisher"][content*="substack"]')) score++;
    return score >= 2;
  },

  priority: 20,

  async extract() {
    const body = document.querySelector('.body.markup') || document.querySelector('.available-content');
    if (!body) return null;

    // Title: h1 with post-title class
    let title = '';
    const h1s = document.querySelectorAll('h1');
    for (const h1 of h1s) {
      if (h1.className.includes('post-title')) {
        title = h1.textContent.trim();
        break;
      }
    }
    // Fallback: first substantial h1
    if (!title) {
      for (const h1 of h1s) {
        const text = h1.textContent.trim();
        if (text.length > 10) { title = text; break; }
      }
    }
    // Fallback: parse document.title
    if (!title) {
      title = document.title.replace(/\s*[-–]\s*by\s+.+$/, '').trim();
    }

    // Author
    const authorMeta = document.querySelector('meta[name="author"]');
    let author = authorMeta?.content || '';
    if (!author) {
      const byline = document.querySelector('.byline, [class*="byline"], a[class*="profile"]');
      author = byline?.textContent?.trim() || '';
    }

    // Date
    const timeEl = document.querySelector('time[datetime]');
    const date = timeEl?.getAttribute('datetime')?.split('T')[0]
      || window.ClipMD.todayISO();

    // Content clone
    const content = body.cloneNode(true);

    // Paywall detection
    const hasPaywall = !!document.querySelector('[class*="paywall"]');

    return {
      title,
      author,
      date,
      type: 'substack',
      url: window.ClipMD.getCanonicalUrl(),
      meta: { paywall: hasPaywall || undefined },
      content
    };
  }
};
})();
