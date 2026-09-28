(function() {
// extractors/twitter-article.js — X long-form Articles.
// Normalizes the div-based article DOM into semantic HTML for Turndown.

const ClipMD = window.ClipMD;

ClipMD.extractors.twitterArticle = {
  id: 'twitter-article',
  matches: () => !!document.querySelector('[data-testid="twitterArticleReadView"]'),

  async extract() {
    const title = document.querySelector('[data-testid="twitter-article-title"]')?.textContent.trim();
    if (!title) throw new Error('article view has no title element');

    const userName = document.querySelector('[data-testid="User-Name"]')?.textContent || '';
    const handle = /@(\w+)/.exec(userName)?.[1];
    const timeEl = document.querySelector('article time[datetime]');

    const longform = document.querySelector('[data-testid="longformRichTextComponent"]');
    if (!longform) throw new Error('article view has no longformRichTextComponent');
    // Walk down to the container with many children (X nests wrapper divs).
    let contentDiv = longform.querySelector(':scope > div');
    while (contentDiv && contentDiv.children.length === 1 && contentDiv.firstElementChild.tagName === 'DIV') {
      contentDiv = contentDiv.firstElementChild;
    }
    if (!contentDiv || contentDiv.children.length === 0) throw new Error('article body container is empty');

    const article = document.createElement('article');
    for (const child of contentDiv.children) {
      const tag = child.tagName.toLowerCase();
      const testId = child.getAttribute('data-testid') || '';
      const innerHeading = child.querySelector('h2, h3');
      if (tag === 'h2' || tag === 'h3' || tag === 'ol' || tag === 'ul') {
        article.appendChild(child.cloneNode(true));
      } else if (innerHeading) {
        article.appendChild(innerHeading.cloneNode(true));
      } else if (tag === 'section' && child.textContent.trim() === '') {
        article.appendChild(document.createElement('hr'));
      } else if (testId === 'tweetPhoto' || child.querySelector('[data-testid="tweetPhoto"]')) {
        const img = child.querySelector('img');
        if (img) {
          const newImg = document.createElement('img');
          newImg.src = ClipMD.getBestImageSrc(img);
          newImg.alt = img.alt || '';
          article.appendChild(newImg);
        }
      } else if (testId === 'videoPlayer' || child.querySelector('video, [data-testid="videoPlayer"]')) {
        const video = child.querySelector('video');
        if (video?.poster) {
          const poster = document.createElement('img');
          poster.src = video.poster;
          poster.alt = 'video still';
          article.appendChild(poster);
        }
        const em = document.createElement('em');
        em.textContent = '[Video]';
        article.appendChild(em);
      } else if (child.textContent.trim()) {
        const p = document.createElement('p');
        // X renders paragraph text pre-wrap: raw "\n" would collapse to spaces.
        p.appendChild(ClipMD.newlinesToBr(ClipMD.flattenInline(child)));
        article.appendChild(p);
      }
    }

    const warnings = [];
    return {
      meta: {
        title,
        url: ClipMD.getCanonicalUrl(),
        author: handle ? '@' + handle : undefined,
        date: timeEl ? ClipMD.isoDate(timeEl.getAttribute('datetime')) : undefined,
        type: 'twitter-article',
      },
      markdown: ClipMD.htmlToMarkdown(article, warnings),
      warnings,
    };
  },
};
})();
