(function() {
// lib/transcript.js — lossless transcript format for conversations and comment threads.
//
// Target reader is an LLM agent: structure is carried by XML-style tags (which nest
// arbitrarily and survive code fences), prose stays markdown. Shape:
//
//   ## Human · 2026-07-30T14:02Z
//   <attachment name="paper.pdf" type="application/pdf">…</attachment>
//   prompt text
//
//   ## Assistant · 2026-07-30T14:03Z
//   <thinking>…</thinking>
//   <tool_use name="web_search" id="…">```json …```</tool_use>
//   <tool_result name="web_search">…</tool_result>
//   response markdown

const T = {};

T.escapeAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#10;');

// Attributes with null/undefined/''/false values are omitted; true renders as "true".
T.attrs = (obj = {}) => Object.entries(obj)
  .filter(([, v]) => v != null && v !== '' && v !== false)
  .map(([k, v]) => ` ${k}="${T.escapeAttr(v === true ? 'true' : v)}"`)
  .join('');

// <name attrs>\nbody\n</name>, or <name attrs /> when body is blank. Only blank lines are
// stripped at the start, so indentation of the first line (code, tables) survives.
T.tag = (name, attrs, body) => {
  const b = body == null ? '' : String(body).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  return b.trim() ? `<${name}${T.attrs(attrs)}>\n${b}\n</${name}>` : `<${name}${T.attrs(attrs)} />`;
};

// Markdown link/image. Brackets in the label are escaped; destinations containing
// whitespace, parens or angle brackets use the <…> form so they can't end the link early.
const destination = (url) => (/[\s()<>]/.test(url) ? `<${String(url).replace(/[<>]/g, encodeURIComponent)}>` : url);
// Labels are single-line: a blank line inside [...] would end the link/image.
const label = (s) => String(s).replace(/\s*\n\s*/g, ' ').replace(/[\\[\]]/g, '\\$&');
// No url (e.g. a citation of a project document) → the label alone, not "(undefined)".
T.link = (text, url) => (url ? `[${label(text || url)}](${destination(url)})` : label(text || ''));
T.image = (alt, url) => `![${label(alt || '')}](${destination(url)})`;

// Fenced block whose fence is longer than any backtick run inside `text`.
T.fence = (text, lang = '') => {
  const s = String(text);
  const longest = Math.max(2, ...(s.match(/`+/g) || []).map((r) => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${s}\n${f}`;
};

T.json = (value) => T.fence(JSON.stringify(value, null, 2), 'json');

// ISO string or Unix seconds (ChatGPT's create_time) → "YYYY-MM-DDTHH:MMZ".
T.time = (t) => {
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t);
  if (isNaN(d)) throw new Error(`transcript: invalid timestamp ${JSON.stringify(t)}`);
  return d.toISOString().slice(0, 16) + 'Z';
};

T.heading = (role, time) => `## ${role}` + (time != null ? ` · ${T.time(time)}` : '');

// Join non-empty sections with blank lines.
T.join = (parts) => parts.filter((p) => p != null && String(p).trim() !== '').join('\n\n');

// Walk parent pointers from `leafId` up to the root; returns ids root→leaf.
//   has(id): node exists · getParent(id): its parent id · isRoot(parentId): the walk may end here
// A chain that ends anywhere else means the head of the conversation is missing from the
// data: the path found so far is returned and the gap is reported in `warnings`.
T.activePath = (leafId, { getParent, has, isRoot }, warnings) => {
  if (!has(leafId)) throw new Error(`transcript: leaf ${leafId} not in tree`);
  const path = [];
  const seen = new Set();
  for (let id = leafId; ; ) {
    if (seen.has(id)) throw new Error(`transcript: cycle at ${id}`);
    seen.add(id);
    path.push(id);
    const parent = getParent(id);
    if (isRoot(parent)) break;
    if (!has(parent)) {
      warnings.push(`conversation tree broken above ${id} (parent ${parent} missing) — earlier messages are not in this clip`);
      break;
    }
    id = parent;
  }
  return path.reverse();
};

window.ClipMD = window.ClipMD || {};
window.ClipMD.transcript = T;
})();
