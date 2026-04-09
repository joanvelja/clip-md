(function() {
window.ClipMD = window.ClipMD || {};

window.ClipMD.preprocessLatex = function (contentEl) {
  const clone = contentEl.cloneNode(true);

  // --- Display math FIRST (prevents double-processing inline .katex inside .katex-display) ---
  clone.querySelectorAll('.katex-display').forEach((el) => {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    if (!annotation) {
      console.warn('katex-display element missing annotation, skipping:', el);
      return;
    }
    const tex = annotation.textContent;
    el.replaceWith(document.createTextNode('\n\n$$' + tex + '$$\n\n'));
  });

  // --- Then inline math (remaining .katex not already removed with their .katex-display parent) ---
  clone.querySelectorAll('.katex').forEach((el) => {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    if (!annotation) {
      console.warn('katex element missing annotation, skipping:', el);
      return;
    }
    const tex = annotation.textContent;
    el.replaceWith(document.createTextNode('$' + tex + '$'));
  });

  // --- MathJax fallback ---

  // Display MathJax
  clone.querySelectorAll('.MathJax_Display').forEach((el) => {
    const script = el.querySelector('script[type="math/tex; mode=display"]');
    if (!script) {
      console.warn('MathJax_Display element missing script, skipping:', el);
      return;
    }
    const tex = script.textContent;
    el.replaceWith(document.createTextNode('\n\n$$' + tex + '$$\n\n'));
  });

  // Inline MathJax
  clone.querySelectorAll('.MathJax').forEach((el) => {
    const script = el.querySelector('script[type="math/tex"]');
    if (!script) {
      console.warn('MathJax element missing script, skipping:', el);
      return;
    }
    const tex = script.textContent;
    el.replaceWith(document.createTextNode('$' + tex + '$'));
  });

  // Standalone math/tex scripts (not inside .MathJax or .MathJax_Display)
  clone.querySelectorAll('script[type="math/tex"]').forEach((script) => {
    const tex = script.textContent;
    script.replaceWith(document.createTextNode('$' + tex + '$'));
  });

  clone.querySelectorAll('script[type="math/tex; mode=display"]').forEach((script) => {
    const tex = script.textContent;
    script.replaceWith(document.createTextNode('\n\n$$' + tex + '$$\n\n'));
  });

  // --- MathJax v3 CHTML (mjx-container) ---
  // Source TeX is consumed by MathJax v3. Try multiple recovery strategies.

  // Build MathJax v3 source lookup (O(n) once, not O(n²) per container)
  let mjxSourceMap = null;
  if (typeof MathJax !== 'undefined' && MathJax.startup?.document?.math) {
    try {
      mjxSourceMap = new Map();
      for (const item of MathJax.startup.document.math.toArray()) {
        if (item.typesetRoot && item.math) {
          mjxSourceMap.set(item.typesetRoot, item.math);
        }
      }
    } catch (e) { mjxSourceMap = null; }
  }

  clone.querySelectorAll('mjx-container').forEach((container) => {
    const isDisplay = container.getAttribute('display') === 'true';
    const wrap = (tex) => isDisplay ? '\n\n$$' + tex + '$$\n\n' : '$' + tex + '$';

    // Strategy 1: aria-label
    const ariaLabel = container.getAttribute('aria-label');
    if (ariaLabel) {
      container.replaceWith(document.createTextNode(wrap(ariaLabel)));
      return;
    }

    // Strategy 2: MathJax internal state (pre-built map)
    if (mjxSourceMap) {
      const tex = mjxSourceMap.get(container);
      if (tex) {
        container.replaceWith(document.createTextNode(wrap(tex)));
        return;
      }
    }

    // Strategy 3: Unicode approximation from mjx-* element tree
    const text = mjxToLatex(container.querySelector('mjx-math') || container);
    if (text) {
      container.replaceWith(document.createTextNode(wrap(text)));
    }
  });

  // Remove any MathJax <style> tags that pollute the output
  clone.querySelectorAll('style').forEach((s) => {
    if (s.textContent.includes('mjx-') || s.textContent.includes('MathJax')) {
      s.remove();
    }
  });

  return clone;
};

// Reconstruct approximate LaTeX from MathJax v3 CHTML element tree.
// Maps Unicode math codepoints back to ASCII + LaTeX commands.
// Lossy (no source TeX available) but produces valid, re-renderable LaTeX.

// Unicode math → ASCII/LaTeX mapping for mjx-c codepoints
function cpToLatex(cp) {
  // Math italic A-Z (1D434-1D44D)
  if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCharCode(65 + cp - 0x1D434);
  // Math italic a-z (1D44E-1D467), with hole at h (1D455 is missing, replaced by ℎ 210E)
  if (cp >= 0x1D44E && cp <= 0x1D467) return String.fromCharCode(97 + cp - 0x1D44E);
  if (cp === 0x210E) return 'h';
  // Math bold A-Z (1D400-1D419)
  if (cp >= 0x1D400 && cp <= 0x1D419) return '\\mathbf{' + String.fromCharCode(65 + cp - 0x1D400) + '}';
  // Math bold a-z (1D41A-1D433)
  if (cp >= 0x1D41A && cp <= 0x1D433) return '\\mathbf{' + String.fromCharCode(97 + cp - 0x1D41A) + '}';
  // Math bold italic A-Z (1D468-1D481)
  if (cp >= 0x1D468 && cp <= 0x1D481) return String.fromCharCode(65 + cp - 0x1D468);
  // Math bold italic a-z (1D482-1D49B)
  if (cp >= 0x1D482 && cp <= 0x1D49B) return String.fromCharCode(97 + cp - 0x1D482);
  // Script/calligraphic A-Z (1D49C-1D4B5)
  if (cp >= 0x1D49C && cp <= 0x1D4B5) return '\\mathcal{' + String.fromCharCode(65 + cp - 0x1D49C) + '}';
  // Greek italic (common range 1D6FC-1D714)
  const greekMap = {
    0x1D6FC: '\\alpha', 0x1D6FD: '\\beta', 0x1D6FE: '\\gamma', 0x1D6FF: '\\delta',
    0x1D700: '\\epsilon', 0x1D701: '\\zeta', 0x1D702: '\\eta', 0x1D703: '\\theta',
    0x1D704: '\\iota', 0x1D705: '\\kappa', 0x1D706: '\\lambda', 0x1D707: '\\mu',
    0x1D708: '\\nu', 0x1D709: '\\xi', 0x1D70B: '\\pi', 0x1D70C: '\\rho',
    0x1D70D: '\\varsigma', 0x1D70E: '\\sigma', 0x1D70F: '\\tau', 0x1D710: '\\upsilon',
    0x1D711: '\\phi', 0x1D712: '\\chi', 0x1D713: '\\psi', 0x1D714: '\\omega',
    0x1D715: '\\partial',
  };
  if (greekMap[cp]) return greekMap[cp];
  // Greek uppercase
  const greekUpper = {
    0x0393: '\\Gamma', 0x0394: '\\Delta', 0x0398: '\\Theta', 0x039B: '\\Lambda',
    0x039E: '\\Xi', 0x03A0: '\\Pi', 0x03A3: '\\Sigma', 0x03A6: '\\Phi',
    0x03A8: '\\Psi', 0x03A9: '\\Omega',
  };
  if (greekUpper[cp]) return greekUpper[cp];
  // Operators and symbols
  const opMap = {
    0x22C5: '\\cdot', 0x00D7: '\\times', 0x00F7: '\\div',
    0x2212: '-', 0x002B: '+', 0x003D: '=',
    0x2264: '\\leq', 0x2265: '\\geq', 0x226A: '\\ll', 0x226B: '\\gg',
    0x2260: '\\neq', 0x2248: '\\approx', 0x223C: '\\sim', 0x2261: '\\equiv',
    0x221E: '\\infty', 0x2208: '\\in', 0x2209: '\\notin', 0x2282: '\\subset',
    0x222B: '\\int', 0x2211: '\\sum', 0x220F: '\\prod',
    0x2200: '\\forall', 0x2203: '\\exists', 0x00AC: '\\neg', 0x2227: '\\land', 0x2228: '\\lor',
    0x2192: '\\to', 0x21D2: '\\Rightarrow', 0x27F9: '\\Longrightarrow',
    0x2217: '*', 0x2032: "'", 0x2033: "''",
    0x2225: '\\|', 0x27E8: '\\langle', 0x27E9: '\\rangle',
    0x2026: '\\ldots', 0x22EF: '\\cdots',
    0x221A: '\\sqrt', 0x2202: '\\partial', 0x2207: '\\nabla',
    0x00A0: ' ',
  };
  if (opMap[cp]) return opMap[cp];
  // Digits 0-9 (regular)
  if (cp >= 0x30 && cp <= 0x39) return String.fromCharCode(cp);
  // Basic ASCII printable
  if (cp >= 0x20 && cp <= 0x7E) return String.fromCharCode(cp);
  // Fallback: emit the Unicode character directly
  return String.fromCodePoint(cp);
}

function mjxToLatex(el) {
  if (!el) return '';
  const tag = el.tagName?.toLowerCase() || '';

  if (el.nodeType === 3) return el.textContent;

  if (tag === 'mjx-c') {
    const cls = el.className || '';
    const match = cls.match(/mjx-c([0-9A-F]+)/i);
    if (match) {
      const cp = parseInt(match[1], 16);
      if (cp > 0) return cpToLatex(cp);
    }
    return el.textContent || '';
  }

  if (tag === 'mjx-mfrac') {
    const num = el.querySelector('mjx-num, mjx-frac > :first-child');
    const den = el.querySelector('mjx-den, mjx-frac > :last-child');
    return '\\frac{' + mjxToLatex(num) + '}{' + mjxToLatex(den) + '}';
  }

  if (tag === 'mjx-msup' || (tag === 'mjx-script' && el.parentElement?.tagName?.toLowerCase() === 'mjx-msup')) {
    const children = Array.from(el.children);
    if (children.length >= 2) {
      return mjxToLatex(children[0]) + '^{' + mjxToLatex(children[children.length - 1]) + '}';
    }
  }

  if (tag === 'mjx-msub') {
    const children = Array.from(el.children);
    if (children.length >= 2) {
      return mjxToLatex(children[0]) + '_{' + mjxToLatex(children[children.length - 1]) + '}';
    }
  }

  if (tag === 'mjx-msubsup') {
    const children = Array.from(el.children);
    const base = children[0] ? mjxToLatex(children[0]) : '';
    const script = el.querySelector('mjx-script');
    if (script && script.children.length >= 2) {
      return base + '_{' + mjxToLatex(script.children[1]) + '}^{' + mjxToLatex(script.children[0]) + '}';
    }
    return base;
  }

  if (tag === 'mjx-msqrt') {
    return '\\sqrt{' + mjxToLatex(el.querySelector('mjx-box') || el) + '}';
  }

  if (tag === 'mjx-spacer' || tag === 'mjx-mark' || tag === 'mjx-tstrut' ||
      tag === 'mjx-dstrut' || tag === 'mjx-nstrut' || tag === 'mjx-line') {
    return '';
  }

  let result = '';
  for (const child of el.childNodes) {
    result += mjxToLatex(child);
  }
  return result;
}
})();
