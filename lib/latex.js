(function() {
// lib/latex.js — keep rendered math as verbatim TeX through Readability + Turndown.
//
// Math elements are swapped for sentinel tokens (\ue000<n>\ue001, private-use chars that
// neither Readability nor Turndown touch); TeX is stashed and restored after Turndown.
// Inserting TeX as text instead would get markdown-escaped (x_i → x\_i, \alpha → \\alpha).
//
// Sources, best first:
//   KaTeX:       <annotation encoding="application/x-tex">
//   MathJax v2:  <script type="math/tex[; mode=display]"> next to its rendered frame
//   MathJax v3:  data-clipmd-tex, stamped on mjx-container by background.js from
//                MathJax's own source list (page world); else approximate from the DOM.
//   Substack:    <div class="latex-rendered" data-attrs='{"persistentExpression": \u2026}'>
//                (empty in the post API's body_html; the page renders it client-side)
//   MathML:      <math> with <annotation encoding="application/x-tex"> (Wikipedia & co.)

const SENTINEL = /\ue000(\d+)\ue001/g;
const RESIDUAL_MATH = '.katex, .katex-display, mjx-container, .MathJax, .MathJax_Display, script[type^="math/tex"], .latex-rendered, .mwe-math-element, math';
// Wikipedia wraps every annotation as {\displaystyle \u2026}: a rendering hint, not the author's TeX.
// Strip it only when that opening brace closes at the very end ({\displaystyle a}{b} stays).
function stripDisplaystyle(tex) {
  const m = /^\{\\displaystyle\s*/.exec(tex);
  if (!m) return tex;
  let depth = 0;
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === '\\') { i++; continue; }  // \{ and \} are literal braces
    if (tex[i] === '{') depth++;
    else if (tex[i] === '}' && --depth === 0) return i === tex.length - 1 ? tex.slice(m[0].length, -1) : tex;
  }
  return tex;
}
// '%' starts a TeX comment unless escaped by an odd number of backslashes (\% vs \\%).
const TEX_COMMENT = /(^|[^\\])(\\\\)*%/;

window.ClipMD = window.ClipMD || {};

window.ClipMD.createMathStash = function() {
  const stash = [];

  function replace(el, tex, display) {
    const doc = el.ownerDocument;
    const token = doc.createTextNode(`\ue000${stash.length}\ue001`);
    stash.push({ tex: tex.trim(), display });
    if (display) {
      const block = doc.createElement('div');
      block.appendChild(token);
      el.replaceWith(block);
    } else {
      el.replaceWith(token);
    }
  }

  // Replace every math element under `root` (in place). `root` may be a Document.
  function protect(root, warnings) {
    // Static lists: elements inside an already-replaced ancestor are skipped via contains().
    const all = (sel) => [...root.querySelectorAll(sel)];

    // KaTeX — display first so the inner .katex goes with its wrapper.
    for (const el of all('.katex-display, .katex')) {
      if (!root.contains(el)) continue;
      const a = el.querySelector('annotation[encoding="application/x-tex"]');
      if (a) replace(el, a.textContent, el.classList.contains('katex-display'));
    }

    // MathJax v2: script holds the TeX; preceding siblings are its preview + rendered frame.
    for (const script of all('script[type^="math/tex"]')) {
      if (!root.contains(script)) continue;
      let prev = script.previousElementSibling;
      while (prev && /(^|\s)MathJax(_\w+)?(\s|$)/.test(prev.className)) {
        const next = prev.previousElementSibling;
        prev.remove();
        prev = next;
      }
      replace(script, script.textContent, /mode=display/.test(script.type));
    }

    // MathJax v3/v4.
    let approximated = 0;
    for (const c of all('mjx-container')) {
      if (!root.contains(c)) continue;
      const display = c.getAttribute('display') === 'true' || c.getAttribute('data-clipmd-display') === 'true';
      const tex = c.getAttribute('data-clipmd-tex');
      if (tex != null) { replace(c, tex, display); continue; }
      // Whitespace-only reconstructions (e.g. SVG output) would emit "$ $"; leave for the residual count.
      const approx = mjxToLatex(c.querySelector('mjx-math') || c);
      if (approx.trim()) { replace(c, approx, display); approximated++; }
    }
    if (approximated) warnings.push(`${approximated} MathJax v3 formula(s) reconstructed from rendered glyphs (source TeX unavailable) — verify`);

    // Substack LaTeX blocks.
    for (const el of all('.latex-rendered[data-attrs]')) {
      let tex;
      try {
        tex = JSON.parse(el.getAttribute('data-attrs')).persistentExpression;
      } catch (err) {
        warnings.push(`Substack LaTeX block with unparseable data-attrs: ${err.message}`);
        continue;
      }
      if (typeof tex === 'string' && tex.trim()) replace(el, tex, true);
    }

    // Plain MathML with a TeX annotation (after KaTeX, whose .katex-mathml is the same shape).
    // Wikipedia's .mwe-math-element also carries a fallback <img alt="TeX">; replace the lot.
    for (const math of all('math')) {
      if (!root.contains(math)) continue;
      const a = math.querySelector('annotation[encoding="application/x-tex"]');
      if (!a) continue;
      const tex = a.textContent.trim();
      replace(math.closest('.mwe-math-element') || math, stripDisplaystyle(tex), math.getAttribute('display') === 'block');
    }

    // Count outermost leftovers only (a .katex-display and its inner .katex are one formula).
    const residual = all(RESIDUAL_MATH)
      .filter((el) => root.contains(el) && !el.parentElement?.closest(RESIDUAL_MATH)).length;
    if (residual) warnings.push(`${residual} math element(s) had no recoverable TeX and were left as rendered text`);
    return root;
  }

  function restore(markdown) {
    return markdown.replace(SENTINEL, (_, i) => {
      const { tex, display } = stash[Number(i)];
      // Newlines are TeX whitespace; collapsing keeps the formula inside its markdown line
      // (lists, blockquotes). A '%' comment would swallow the rest of the line, so keep those.
      const t = TEX_COMMENT.test(tex) ? tex : tex.replace(/\s*\n\s*/g, ' ');
      return display ? `$$${t}$$` : `$${t}$`;
    });
  }

  return { protect, restore };
};

// --- MathJax v3 CHTML → approximate LaTeX (only when the source TeX is unavailable) ---

function cpToLatex(cp) {
  if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCharCode(65 + cp - 0x1D434);  // italic A-Z
  if (cp >= 0x1D44E && cp <= 0x1D467) return String.fromCharCode(97 + cp - 0x1D44E);  // italic a-z
  if (cp === 0x210E) return 'h';                                                          // italic h hole
  if (cp >= 0x1D400 && cp <= 0x1D419) return '\\mathbf{' + String.fromCharCode(65 + cp - 0x1D400) + '}';
  if (cp >= 0x1D41A && cp <= 0x1D433) return '\\mathbf{' + String.fromCharCode(97 + cp - 0x1D41A) + '}';
  if (cp >= 0x1D468 && cp <= 0x1D481) return String.fromCharCode(65 + cp - 0x1D468);  // bold italic
  if (cp >= 0x1D482 && cp <= 0x1D49B) return String.fromCharCode(97 + cp - 0x1D482);
  if (cp >= 0x1D49C && cp <= 0x1D4B5) return '\\mathcal{' + String.fromCharCode(65 + cp - 0x1D49C) + '}';
  if (SYMBOLS[cp]) return SYMBOLS[cp];
  if (cp >= 0x20 && cp <= 0x7E) return String.fromCharCode(cp);
  return String.fromCodePoint(cp);
}

const SYMBOLS = {
  0x1D6FC: '\\alpha', 0x1D6FD: '\\beta', 0x1D6FE: '\\gamma', 0x1D6FF: '\\delta',
  0x1D700: '\\epsilon', 0x1D701: '\\zeta', 0x1D702: '\\eta', 0x1D703: '\\theta',
  0x1D704: '\\iota', 0x1D705: '\\kappa', 0x1D706: '\\lambda', 0x1D707: '\\mu',
  0x1D708: '\\nu', 0x1D709: '\\xi', 0x1D70B: '\\pi', 0x1D70C: '\\rho',
  0x1D70D: '\\varsigma', 0x1D70E: '\\sigma', 0x1D70F: '\\tau', 0x1D710: '\\upsilon',
  0x1D711: '\\phi', 0x1D712: '\\chi', 0x1D713: '\\psi', 0x1D714: '\\omega', 0x1D715: '\\partial',
  0x0393: '\\Gamma', 0x0394: '\\Delta', 0x0398: '\\Theta', 0x039B: '\\Lambda', 0x039E: '\\Xi',
  0x03A0: '\\Pi', 0x03A3: '\\Sigma', 0x03A6: '\\Phi', 0x03A8: '\\Psi', 0x03A9: '\\Omega',
  0x22C5: '\\cdot', 0x00D7: '\\times', 0x00F7: '\\div', 0x2212: '-',
  0x2264: '\\leq', 0x2265: '\\geq', 0x226A: '\\ll', 0x226B: '\\gg',
  0x2260: '\\neq', 0x2248: '\\approx', 0x223C: '\\sim', 0x2261: '\\equiv',
  0x221E: '\\infty', 0x2208: '\\in', 0x2209: '\\notin', 0x2282: '\\subset',
  0x222B: '\\int', 0x2211: '\\sum', 0x220F: '\\prod',
  0x2200: '\\forall', 0x2203: '\\exists', 0x00AC: '\\neg', 0x2227: '\\land', 0x2228: '\\lor',
  0x2192: '\\to', 0x21D2: '\\Rightarrow', 0x27F9: '\\Longrightarrow',
  0x2217: '*', 0x2032: "'", 0x2033: "''", 0x2225: '\\|', 0x27E8: '\\langle', 0x27E9: '\\rangle',
  0x2026: '\\ldots', 0x22EF: '\\cdots', 0x221A: '\\sqrt', 0x2202: '\\partial', 0x2207: '\\nabla',
  0x00A0: ' ',
};

const SKIP_TAGS = new Set(['mjx-spacer', 'mjx-mark', 'mjx-tstrut', 'mjx-dstrut', 'mjx-nstrut', 'mjx-line', 'mjx-assistive-mml']);

function mjxToLatex(el) {
  if (!el) return '';
  if (el.nodeType === 3) return el.textContent;
  const tag = el.tagName?.toLowerCase() || '';
  const kids = () => Array.from(el.children);

  if (SKIP_TAGS.has(tag)) return '';
  if (tag === 'mjx-c') {
    const m = /mjx-c([0-9A-F]+)/i.exec(el.className || '');
    return m && parseInt(m[1], 16) > 0 ? cpToLatex(parseInt(m[1], 16)) : el.textContent || '';
  }
  if (tag === 'mjx-mfrac') {
    return '\\frac{' + mjxToLatex(el.querySelector('mjx-num')) + '}{' + mjxToLatex(el.querySelector('mjx-den')) + '}';
  }
  if ((tag === 'mjx-msup' || tag === 'mjx-msub') && kids().length >= 2) {
    const k = kids();
    return mjxToLatex(k[0]) + (tag === 'mjx-msup' ? '^{' : '_{') + mjxToLatex(k[k.length - 1]) + '}';
  }
  if (tag === 'mjx-msubsup') {
    const base = kids()[0] ? mjxToLatex(kids()[0]) : '';
    const script = el.querySelector('mjx-script');
    if (script && script.children.length >= 2) {
      return base + '_{' + mjxToLatex(script.children[1]) + '}^{' + mjxToLatex(script.children[0]) + '}';
    }
    return base;
  }
  if (tag === 'mjx-msqrt') return '\\sqrt{' + mjxToLatex(el.querySelector('mjx-box') || el) + '}';

  let out = '';
  for (const child of el.childNodes) out += mjxToLatex(child);
  return out;
}
})();
