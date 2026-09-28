(function() {
// extractors/twitter-thread.js — X/Twitter threads via the web client's own GraphQL
// endpoint (TweetDetail). The timeline DOM is virtualized and loads lazily (a 17-tweet
// thread clipped as 1 or 8 tweets); the API returns the whole self-thread, long-form
// text, media and quotes. Query id, feature flags and the web client's bearer are read
// from X's own bundle at clip time, so nothing X rotates is hardcoded here.

const ClipMD = window.ClipMD;
const T = ClipMD.transcript;

const STATUS_PATH = /^\/([A-Za-z0-9_]+)\/status\/(\d+)/;
const MAX_FETCHES = 40;

async function clientConfig() {
  const src = [...document.querySelectorAll('script[src]')].map((s) => s.src)
    .find((s) => /\/main\.[\w]+\.js$/.test(s));
  if (!src) throw new Error('X client bundle (main.*.js) not found on the page');
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`X client bundle HTTP ${resp.status}`);
  const js = await resp.text();
  const bearer = /"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+)"/.exec(js)?.[1];
  const op = /queryId:"([^"]+)",operationName:"TweetDetail",operationType:"query",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]/.exec(js);
  if (!bearer || !op) throw new Error('TweetDetail config not found in X client bundle — X changed its bundle format');
  const flags = (list) => Object.fromEntries(list.split(',').filter(Boolean).map((s) => [s.replace(/"/g, ''), true]));
  return { bearer: decodeURIComponent(bearer), queryId: op[1], features: flags(op[2]), fieldToggles: flags(op[3]) };
}

async function tweetDetail(cfg, focalTweetId) {
  const csrf = /(?:^|; )ct0=([^;]+)/.exec(document.cookie)?.[1];
  if (!csrf) throw new Error('no ct0 cookie — not logged in to X?');
  const variables = {
    focalTweetId, with_rux_injections: false, rankingMode: 'Relevance', includePromotedContent: false,
    withCommunity: true, withQuickPromoteEligibilityTweetFields: false, withBirdwatchNotes: true, withVoice: true,
  };
  const qs = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(cfg.features),
    fieldToggles: JSON.stringify(cfg.fieldToggles),
  });
  const resp = await fetch(`/i/api/graphql/${cfg.queryId}/TweetDetail?${qs}`, {
    credentials: 'include',
    headers: {
      authorization: `Bearer ${cfg.bearer}`,
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
    },
  });
  if (!resp.ok) throw new Error(`TweetDetail HTTP ${resp.status}`);
  const body = await resp.json();
  if (!body.data) throw new Error('TweetDetail: ' + (body.errors || []).map((e) => e.message).join('; '));
  return body.data;
}

// --- normalization ---

const decodeEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function expandUrls(text, urls) {
  for (const u of urls || []) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  return text;
}

function tweetText(t, warnings) {
  const note = t.note_tweet?.note_tweet_results?.result;
  if (note?.text) return decodeEntities(expandUrls(note.text, note.entity_set?.urls));
  const L = t.legacy;
  // display_text_range drops leading reply @mentions and the trailing media link. On this
  // GraphQL endpoint it counts CODE POINTS of the entity-escaped text (live check: 22/22
  // discriminating tweets with emoji/&amp;/media; the syndication API counts differently).
  const cps = Array.from(L.full_text);
  const [start, end] = L.display_text_range || [0, cps.length];
  const shown = cps.slice(start, end).join('');
  // The unit of these offsets has been misread both ways before: what gets dropped must be
  // reply mentions (head) and media links (tail), or the slice is wrong — say so.
  const head = cps.slice(0, start).join(''), tail = cps.slice(end).join('');
  if (!/^(@\w+\s+)*$/.test(head) || !/^\s*(https:\/\/t\.co\/\w+\s*)*$/.test(tail)) {
    warnings.push(`tweet ${t.rest_id}: display_text_range dropped unexpected text — check its units`);
  }
  return decodeEntities(expandUrls(shown, L.entities?.urls)).trim();
}

function media(t) {
  return (t.legacy.extended_entities?.media || t.legacy.entities?.media || []).map((m) => {
    if (m.type === 'photo') return T.image(m.ext_alt_text, `${m.media_url_https}?name=large`);
    const mp4 = (m.video_info?.variants || [])
      .filter((v) => v.content_type === 'video/mp4')
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    return T.tag(m.type === 'animated_gif' ? 'gif' : 'video', { url: mp4?.url, poster: m.media_url_https });
  });
}

function card(t) {
  const c = t.card?.legacy;
  if (!c) return null;
  const v = Object.fromEntries((c.binding_values || []).map((b) => [b.key, b.value?.string_value]));
  const url = (t.legacy.entities?.urls || []).find((u) => u.url === (v.card_url || c.url))?.expanded_url || v.card_url || c.url;
  return T.tag('card', { url, title: v.title }, v.description);
}

function unwrap(result) {
  if (result?.__typename === 'TweetWithVisibilityResults') return result.tweet;
  return result?.__typename === 'Tweet' ? result : null;
}

const handleOf = (t) => {
  const user = t.core?.user_results?.result;
  return user?.core?.screen_name ?? user?.legacy?.screen_name;
};
const replyToOf = (t) => t.legacy.in_reply_to_status_id_str || null;

function isoTime(t) {
  const d = new Date(t.legacy.created_at);
  if (isNaN(d)) throw new Error(`tweet ${t.rest_id} has invalid created_at`);
  return d.toISOString();
}

// Every Tweet in the response, raw, keyed by id. Only tweets that end up in the clip are
// rendered (and validated) — an unrelated broken reply must not sink the thread.
function collect(data, into) {
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    const t = unwrap(o);
    if (t?.legacy && !into.has(t.rest_id)) into.set(t.rest_id, t);
    for (const v of Object.values(o)) walk(v);
  };
  walk(data);
  return into;
}

function renderTweet(t, warnings, tag = 'tweet') {
  const handle = handleOf(t);
  // Thread tweets always have one (they're matched by handle); context tweets from
  // suspended/unavailable accounts don't.
  if (!handle) {
    warnings.push(`tweet ${t.rest_id}: author unavailable, text omitted`);
    return T.tag(tag, { id: t.rest_id, unavailable: true });
  }
  const q = unwrap(t.quoted_status_result?.result);
  const quoteOk = q?.legacy && handleOf(q);
  if (t.quoted_status_result && !quoteOk) warnings.push(`tweet ${t.rest_id}: quoted tweet unavailable (deleted, protected or withheld)`);
  return T.tag(tag, {
    id: t.rest_id,
    author: '@' + handle,
    date: T.time(isoTime(t)),
    url: `https://x.com/${handle}/status/${t.rest_id}`,
  }, T.join([tweetText(t, warnings), ...media(t), card(t), quoteOk && renderTweet(q, warnings, 'quote')]));
}

// --- extractor ---

ClipMD.extractors.twitterThread = {
  id: 'twitter-thread',
  matches: () => /(^|\.)(x|twitter)\.com$/.test(location.hostname) &&
    STATUS_PATH.test(location.pathname) &&
    !document.querySelector('[data-testid="twitterArticleReadView"]'),

  async extract() {
    const focalId = STATUS_PATH.exec(location.pathname)[2];
    const warnings = [];
    const cfg = await clientConfig();
    const tweets = collect(await tweetDetail(cfg, focalId), new Map());
    let fetches = 1;
    const focal = tweets.get(focalId);
    if (!focal) throw new Error(`tweet ${focalId} missing from API response (deleted or protected?)`);
    const handle = handleOf(focal);
    if (!handle) throw new Error(`tweet ${focalId} has no author handle`);
    const isAuthor = (t) => handleOf(t)?.toLowerCase() === handle.toLowerCase();

    // Ancestors (root first). The unbroken run by the same author is the thread's start;
    // anything above it is the conversation the thread replies to.
    const ancestors = [];
    for (let id = replyToOf(focal); id && tweets.has(id); id = replyToOf(tweets.get(id))) ancestors.unshift(tweets.get(id));
    const missingParent = replyToOf(ancestors[0] ?? focal);
    if (missingParent) warnings.push(`parent tweet ${missingParent} not returned by the API — the conversation above is incomplete`);
    let split = ancestors.length;
    while (split > 0 && isAuthor(ancestors[split - 1])) split--;
    const context = ancestors.slice(0, split);
    const thread = [...ancestors.slice(split), focal];

    // Continuation: the author's own replies to the current tail. When the loaded page has
    // none, refocus on the tail once — long threads are paged per focal tweet.
    let refocusedOn = focalId;
    const inThread = new Set(thread.map((t) => t.rest_id));
    for (;;) {
      const tail = thread[thread.length - 1];
      const next = [...tweets.values()]
        .filter((t) => replyToOf(t) === tail.rest_id && isAuthor(t) && !inThread.has(t.rest_id))
        .sort((a, b) => Date.parse(a.legacy.created_at) - Date.parse(b.legacy.created_at))[0];
      if (next) { thread.push(next); inThread.add(next.rest_id); continue; }
      if (refocusedOn === tail.rest_id) break;
      if (fetches >= MAX_FETCHES) { warnings.push(`stopped after ${MAX_FETCHES} API pages — thread may continue`); break; }
      collect(await tweetDetail(cfg, tail.rest_id), tweets);
      fetches++;
      refocusedOn = tail.rest_id;
    }

    const sections = [];
    if (context.length) sections.push(T.tag('context', {}, T.join(context.map((t) => renderTweet(t, warnings)))));
    sections.push(...thread.map((t) => renderTweet(t, warnings)));

    return {
      meta: {
        title: `Thread by @${handle}`,
        url: `https://x.com/${handle}/status/${thread[0].rest_id}`,
        author: '@' + handle,
        date: ClipMD.isoDate(isoTime(thread[0])),
        type: 'twitter-thread',
        tweet_count: thread.length,
        context_tweets: context.length || undefined,
      },
      markdown: T.join(sections),
      warnings,
    };
  },
};
})();
