(function() {
// lib/yaml.js — YAML frontmatter escaping for ClipMD

const YAML_SPECIAL_WORDS = new Set([
  'true', 'false', 'null', 'yes', 'no',
  'True', 'False', 'Null', 'Yes', 'No',
  'TRUE', 'FALSE', 'NULL', 'YES', 'NO',
]);

const NEEDS_QUOTING = /: | #|['"\[\]{}\\]|\n/;
const SPECIAL_START = /^[@!&*>|?\-%]/;

function yamlString(value) {
  if (value == null) return '""';
  const s = String(value);
  if (s === '') return '""';
  if (YAML_SPECIAL_WORDS.has(s) || NEEDS_QUOTING.test(s) || SPECIAL_START.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

function buildFrontmatter(fields) {
  let lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    lines.push(key + ': ' + yamlString(value));
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

window.ClipMD = window.ClipMD || {};
window.ClipMD.yamlString = yamlString;
window.ClipMD.buildFrontmatter = buildFrontmatter;
})();
