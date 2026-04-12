(function() {
window.ClipMD = window.ClipMD || { extractors: {} };
window.ClipMD.extractors = window.ClipMD.extractors || {};

const PANEL_TIMEOUT_MS = 3000;
const MORE_BTN_WAIT_MS = 1500;
const SEL = {
  turn: '[data-testid^="conversation-turn-"]',
  role: '[data-message-author-role]',
  markdown: '.markdown',
  userText: '.whitespace-pre-wrap',
  panel: '[data-testid="screen-threadFlyOut"]',
  panelClose: 'button[aria-label="Close"]',
  codeMirror: '.cm-content',
  langHeader: 'div[class*="max-w"]',
};
const THINKING_LABEL_RE = /^Thought for\b|^Thinking\b|^Reasoning\b/i;
const MORE_BTN_RE = /^\d+\s+more$/;
const LANG_LABEL_RE = /^[A-Za-z][\w+#.-]*$/;
const MAX_LANG_LABEL_LEN = 20;

// ChatGPT wraps code in a CodeMirror editor with a language-label header
// sibling. pre.textContent concatenates the label with the code, breaking
// Turndown. Rebuild pre -> code from the .cm-content span tree.
function normalizeCodeBlocks(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const cm = pre.querySelector(SEL.codeMirror);
    if (!cm) continue;

    const headerText = pre.querySelector(SEL.langHeader)?.textContent?.trim() || '';
    const lang = (LANG_LABEL_RE.test(headerText) && headerText.length < MAX_LANG_LABEL_LEN)
      ? headerText.toLowerCase() : '';

    let code = '';
    for (const node of cm.childNodes) {
      if (node.nodeType === 3) code += node.textContent;
      else if (node.nodeType === 1) code += node.tagName === 'BR' ? '\n' : node.textContent;
    }

    const newPre = document.createElement('pre');
    const newCode = document.createElement('code');
    if (lang) newCode.className = 'language-' + lang;
    newCode.textContent = code;
    newPre.appendChild(newCode);
    pre.replaceWith(newPre);
  }
}

function getPanel() {
  return document.querySelector(SEL.panel);
}

function findThinkingButton(turn) {
  return [...turn.querySelectorAll('button')]
    .find(b => THINKING_LABEL_RE.test(b.textContent?.trim() || ''));
}

async function expandAllMoreButtons(panel) {
  const btns = [...panel.querySelectorAll('button')]
    .filter(b => MORE_BTN_RE.test(b.textContent?.trim() || ''));
  if (btns.length === 0) return;
  for (const btn of btns) btn.click();
  await window.ClipMD.waitForMutation(panel, {
    timeoutMs: MORE_BTN_WAIT_MS,
    predicate: () => !panel.querySelector('button') ||
      ![...panel.querySelectorAll('button')].some(b => MORE_BTN_RE.test(b.textContent?.trim() || '')),
  });
}

async function captureThinkingForTurn(turn) {
  const btn = findThinkingButton(turn);
  if (!btn) return null;

  const label = btn.textContent?.trim() || '';
  // Fingerprint on first .markdown identity — text-length comparison fails
  // when consecutive turns happen to produce same-length summaries.
  const prevFirstMd = getPanel()?.querySelector(SEL.markdown) || null;

  btn.click();
  await window.ClipMD.waitForMutation(document.body, {
    timeoutMs: PANEL_TIMEOUT_MS,
    predicate: () => {
      const firstMd = getPanel()?.querySelector(SEL.markdown);
      return !!firstMd && firstMd !== prevFirstMd;
    },
  });

  const panel = getPanel();
  if (!panel) return { label, content: null };
  await expandAllMoreButtons(panel);

  const panelMds = [...panel.querySelectorAll(SEL.markdown)];
  if (panelMds.length === 0) return { label, content: null };

  const container = document.createElement('div');
  for (const md of panelMds) window.ClipMD.cloneChildrenInto(container, md);
  return { label, content: container };
}

function appendTurnHeader(article, role) {
  const h2 = document.createElement('h2');
  h2.textContent = role;
  article.appendChild(h2);
}

window.ClipMD.extractors.chatgptConversation = {
  canHandle() {
    const host = window.location.hostname;
    if (host !== 'chatgpt.com' && host !== 'chat.openai.com') return false;
    return !!document.querySelector(SEL.turn);
  },

  priority: 35,

  async extract() {
    const title = document.title.replace(/\s*[-\u2013\u2014]\s*ChatGPT\s*$/, '').trim() ||
                  'ChatGPT conversation';
    const url = window.ClipMD.getCanonicalUrl();

    const turns = [...document.querySelectorAll(SEL.turn)];
    if (turns.length === 0) return null;

    const article = document.createElement('article');
    let turnCount = 0;

    for (const turn of turns) {
      const roleEl = turn.querySelector(SEL.role);
      const role = roleEl?.getAttribute('data-message-author-role');
      if (!role) continue;

      turnCount++;

      if (role === 'user') {
        appendTurnHeader(article, 'Human');
        const contentEl = roleEl.querySelector(SEL.markdown) ||
                          roleEl.querySelector(SEL.userText);
        if (contentEl) window.ClipMD.cloneChildrenInto(article, contentEl);
        article.appendChild(document.createElement('hr'));
        continue;
      }

      if (role === 'assistant') {
        appendTurnHeader(article, 'Assistant');
        const thinking = await captureThinkingForTurn(turn);
        if (thinking) {
          const bq = document.createElement('blockquote');
          if (thinking.label) {
            const strong = document.createElement('strong');
            strong.textContent = 'Thinking: ' + thinking.label;
            bq.appendChild(strong);
          }
          if (thinking.content) window.ClipMD.cloneChildrenInto(bq, thinking.content);
          article.appendChild(bq);
        }
        const assistantMd = roleEl.querySelector(SEL.markdown);
        if (assistantMd) window.ClipMD.cloneChildrenInto(article, assistantMd);
        article.appendChild(document.createElement('hr'));
      }
    }

    getPanel()?.querySelector(SEL.panelClose)?.click();
    normalizeCodeBlocks(article);

    return {
      title,
      url,
      date: window.ClipMD.todayISO(),
      type: 'chatgpt-conversation',
      meta: { turns: turnCount },
      content: article,
    };
  },
};
})();
