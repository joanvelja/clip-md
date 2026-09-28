(function() {
// extractors/claude-conversation.js — claude.ai conversations via the app's JSON API.
// The UI virtualizes its message list, so the DOM never holds the whole chat; the API
// returns every branch with raw markdown, thinking, tool calls and attachment text.

const ClipMD = window.ClipMD;
const T = ClipMD.transcript;

const CHAT_PATH = /^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const ROLES = { human: 'Human', assistant: 'Assistant' };
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';  // parent id of the first message

// The conversation lives in exactly one of the user's orgs; the others answer 403.
async function fetchConversation(id) {
  const res = await fetch('/api/organizations');
  if (!res.ok) throw new Error(`GET /api/organizations: HTTP ${res.status}`);
  const orgs = await res.json();
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('GET /api/organizations returned no organizations');
  const statuses = [];
  for (const { uuid } of orgs) {
    const r = await fetch(`/api/organizations/${uuid}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`);
    if (r.ok) return r.json();
    statuses.push(r.status);
  }
  throw new Error(`conversation ${id} not found in any of ${orgs.length} orgs (HTTP ${statuses.join(', ')})`);
}

// Offsets index the citing block's own text (live data: every span ends inside it, on a
// word boundary). Citations are listed after the prose rather than spliced into it, with
// any further sources nested under the main one. A span outside its block is dropped and
// counted, not guessed at.
function renderCitations(textBlocks, ctx) {
  const lines = new Set();
  for (const b of textBlocks) {
    for (const c of b.citations || []) {
      const inBounds = 0 <= c.start_index && c.start_index <= c.end_index && c.end_index <= b.text.length;
      if (!inBounds) ctx.badSpans++;
      const quote = inBounds ? ` — "${b.text.slice(c.start_index, c.end_index)}"` : '';
      const more = (c.sources || []).filter((s) => s.url && s.url !== c.url).map((s) => `\n  - ${T.link(s.title, s.url)}`);
      lines.add(`- ${T.link(c.title, c.url)}${quote}${more.join('')}`);
    }
  }
  return lines.size ? T.tag('citations', {}, [...lines].join('\n')) : '';
}

// Most thinking arrives with thinking_hidden and empty text; the summaries are all we get.
function renderThinking(b) {
  const visible = Boolean(b.thinking?.trim());
  const body = visible ? b.thinking : (b.summaries || []).map((s) => `- ${s.summary}`).join('\n');
  return T.tag('thinking', { hidden: !visible, cut_off: b.cut_off, truncated: b.truncated }, body);
}

function renderResultItem(item, ctx) {
  if (typeof item === 'string') return item;
  switch (item?.type) {
    case 'text': return item.text;
    case 'knowledge': return T.tag('source', { title: item.title, url: item.url, missing: item.is_missing }, item.text);
    case 'local_resource': return T.tag('file', { path: item.file_path, name: item.name, type: item.mime_type });
    default:
      ctx.unknownItems.add(String(item?.type));
      return T.json(item);
  }
}

function renderBlock(b, ctx) {
  switch (b.type) {
    case 'thinking': return renderThinking(b);
    case 'tool_use': return T.tag('tool_use', { name: b.name, id: b.id }, T.json(b.input));
    case 'tool_result': {
      const items = [].concat(b.content ?? []);  // array, lone string, or absent
      const body = T.join(items.map((it) => renderResultItem(it, ctx)));
      return T.tag('tool_result', { name: b.name, tool_use_id: b.tool_use_id, error: b.is_error }, body);
    }
    default:
      ctx.unknownBlocks.add(String(b.type));
      return T.tag('block', { type: b.type }, T.json(b));
  }
}

// m.text is defined as the plain concatenation of the text blocks, so adjacent ones (none
// seen live) are glued back without a separator; citations follow the run.
function renderBlocks(blocks, ctx) {
  const parts = [];
  for (let i = 0; i < blocks.length;) {
    if (blocks[i].type !== 'text') {
      parts.push(renderBlock(blocks[i++], ctx));
      continue;
    }
    const run = [];
    while (i < blocks.length && blocks[i].type === 'text') run.push(blocks[i++]);
    parts.push(run.map((b) => b.text).join(''), renderCitations(run, ctx));
  }
  return parts;
}

function renderMessage(m, ctx, origin) {
  const role = ROLES[m.sender];
  if (!role) throw new Error(`message ${m.index} has unexpected sender ${JSON.stringify(m.sender)}`);
  if (!Array.isArray(m.content)) throw new Error(`message ${m.index} has no content array`);
  if (m.truncated) ctx.warnings.push(`message ${m.index} truncated by server`);

  const attachments = (m.attachments || []).map((a) =>
    T.tag('attachment', { name: a.file_name, type: a.file_type, size: a.file_size }, a.extracted_content));
  const files = (m.files || []).map((f) => {
    const src = f.preview_asset?.url || f.document_asset?.url || f.preview_url;
    return T.tag('file', { name: f.file_name, kind: f.file_kind, url: src && new URL(src, origin).href });
  });
  // Never seen populated, so its shape is unknown: keep it raw and flag it.
  const syncSources = m.sync_sources?.length ? T.tag('sync_sources', {}, T.json(m.sync_sources)) : null;
  if (syncSources) ctx.syncSourceMessages++;
  return T.join([
    T.heading(role, m.created_at),
    ...attachments,
    ...files,
    syncSources,
    ...renderBlocks(m.content, ctx),
    m.compaction_summary?.length ? T.tag('compaction_summary', {}, T.join(renderBlocks(m.compaction_summary, ctx))) : null,
    m.stop_reason && m.stop_reason !== 'end_turn' ? T.tag('stop', { reason: m.stop_reason }) : null,
  ]);
}

// Pure: API conversation → clip. Renders only the branch the UI shows (current leaf → root).
function render(conv, { url, origin }) {
  if (!Array.isArray(conv.chat_messages)) throw new Error('conversation response has no chat_messages array');
  const ctx = { warnings: [], unknownBlocks: new Set(), unknownItems: new Set(), badSpans: 0, syncSourceMessages: 0 };
  const byId = new Map(conv.chat_messages.map((m) => [m.uuid, m]));
  const path = T.activePath(conv.current_leaf_message_uuid, {
    getParent: (id) => byId.get(id).parent_message_uuid,
    has: (id) => byId.has(id),
    isRoot: (id) => id === ROOT_PARENT,
  }, ctx.warnings).map((id) => byId.get(id));

  const markdown = T.join(path.map((m) => renderMessage(m, ctx, origin)));
  if (ctx.unknownBlocks.size) ctx.warnings.push(`unrecognized Claude block type(s): ${[...ctx.unknownBlocks].join(', ')}`);
  if (ctx.unknownItems.size) ctx.warnings.push(`unrecognized Claude tool_result item type(s): ${[...ctx.unknownItems].join(', ')}`);
  if (ctx.badSpans) ctx.warnings.push(`${ctx.badSpans} citation span(s) fall outside their text block; quotes omitted`);
  if (ctx.syncSourceMessages) ctx.warnings.push(`sync_sources present on ${ctx.syncSourceMessages} message(s) — kept as raw JSON (format not interpreted)`);

  return {
    meta: {
      title: conv.name || 'Untitled conversation',
      url,
      date: ClipMD.isoDate(conv.created_at),
      type: 'claude-conversation',
      model: conv.model,
      turns: path.length,
      messages_omitted: conv.chat_messages.length - path.length,
    },
    markdown,
    warnings: ctx.warnings,
  };
}

ClipMD.extractors.claude = {
  id: 'claude-conversation',
  matches: () => location.hostname === 'claude.ai' && CHAT_PATH.test(location.pathname),

  async extract() {
    const conv = await fetchConversation(CHAT_PATH.exec(location.pathname)[1]);
    return render(conv, { url: location.origin + location.pathname, origin: location.origin });
  },

  render,
};
})();
