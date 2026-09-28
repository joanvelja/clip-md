// tests/harness.mjs — load the extension's injected scripts into a jsdom page.
// Same files, same order as a real clip (inject-files.js).
import { JSDOM } from 'jsdom';
import { parse as parseYaml } from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const ROOT = path.resolve(import.meta.dirname, '..');

export function injectFiles() {
  const ctx = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'inject-files.js'), 'utf8'), ctx);
  return ctx.self.CLIPMD_FILES;
}

// Returns the jsdom window with window.ClipMD populated.
// `fetch` (optional) replaces window.fetch — jsdom has none.
export function loadPage({ html = '<!doctype html><html><head></head><body></body></html>', url = 'https://example.com/', fetch } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (fetch) w.fetch = fetch;
  for (const f of injectFiles()) w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  return w;
}

// Minimal fetch stub: routes is [[RegExp|string, handler(url, opts) => {status, body}], ...].
// Unrouted requests fail the test loudly.
export function fetchStub(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [pat, handler] of routes) {
      const hit = typeof pat === 'string' ? String(url).includes(pat) : pat.test(String(url));
      if (!hit) continue;
      const { status = 200, body } = await handler(String(url), opts);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      };
    }
    throw new Error(`fetchStub: unrouted request ${url}`);
  };
  fn.calls = calls;
  return fn;
}

// Split clip output into { frontmatter (parsed YAML), body }. Throws on malformed output.
export function splitClip(markdown) {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(markdown);
  if (!m) throw new Error('clip output has no frontmatter block');
  return { frontmatter: parseYaml(m[1]), body: m[2] };
}
