(function() {
// lib/yaml.js — YAML frontmatter. Strings are emitted as JSON strings, which are valid
// YAML double-quoted scalars, so no title can change type or break the block.

// Printable-in-JSON but not in YAML (C1 controls, NEL, line/paragraph separators, BOM).
const YAML_UNSAFE = /[\u007f-\u009f\u2028\u2029\ufeff]/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Emitted bare (YAML dates). Any other string — even "2024-01-15" as a title — stays quoted.
const DATE_KEYS = new Set(['date', 'clipped']);

function scalar(key, v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`frontmatter: ${key} is ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    if (DATE_KEYS.has(key)) {
      if (!ISO_DATE.test(v)) throw new Error(`frontmatter: ${key} must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
      return v;
    }
    return JSON.stringify(v).replace(YAML_UNSAFE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  throw new Error(`frontmatter: ${key} has unsupported type ${typeof v}`);
}

function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error(`frontmatter: invalid key ${JSON.stringify(key)}`);
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${scalar(key, item)}`);
    } else {
      lines.push(`${key}: ${scalar(key, value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

window.ClipMD = window.ClipMD || {};
window.ClipMD.buildFrontmatter = buildFrontmatter;
})();
