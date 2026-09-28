(function() {
// extractors/substack.js — Substack posts (incl. custom domains) via the publication's
// post API, which returns the source HTML regardless of how the page rendered.

const ClipMD = window.ClipMD;
const POST_PATH = /^\/p\/([^/?#]+)/;

function isSubstack() {
  return location.hostname.endsWith('.substack.com') ||
    !!document.querySelector('link[href*="substackcdn.com"], script[src*="substackcdn.com"]');
}

ClipMD.extractors.substack = {
  id: 'substack',
  matches: () => POST_PATH.test(location.pathname) && isSubstack(),

  async extract() {
    const slug = POST_PATH.exec(location.pathname)[1];
    const resp = await fetch(`/api/v1/posts/${slug}`);
    if (!resp.ok) throw new Error(`post API HTTP ${resp.status} for ${slug}`);
    const post = await resp.json();
    if (post.body_html == null) {
      throw new Error(`no body in API response (audience: ${post.audience}) — paywalled for this account?`);
    }
    const warnings = [];
    // Inert document: parsing here fetches no images and runs nothing.
    const body = new DOMParser().parseFromString(post.body_html, 'text/html').body;
    // Non-subscribers get a truncated preview in body_html. Full bodies measured 0.97–1.26×
    // the API's wordcount; a paywall preview was ~0.2×.
    const words = body.textContent.split(/\s+/).filter(Boolean).length;
    if (post.audience !== 'everyone' && post.wordcount > 0 && words < 0.5 * post.wordcount) {
      throw new Error(`API returned a paywall preview (${words} of ~${post.wordcount} words, audience: ${post.audience})`);
    }

    return {
      meta: {
        title: post.title,
        url: post.canonical_url || ClipMD.getCanonicalUrl(),
        author: (post.publishedBylines || []).map((b) => b.name).join(', ') || undefined,
        date: post.post_date ? ClipMD.isoDate(post.post_date) : undefined,
        type: 'substack',
        subtitle: post.subtitle || undefined,
        audience: post.audience,
      },
      markdown: ClipMD.htmlToMarkdown(body, warnings),
      warnings,
    };
  },
};
})();
