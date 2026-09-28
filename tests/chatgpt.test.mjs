// tests/chatgpt.test.mjs — ChatGPT extractor: backend-API JSON → transcript.
// Conversations are synthetic but follow the observed /backend-api/conversation schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fetchStub, splitClip } from './harness.mjs';

const UUID = '68d8f1a2-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const PUA = /[\uE200-\uE206]/;

// ---- synthetic conversation builders ---------------------------------------------------

let clock = 1_750_000_000;
function msg(role, content, { name = null, recipient = 'all', metadata = {}, create_time = clock++ } = {}) {
  return {
    author: { role, name, metadata: {} }, create_time, update_time: null, content,
    status: 'finished_successfully', end_turn: null, weight: 1, metadata, recipient, channel: null,
  };
}
const text = (...parts) => ({ content_type: 'text', parts });
const multimodal = (...parts) => ({ content_type: 'multimodal_text', parts });
const user = (s, opts) => msg('user', text(s), opts);
const assistant = (s, opts) => msg('assistant', text(s), opts);
const marker = (kind, ...args) => '\uE200' + [kind, ...args].join('\uE202') + '\uE201';

// nodes: [id, parentId, message]. Adds ChatGPT's null-message root + empty system message.
function conversation(nodes, current_node, extra = {}) {
  const all = [['client-created-root', null, null], ['sys', 'client-created-root', msg('system', text(''))], ...nodes];
  const mapping = {};
  for (const [id, parent, message] of all) mapping[id] = { id, parent, children: [], message: message && { id, ...message } };
  for (const n of Object.values(mapping)) mapping[n.parent]?.children.push(n.id);
  return {
    title: 'Synthetic chat', create_time: 1_750_000_000.25, update_time: 1_750_000_900.5, mapping, current_node,
    conversation_id: UUID, default_model_slug: 'gpt-5-thinking', is_archived: false, gizmo_id: null, ...extra,
  };
}
function linear(...messages) {
  let parent = 'sys';
  const nodes = messages.map((m, i) => { const node = [`n${i}`, parent, m]; parent = `n${i}`; return node; });
  return conversation(nodes, parent);
}

const w = loadPage();
const render = (conv) => w.ClipMD.extractors.chatgpt.render(conv, { url: `https://chatgpt.com/c/${UUID}` });
const headings = (md) => md.match(/^## (Human|Assistant|System)\b.*$/gm) || [];
function assertOrder(md, needles) {
  const idx = needles.map((n) => md.indexOf(n));
  idx.forEach((i, k) => assert.ok(i >= 0, `missing ${JSON.stringify(needles[k])} in:\n${md}`));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, `out of order: ${needles.join(' < ')}\n${md}`);
}

// ---- rendering --------------------------------------------------------------------------

test('renders the branch selected by current_node; abandoned branches are omitted and counted', () => {
  // u2 was edited into u2e; the reply to u2e was regenerated (a2x → a2y).
  const nodes = [
    ['u1', 'sys', user('FIRST-QUESTION')],
    ['a1', 'u1', assistant('FIRST-ANSWER')],
    ['u2', 'a1', user('OLD-PROMPT')],
    ['a2', 'u2', assistant('OLD-REPLY')],
    ['u2e', 'a1', user('EDITED-PROMPT')],
    ['a2x', 'u2e', assistant('REGEN-ONE')],
    ['a2y', 'u2e', assistant('REGEN-TWO')],
  ];
  const { meta, markdown } = render(conversation(nodes, 'a2y'));
  assertOrder(markdown, ['FIRST-QUESTION', 'FIRST-ANSWER', 'EDITED-PROMPT', 'REGEN-TWO']);
  for (const gone of ['OLD-PROMPT', 'OLD-REPLY', 'REGEN-ONE']) assert.ok(!markdown.includes(gone), gone);
  assert.equal(meta.messages_omitted, 3);
  assert.equal(meta.turns, 4);
  assert.deepEqual(headings(markdown).map((h) => h.split(' ')[1]), ['Human', 'Assistant', 'Human', 'Assistant']);

  // The UI can show an older sibling; current_node, not recency, decides.
  const older = render(conversation(nodes, 'a2x')).markdown;
  assert.ok(older.includes('REGEN-ONE') && !older.includes('REGEN-TWO'));
});

test('one assistant turn = thoughts, tool call, tool result, answer under a single heading, in order', () => {
  const conv = linear(
    user('look it up'),
    msg('assistant', { content_type: 'thoughts', thoughts: [{ summary: 'Planning search', content: 'THOUGHT-BODY', chunks: [], finished: true }], source_analysis_msg_id: 'x' },
      { metadata: { reasoning_title: 'Searching the web' } }),
    msg('assistant', { content_type: 'reasoning_recap', content: 'Worked for 12 seconds' }),
    msg('assistant', { content_type: 'code', language: 'json', response_format_name: null, text: '{"q":"TOOL-QUERY"}' }, { recipient: 'web.run' }),
    msg('tool', text('TOOL-RESULT-TEXT'), { name: 'web.run' }),
    msg('assistant', { content_type: 'code', language: 'python3', response_format_name: null, text: 'print(6 * 7)' }, { recipient: 'python' }),
    msg('tool', { content_type: 'execution_output', text: 'EXEC-OUT-42' }, { name: 'python' }),
    assistant('FINAL-ANSWER'),
  );
  const { meta, markdown } = render(conv);
  assert.equal(headings(markdown).length, 2);
  assert.equal(meta.turns, 2);
  assertOrder(markdown, [
    '## Assistant', '<thinking title="Searching the web">', 'Planning search', 'THOUGHT-BODY', '</thinking>',
    'Worked for 12 seconds', '<tool_use name="web.run">', '"q":"TOOL-QUERY"', '</tool_use>',
    '<tool_result name="web.run">', 'TOOL-RESULT-TEXT', '</tool_result>',
    '<tool_use name="python">', 'print(6 * 7)', '<tool_result name="python">', 'EXEC-OUT-42', 'FINAL-ANSWER',
  ]);
  assert.match(markdown, /```json\n\{"q":"TOOL-QUERY"\}\n```/);
  assert.ok(markdown.includes('```python\nprint(6 * 7)\n```'));
});

test('assistant text addressed to a tool is a verbatim tool call, not prose', () => {
  const conv = linear(
    user('find it'),
    assistant('{"search_query":[{"q":"QUERY-XYZ"}]}', { recipient: 'web.run' }),
    msg('tool', text('RESULT-ABC'), { name: 'web.run', recipient: 'assistant' }),
    assistant('open \\(PLAIN-CALL\\)', { recipient: 'web' }),
    msg('tool', text('RESULT-DEF'), { name: 'web' }),
    assistant('ANSWER'),
  );
  const { markdown } = render(conv);
  const calls = [...markdown.matchAll(/<tool_use name="([^"]+)">\n([\s\S]*?)\n<\/tool_use>/g)];
  assert.deepEqual(calls.map((m) => m[1]), ['web.run', 'web']);
  assert.ok(calls[0][2].includes('```json\n{"search_query":[{"q":"QUERY-XYZ"}]}\n```'), calls[0][2]);
  assert.ok(calls[1][2].includes('open \\(PLAIN-CALL\\)'), 'non-JSON payload kept verbatim, no math conversion');
  const outside = calls.reduce((md, m) => md.replace(m[0], ''), markdown);
  assert.ok(!outside.includes('QUERY-XYZ') && !outside.includes('PLAIN-CALL'), outside);
  assertOrder(markdown, ['QUERY-XYZ', '<tool_result name="web.run">', 'RESULT-ABC', 'PLAIN-CALL', 'RESULT-DEF', 'ANSWER']);
  assert.equal(headings(markdown).length, 2);
});

test('a message without a recipient field is visible text, with one warning', () => {
  const noRecipient = (m) => { delete m.recipient; return m; };
  const conv = linear(
    user('q'),
    noRecipient(assistant('VISIBLE-ONE')),
    noRecipient(msg('assistant', { content_type: 'code', language: 'python3', response_format_name: null, text: 'print("VISIBLE-CODE")' })),
  );
  const { markdown, warnings } = render(conv);
  assert.ok(!markdown.includes('<tool_use'), markdown);
  assert.ok(markdown.includes('VISIBLE-ONE') && markdown.includes('print("VISIBLE-CODE")'), markdown);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /\b2\b.*recipient/);
});

test('visually hidden messages are kept, marked hidden', () => {
  const conv = linear(user('q'), assistant('HIDDEN-SCAFFOLD', { metadata: { is_visually_hidden_from_conversation: true } }), assistant('SHOWN'));
  const { markdown } = render(conv);
  assertOrder(markdown, ['<hidden>', 'HIDDEN-SCAFFOLD', '</hidden>', 'SHOWN']);
});

test('citation markers resolve through content_references; no private-use chars survive', () => {
  const cite = marker('cite', 'turn0search3', 'turn0search5');
  const bare = marker('cite', 'turn1search0');
  const file = marker('filecite', 'turn0file3', 'L354-L372');
  const hid = marker('cite', 'turn0search9');
  const widget = marker('genui', '{"math_block_widget_always_prefetch_v2":{}}');
  const unknown = marker('cite', 'turn7search1');
  const answer = assistant(
    `Paris is the capital${cite}. Others agree${bare}. See notes${file}. alpha${hid}omega. ${widget} Also${unknown}.`,
    { metadata: { content_references: [
      { matched_text: cite, type: 'grouped_webpages', alt: '([Wikipedia](https://en.wikipedia.org/wiki/Paris))', items: [] },
      { matched_text: bare, type: 'grouped_webpages', alt: null, items: [
        { title: 'Site A', url: 'https://a.example/1' }, { title: 'Site B', url: 'https://b.example/2' }] },
      { matched_text: file, type: 'file', alt: null, name: 'notes.pdf', id: 'file-1', source: 'my_files' },
      { matched_text: hid, type: 'hidden', alt: null, invalid: true },
      { matched_text: widget, type: 'client_defined_widget', alt: { k: 1 }, name: 'math_block', data: { WIDGET_DATA: 7 } },
      { matched_text: ' ', type: 'sources_footnote', sources: [
        { title: 'Le Monde', url: 'https://lemonde.example/x' }, { title: 'BBC', url: 'https://bbc.example/y' }] },
    ] } },
  );
  const { markdown, warnings } = render(linear(user('capital of France?'), answer));
  assert.ok(!PUA.test(markdown), 'private-use chars in output');
  assert.ok(markdown.includes('Paris is the capital([Wikipedia](https://en.wikipedia.org/wiki/Paris))'));
  assert.ok(markdown.includes('[Site A](https://a.example/1)') && markdown.includes('[Site B](https://b.example/2)'));
  assert.ok(markdown.includes('notes.pdf'));
  assert.ok(markdown.includes('alphaomega'), 'hidden ref must vanish');
  assert.match(markdown, /<widget[^>]*type="client_defined_widget"[\s\S]*WIDGET_DATA[\s\S]*<\/widget>/);
  assert.match(markdown, /<sources>[\s\S]*\[Le Monde\]\(https:\/\/lemonde\.example\/x\)[\s\S]*\[BBC\]\(https:\/\/bbc\.example\/y\)[\s\S]*<\/sources>/);
  assertOrder(markdown, ['Also', '<sources>']);
  assert.match(markdown, /cite\W+turn7search1/, 'unresolved marker must stay readable');
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /cite/);
});

test('unresolved markers in tool output are rendered readably without a warning', () => {
  const conv = linear(
    user('search my files'),
    msg('tool', multimodal(`chunk text ${marker('filecite', 'turn0file1', 'L1-L9')} more`), { name: 'file_search' }),
    assistant('done'),
  );
  const { markdown, warnings } = render(conv);
  assert.ok(!PUA.test(markdown));
  assert.match(markdown, /filecite\W+turn0file1\W+L1-L9/);
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
});

test('stray private-use chars outside well-formed markers are stripped with a warning', () => {
  const { markdown, warnings } = render(linear(user('q'), assistant('dangling\uE203 marker\uE200cite')));
  assert.ok(!PUA.test(markdown));
  assert.ok(markdown.includes('dangling marker'));
  assert.equal(warnings.length, 1);
});

test('\\( \\) and \\[ \\] become $ / $$ in prose only, never inside code', () => {
  const src = [
    'Inline \\(a_i\\) and existing $b$.',
    '\\[',
    '\\sum_i a_i',
    '\\]',
    'Code `\\(keep\\)` and ``x `\\[keep\\]` y``.',
    '```latex',
    '\\[ fenced \\]',
    '```',
    '~~~',
    '\\( tilde \\)',
    '~~~',
    '1. item',
    '   ```',
    '   \\(listfence\\)',
    '   ```',
    '$$\\begin{aligned} a \\\\[2pt] b \\end{aligned}$$ then \\[c\\]',
  ].join('\n');
  const { markdown } = render(linear(user('math please'), assistant(src)));
  assert.ok(markdown.includes('Inline $a_i$ and existing $b$.'));
  assert.ok(markdown.includes('$$\\sum_i a_i$$'));
  assert.ok(markdown.includes('Code `\\(keep\\)` and ``x `\\[keep\\]` y``.'));
  assert.ok(markdown.includes('```latex\n\\[ fenced \\]\n```'));
  assert.ok(markdown.includes('~~~\n\\( tilde \\)\n~~~'));
  assert.ok(markdown.includes('   ```\n   \\(listfence\\)\n   ```'));
  assert.ok(markdown.includes('$$\\begin{aligned} a \\\\[2pt] b \\end{aligned}$$ then $$c$$'));
});

test('math delimiters are converted only in assistant-authored text', () => {
  const conv = linear(
    user('USER: match the regex \\(\\d+\\) please'),
    msg('assistant', { content_type: 'thoughts', thoughts: [{ summary: 'Plan', content: 'THINK: let \\(n\\) be it', chunks: [], finished: true }] }),
    msg('assistant', { content_type: 'code', language: 'json', response_format_name: null, text: '{"q":"x"}' }, { recipient: 'web.run' }),
    msg('tool', text('TOOL: page says \\(y\\) and \\[z\\]'), { name: 'web.run' }),
    assistant('ANSWER: so \\(n = 3\\)'),
  );
  const { markdown } = render(conv);
  assert.ok(markdown.includes('USER: match the regex \\(\\d+\\) please'), markdown);
  assert.ok(markdown.includes('TOOL: page says \\(y\\) and \\[z\\]'), markdown);
  assert.ok(markdown.includes('THINK: let $n$ be it'), markdown);
  assert.ok(markdown.includes('ANSWER: so $n = 3$'), markdown);
});

test('ordinary markdown passes through byte-identical', () => {
  const md = [
    '# Title', '', 'Some **bold**, _em_, `code`, and [a link](https://x.example/?a=1&b=2).', '',
    '- one', '  - nested', '- two', '', '1. first', '2. second', '',
    '> quoted *line*', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
    '````md', '```js', 'const x = `tpl`;', '```', '````', '', 'Price: $5 and 10$.', '<not-a-tag> & ampersand',
  ].join('\n');
  const { markdown, warnings } = render(linear(user(`Q:\n\n${md}`), assistant(md)));
  assert.equal(markdown.split(md).length - 1, 2, 'both user and assistant copies verbatim');
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
});

test('images, voice transcripts and attachments', () => {
  const upload = { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-UPLOAD', mime_type: 'image/png', size_bytes: 1234, width: 800, height: 600, fovea: null, metadata: {} };
  const generated = { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_GEN', mime_type: 'image/webp', size_bytes: 99, width: 1024, height: 1024, fovea: null, metadata: { dalle: { prompt: 'a cat' }, generation: null } };
  const conv = linear(
    msg('user', multimodal(upload, 'WHAT-IS-THIS'), { metadata: { attachments: [
      { id: 'file-UPLOAD', name: 'photo.png', mime_type: 'image/png', size: 1234, width: 800, height: 600, source: 'local' },
      { id: 'file-2', name: 'paper.pdf', mime_type: 'application/pdf', size: 99999, source: 'library' },
    ] } }),
    msg('assistant', multimodal(generated, { content_type: 'audio_transcription', text: 'SPOKEN-WORDS', direction: 'out', decoding_id: null })),
  );
  const { markdown, warnings } = render(conv);
  assertOrder(markdown, ['## Human', '<attachment name="photo.png"', '<attachment name="paper.pdf"', 'WHAT-IS-THIS', '## Assistant']);
  assert.match(markdown, /<attachment name="paper\.pdf"[^>]*type="application\/pdf"/);
  const img = (asset) => markdown.match(new RegExp(`<image[^>]*asset="${asset}"[^>]*>`))?.[0];
  assert.ok(img('file-service://file-UPLOAD'), markdown);
  assert.match(img('file-service://file-UPLOAD'), /width="800"/);
  assert.ok(!/generated="true"/.test(img('file-service://file-UPLOAD')));
  assert.match(img('sediment://file_GEN'), /generated="true"/);
  assert.match(markdown, /<voice direction="out">\s*SPOKEN-WORDS\s*<\/voice>/);
  assert.ok(warnings.some((w) => /2 attachment/.test(w)), JSON.stringify(warnings));
});

test('unknown content types and parts are dumped as JSON with a warning', () => {
  const conv = linear(
    user('q'),
    msg('assistant', { content_type: 'system_error', name: 'ToolError', text: 'BOOM-DETAIL' }),
    msg('assistant', multimodal({ content_type: 'audio_asset_pointer', asset_pointer: 'sediment://AUDIO', size_bytes: 5 })),
  );
  const { markdown, warnings } = render(conv);
  assert.match(markdown, /```json[\s\S]*"BOOM-DETAIL"[\s\S]*```/);
  assert.match(markdown, /```json[\s\S]*"sediment:\/\/AUDIO"[\s\S]*```/);
  assert.ok(warnings.some((w) => w.includes('system_error')), JSON.stringify(warnings));
  assert.ok(warnings.some((w) => w.includes('audio_asset_pointer')), JSON.stringify(warnings));
});

// ---- fetch layer + orchestrator -----------------------------------------------------------

const CONV_URL = `https://chatgpt.com/c/${UUID}`;
function apiStub({ session = { accessToken: 'TOKEN-123' }, conv = linear(user('hello'), assistant('hi there')), status = 200 } = {}) {
  return fetchStub([
    ['/api/auth/session', () => ({ body: session })],
    [`/backend-api/conversation/${UUID}`, () => ({ status, body: status === 200 ? conv : { detail: 'nope' } })],
  ]);
}

test('extract() rejects when the session has no access token', async () => {
  const fetch = apiStub({ session: {} });
  const page = loadPage({ url: CONV_URL, fetch });
  await assert.rejects(page.ClipMD.extractors.chatgpt.extract(), /not logged in/);
  assert.ok(!fetch.calls.some((c) => c.url.includes('/backend-api/')), 'must not call the API without a token');
});

test('extract() rejects on a non-OK conversation response, naming the status', async () => {
  const page = loadPage({ url: CONV_URL, fetch: apiStub({ status: 404 }) });
  await assert.rejects(page.ClipMD.extractors.chatgpt.extract(), /404/);
});

test('extract() fetches the conversation with the bearer token', async () => {
  const fetch = apiStub();
  const page = loadPage({ url: `https://chatgpt.com/g/g-p-abc123/c/${UUID}?model=gpt-5`, fetch });
  const { meta, markdown } = await page.ClipMD.extractors.chatgpt.extract();
  const call = fetch.calls.find((c) => c.url.includes(`/backend-api/conversation/${UUID}`));
  assert.ok(call, JSON.stringify(fetch.calls));
  assert.equal(call.opts.headers.Authorization, 'Bearer TOKEN-123');
  assert.ok(markdown.includes('hi there'));
  assert.ok(meta.url.startsWith('https://chatgpt.com/') && meta.url.includes(UUID));
});

test('end-to-end through ClipMD.clip: frontmatter parses and turns match headings', async () => {
  const conv = linear(
    user('first'),
    msg('assistant', { content_type: 'thoughts', thoughts: [{ summary: 's', content: 'c', chunks: [], finished: true }] }),
    assistant('answer one'),
    user('second'),
    assistant('answer two'),
  );
  const page = loadPage({ url: CONV_URL, fetch: apiStub({ conv }) });
  const res = await page.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assert.equal(frontmatter.type, 'chatgpt-conversation');
  assert.equal(frontmatter.title, 'Synthetic chat');
  assert.equal(frontmatter.model, 'gpt-5-thinking');
  assert.equal(frontmatter.messages_omitted, 0);
  assert.equal((body.match(/^## (Human|Assistant)\b/gm) || []).length, frontmatter.turns);
  assert.equal(frontmatter.turns, 4);
});

test('a broken parent chain keeps the reachable tail and reports the gap in clip_warnings', async () => {
  const conv = conversation([
    ['u1', 'sys', user('LOST-QUESTION')],
    ['a1', 'u1', assistant('LOST-ANSWER')],
    ['u2', 'ghost-node', user('KEPT-QUESTION')],
    ['a2', 'u2', assistant('KEPT-ANSWER')],
  ], 'a2');
  const page = loadPage({ url: CONV_URL, fetch: apiStub({ conv }) });
  const res = await page.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assertOrder(body, ['KEPT-QUESTION', 'KEPT-ANSWER']);
  assert.ok(!body.includes('LOST-'), body);
  assert.ok(frontmatter.clip_warnings?.some((w) => w.includes('ghost-node')), JSON.stringify(frontmatter.clip_warnings));
  assert.equal(frontmatter.messages_omitted, 3);  // sys, u1, a1
});

test('matches() only conversation pages on ChatGPT hosts', () => {
  const at = (url) => loadPage({ url }).ClipMD.extractors.chatgpt.matches();
  assert.equal(at(`https://chatgpt.com/c/${UUID}`), true);
  assert.equal(at(`https://chatgpt.com/g/g-p-abc123-project/c/${UUID}`), true);
  assert.equal(at(`https://chat.openai.com/c/${UUID}`), true);
  assert.equal(at('https://chatgpt.com/'), false);
  assert.equal(at('https://chatgpt.com/gpts'), false);
  assert.equal(at(`https://example.com/c/${UUID}`), false);
});
