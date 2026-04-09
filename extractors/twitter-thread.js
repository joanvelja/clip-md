(function() {
// extractors/twitter-thread.js — X/Twitter thread extractor
// Scrolls the virtualized timeline, capturing tweets incrementally into a
// de-duped Map keyed by status ID, then assembles semantic HTML for Turndown.

window.ClipMD = window.ClipMD || { extractors: {} };
window.ClipMD.extractors = window.ClipMD.extractors || {};

const MAX_SCROLL_ITERATIONS = 30;
const SCROLL_WAIT_MS = 2000;
const TIME_GAP_SEPARATOR_MS = 3 * 60 * 60 * 1000; // 3 hours

window.ClipMD.extractors.twitterThread = {
  canHandle() {
    const isStatusUrl = /^https?:\/\/(x\.com|twitter\.com)\/[^/]+\/status\//.test(
      window.location.href
    );
    const hasArticleView = !!document.querySelector('[data-testid="twitterArticleReadView"]');
    const hasTweetText = !!document.querySelector('[data-testid="tweetText"]');
    return isStatusUrl && !hasArticleView && hasTweetText;
  },

  priority: 40,

  async extract() {
    // --- Phase 1: Setup ---

    const mainTweet = document.querySelector('article[data-testid="tweet"]');
    if (!mainTweet) return null;

    const userNameEl = mainTweet.querySelector('[data-testid="User-Name"]');
    const authorText = userNameEl?.textContent || '';
    const handleMatch = authorText.match(/@(\w+)/);
    const threadAuthor = handleMatch ? handleMatch[1] : '';
    if (!threadAuthor) return null;

    const savedScrollY = window.scrollY;

    // --- Phase 2: Incremental capture with de-dupe ---

    const tweetMap = new Map(); // statusId → tweet data

    function extractStatusId(article) {
      // Find permalink matching the tweet author's handle to avoid retweet links.
      // Fall back to any /status/ link with a numeric ID.
      const links = article.querySelectorAll('a[href*="/status/"]');
      let bestId = null;

      const nameEl = article.querySelector('[data-testid="User-Name"]');
      const nameText = nameEl?.textContent || '';
      const tweetHandleMatch = nameText.match(/@(\w+)/);
      const tweetHandle = tweetHandleMatch ? tweetHandleMatch[1].toLowerCase() : '';

      for (const link of links) {
        const match = link.href.match(/\/([^/]+)\/status\/(\d+)/);
        if (!match) continue;
        const linkHandle = match[1].toLowerCase();
        const linkId = match[2];
        // Prefer link matching this tweet's author
        if (linkHandle === tweetHandle) return linkId;
        if (!bestId) bestId = linkId;
      }
      return bestId;
    }

    function harvestVisibleTweets() {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      let newCount = 0;

      for (const article of articles) {
        // Skip tweets in "Discover more" / recommendation sections
        const cell = article.closest('[data-testid="cellInnerDiv"]');
        if (cell) {
          let prev = cell.previousElementSibling;
          let hitBoundary = false;
          while (prev) {
            const text = prev.textContent;
            if (text.includes('Discover more') || text.includes('More Tweets') ||
                text.includes('Sourced from')) {
              hitBoundary = true;
              break;
            }
            // Also stop if we hit another tweet (we're scanning backwards)
            if (prev.querySelector('article[data-testid="tweet"]')) break;
            prev = prev.previousElementSibling;
          }
          if (hitBoundary) continue;
        }

        const statusId = extractStatusId(article);
        if (!statusId || tweetMap.has(statusId)) continue;

        const textEl = article.querySelector('[data-testid="tweetText"]');
        const timeEl = article.querySelector('time');
        const nameEl = article.querySelector('[data-testid="User-Name"]');
        const nameText = nameEl?.textContent || '';
        const tweetHandleMatch = nameText.match(/@(\w+)/);
        const tweetAuthor = tweetHandleMatch ? tweetHandleMatch[1] : '';

        // Images
        const photos = article.querySelectorAll('[data-testid="tweetPhoto"] img');
        const images = Array.from(photos).map((img) => window.ClipMD.getBestImageSrc(img));

        // Card links (external URL previews rendered outside tweetText)
        const cardEl = article.querySelector('[data-testid="card.wrapper"]');
        let cardLink = null;
        if (cardEl) {
          const cardAnchor = cardEl.querySelector('a[href]');
          const cardTitle = cardEl.querySelector('[data-testid="card.layoutLarge.detail"] span, [data-testid="card.layoutSmall.detail"] span');
          if (cardAnchor) {
            cardLink = {
              href: cardAnchor.href,
              title: cardTitle?.textContent?.trim() || cardAnchor.textContent?.trim() || '',
            };
          }
        }

        // Quote tweet
        const quoteEl = article.querySelector('[data-testid="quoteTweet"]');
        let quoteData = null;
        if (quoteEl) {
          const quoteText = quoteEl.querySelector('[data-testid="tweetText"]');
          const quoteName = quoteEl.querySelector('[data-testid="User-Name"]');
          const quoteTime = quoteEl.querySelector('time');
          quoteData = {
            author: quoteName?.textContent?.match(/@(\w+)/)?.[1] || '',
            text: quoteText?.textContent || '',
            time: quoteTime?.getAttribute('datetime') || '',
          };
        }

        tweetMap.set(statusId, {
          author: tweetAuthor,
          text: textEl?.innerHTML || '',
          time: timeEl?.getAttribute('datetime') || '',
          images,
          cardLink,
          quoteData,
        });
        newCount++;
      }
      return newCount;
    }

    // Initial harvest before scrolling
    harvestVisibleTweets();

    // Scroll loop with MutationObserver for efficient wait
    let consecutiveEmptyScrolls = 0;

    for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
      const sizeBefore = tweetMap.size;

      window.scrollBy(0, window.innerHeight);

      // Wait for DOM mutations (new tweets rendered) or timeout
      await new Promise((resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          observer.disconnect();
          resolve();
        };
        const observer = new MutationObserver(done);
        const section = document.querySelector('section[role="region"]');
        if (section) {
          observer.observe(section, { childList: true, subtree: true });
        }
        setTimeout(done, SCROLL_WAIT_MS);
      });

      harvestVisibleTweets();

      if (tweetMap.size === sizeBefore) {
        consecutiveEmptyScrolls++;
        if (consecutiveEmptyScrolls >= 2) break;
      } else {
        consecutiveEmptyScrolls = 0;
      }
    }

    // Restore scroll position
    window.scrollTo(0, savedScrollY);

    // --- Phase 3: Filter and assemble ---

    const threadAuthorLower = threadAuthor.toLowerCase();
    const threadTweets = Array.from(tweetMap.entries())
      .filter(([_, data]) => data.author.toLowerCase() === threadAuthorLower)
      .sort((a, b) => new Date(a[1].time) - new Date(b[1].time));

    if (threadTweets.length === 0) return null;

    // Build semantic HTML for Turndown
    const article = document.createElement('article');

    // Header
    const header = document.createElement('p');
    const firstTime = threadTweets[0][1].time;
    const dateStr = firstTime
      ? new Date(firstTime).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '';
    header.innerHTML =
      '<strong>Thread by @' + threadAuthor + '</strong>' + (dateStr ? ' \u00b7 ' + dateStr : '');
    article.appendChild(header);
    article.appendChild(document.createElement('hr'));

    let prevTime = null;
    for (const [statusId, tweet] of threadTweets) {
      // Time-gap separator (>3h between consecutive tweets)
      if (prevTime && tweet.time) {
        const gap = new Date(tweet.time) - new Date(prevTime);
        if (gap > TIME_GAP_SEPARATOR_MS) {
          article.appendChild(document.createElement('hr'));
        }
      }

      const p = document.createElement('p');
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = tweet.text;
      p.appendChild(window.ClipMD.flattenInline(tempDiv));
      article.appendChild(p);

      // Images
      for (const imgSrc of tweet.images) {
        const img = document.createElement('img');
        img.src = imgSrc;
        img.alt = '';
        article.appendChild(img);
      }

      // Card link (external URL preview)
      if (tweet.cardLink) {
        const linkP = document.createElement('p');
        const a = document.createElement('a');
        a.href = tweet.cardLink.href;
        a.textContent = tweet.cardLink.title || tweet.cardLink.href;
        linkP.appendChild(a);
        article.appendChild(linkP);
      }

      // Quote tweet as blockquote
      if (tweet.quoteData) {
        const bq = document.createElement('blockquote');
        const qHeader = document.createElement('p');
        qHeader.innerHTML = '<strong>@' + tweet.quoteData.author + '</strong>';
        bq.appendChild(qHeader);
        const qText = document.createElement('p');
        qText.textContent = tweet.quoteData.text;
        bq.appendChild(qText);
        article.appendChild(bq);
      }

      prevTime = tweet.time;
    }

    return {
      title: 'Thread by @' + threadAuthor,
      author: '@' + threadAuthor,
      date: threadTweets[0][1].time?.split('T')[0] || window.ClipMD.todayISO(),
      type: 'twitter-thread',
      url: window.ClipMD.getCanonicalUrl(),
      meta: { tweet_count: threadTweets.length },
      content: article,
    };
  },
};
})();
