(function() {
// extractors/twitter-article.js — X/Twitter Article extractor
// Normalizes X Article DOM (div-based) into semantic HTML for Turndown.

window.ClipMD = window.ClipMD || { extractors: {} };
window.ClipMD.extractors = window.ClipMD.extractors || {};

window.ClipMD.extractors.twitterArticle = {
  canHandle() {
    return !!document.querySelector('[data-testid="twitterArticleReadView"]');
  },

  priority: 50,

  async extract() {
    // --- Metadata ---
    const titleEl = document.querySelector('[data-testid="twitter-article-title"]');
    const title = titleEl ? titleEl.textContent.trim() : 'Untitled Article';

    const userNameEl = document.querySelector('[data-testid="User-Name"]');
    let author = '';
    if (userNameEl) {
      const text = userNameEl.textContent;
      const atIdx = text.lastIndexOf('@');
      author = atIdx !== -1 ? '@' + text.slice(atIdx + 1).split(/\s/)[0] : text.trim();
    }

    const timeEl = document.querySelector('article time[datetime]');
    const date = timeEl
      ? timeEl.getAttribute('datetime').split('T')[0]
      : window.ClipMD.todayISO();

    const url = window.ClipMD.getCanonicalUrl();

    // --- Content container ---
    const longform = document.querySelector('[data-testid="longformRichTextComponent"]');
    if (!longform) return null;

    // Walk down to the container with many children (handles nested wrapper divs)
    let contentDiv = longform.querySelector(':scope > div');
    while (contentDiv && contentDiv.children.length === 1 && contentDiv.firstElementChild.tagName === 'DIV') {
      contentDiv = contentDiv.firstElementChild;
    }
    if (!contentDiv || contentDiv.children.length === 0) return null;

    // --- Normalize to semantic HTML ---
    const article = document.createElement('article');

    for (const child of contentDiv.children) {
      const tag = child.tagName.toLowerCase();
      const testId = child.getAttribute('data-testid') || '';

      // Check for headings inside wrapper divs (X wraps h2 in divs)
      const innerHeading = child.querySelector('h2, h3');
      if (tag === 'h2' || tag === 'h3') {
        article.appendChild(child.cloneNode(true));
      } else if (innerHeading) {
        article.appendChild(innerHeading.cloneNode(true));
      } else if (tag === 'ol' || tag === 'ul') {
        article.appendChild(child.cloneNode(true));
      } else if (tag === 'section' && child.textContent.trim() === '') {
        article.appendChild(document.createElement('hr'));
      } else if (testId === 'tweetPhoto' || child.querySelector('[data-testid="tweetPhoto"]')) {
        const img = child.querySelector('img');
        if (img) {
          const newImg = document.createElement('img');
          newImg.src = window.ClipMD.getBestImageSrc(img);
          newImg.alt = img.alt || '';
          article.appendChild(newImg);
        }
      } else if (testId === 'videoPlayer' || child.querySelector('video') || child.querySelector('[data-testid="videoPlayer"]')) {
        const video = child.querySelector('video');
        if (video && video.poster) {
          const posterImg = document.createElement('img');
          posterImg.src = video.poster;
          posterImg.alt = 'video still';
          article.appendChild(posterImg);
        }
        const em = document.createElement('em');
        em.textContent = '[Video]';
        article.appendChild(em);
      } else if (child.textContent.trim().length > 0) {
        const p = document.createElement('p');
        p.appendChild(window.ClipMD.flattenInline(child));
        article.appendChild(p);
      }
      // Empty divs with no text → skip
    }

    return {
      title,
      author,
      date,
      type: 'twitter-article',
      url,
      meta: {},
      content: article
    };
  }
};
})();
