(function() {
// extractors/chatgpt-conversation.js — ChatGPT conversations via the backend JSON API.
//
// Renders the branch currently shown in the UI (current_node → root) as a lossless
// transcript: reasoning, tool calls and results, citations resolved to links, attachment
// metadata. One ChatGPT turn spans many messages (thoughts → tool call → tool result →
// … → text); consecutive non-user messages are grouped under one Assistant heading.

const ClipMD = window.ClipMD;
const T = ClipMD.transcript;

const HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
// Also matches project/GPT-scoped paths like /g/g-p-abc/c/<uuid>.
const CONV_PATH = /\/c\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\/|$)/i;

// Citation markers are private-use chars: U+E200 kind (U+E202 arg)* U+E201.
const MARKER = /\uE200([^\uE200-\uE206]*)((?:\uE202[^\uE200-\uE206]*)*)\uE201/g;
const PRIVATE_USE = /[\uE200-\uE206]/g;

// Code (fenced blocks, any indent so fences inside list items count; inline spans with
// CommonMark's equal-length backtick rule) — math conversion must not touch it.
const CODE = /^[ \t]*((`|~)\2{2,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1\2*[ \t]*$|(?![\s\S]))|(?<!`)(`+)(?!`)[\s\S]*?[^`]\3(?!`)/gm;

const LANG = { python3: 'python', unknown: '' };

function mapProse(text, fn) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(CODE)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

// ChatGPT emits \( \) and \[ \] delimiters; normalize to $ / $$. The lookbehind skips
// LaTeX's `\\[2pt]` row spacing inside existing math.
const convertMath = (s) => s
  .replace(/(?<!\\)\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m.trim()}$$`)
  .replace(/(?<!\\)\\\(([^\n]+?)\\\)/g, (_, m) => `$${m.trim()}$`);

function renderRef(ref) {
  if (ref.type === 'hidden' || ref.type === 'sources_footnote') return '';
  if (typeof ref.alt === 'string' && ref.alt.trim()) return ref.alt;  // already markdown
  // Observed live: single-source cites carry a markdown alt; multi-source ones have an empty alt.
  if (ref.type === 'grouped_webpages' && ref.items?.length) {
    return ` (${ref.items.map((i) => T.link(i.title, i.url)).join(', ')})`;
  }
  if (ref.type === 'file') return `[file: ${ref.name}]`;
  // Widgets (genui, nav lists, …): dump their payload; matched_text holds the raw marker.
  const payload = ref.data ?? (ref.alt || { ...ref, matched_text: undefined });
  return T.tag('widget', { type: ref.type, name: ref.name }, T.json(payload));
}

// Math delimiters are normalized only in assistant-authored text: the UI shows user prompts
// as plain text (a prompt about the regex \(\d+\) is not math), and tool output is data.
function resolveText(text, msg, ctx) {
  const prose = msg.author.role === 'assistant' ? mapProse(text, convertMath) : text;
  return prose.replace(MARKER, (marker, kind, rawArgs) => {
    const ref = msg.refs.get(marker);
    if (ref) return renderRef(ref);
    // File-search tool output carries markers the tool never resolves; only the
    // assistant's own unresolved citations are worth flagging.
    if (msg.author.role !== 'tool') ctx.warn(`unresolved "${kind}" citation marker(s) rendered as [${kind}: …]`);
    const args = rawArgs.split('\uE202').slice(1);
    return `[${kind}${args.length ? ': ' + args.join(' ') : ''}]`;
  });
}

function renderPart(p, msg, ctx) {
  if (typeof p === 'string') return resolveText(p, msg, ctx);
  switch (p.content_type) {
    case 'image_asset_pointer':
      return T.tag('image', {
        asset: p.asset_pointer, type: p.mime_type, width: p.width, height: p.height, size: p.size_bytes,
        generated: !!(p.metadata?.dalle || p.metadata?.generation),
      });
    case 'audio_transcription':
      return T.tag('voice', { direction: p.direction }, p.text);
    default:
      ctx.warn(`unknown content part "${p.content_type}" rendered as JSON`);
      return T.tag('block', { type: p.content_type }, T.json(p));
  }
}

// Assistant text addressed to a tool (e.g. web.run search queries) is a machine payload:
// verbatim, no math or marker processing.
function toolCallBody(parts) {
  if (!parts.every((p) => typeof p === 'string')) return T.json(parts);
  const text = parts.join('\n');
  try {
    JSON.parse(text);
  } catch {
    return T.fence(text);
  }
  return T.fence(text, 'json');
}

function renderContent(msg, ctx) {
  const c = msg.content;
  switch (c.content_type) {
    case 'text':
    case 'multimodal_text':
      if (msg.author.role === 'assistant' && msg.recipient !== 'all') {
        return T.tag('tool_use', { name: msg.recipient }, toolCallBody(c.parts));
      }
      return T.join(c.parts.map((p) => renderPart(p, msg, ctx)));
    case 'thoughts':
      return T.tag('thinking', { title: msg.metadata?.reasoning_title }, c.thoughts
        .map((t) => T.join([t.summary && `**${t.summary}**`, t.content && resolveText(t.content, msg, ctx)]))
        .join('\n\n'));
    case 'reasoning_recap':
      return c.content ? T.tag('reasoning_recap', {}, c.content) : '';
    case 'code': {
      const block = T.fence(c.text, LANG[c.language] ?? c.language ?? '');
      return msg.recipient === 'all' ? block : T.tag('tool_use', { name: msg.recipient }, block);
    }
    case 'execution_output':
      return T.fence(c.text);  // program output, not markdown
    case 'tether_browsing_display':
      return T.join([c.summary, c.result]);
    default:
      ctx.warn(`unknown content_type "${c.content_type}" rendered as JSON`);
      return T.tag('block', { type: c.content_type }, T.json(c));
  }
}

function renderMessage(msg, ctx) {
  const role = msg.author.role;
  const refs = msg.metadata?.content_references || [];
  const attachments = (msg.metadata?.attachments || []).map((a) =>
    T.tag('attachment', { name: a.name, type: a.mime_type, size: a.size, source: a.source }));
  ctx.attachments += attachments.length;
  const sources = refs.filter((r) => r.type === 'sources_footnote').flatMap((r) => r.sources || []);
  // Every observed message has a recipient; without one, a visible answer must not turn
  // into a nameless tool call.
  if (msg.recipient == null) ctx.noRecipient++;
  let out = T.join([
    ...attachments,
    renderContent({ ...msg, recipient: msg.recipient ?? 'all', refs: new Map(refs.map((r) => [r.matched_text, r])) }, ctx),
    sources.length ? T.tag('sources', {}, sources.map((s) => `- ${T.link(s.title, s.url)}`).join('\n')) : '',
  ]);
  if (role === 'tool') {
    out = T.tag('tool_result', { name: msg.author.name }, out);
  } else if (!['user', 'assistant', 'system'].includes(role)) {
    ctx.warn(`unknown author role "${role}" rendered inside the Assistant turn`);
    out = T.tag('message', { role, name: msg.author.name }, out);
  }
  return msg.metadata?.is_visually_hidden_from_conversation && out ? T.tag('hidden', {}, out) : out;
}

function render(conv, { url }) {
  if (!conv?.mapping || !conv.current_node) throw new Error('conversation payload has no mapping/current_node');
  const warnings = [];
  const ctx = { attachments: 0, noRecipient: 0, warn: (w) => warnings.includes(w) || warnings.push(w) };
  const pathIds = T.activePath(conv.current_node, {
    getParent: (id) => conv.mapping[id].parent,
    has: (id) => !!conv.mapping[id],
    isRoot: (parent) => parent == null,  // client-created-root has parent null
  }, warnings);
  const messages = pathIds.map((id) => conv.mapping[id].message).filter(Boolean);

  const turns = [];
  for (const msg of messages) {
    const body = renderMessage(msg, ctx);
    const role = msg.author.role;
    if (role === 'system' && !body) continue;  // the empty root system message
    const label = role === 'user' ? 'Human' : role === 'system' ? 'System' : 'Assistant';
    if (label === 'Assistant' && turns.at(-1)?.label === 'Assistant') turns.at(-1).parts.push(body);
    else turns.push({ label, time: msg.create_time, parts: [body] });
  }

  let markdown = turns.map((t) => T.join([T.heading(t.label, t.time), ...t.parts])).join('\n\n');
  const stray = markdown.match(PRIVATE_USE);
  if (stray) {
    ctx.warn(`stripped ${stray.length} stray citation control character(s) (U+E200–U+E206)`);
    markdown = markdown.replace(PRIVATE_USE, '');
  }
  if (ctx.attachments) {
    ctx.warn(`${ctx.attachments} attachment(s) included by name only (ChatGPT's API does not return file contents)`);
  }
  if (ctx.noRecipient) ctx.warn(`${ctx.noRecipient} message(s) had no recipient field — treated as visible text`);

  const total = Object.values(conv.mapping).filter((n) => n.message).length;
  return {
    meta: {
      title: conv.title || 'Untitled conversation',
      url,
      date: ClipMD.isoDate(conv.create_time * 1000),
      type: 'chatgpt-conversation',
      model: conv.default_model_slug,
      turns: turns.length,
      messages_omitted: total - messages.length,
    },
    markdown,
    warnings,
  };
}

async function getJson(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return res.json();
}

ClipMD.extractors.chatgpt = {
  id: 'chatgpt-conversation',
  matches() {
    return HOSTS.has(location.hostname) && CONV_PATH.test(location.pathname);
  },
  async extract() {
    const id = CONV_PATH.exec(location.pathname)[1];
    const session = await getJson('/api/auth/session');
    if (!session.accessToken) throw new Error('not logged in to ChatGPT (no accessToken in /api/auth/session)');
    const conv = await getJson(`/backend-api/conversation/${id}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    return render(conv, { url: location.origin + location.pathname });
  },
  render,
};
})();
