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
    const text = mjxToUnicode(container.querySelector('mjx-math') || container);
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

// Reconstruct readable Unicode text from MathJax v3 CHTML element tree.
// Not LaTeX — produces things like "(a+b)/(c·d)" and "x²" instead of
// "\frac{a+b}{c \cdot d}" and "x^2". Lossy but readable.
function mjxToUnicode(el) {
  if (!el) return '';
  const tag = el.tagName?.toLowerCase() || '';

  // Text node
  if (el.nodeType === 3) return el.textContent;

  // mjx-c: rendered character. Class name encodes Unicode codepoint.
  if (tag === 'mjx-c') {
    const cls = el.className || '';
    const match = cls.match(/mjx-c([0-9A-F]+)/i);
    if (match) {
      const cp = parseInt(match[1], 16);
      if (cp > 0) return String.fromCodePoint(cp);
    }
    // Fallback: check ::before content via getComputedStyle (expensive)
    return el.textContent || '';
  }

  // Fraction: (numerator)/(denominator)
  if (tag === 'mjx-mfrac') {
    const num = el.querySelector('mjx-num, mjx-frac > :first-child');
    const den = el.querySelector('mjx-den, mjx-frac > :last-child');
    const numText = num ? mjxToUnicode(num) : '?';
    const denText = den ? mjxToUnicode(den) : '?';
    return '(' + numText + ')/(' + denText + ')';
  }

  // Superscript
  if (tag === 'mjx-msup' || (tag === 'mjx-script' && el.parentElement?.tagName?.toLowerCase() === 'mjx-msup')) {
    const children = Array.from(el.children);
    if (children.length >= 2) {
      return mjxToUnicode(children[0]) + '^' + mjxToUnicode(children[children.length - 1]);
    }
  }

  // Subscript
  if (tag === 'mjx-msub') {
    const children = Array.from(el.children);
    if (children.length >= 2) {
      return mjxToUnicode(children[0]) + '_' + mjxToUnicode(children[children.length - 1]);
    }
  }

  // Sub+sup
  if (tag === 'mjx-msubsup') {
    const children = Array.from(el.children);
    const base = children[0] ? mjxToUnicode(children[0]) : '';
    const script = el.querySelector('mjx-script');
    if (script && script.children.length >= 2) {
      return base + '_' + mjxToUnicode(script.children[1]) + '^' + mjxToUnicode(script.children[0]);
    }
    return base;
  }

  // Spacer/mark — skip
  if (tag === 'mjx-spacer' || tag === 'mjx-mark' || tag === 'mjx-tstrut' ||
      tag === 'mjx-dstrut' || tag === 'mjx-nstrut') {
    return '';
  }

  // Default: concatenate children
  let result = '';
  for (const child of el.childNodes) {
    result += mjxToUnicode(child);
  }
  return result;
}
})();
