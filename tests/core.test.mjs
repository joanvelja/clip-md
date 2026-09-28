// Core pipeline: math survives Turndown/Readability verbatim, pre-wrap line breaks survive,
// frontmatter always parses to the exact input values, and dispatch fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, splitClip } from './harness.mjs';

const TEXES = [
  String.raw`\alpha_i = x^*_{[0,1]}`,
  String.raw`\frac{\partial L}{\partial \theta} \cdot \|\nabla f\|_2`,
  String.raw`a \# b \_ c`,
];
const katex = (tex, display) => {
  const inner = `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow>` +
    `<annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span>` +
    `<span class="katex-html" aria-hidden="true">RENDERED_GLYPHS</span></span>`;
  return display ? `<span class="katex-display">${inner}</span>` : inner;
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function md(w, html) {
  const el = w.document.createElement('div');
  el.innerHTML = html;
  const warnings = [];
  return { out: w.ClipMD.htmlToMarkdown(el, warnings), warnings };
}

test('KaTeX inline and display TeX come through verbatim, display on its own line', () => {
  const w = loadPage();
  const html = TEXES.map((t, i) => `<p>Let ${katex(esc(t))} hold.</p><p>${katex(esc(t), true)}</p>`).join('');
  const { out, warnings } = md(w, html);
  for (const t of TEXES) {
    assert.ok(out.includes(`$${t}$`), `inline ${t} missing in:\n${out}`);
    assert.match(out, new RegExp(`^\\$\\$${t.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\$\\$$`, 'm'));
  }
  assert.ok(!out.includes('RENDERED_GLYPHS'), 'rendered KaTeX glyphs leaked');
  assert.deepEqual(warnings, []);
});

test('MathJax v2 scripts replace their rendered frames (no duplicated glyph text)', () => {
  const w = loadPage();
  const html = `<p>Inline <span class="MathJax_Preview"></span><span class="MathJax" id="MathJax-Element-1-Frame">GLYPHS1</span>` +
    `<script type="math/tex" id="MathJax-Element-1">${TEXES[0]}</script> done.</p>` +
    `<span class="MathJax_Preview"></span><div class="MathJax_Display"><span class="MathJax">GLYPHS2</span></div>` +
    `<script type="math/tex; mode=display" id="MathJax-Element-2">${TEXES[1]}</script>`;
  const { out } = md(w, html);
  assert.ok(out.includes(`$${TEXES[0]}$`), out);
  assert.ok(out.includes(`$$${TEXES[1]}$$`), out);
  assert.ok(!/GLYPHS/.test(out), `rendered MathJax text leaked:\n${out}`);
});

test('MathJax v3 uses stamped source TeX; unstamped containers are approximated with a warning', () => {
  const w = loadPage();
  const html = `<p>A <mjx-container data-clipmd-tex="${esc(TEXES[0])}" data-clipmd-display="false"><mjx-math>junk</mjx-math></mjx-container></p>` +
    `<p>B <mjx-container><mjx-math><mjx-mi><mjx-c class="mjx-c1D465"></mjx-c></mjx-mi></mjx-math></mjx-container></p>`;
  const { out, warnings } = md(w, html);
  assert.ok(out.includes(`$${TEXES[0]}$`), out);
  assert.ok(out.includes('$x$'), out);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reconstructed/);
});

test('math without recoverable TeX is reported, not silently dropped', () => {
  const w = loadPage();
  const { warnings } = md(w, '<p><span class="katex"><span class="katex-html">x</span></span></p>');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no recoverable TeX/);
});

test('generic (Readability) path keeps KaTeX verbatim', async () => {
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ';
  const html = `<!doctype html><html><head><title>Math post</title></head><body><article><h1>Math post</h1>` +
    `<p>${para.repeat(4)} Consider ${katex(esc(TEXES[0]))} carefully.</p>` +
    `<p>${katex(esc(TEXES[1]), true)}</p><p>${para.repeat(4)}</p></article></body></html>`;
  const w = loadPage({ html, url: 'https://blog.example.org/post' });
  const res = await w.ClipMD.clip('full');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assert.equal(frontmatter.type, 'article');
  assert.ok(body.includes(`$${TEXES[0]}$`), body);
  assert.ok(body.includes(`$$${TEXES[1]}$$`), body);
  assert.ok(!body.includes('RENDERED_GLYPHS'), body);
});

test('pre-wrap newlines become line breaks', () => {
  const w = loadPage();
  const el = w.document.createElement('div');
  el.textContent = 'line one\nline two\n\n- not a list';
  w.ClipMD.newlinesToBr(el);
  const out = w.ClipMD.htmlToMarkdown(el, []);
  assert.deepEqual(out.split('\n').map((l) => l.trim()).filter(Boolean), ['line one', 'line two', '\\- not a list']);
});

test('frontmatter parses and round-trips hostile values exactly', () => {
  const w = loadPage();
  const nasty = ['#hashtag title', '`code` title', 'Title: with colon', 'ends with colon:', '2024', 'on', 'null',
    '  leading space', 'a,b', '~', 'tab\there', '%percent', '"quoted"', 'back\\slash', 'multi\nline', '- dash',
    '[bracket]', '{brace}', '@at', '*star', '&amp', '!bang', '|pipe', '>gt', "it's", 'emoji 🧵', '2024-01-15', '2024-13-45', 'sep\u2028arator', 'nel\u0085x'];
  for (const title of nasty) {
    const yamlText = w.ClipMD.buildFrontmatter({ title, karma: 42, date: '2026-09-28', clip_warnings: [title] });
    const { frontmatter } = splitClip(yamlText + '\nbody');
    assert.equal(frontmatter.title, title, `title ${JSON.stringify(title)} became ${JSON.stringify(frontmatter.title)}`);
    assert.deepEqual(frontmatter.clip_warnings, [title]);
    assert.equal(frontmatter.karma, 42);
  }
});

test('frontmatter rejects values it cannot represent', () => {
  const w = loadPage();
  assert.throws(() => w.ClipMD.buildFrontmatter({ title: { nested: 1 } }), /unsupported type/);
  assert.throws(() => w.ClipMD.buildFrontmatter({ 'bad key': 'x' }), /invalid key/);
  assert.throws(() => w.ClipMD.buildFrontmatter({ title: 't', date: 'Sep 28' }), /date must be YYYY-MM-DD/);
});

test('a failing site extractor fails the clip — no Readability fallback', async () => {
  const para = 'Plenty of article text so Readability would happily succeed here. '.repeat(10);
  const w = loadPage({ html: `<!doctype html><body><article><p>${para}</p></article></body>`, url: 'https://www.lesswrong.com/posts/abc123/slug' });
  w.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const res = await w.ClipMD.clip('full');
  assert.equal(res.ok, false);
  assert.match(res.error, /^\[lesswrong\] GraphQL HTTP 503/);
});

test('two site extractors claiming one page is an error', async () => {
  const w = loadPage();
  w.ClipMD.extractors.a = { id: 'a', matches: () => true, extract: async () => { throw new Error('unreachable'); } };
  w.ClipMD.extractors.b = { id: 'b', matches: () => true, extract: async () => { throw new Error('unreachable'); } };
  const res = await w.ClipMD.clip('full');
  assert.equal(res.ok, false);
  assert.match(res.error, /ambiguous page, claimed by: a, b/);
});

test('generic on a page with no article content errors instead of emitting junk', async () => {
  const w = loadPage({ html: '<!doctype html><body><nav>Home</nav></body>' });
  const res = await w.ClipMD.clip('full');
  assert.equal(res.ok, false);
  assert.match(res.error, /\[generic\] Readability found no article content/);
});

test('selection clip keeps math and parses', async () => {
  const w = loadPage({ html: `<!doctype html><body><p id="p">Pick ${katex(esc(TEXES[0]))} this.</p></body>` });
  const range = w.document.createRange();
  range.selectNodeContents(w.document.getElementById('p'));
  w.getSelection().addRange(range);
  const res = await w.ClipMD.clip('selection');
  assert.ok(res.ok, res.error);
  const { frontmatter, body } = splitClip(res.markdown);
  assert.equal(frontmatter.type, 'selection');
  assert.ok(body.includes(`$${TEXES[0]}$`), body);
});

test('TeX with a \\\\% comment keeps its newlines; plain multi-line TeX is collapsed', () => {
  const w = loadPage();
  const commented = 'a \\\\% trailing comment\n+ b';
  const plain = 'a \\\\\n+ b';
  const { out } = md(w, `<p>${katex(esc(commented), true)}</p><p>${katex(esc(plain), true)}</p>`);
  assert.ok(out.includes('$$' + commented + '$$'), out);
  assert.ok(out.includes('$$a \\\\ + b$$'), out);
});

test('MathJax v3 container with no reconstructable glyphs is not emitted as empty math', () => {
  const w = loadPage();
  const { out, warnings } = md(w, '<p>A <mjx-container><mjx-math> </mjx-math></mjx-container> B</p>');
  assert.ok(!/\$\s*\$/.test(out), out);
  assert.deepEqual(warnings.map((x) => x.match(/^\d+/)[0]), ['1']);
});

test('residual math is counted per formula, not per nested element', () => {
  const w = loadPage();
  const { warnings } = md(w, '<p><span class="katex-display"><span class="katex"><span class="katex-html">x</span></span></span></p>');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^1 math element/);
});

test('transcript tags keep first-line indentation; links escape brackets', () => {
  const w = loadPage();
  const T = w.ClipMD.transcript;
  const body = '    def f():\n        return 1';
  assert.equal(T.tag('attachment', { name: 'a.py' }, '\n' + body + '\n\n'), '<attachment name="a.py">\n' + body + '\n</attachment>');
  assert.equal(T.tag('x', {}, '  \n '), '<x />');
  assert.equal(T.link('a [b] c', 'https://e.org/x'), '[a \\[b\\] c](https://e.org/x)');
  assert.equal(T.link('', 'https://e.org/a b'), '[https://e.org/a b](<https://e.org/a b>)');
  assert.equal(T.link('spec.pdf', undefined), 'spec.pdf');
  assert.equal(T.image('line one\n\nline two', 'https://e.org/i.png'), '![line one line two](https://e.org/i.png)');
});

test('activePath reports a broken chain instead of silently treating it as the root', () => {
  const w = loadPage();
  const parent = { c: 'b', b: 'gone' };
  const warnings = [];
  const path = w.ClipMD.transcript.activePath('c', { getParent: (id) => parent[id], has: (id) => id in parent, isRoot: (p) => p === 'ROOT' }, warnings);
  assert.deepEqual([...path], ['b', 'c']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /parent gone missing/);
});

test('MathML with a TeX annotation (Wikipedia shape) → verbatim TeX, fallback image dropped', () => {
  const w = loadPage();
  const wiki = (tex, block) => {
    const kind = block ? 'block' : 'inline';
    return `<span class="mwe-math-element mwe-math-element-${kind}"><span class="mwe-math-mathml-${block ? 'display' : 'inline'} mwe-math-mathml-a11y" style="display: none;">` +
      `<math xmlns="http://www.w3.org/1998/Math/MathML"${block ? ' display="block"' : ''} alttext="${esc(tex)}"><semantics><mrow><mi>σ</mi></mrow>` +
      `<annotation encoding="application/x-tex">${esc(tex)}</annotation></semantics></math></span>` +
      `<img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/abc" class="mwe-math-fallback-image-${kind}" alt="${esc(tex)}"></span>`;
  };
  const inline = String.raw`{\displaystyle \sigma :\mathbb {R} ^{K}\to (0,1)^{K}}`;
  const block = String.raw`{\displaystyle \sigma (\mathbf {z} )_{i}={\frac {e^{z_{i}}}{\sum _{j=1}^{K}e^{z_{j}}}}\,.}`;
  const { out, warnings } = md(w, `<p>Formally ${wiki(inline)} where</p><div>${wiki(block, true)}</div>`);
  assert.ok(out.includes(String.raw`$\sigma :\mathbb {R} ^{K}\to (0,1)^{K}$`), out);
  assert.match(out, /^\$\$\\sigma \(\\mathbf \{z\} \)_\{i\}=.*\\,\.\$\$$/m);
  assert.ok(!/wikimedia|σ/.test(out), `fallback image or MathML text leaked:\n${out}`);
  assert.equal(warnings.length, 0);
});

test('MathML without a TeX source is reported as residual', () => {
  const w = loadPage();
  const { warnings } = md(w, '<p>x <math><mi>y</mi></math></p>');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^1 math element/);
});

test('{\\displaystyle …} is stripped only when it wraps the whole annotation', () => {
  const w = loadPage();
  const m = (tex) => md(w, `<p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">${esc(tex)}</annotation></semantics></math></p>`).out;
  const dollars = (s) => '$' + s + '$';
  assert.equal(m(String.raw`{\displaystyle a+\{b\}}`), dollars(String.raw`a+\{b\}`));
  assert.equal(m(String.raw`{\displaystyle a}{b}`), dollars(String.raw`{\displaystyle a}{b}`));
});
