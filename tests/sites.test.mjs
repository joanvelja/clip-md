// Site extractors backed by source APIs: LessWrong (post + comment tree), Substack, X threads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fetchStub, splitClip } from './harness.mjs';

// Parse nested <comment …> tags back into a tree: [{ attrs, children }].
function commentTree(body) {
  const root = { children: [] };
  const stack = [root];
  for (const m of body.matchAll(/<comment(\s[^>]*?)?(\/?)>|<\/comment>/g)) {
    if (m[0] === '</comment>') { stack.pop(); continue; }
    const attrs = Object.fromEntries([...(m[1] || '').matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const node = { attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!m[2]) stack.push(node);
  }
  assert.equal(stack.length, 1, 'unbalanced <comment> tags');
  return root.children;
}

// --- LessWrong ---

const LW_POST = {
  title: 'A post', postedAt: '2026-09-21T10:00:00.000Z', baseScore: 294, commentCount: 6,
  user: { displayName: 'Toby_Ord' }, contents: { markdown: 'Body with $x_i^2$ and **bold**.' },
};
const c = (id, parent, score, extra = {}) => ({
  _id: id, parentCommentId: parent, deleted: false, baseScore: score, postedAt: '2026-09-22T00:00:00.000Z',
  user: { displayName: 'u' + id }, contents: { markdown: `comment ${id} text` }, ...extra,
});
const LW_COMMENTS = [
  c('a', null, 5), c('b', null, 50),
  c('a1', 'a', 1), c('a2', 'a', 9), c('a2x', 'a2', 3), c('a2xy', 'a2x', 2),
  { _id: 'd', parentCommentId: 'b', deleted: true, baseScore: 0, postedAt: null, user: null, contents: null },
  c('d1', 'd', 4),
  c('orph', 'gone', 7),
];

function lwStub(comments = LW_COMMENTS, post = LW_POST) {
  return fetchStub([['/graphql', (_url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes('comments(')) return { body: { data: { comments: { results: comments } } } };
    assert.equal(variables.id, 'abc123XYZ');
    return { body: { data: { post: { result: post } } } };
  }]]);
}

test('LW: post markdown verbatim + full nested comment tree ordered by karma', async () => {
  const w = loadPage({ url: 'https://www.lesswrong.com/posts/abc123XYZ/a-post', fetch: lwStub() });
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assert.equal(frontmatter.type, 'lesswrong');
  assert.equal(frontmatter.karma, 294);
  assert.equal(frontmatter.comments, 8);  // live (non-deleted) comments
  assert.ok(body.startsWith('Body with $x_i^2$ and **bold**.'), body);

  const tree = commentTree(body);
  const ids = (nodes) => nodes.map((n) => n.attrs.id);
  assert.deepEqual(ids(tree), ['b', 'orph', 'a']);  // top level by karma, orphan attached at top
  const [b, orph, a] = tree;
  assert.deepEqual(ids(a.children), ['a2', 'a1']);
  assert.deepEqual(ids(a.children[0].children), ['a2x']);
  assert.deepEqual(ids(a.children[0].children[0].children), ['a2xy']);  // depth 3 preserved
  assert.equal(b.children[0].attrs.deleted, 'true');                  // deleted placeholder keeps its reply
  assert.deepEqual(ids(b.children[0].children), ['d1']);
  assert.equal(orph.attrs.orphan_of, 'gone');
  for (const id of ['a', 'a1', 'a2', 'a2x', 'a2xy', 'b', 'd1', 'orph']) assert.ok(body.includes(`comment ${id} text`));
  // 8 live returned vs commentCount 6 → no shortfall warning
  assert.deepEqual(frontmatter.clip_warnings, undefined);
});

test('LW: fewer comments than commentCount is a warning; path without slug matches', async () => {
  const w = loadPage({ url: 'https://www.alignmentforum.org/posts/abc123XYZ', fetch: lwStub([c('a', null, 1)], { ...LW_POST, commentCount: 3 }) });
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter } = splitClip(res.markdown);
  assert.equal(frontmatter.type, 'alignment-forum');
  assert.deepEqual(frontmatter.clip_warnings, ['1 of 3 comments returned by the API']);
});

test('LW: sequence URLs (/s/<seq>/p/<id>) are post pages', async () => {
  const w = loadPage({ url: 'https://www.lesswrong.com/s/seqABC/p/abc123XYZ', fetch: lwStub() });
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  assert.equal(splitClip(res.markdown).frontmatter.type, 'lesswrong');
});

test('LW: GraphQL errors fail the clip', async () => {
  const stub = fetchStub([['/graphql', () => ({ body: { errors: [{ message: 'bad selector' }] } })]]);
  const w = loadPage({ url: 'https://www.lesswrong.com/posts/abc123XYZ/x', fetch: stub });
  const res = await w.ClipMD.clip('full');
  assert.equal(res.ok, false);
  assert.match(res.error, /\[lesswrong\] GraphQL: bad selector/);
});

// --- Substack ---

const SUBSTACK_HTML = '<!doctype html><html><head><link rel="stylesheet" href="https://substackcdn.com/x.css"></head><body></body></html>';

test('Substack (custom domain): API body → markdown with metadata', async () => {
  const stub = fetchStub([['/api/v1/posts/mistakes', () => ({ body: {
    title: 'Mistakes', subtitle: 'A list', post_date: '2020-09-29T20:04:06.540Z', audience: 'everyone',
    canonical_url: 'https://www.astralcodexten.com/p/mistakes', publishedBylines: [{ name: 'Scott Alexander' }],
    body_html: '<h2>Heading</h2><p>Text with <a href="https://x.org">link</a>.</p><ul><li>one</li></ul>',
  } })]]);
  const w = loadPage({ html: SUBSTACK_HTML, url: 'https://www.astralcodexten.com/p/mistakes?utm=1', fetch: stub });
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assert.equal(frontmatter.type, 'substack');
  assert.equal(frontmatter.author, 'Scott Alexander');
  assert.equal(frontmatter.url, 'https://www.astralcodexten.com/p/mistakes');
  assert.equal(frontmatter.subtitle, 'A list');
  assert.match(body, /^## Heading$/m);
  assert.match(body, /\[link\]\(https:\/\/x\.org\)/);
});

test('Substack: LaTeX blocks (empty divs carrying persistentExpression) become display math', async () => {
  const tex = String.raw`u(x) = \int_0^\infty \big(x_{nt}^*\big) \, dx`;
  const attrs = JSON.stringify({ persistentExpression: tex, id: 'ABCDEF' }).replace(/'/g, '&#39;');
  const stub = fetchStub([['/api/v1/posts/gdp', () => ({ body: {
    title: 'GDP', post_date: '2026-01-01T00:00:00Z', audience: 'everyone', wordcount: 4,
    body_html: `<p>Before text.</p><div class="latex-rendered" data-attrs='${attrs}' data-component-name="LatexBlockToDOM"></div><p>After text.</p>`,
  } })]]);
  const w = loadPage({ html: SUBSTACK_HTML, url: 'https://epochai.substack.com/p/gdp', fetch: stub });
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assert.match(body, new RegExp('^\\$\\$' + tex.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '\\$\\$$', 'm'));
  assert.equal(frontmatter.clip_warnings, undefined);
});

test('Substack: a paid post returned as a preview is an error, a full paid body is not', async () => {
  const words = (n) => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
  const mk = (n) => fetchStub([['/api/v1/posts/', () => ({ body: {
    title: 'Paid', audience: 'only_paid', wordcount: 1000, post_date: '2026-01-01T00:00:00Z', body_html: `<p>${words(n)}</p>`,
  } })]]);
  let w = loadPage({ html: SUBSTACK_HTML, url: 'https://foo.substack.com/p/paid', fetch: mk(200) });
  let res = await w.ClipMD.clip('full');
  assert.equal(res.ok, false);
  assert.match(res.error, /paywall preview \(200 of ~1000 words/);
  w = loadPage({ html: SUBSTACK_HTML, url: 'https://foo.substack.com/p/paid', fetch: mk(1000) });
  res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
});

test('Substack: paywalled body is an explicit error', async () => {
  const stub = fetchStub([['/api/v1/posts/', () => ({ body: { title: 'Paid', audience: 'only_paid', body_html: null } })]]);
  const w = loadPage({ html: SUBSTACK_HTML, url: 'https://foo.substack.com/p/paid', fetch: stub });
  const res = await w.ClipMD.clip('full');
  assert.equal(res.ok, false);
  assert.match(res.error, /\[substack\] no body in API response \(audience: only_paid\)/);
});

// --- X threads ---

const X_HTML = '<!doctype html><html><head><script src="https://abs.twimg.com/responsive-web/client-web/main.abc123.js"></script></head><body></body></html>';
const BUNDLE = 'x={a:1};const t="AAAAAAAAAAAAAAAAAAAAAFAKEBEARER%3Dxyz";' +
  'e.exports={queryId:"QID123",operationName:"TweetDetail",operationType:"query",metadata:{featureSwitches:["f_one","f_two"],fieldToggles:["t_one"]}}';

const user = (h) => ({ result: { __typename: 'User', core: { screen_name: h } } });
function tweet(id, handle, text, { replyTo = null, minute = 0, extra = {}, legacy = {} } = {}) {
  return {
    __typename: 'Tweet', rest_id: id, core: { user_results: user(handle) },
    legacy: {
      id_str: id, full_text: text, display_text_range: [0, Array.from(text).length],  // code points, like TweetDetail
      created_at: new Date(Date.UTC(2025, 1, 15, 18, minute)).toUTCString(),
      in_reply_to_status_id_str: replyTo, entities: { urls: [] }, ...legacy,
    },
    ...extra,
  };
}
const page = (...tweets) => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{
  type: 'TimelineAddEntries',
  entries: tweets.map((t) => ({ entryId: 'tweet-' + t.rest_id, content: { itemContent: { tweet_results: { result: t } } } })),
}] } } });

function xStub(pagesByFocal) {
  return fetchStub([
    ['main.abc123.js', () => ({ body: BUNDLE })],
    [/\/i\/api\/graphql\/QID123\/TweetDetail/, (url, opts) => {
      assert.equal(opts.headers['x-csrf-token'], 'csrf1');
      assert.equal(opts.headers.authorization, 'Bearer AAAAAAAAAAAAAAAAAAAAAFAKEBEARER=xyz');
      const u = new URL(url, 'https://x.com');
      assert.deepEqual(JSON.parse(u.searchParams.get('features')), { f_one: true, f_two: true });
      const focal = JSON.parse(u.searchParams.get('variables')).focalTweetId;
      if (!pagesByFocal[focal]) throw new Error('unexpected focal ' + focal);
      return { body: pagesByFocal[focal] };
    }],
  ]);
}

function xPage(url, stub) {
  const w = loadPage({ html: X_HTML, url, fetch: stub });
  w.document.cookie = 'ct0=csrf1';
  return w;
}

test('X thread: context above, author prefix + continuation across refocused pages, verbatim text', async () => {
  const other = tweet('100', 'someone', 'Original question?', { minute: 0 });
  const t1 = tweet('201', 'Author', '🧵1/4 Start &amp; intro\nsecond line', { replyTo: '100', minute: 1 });
  const t2 = tweet('202', 'Author', '2/4 focal https://t.co/abc', { replyTo: '201', minute: 2,
    legacy: { entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.org/paper' }] } } });
  const reply = tweet('300', 'rando', 'nice thread', { replyTo: '202', minute: 3 });
  const t3 = tweet('203', 'Author', '3/4 more', { replyTo: '202', minute: 4 });
  const t4 = tweet('204', 'Author', 'long form is ignored in favour of the note', { replyTo: '203', minute: 5,
    extra: { note_tweet: { note_tweet_results: { result: { text: '4/4 the full long-form text', entity_set: { urls: [] } } } } } });
  const stub = xStub({
    202: page(other, t1, t2, reply, t3),   // first page ends at 3/4
    203: page(t2, t3, t4),                 // refocus on the tail finds 4/4
    204: page(t3, t4),                     // refocus on 4/4: nothing further
  });
  const w = xPage('https://x.com/Author/status/202', stub);
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assert.equal(frontmatter.type, 'twitter-thread');
  assert.equal(frontmatter.tweet_count, 4);
  assert.equal(frontmatter.context_tweets, 1);
  assert.equal(frontmatter.url, 'https://x.com/Author/status/201');

  const ctx = /<context>([\s\S]*?)<\/context>/.exec(body)?.[1] || '';
  assert.ok(ctx.includes('Original question?'));
  const after = body.slice(body.indexOf('</context>'));
  const order = ['🧵1/4 Start & intro\nsecond line', '2/4 focal https://example.org/paper', '3/4 more', '4/4 the full long-form text'];
  let pos = 0;
  for (const s of order) {
    const i = after.indexOf(s, pos);
    assert.ok(i >= pos, `missing or out of order: ${JSON.stringify(s)}\n${after}`);
    pos = i;
  }
  assert.ok(!body.includes('nice thread'), 'replies by others must not be in the thread');
  assert.ok(!body.includes('long form is ignored'));
});

test('X thread: media, quote tweets and reply-mention trimming', async () => {
  const quoted = tweet('50', 'quoted_person', 'the quoted claim');
  const focal = tweet('400', 'Author', '@someone look ![img] https://t.co/media', { legacy: {
    display_text_range: [9, 14],
    extended_entities: { media: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/P1.jpg', ext_alt_text: 'a chart' },
      { type: 'video', media_url_https: 'https://pbs.twimg.com/thumb.jpg', video_info: { variants: [
        { content_type: 'application/x-mpegURL', url: 'https://v/x.m3u8' },
        { content_type: 'video/mp4', bitrate: 256000, url: 'https://v/low.mp4' },
        { content_type: 'video/mp4', bitrate: 2176000, url: 'https://v/high.mp4' },
      ] } },
    ] },
  }, extra: { quoted_status_result: { result: quoted } } });
  const w = xPage('https://x.com/Author/status/400', xStub({ 400: page(focal) }));
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { body } = splitClip(res.markdown);
  assert.ok(body.includes('look'), body);
  assert.ok(!body.includes('@someone'), 'leading reply mention should be trimmed');
  assert.ok(body.includes('![a chart](https://pbs.twimg.com/media/P1.jpg?name=large)'), body);
  assert.match(body, /<video url="https:\/\/v\/high\.mp4" poster="https:\/\/pbs\.twimg\.com\/thumb\.jpg" \/>/);
  assert.match(body, /<quote id="50" author="@quoted_person"[^>]*>\nthe quoted claim\n<\/quote>/);
});

test('X thread: missing login / bundle config / focal tweet fail loudly', async () => {
  let w = loadPage({ html: X_HTML, url: 'https://x.com/A/status/1', fetch: xStub({}) });  // no ct0 cookie
  let res = await w.ClipMD.clip('full');
  assert.match(res.error, /\[twitter-thread\] no ct0 cookie/);

  const noConfig = fetchStub([['main.abc123.js', () => ({ body: 'nothing here' })]]);
  w = xPage('https://x.com/A/status/1', noConfig);
  res = await w.ClipMD.clip('full');
  assert.match(res.error, /TweetDetail config not found/);

  w = xPage('https://x.com/A/status/1', xStub({ 1: page(tweet('2', 'A', 'other')) }));
  res = await w.ClipMD.clip('full');
  assert.match(res.error, /tweet 1 missing from API response/);
});

test('X article view is claimed by the article extractor, not the thread extractor', () => {
  const w = loadPage({ html: '<!doctype html><body><div data-testid="twitterArticleReadView"></div></body>', url: 'https://x.com/A/status/1' });
  assert.equal(w.ClipMD.extractors.twitterThread.matches(), false);
  assert.equal(w.ClipMD.extractors.twitterArticle.matches(), true);
});

test('X thread: display_text_range counts code points of the escaped text — emoji and &amp; before the media link', async () => {
  const text = '🔥🇺🇸 hot &amp; take 🧵1/17 https://t.co/media';
  const shown = '🔥🇺🇸 hot &amp; take 🧵1/17';
  const focal = tweet('500', 'Author', text, { legacy: { display_text_range: [0, Array.from(shown).length] } });
  const w = xPage('https://x.com/Author/status/500', xStub({ 500: page(focal) }));
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { body } = splitClip(res.markdown);
  assert.ok(body.includes('🔥🇺🇸 hot & take 🧵1/17\n</tweet>'), body);
  assert.ok(!/hot take h|t\.co/.test(body), 'no t.co fragment may leak: ' + body);
});

test('X thread: parent not returned → warning; unavailable context author → placeholder; broken unrelated reply ignored', async () => {
  const unavailable = { __typename: 'Tweet', rest_id: '610', core: { user_results: { result: { __typename: 'UserUnavailable' } } },
    legacy: { id_str: '610', full_text: 'x', created_at: 'garbage', in_reply_to_status_id_str: '600' } };
  const focal = tweet('611', 'Author', 'reply to a suspended account', { replyTo: '610', minute: 2 });
  const brokenReply = { __typename: 'Tweet', rest_id: '612', core: {}, legacy: { id_str: '612', created_at: 'nope', in_reply_to_status_id_str: '611' } };
  const w = xPage('https://x.com/Author/status/611', xStub({ 611: page(unavailable, focal, brokenReply) }));
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assert.equal(frontmatter.tweet_count, 1);
  assert.match(body, /<context>\n<tweet id="610" unavailable="true" \/>\n<\/context>/);
  assert.ok(frontmatter.clip_warnings.some((x) => /parent tweet 600 not returned/.test(x)), frontmatter.clip_warnings);
  assert.ok(frontmatter.clip_warnings.some((x) => /610: author unavailable/.test(x)), frontmatter.clip_warnings);
});

test('X thread: a display_text_range that cuts real text (wrong units) is flagged', async () => {
  const text = '🧵🧵 cut 1/17';
  const focal = tweet('700', 'Author', text, { legacy: { display_text_range: [0, Array.from(text).length - 2] } });  // drops "17"
  const w = xPage('https://x.com/Author/status/700', xStub({ 700: page(focal) }));
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter } = splitClip(res.markdown);
  assert.ok(frontmatter.clip_warnings?.some((x) => /700: display_text_range dropped unexpected text/.test(x)), frontmatter.clip_warnings);
});
