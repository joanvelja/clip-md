(function() {
// extractors/lesswrong.js — LessWrong + Alignment Forum extractor
// Uses LW's GraphQL API to get raw markdown with LaTeX intact,
// instead of scraping rendered HTML (which loses math via MathJax v3).

window.ClipMD = window.ClipMD || { extractors: {} };
window.ClipMD.extractors = window.ClipMD.extractors || {};

window.ClipMD.extractors.lesswrong = {
  canHandle() {
    const host = window.location.hostname;
    return host.includes('lesswrong.com') || host.includes('alignmentforum.org');
  },

  priority: 30,

  async extract() {
    const host = window.location.hostname;
    const type = host.includes('alignmentforum') ? 'alignment-forum' : 'lesswrong';

    const postIdMatch = window.location.pathname.match(/\/posts\/([^/]+)\//);
    if (!postIdMatch) return null;
    const postId = postIdMatch[1];

    // Fetch raw markdown via GraphQL API (same-origin, no CORS issues)
    const query = `{
      post(input: {selector: {_id: "${postId}"}}) {
        result {
          title
          contents { markdown }
          user { displayName }
          baseScore
          postedAt
        }
      }
    }`;

    let post;
    try {
      const resp = await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      if (!resp.ok) throw new Error('GraphQL request failed: ' + resp.status);
      const data = await resp.json();
      post = data?.data?.post?.result;
    } catch (err) {
      console.error('[clip.md] LW API fetch failed, falling back to DOM:', err);
      return this._extractFromDOM();
    }

    if (!post || !post.contents?.markdown) {
      console.warn('[clip.md] LW API returned no markdown, falling back to DOM');
      return this._extractFromDOM();
    }

    const markdown = post.contents.markdown;
    const date = post.postedAt ? post.postedAt.split('T')[0] : '';
    return {
      title: post.title || '',
      author: post.user?.displayName || '',
      date,
      type,
      url: window.ClipMD.getCanonicalUrl(),
      meta: { karma: post.baseScore || null },
      markdown // raw markdown — content.js skips Turndown when this is present
    };
  },

  // Fallback: DOM-based extraction (for when API fails)
  _extractFromDOM() {
    const postContent = document.querySelector('.PostsPage-postContent, [class*="postContent"]');
    if (!postContent) return null;

    const titleEl = document.querySelector('h1[class*="PostsPageTitle"], .PostsPageTitle-root');
    let title = titleEl?.textContent?.trim() || '';
    if (!title) {
      title = document.title.replace(/\s*[—–-]\s*(LessWrong|Alignment Forum)\s*$/, '').trim();
    }

    const authorEl = document.querySelector('a[class*="UsersName"]');
    const author = authorEl?.textContent?.trim() || '';

    const timeEl = document.querySelector('time[datetime]');
    const date = timeEl?.getAttribute('datetime')?.split('T')[0] || '';

    const karmaEl = document.querySelector('[class*="voteScore"], [class*="PostsPageTopHeaderVote"]');
    const karma = parseInt(karmaEl?.textContent?.trim()) || null;

    const content = postContent.cloneNode(true);
    // Remove comments, style tags (MathJax CSS), and script tags
    content.querySelectorAll('[class*="CommentBody"], [class*="CommentsSection"], style, script').forEach(el => el.remove());

    const host = window.location.hostname;

    return {
      title,
      author,
      date,
      type: host.includes('alignmentforum') ? 'alignment-forum' : 'lesswrong',
      url: window.ClipMD.getCanonicalUrl(),
      meta: { karma },
      content
    };
  }
};
})();
