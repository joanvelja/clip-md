(function() {
window.ClipMD = window.ClipMD || { extractors: {} };
window.ClipMD.extractors = window.ClipMD.extractors || {};

const EXPAND_TIMEOUT_MS = 3000;
const ARTIFACT_PANEL_TIMEOUT_MS = 3000;
const DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}$|^(Today|Yesterday)$/;
const SEL = {
  convContainer: '.flex-1.flex.flex-col.px-4.max-w-3xl',
  userMsg: '[data-testid="user-message"]',
  streaming: '[data-is-streaming]',
  fontResponse: '.font-claude-response',
  standardMarkdown: '.standard-markdown',
  chatTitle: '[data-testid="chat-title-button"]',
  collapsibleBtn: 'button[aria-expanded]',
  blockGrid: 'div[class*="grid-rows"]',
  artifactRegion: '[role="region"].bg-bg-000',
  artifactContent: '[role="region"] .standard-markdown',
};
// Claude wraps thinking segments in a `transition-[max-height]` collapsible
// container. Response fragments sit outside it. This class is our only
// reliable boundary since Claude's Tailwind utility classes are otherwise
// brittle to layout tweaks.
const THINKING_WRAPPER_CLASS = 'transition-[max-height]';
const ARTIFACT_MARKER_CLASS = 'my-3';

// Timestamps live in a hover-only span inside human turns; no stable selector
// exists, so we scan spans for a date-shaped string.
function extractTimestamp(turnEl) {
  for (const span of turnEl.querySelectorAll('span')) {
    const text = span.textContent?.trim();
    if (text && DATE_RE.test(text)) return text;
  }
  return '';
}

// Artifact cards are the only font-claude-response children that have a
// direct <button aria-label>; everything else is the grid-rows wrapper.
function isArtifactCard(block) {
  if (!(block.className || '').includes(ARTIFACT_MARKER_CLASS)) return false;
  const btn = block.querySelector(':scope > button');
  return !!(btn && btn.getAttribute('aria-label'));
}

function getBlockGrid(block) {
  return block.querySelector(SEL.blockGrid);
}

function getBlockSummary(block) {
  return getBlockGrid(block)?.querySelector(SEL.collapsibleBtn)?.textContent?.trim() || '';
}

function partitionBlockMds(block) {
  const allMds = [...block.querySelectorAll(SEL.standardMarkdown)];
  const thinkingSet = new Set(block.querySelectorAll(`[class*="${THINKING_WRAPPER_CLASS}"] ${SEL.standardMarkdown}`));
  const thinking = [];
  const response = [];
  for (const md of allMds) {
    if (thinkingSet.has(md)) thinking.push(md);
    else response.push(md);
  }
  return { thinking, response };
}

async function expandAllBlocks(blocks) {
  const targets = [];
  for (const block of blocks) {
    const btn = block.querySelector(SEL.collapsibleBtn);
    if (!btn || btn.getAttribute('aria-expanded') === 'true') continue;
    targets.push({ block, before: block.querySelectorAll(SEL.standardMarkdown).length });
    btn.click();
  }
  if (targets.length === 0) return;
  const root = blocks[0].parentElement || document.body;
  await window.ClipMD.waitForMutation(root, {
    timeoutMs: EXPAND_TIMEOUT_MS,
    predicate: () => targets.every(({ block, before }) =>
      block.querySelectorAll(SEL.standardMarkdown).length > before),
  });
}

async function extractArtifactContent(button) {
  const getContent = () => document.querySelector(SEL.artifactContent);
  const beforeText = getContent()?.textContent?.substring(0, 80) || '';
  button.click();
  await window.ClipMD.waitForMutation(document.body, {
    timeoutMs: ARTIFACT_PANEL_TIMEOUT_MS,
    predicate: () => {
      const el = getContent();
      return !!el && (el.textContent?.substring(0, 80) || '') !== beforeText;
    },
  });
  const md = getContent();
  if (!md) return null;
  const clone = md.cloneNode(true);
  const region = document.querySelector(SEL.artifactRegion);
  region?.querySelector('button[aria-label="Close" i]')?.click();
  await window.ClipMD.waitForMutation(document.body, {
    timeoutMs: 1000,
    predicate: () => !document.querySelector(SEL.artifactRegion),
  });
  return clone;
}

function appendTurnHeader(article, role, dateText) {
  const h2 = document.createElement('h2');
  h2.textContent = role + (dateText ? ' \u2014 ' + dateText : '');
  article.appendChild(h2);
}

window.ClipMD.extractors.claudeConversation = {
  canHandle() {
    return window.location.hostname === 'claude.ai' &&
           /\/chat\//.test(window.location.pathname) &&
           !!document.querySelector(SEL.userMsg);
  },

  priority: 35,

  async extract() {
    const title = document.querySelector(SEL.chatTitle)?.textContent?.trim() ||
                  document.title.replace(/\s*-\s*Claude\s*$/, '').trim();
    const url = window.ClipMD.getCanonicalUrl();

    const convContainer = document.querySelector(SEL.convContainer);
    if (!convContainer) return null;

    const article = document.createElement('article');
    let turnCount = 0;
    let firstDate = '';
    const artifactQueue = [];

    for (const child of convContainer.children) {
      const isHuman = !!child.querySelector(SEL.userMsg);
      const isAssistant = !!child.querySelector(SEL.streaming);
      if (!isHuman && !isAssistant) continue;

      turnCount++;

      if (isHuman) {
        const dateText = extractTimestamp(child);
        if (!firstDate && dateText) firstDate = dateText;
        appendTurnHeader(article, 'Human', dateText);
        const userMsg = child.querySelector(SEL.userMsg);
        if (userMsg) window.ClipMD.cloneChildrenInto(article, userMsg);
        article.appendChild(document.createElement('hr'));
        continue;
      }

      appendTurnHeader(article, 'Assistant', '');
      const fontDiv = child.querySelector(SEL.fontResponse);
      if (!fontDiv) continue;

      const gridBlocks = [];
      const turnBlockMetas = [];
      for (const block of fontDiv.children) {
        if (isArtifactCard(block)) {
          const label = block.querySelector(':scope > button').getAttribute('aria-label');
          const bq = document.createElement('blockquote');
          bq.textContent = 'Artifact: ' + label.replace(/\.\s*Open\s+\w+\s+panel\.?\s*$/i, '').trim();
          article.appendChild(bq);
          const btn = block.querySelector(':scope > button');
          if (btn && !btn.disabled) artifactQueue.push({ button: btn, placeholder: bq });
          turnBlockMetas.push({ kind: 'artifact' });
          continue;
        }
        const summary = getBlockSummary(block);
        turnBlockMetas.push({ kind: 'grid', block, summary });
        gridBlocks.push(block);
      }

      await expandAllBlocks(gridBlocks);

      for (const meta of turnBlockMetas) {
        if (meta.kind !== 'grid') continue;
        const { thinking, response } = partitionBlockMds(meta.block);
        if (meta.summary || thinking.length > 0) {
          const bq = document.createElement('blockquote');
          if (meta.summary) {
            const strong = document.createElement('strong');
            strong.textContent = 'Thinking: ' + meta.summary;
            bq.appendChild(strong);
          }
          for (const tmd of thinking) window.ClipMD.cloneChildrenInto(bq, tmd);
          article.appendChild(bq);
        }
        for (const rmd of response) window.ClipMD.cloneChildrenInto(article, rmd);
      }

      article.appendChild(document.createElement('hr'));
    }

    const savedScrollY = window.scrollY;
    for (const { button, placeholder } of artifactQueue) {
      const content = await extractArtifactContent(button);
      if (!content) continue;
      const replacement = document.createElement('blockquote');
      const strong = document.createElement('strong');
      strong.textContent = placeholder.textContent;
      replacement.appendChild(strong);
      window.ClipMD.cloneChildrenInto(replacement, content);
      placeholder.replaceWith(replacement);
    }
    window.scrollTo(0, savedScrollY);

    return {
      title,
      url,
      date: firstDate || window.ClipMD.todayISO(),
      type: 'claude-conversation',
      meta: { turns: turnCount },
      content: article,
    };
  },
};
})();
