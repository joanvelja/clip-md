#!/usr/bin/env node
// tools/check-clip.mjs — validate a clip.md output at its real boundary (the clipboard).
//
//   node tools/check-clip.mjs --expect claude-conversation [--turns 12] [--file out.md]
//
// Reads the macOS clipboard (pbpaste) unless --file is given. Checks:
//   - frontmatter parses as YAML and has title/url/type
//   - type equals --expect (catches a silent fall-through to another extractor)
//   - no markdown-escaped TeX inside $…$ / $$…$$ — Turndown's signatures: \\alpha (doubled
//     command backslash), x\_i (escaped subscript), \* — none of which valid TeX produces
//   - structural counts agree with frontmatter (and with --turns/--tweets/--comments if given)
// Exit code 1 on any failure.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';

const { values: args } = parseArgs({
  options: {
    expect: { type: 'string' },
    file: { type: 'string' },
    turns: { type: 'string' },
    tweets: { type: 'string' },
    comments: { type: 'string' },
  },
});
if (!args.expect) {
  console.error('usage: check-clip.mjs --expect <type> [--turns N] [--tweets N] [--comments N] [--file path]');
  process.exit(2);
}

const text = args.file ? fs.readFileSync(args.file, 'utf8') : execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 1 << 30 });
const failures = [];
const fail = (msg) => failures.push(msg);

const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
if (!m) {
  console.error('FAIL: no frontmatter block at start of clip');
  process.exit(1);
}
let fm;
try {
  fm = parseYaml(m[1]);
} catch (err) {
  console.error('FAIL: frontmatter is not valid YAML:', err.message);
  process.exit(1);
}
const body = m[2];

for (const k of ['title', 'url', 'type']) if (!fm[k]) fail(`frontmatter missing ${k}`);
if (fm.type !== args.expect) fail(`type is ${JSON.stringify(fm.type)}, expected ${JSON.stringify(args.expect)}`);

// Math spans outside code: markdown escaping inside them means the TeX was mangled.
// Quoted source data (attachments, tool output, fetched pages) is reproduced verbatim and
// may legitimately contain anything, so only text the clipper produced is judged.
const prose = body
  // (?<!\/) — a self-closing <tool_result … /> has no body; don't let it open a strip.
  .replace(/^<(attachment|tool_result|tool_use|source|sync_sources)\b[^>]*(?<!\/)>[\s\S]*?^<\/\1>$/gm, '')
  .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '')
  .replace(/`[^`\n]*`/g, '');
const mathSpans = prose.match(/\$\$[^$]+\$\$|\$[^$\n]+\$/g) || [];
const mangled = mathSpans.filter((s) => {
  // Text-mode groups legitimately contain \_ (e.g. \texttt{max\_len}); judge the math around them.
  const m = s.replace(/\\(?:text\w*|mathrm|operatorname)\{[^{}]*\}/g, '');
  // An even backslash run before a command name = doubled "\" (\\alpha); an odd run (\\\hline) is valid.
  return /(?<!\\)(?:\\\\)+[A-Za-z]{2,}|\\_[{A-Za-z0-9]|\\\*/.test(m);
});
if (mangled.length) fail(`${mangled.length} math span(s) look markdown-escaped, e.g. ${mangled.slice(0, 3).join('  ')}`);

const count = (re) => (body.match(re) || []).length;
const checkCount = (label, actual, fmValue, cli) => {
  if (fmValue !== undefined && actual !== fmValue) fail(`${label}: body has ${actual}, frontmatter says ${fmValue}`);
  if (cli !== undefined && actual !== Number(cli)) fail(`${label}: body has ${actual}, expected ${cli}`);
};
if (/-conversation$/.test(fm.type)) checkCount('turns', count(/^## (Human|Assistant|System)\b/gm), fm.turns, args.turns);
if (fm.type === 'twitter-thread') {
  const threadPart = body.replace(/^<context>[\s\S]*?^<\/context>$/m, '');
  checkCount('tweets', (threadPart.match(/^<tweet\s/gm) || []).length, fm.tweet_count, args.tweets);
}
if (fm.type === 'lesswrong' || fm.type === 'alignment-forum') {
  checkCount('comments', count(/<comment\s(?![^>]*deleted="true")/g), fm.comments, args.comments);
}

const sizeKB = (Buffer.byteLength(text) / 1024).toFixed(1);
console.log(`type=${fm.type} title=${JSON.stringify(fm.title)} size=${sizeKB}KB math_spans=${mathSpans.length}`);
for (const k of ['turns', 'messages_omitted', 'tweet_count', 'context_tweets', 'comments', 'karma']) {
  if (fm[k] !== undefined) console.log(`  ${k}: ${fm[k]}`);
}
for (const w of fm.clip_warnings || []) console.log(`  warning: ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log('OK');
