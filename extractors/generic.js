(function() {
// extractors/generic.js — Readability, for pages no site extractor claims.

const ClipMD = window.ClipMD;

ClipMD.extractors.generic = {
  id: 'generic',
  matches: () => true,

  async extract() {
    const warnings = [];
    const doc = document.cloneNode(true);
    // Before Readability: it strips the classes/scripts that identify math markup.
    const math = ClipMD.createMathStash();
    math.protect(doc, warnings);

    const article = new Readability(doc).parse();
    if (!article || article.textContent.trim().length < 200) {
      throw new Error('Readability found no article content on this page');
    }
    const container = document.createElement('div');
    container.innerHTML = article.content;

    return {
      meta: {
        title: article.title || document.title,
        url: ClipMD.getCanonicalUrl(),
        author: article.byline || undefined,
        date: publishedDate(),
        type: 'article',
      },
      markdown: ClipMD.markdownFromProtected(container, math),
      warnings,
    };
  },
};

function publishedDate() {
  const candidates = [
    document.querySelector('meta[property="article:published_time"]')?.content,
    document.querySelector('time[datetime]')?.getAttribute('datetime'),
  ];
  for (const c of candidates) {
    if (c && !isNaN(new Date(c))) return ClipMD.isoDate(c);
  }
  return undefined;  // unknown — omitted from frontmatter rather than faked as today
}
})();
