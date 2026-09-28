// tests/claude.test.mjs — claude.ai conversation extractor (API → transcript).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fetchStub, splitClip } from './harness.mjs';

const ROOT = '00000000-0000-4000-8000-000000000000';
const CONV_ID = '0f3c9a1e-5b7d-4c2a-9e8f-1a2b3c4d5e6f';
const ORIGIN = 'https://claude.ai';
const CHAT_URL = `${ORIGIN}/chat/${CONV_ID}`;

// --- synthetic API data, shaped like /chat_conversations/<id>?tree=True&rendering_mode=messages

let clock = Date.parse('2026-09-01T10:00:00Z');
const stamp = () => new Date((clock += 60_000)).toISOString().replace('Z', '123+00:00');

const text = (t, citations = []) => ({
  type: 'text', text: t, citations, citations_grouping_mode: 'default', start_timestamp: stamp(), stop_timestamp: stamp(),
});

function msg(uuid, parent, sender, content, extra = {}) {
  return {
    uuid, parent_message_uuid: parent, sender, content,
    text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    index: 0, created_at: stamp(), updated_at: stamp(), truncated: false,
    attachments: [], files: [], sync_sources: [], stop_reason: sender === 'assistant' ? 'end_turn' : undefined,
    ...extra,
  };
}

function conversation(chat_messages, leaf, extra = {}) {
  return {
    uuid: CONV_ID, name: 'Proof: "fixed point" #1 — ε-δ', summary: '', model: 'claude-opus-4-5',
    created_at: '2026-09-01T09:59:00.000000+00:00', updated_at: stamp(), settings: {},
    is_starred: false, is_archived: false, is_temporary: false, platform: 'CLAUDE_AI',
    current_leaf_message_uuid: leaf, chat_messages, ...extra,
  };
}

// h1 ─┬─ a1old (regenerated away)
//     └─ a1 ─┬─ h2old ── a2old (edited away)
//            └─ h2 ── a2 ── a3 (continuation; current leaf)
function branchyConversation() {
  const msgs = [
    msg('a3', 'a2', 'assistant', [text('ACTIVE continuation of the answer.')]),
    msg('h2old', 'a1', 'human', [text('ABANDONED edited-away question')]),
    msg('a1old', 'h1', 'assistant', [text('ABANDONED regenerated answer')]),
    msg('h1', ROOT, 'human', [text('ACTIVE first question')]),
    msg('a2', 'h2', 'assistant', [text('ACTIVE final answer')], { stop_reason: 'max_tokens' }),
    msg('a2old', 'h2old', 'assistant', [text('ABANDONED answer to edited-away question')]),
    msg('a1', 'h1', 'assistant', [text('ACTIVE regenerated answer')]),
    msg('h2', 'a1', 'human', [text('ACTIVE edited question')]),
  ];
  return conversation(msgs, 'a3');
}

// One human turn + one assistant turn with the given assistant blocks.
const exchange = (blocks, humanExtra = {}) => conversation([
  msg('h', ROOT, 'human', [text('question')], humanExtra),
  msg('a', 'h', 'assistant', blocks),
], 'a');

const page = loadPage({ url: CHAT_URL });
const render = (conv) => page.ClipMD.extractors.claude.render(conv, { url: CHAT_URL, origin: ORIGIN });

// --- reading the transcript back

const unescape = (s) => s.replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const parseAttrs = (s = '') => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, unescape(v)]));

// All <name …>body</name> and <name … /> occurrences (no same-name nesting in these fixtures).
function tags(markdown, name) {
  const re = new RegExp(`<${name}((?: [\\w]+="[^"]*")*)(?: />|>\\n([\\s\\S]*?)\\n</${name}>)`, 'g');
  return [...markdown.matchAll(re)].map(([, attrs, body]) => ({ attrs: parseAttrs(attrs), body: body ?? '' }));
}

function fencedJson(body) {
  const m = /^(`{3,})json\n([\s\S]*)\n\1$/.exec(body.trim());
  assert.ok(m, `expected a single fenced json block, got:\n${body}`);
  return JSON.parse(m[2]);
}

const headings = (md) => [...md.matchAll(/^## (Human|Assistant)\b/gm)].map((m) => m[1]);

// First markdown link in `line`, escapes undone: { label, url }.
function parseLink(line) {
  const m = /\[((?:\\.|[^\\\]])*)\]\((<[^>]*>|[^)\s]*)\)/.exec(line);
  assert.ok(m, `no markdown link in: ${line}`);
  return { label: m[1].replace(/\\(.)/g, '$1'), url: m[2].replace(/^<(.*)>$/, '$1') };
}

// --- tests

test('renders only the active branch, root → leaf, and counts omitted messages', () => {
  const conv = branchyConversation();
  const { meta, markdown, warnings } = render(conv);
  assert.equal(warnings.length, 0, JSON.stringify(warnings));

  assert.deepEqual(headings(markdown), ['Human', 'Assistant', 'Human', 'Assistant', 'Assistant']);
  const order = ['ACTIVE first question', 'ACTIVE regenerated answer', 'ACTIVE edited question',
    'ACTIVE final answer', 'ACTIVE continuation of the answer.'].map((s) => markdown.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `missing active text: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'active messages out of order');
  assert.ok(!markdown.includes('ABANDONED'), 'abandoned-branch text leaked into the transcript');

  assert.equal(meta.turns, 5);
  assert.equal(meta.messages_omitted, 3);
  assert.equal(meta.type, 'claude-conversation');
  assert.equal(meta.url, CHAT_URL);
  assert.equal(meta.date, '2026-09-01');
  assert.equal(tags(markdown, 'stop')[0]?.attrs.reason, 'max_tokens');
});

test('throws when the current leaf is not in the message list', () => {
  const conv = branchyConversation();
  conv.current_leaf_message_uuid = 'gone';
  assert.throws(() => render(conv), /gone/);
});

test('markdown and LaTeX pass through byte-identical', () => {
  const src = 'Let $\\alpha_i = x^*_{[0,1]}$ and **bold** with a_b_c & <tag> \\_ \\*.\n\n' +
    '```python\ndef f(x):\n    return x * 2  # <b>not html</b>\n```\n\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$';
  // The human message arrives split mid-token across two blocks; m.text is their concatenation.
  const human = msg('h', ROOT, 'human', [text(src.slice(0, 17)), text(src.slice(17))]);
  assert.equal(human.text, src);
  const conv = conversation([human, msg('a', 'h', 'assistant', [text(src)])], 'a');

  const { markdown } = render(conv);
  assert.equal(markdown.split(src).length - 1, 2, 'source should appear verbatim in both messages');
});

test('hidden thinking renders its summaries; visible thinking renders in full', () => {
  const thinking = (t, summaries, extra = {}) => ({
    type: 'thinking', thinking: t, summaries: summaries.map((summary) => ({ summary })),
    cut_off: false, truncated: false, hidden: false, thinking_hidden: !t, start_timestamp: stamp(), stop_timestamp: stamp(), ...extra,
  });
  const full = 'Step 1: suppose $f(x) = x$.\nStep 2: contradiction.';
  const { markdown } = render(exchange([
    thinking('', ['Weighing the fixed-point argument', 'Checking the boundary case']),
    thinking(full, ['a summary'], { cut_off: true }),
    thinking('', []),
    text('answer'),
  ]));

  const [hidden, visible, bare] = tags(markdown, 'thinking');
  assert.equal(hidden.attrs.hidden, 'true');
  assert.match(hidden.body, /Weighing the fixed-point argument/);
  assert.match(hidden.body, /Checking the boundary case/);
  assert.equal(visible.attrs.hidden, undefined);
  assert.equal(visible.attrs.cut_off, 'true');
  assert.ok(visible.body.includes(full));
  assert.equal(bare.attrs.hidden, 'true');
  assert.equal(bare.body, '');
});

test('tool_use input round-trips as JSON; tool_result items render with their sources and files', () => {
  const input = {
    query: 'fixed "point" theorems ```not a fence```',
    opts: { n: 3, list: [1, 'two', null, true], unicode: 'π ≈ 3.14 — ok', html: '<b>&amp;</b>' },
  };
  const { markdown } = render(exchange([
    { type: 'tool_use', id: 'toolu_01', name: 'web_search', input, message: 'Searching', integration_name: null, is_mcp_app: false },
    {
      type: 'tool_result', tool_use_id: 'toolu_01', name: 'web_search', is_error: true, message: null, meta: null,
      content: [
        { type: 'text', text: 'Partial failure: rate limited' },
        { type: 'knowledge', title: 'Brouwer FPT', url: 'https://ex.com/brouwer', text: 'Every continuous map has a fixed point.', metadata: { site_domain: 'ex.com' }, is_missing: false },
        { type: 'local_resource', file_path: '/mnt/user-data/outputs/proof.md', name: 'proof.md', mime_type: 'text/markdown', uuid: 'f1' },
      ],
    },
    { type: 'tool_result', tool_use_id: 'toolu_02', name: 'bash_tool', is_error: false, content: 'exit 0: plain string output' },
    { type: 'tool_result', tool_use_id: 'toolu_03', name: 'present_files', is_error: false },
    text('done'),
  ]));

  const [use] = tags(markdown, 'tool_use');
  assert.equal(use.attrs.name, 'web_search');
  assert.equal(use.attrs.id, 'toolu_01');
  assert.deepEqual(fencedJson(use.body), input);

  const [failed, ok, empty] = tags(markdown, 'tool_result');
  assert.equal(failed.attrs.tool_use_id, 'toolu_01');
  assert.equal(failed.attrs.error, 'true');
  assert.match(failed.body, /Partial failure: rate limited/);
  const [source] = tags(failed.body, 'source');
  assert.equal(source.attrs.url, 'https://ex.com/brouwer');
  assert.equal(source.body, 'Every continuous map has a fixed point.');
  assert.equal(tags(failed.body, 'file')[0]?.attrs.path, '/mnt/user-data/outputs/proof.md');

  assert.equal(ok.attrs.tool_use_id, 'toolu_02');
  assert.equal(ok.attrs.error, undefined);
  assert.match(ok.body, /exit 0: plain string output/);

  assert.equal(empty.attrs.tool_use_id, 'toolu_03');
  assert.equal(empty.body, '', 'a result without content has an empty body');
  assert.ok(!markdown.includes('undefined'));
});

test('attachment extracted_content appears in full; uploaded files link absolutely', () => {
  const lines = Array.from({ length: 12_000 }, (_, i) => `line ${i}: ${'αβγ'.repeat(i % 5)}`).join('\n');
  const content = ('BEGIN\n' + lines).slice(0, 100_000 - 4) + '\nEND';
  assert.equal(content.length, 100_000);
  const { markdown } = render(exchange([text('ok')], {
    attachments: [{ id: 'at1', file_name: 'notes.txt', file_size: 100_000, file_type: 'text/plain', extracted_content: content, created_at: stamp() }],
    files: [{ file_kind: 'image', file_uuid: 'img1', file_name: 'plot.png', preview_asset: { url: '/api/org/files/img1/preview' }, success: true }],
  }));

  const [att] = tags(markdown, 'attachment');
  assert.equal(att.attrs.name, 'notes.txt');
  assert.equal(att.body, content);
  const [file] = tags(markdown, 'file');
  assert.equal(file.attrs.name, 'plot.png');
  assert.equal(file.attrs.url, `${ORIGIN}/api/org/files/img1/preview`);
});

const cite = (url, title, [start, end], sources = [{ title, url }]) => ({
  uuid: `${url}#${start}`, title, url, metadata: { type: 'webpage_metadata', site_domain: new URL(url).hostname },
  origin_tool_name: 'web_search', sources, start_index: start, end_index: end,
});
const spanOf = (prose, s) => [prose.indexOf(s), prose.indexOf(s) + s.length];

test('citations list title, url and cited span, plus every other source; duplicates collapsed', () => {
  const [s1, s2] = ['Shannon founded information theory in 1948.', 'Turing defined computability.'];
  const prose = `${s1} ${s2}`;
  const SHANNON = 'https://en.wikipedia.org/wiki/Claude_Shannon';
  const TURING = 'https://plato.stanford.edu/entries/turing/';
  const SETS = 'https://en.wikipedia.org/wiki/Set_(mathematics)';
  const turingTitle = 'Alan Turing [SEP] entry] \\ part 2';
  const { markdown, warnings } = render(exchange([text(prose, [
    cite(SHANNON, 'Claude Shannon', spanOf(prose, s1)),
    cite(SHANNON, 'Claude Shannon', spanOf(prose, s1)),
    cite(TURING, turingTitle, spanOf(prose, s2), [{ title: turingTitle, url: TURING }, { title: 'Set (mathematics)', url: SETS }]),
  ])]));

  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.ok(markdown.includes(prose), 'cited prose must stay verbatim');
  const [list] = tags(markdown, 'citations');
  assert.ok(list, 'no <citations> block');
  const linesWith = (url) => list.body.split('\n').filter((l) => l.includes(url));

  assert.equal(linesWith(SHANNON).length, 1, 'duplicate citation listed twice');
  assert.deepEqual(parseLink(linesWith(SHANNON)[0]), { label: 'Claude Shannon', url: SHANNON });
  assert.ok(linesWith(SHANNON)[0].includes(s1));

  assert.deepEqual(parseLink(linesWith(TURING)[0]), { label: turingTitle, url: TURING });
  assert.ok(linesWith(TURING)[0].includes(s2));
  assert.deepEqual(parseLink(linesWith('Set_')[0]), { label: 'Set (mathematics)', url: SETS });
});

test('a citation span outside its text block is warned about, never quoted', () => {
  const prose = 'Short text.';
  const { markdown, warnings } = render(exchange([text(prose, [cite('https://ex.com/x', 'X', [3, 500])])]));
  const [line] = tags(markdown, 'citations')[0].body.split('\n').filter((l) => l.includes('https://ex.com/x'));
  assert.ok(line, 'citation dropped entirely');
  assert.ok(!line.includes('"'), `out-of-range span was quoted: ${line}`);
  assert.equal(warnings.filter((w) => /citation/.test(w)).length, 1, JSON.stringify(warnings));
});

test('non-empty sync_sources are kept as JSON and flagged by one warning', () => {
  const drive = [{ type: 'gdrive', uri: 'drive://doc/1', name: 'Spec' }];
  const repo = [{ type: 'github', repo: 'org/repo', ref: 'main' }];
  const conv = conversation([
    msg('h', ROOT, 'human', [text('q')], { sync_sources: drive }),
    msg('a', 'h', 'assistant', [text('a')]),
    msg('h2', 'a', 'human', [text('q2')], { sync_sources: repo }),
    msg('a2', 'h2', 'assistant', [text('a2')]),
  ], 'a2');
  const { markdown, warnings } = render(conv);
  assert.deepEqual(tags(markdown, 'sync_sources').map((t) => fencedJson(t.body)), [drive, repo]);
  const flagged = warnings.filter((w) => w.includes('sync_sources'));
  assert.equal(flagged.length, 1, JSON.stringify(warnings));
  assert.match(flagged[0], /\b2\b/);
});

test('unknown block and tool_result item types are kept as JSON and warned about once', () => {
  const budget = { type: 'token_budget', remaining: 12345, nested: { a: [1, 2] } };
  const mystery = { type: 'mystery_block', payload: 'x' };
  const oddItem = { type: 'image_ref', src: 'blob:1' };
  const { markdown, warnings } = render(exchange([
    budget, text('mid'), { ...budget, remaining: 99 }, mystery,
    { type: 'tool_result', tool_use_id: 't', name: 'x', is_error: false, content: [oddItem] },
  ]));

  const blocks = tags(markdown, 'block');
  assert.deepEqual(blocks.map((b) => fencedJson(b.body)), [budget, { ...budget, remaining: 99 }, mystery]);
  const blockWarnings = warnings.filter((w) => /token_budget|mystery_block/.test(w));
  assert.equal(blockWarnings.length, 1, `expected one deduped warning, got ${JSON.stringify(warnings)}`);
  assert.match(blockWarnings[0], /token_budget/);
  assert.match(blockWarnings[0], /mystery_block/);

  const [result] = tags(markdown, 'tool_result');
  assert.deepEqual(fencedJson(result.body), oddItem);
  assert.ok(warnings.some((w) => w.includes('image_ref')), `no warning for unknown item: ${JSON.stringify(warnings)}`);
});

test('server-truncated message and compaction summary are surfaced', () => {
  const conv = conversation([
    msg('h', ROOT, 'human', [text('q')]),
    msg('a', 'h', 'assistant', [text('partial')], {
      index: 7, truncated: true, stop_reason: 'compaction',
      compaction_summary: [{ type: 'text', text: 'Earlier we proved lemma 2.', citations: [], start_timestamp: stamp(), stop_timestamp: stamp() }],
    }),
  ], 'a');
  const { markdown, warnings } = render(conv);
  assert.match(tags(markdown, 'compaction_summary')[0]?.body ?? '', /Earlier we proved lemma 2\./);
  assert.equal(tags(markdown, 'stop')[0]?.attrs.reason, 'compaction');
  assert.ok(warnings.some((w) => /7/.test(w) && /truncated/.test(w)), JSON.stringify(warnings));
});

// --- fetch layer (through extract())

const ORGS = /\/api\/organizations$/;
const convRoute = (org) => new RegExp(`/api/organizations/${org}/chat_conversations/${CONV_ID}\\?.*tree=True`);

test('extract() falls through a 403 org to the one holding the conversation', async () => {
  const fetch = fetchStub([
    [ORGS, () => ({ body: [{ uuid: 'org-a' }, { uuid: 'org-b' }] })],
    [convRoute('org-a'), () => ({ status: 403, body: { error: 'forbidden' } })],
    [convRoute('org-b'), () => ({ body: branchyConversation() })],
  ]);
  const w = loadPage({ url: CHAT_URL, fetch });
  const clip = await w.ClipMD.extractors.claude.extract();
  assert.equal(clip.meta.turns, 5);
  assert.match(clip.markdown, /ACTIVE final answer/);
  assert.deepEqual(fetch.calls.map((c) => /org-(a|b)/.exec(c.url)?.[0] ?? 'orgs'), ['orgs', 'org-a', 'org-b']);
});

test('extract() rejects naming the conversation when no org has it', async () => {
  const fetch = fetchStub([
    [ORGS, () => ({ body: [{ uuid: 'org-a' }, { uuid: 'org-b' }] })],
    [convRoute('org-(a|b)'), () => ({ status: 403, body: {} })],
  ]);
  const w = loadPage({ url: CHAT_URL, fetch });
  await assert.rejects(w.ClipMD.extractors.claude.extract(), (err) => err.message.includes(CONV_ID) && /403/.test(err.message));
});

test('extract() rejects when the org list itself fails', async () => {
  const fetch = fetchStub([[ORGS, () => ({ status: 401, body: {} })]]);
  const w = loadPage({ url: CHAT_URL, fetch });
  await assert.rejects(w.ClipMD.extractors.claude.extract(), /401/);
});

// Full clip via ClipMD.clip('full') on a claude.ai chat page serving `conv`.
async function clipVia(conv) {
  const fetch = fetchStub([
    [ORGS, () => ({ body: [{ uuid: 'org-a' }] })],
    [convRoute('org-a'), () => ({ body: conv })],
  ]);
  const res = await loadPage({ url: CHAT_URL, fetch }).ClipMD.clip('full');
  assert.ok(res.ok, `clip failed: ${res.error}`);
  return splitClip(res.markdown);
}

test('end-to-end clip through the orchestrator yields valid frontmatter and one heading per turn', async () => {
  const conv = branchyConversation();
  conv.chat_messages.find((m) => m.uuid === 'a2').content.unshift({ type: 'token_budget' });
  const { frontmatter, body } = await clipVia(conv);
  assert.equal(frontmatter.type, 'claude-conversation');
  assert.equal(frontmatter.title, conv.name);
  assert.equal(frontmatter.url, CHAT_URL);
  assert.equal(frontmatter.model, 'claude-opus-4-5');
  assert.equal(frontmatter.messages_omitted, 3);
  assert.equal(headings(body).length, frontmatter.turns);
  assert.ok(frontmatter.clip_warnings.some((wn) => wn.includes('token_budget')));
});

test('a missing ancestor cuts the transcript at the gap and is reported in clip_warnings', async () => {
  const conv = branchyConversation();
  conv.chat_messages = conv.chat_messages.filter((m) => m.uuid !== 'a1');  // parent of h2
  const { frontmatter, body } = await clipVia(conv);
  assert.deepEqual(headings(body), ['Human', 'Assistant', 'Assistant']);
  assert.ok(!body.includes('ACTIVE first question'), 'message above the gap rendered');
  assert.equal(frontmatter.turns, 3);
  assert.equal(frontmatter.clip_warnings?.length, 1, JSON.stringify(frontmatter.clip_warnings));
  assert.match(frontmatter.clip_warnings[0], /\ba1\b/);
});

test('matches() claims only /chat/<uuid> on claude.ai', () => {
  const claims = (url) => loadPage({ url }).ClipMD.extractors.claude.matches();
  assert.equal(claims(CHAT_URL), true);
  assert.equal(claims(`${CHAT_URL}?q=1#x`), true);
  assert.equal(claims(`${ORIGIN}/recents`), false);
  assert.equal(claims(`${ORIGIN}/project/${CONV_ID}`), false);
  assert.equal(claims(`${ORIGIN}/chat/not-a-uuid`), false);
  assert.equal(claims(`https://example.com/chat/${CONV_ID}`), false);
});
