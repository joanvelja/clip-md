# clip.md

Chrome extension. Clips web pages to Markdown on your clipboard. No server, no build step.

## What it clips

Every site extractor reads the site's own **source data** (the JSON/GraphQL its web app uses),
not the rendered DOM — rendered DOMs are virtualized, lazily loaded and restyled without notice.

| Site | Source | What you get |
|------|--------|-------------|
| **Claude.ai** | `/api/organizations/…/chat_conversations/…?tree=True` | Active branch: prompts, attachments (full extracted text), thinking (or its summaries when hidden), every tool call + result, citations |
| **ChatGPT** | `/backend-api/conversation/…` | Active branch: prompts, reasoning, tool calls + outputs, citations resolved to links, images/voice/attachments metadata |
| **X threads** | X web client's `TweetDetail` GraphQL | Author's full self-thread (long-form text, media, quotes, cards) + the conversation it replies to |
| **LessWrong / AF** | ForumMagnum GraphQL | Post markdown with LaTeX source + the complete, arbitrarily nested comment tree |
| **Substack** (incl. custom domains) | `/api/v1/posts/{slug}` | Post body, subtitle, bylines |
| **X Articles** | DOM (normalized) | Article with headings, images, video stills |
| **Everything else** | Readability | Best-effort article content |

Math on any page — KaTeX, MathJax v2, MathJax v3/v4 (source read from MathJax itself),
MathML with a TeX annotation (Wikipedia), Substack LaTeX blocks — is emitted as its verbatim
TeX source. Math with no recoverable source is flagged in `clip_warnings`, never garbled silently.

## Output

YAML frontmatter + body. Conversations and threads use XML-style tags for structure, so an
LLM agent can ingest them losslessly:

```
---
title: "Bilevel optimization in machine learning"
url: "https://claude.ai/chat/…"
date: 2026-07-30
type: claude-conversation
model: "claude-…"
turns: 10
messages_omitted: 1
clipped: 2026-09-28
---

## Human · 2026-07-30T14:02Z

<attachment name="paper.pdf" type="application/pdf">…</attachment>

prompt text

## Assistant · 2026-07-30T14:03Z

<thinking>…</thinking>

<tool_use name="web_search" id="…">…</tool_use>

response with $\LaTeX$ intact
```

`date` is the source's own date (omitted when unknown); `clipped` is when you clipped it.
Anything recoverable-but-imperfect is listed under `clip_warnings` and counted in the toast.

## Failure policy

A site extractor that can't do its job **fails the clip** with a toast naming it
(`clip.md failed: [claude-conversation] …`) and a `!` badge on the toolbar icon. It never
falls back to Readability — a wrong-but-plausible clip is worse than an error.

## Install

1. Clone this repo
2. `chrome://extensions` → Developer mode → Load unpacked → select the repo folder
3. Click the toolbar icon or press `Ctrl+Shift+M` (`Control+Shift+M` on Mac)
4. Right-click a selection → "Clip selection as Markdown"

## Development

```
npm install            # dev-only: jsdom + yaml for tests
npm test               # runs the injected scripts in jsdom, in production order
node tools/check-clip.mjs --expect claude-conversation   # validate what's on the clipboard
```

`Ctrl+Shift+.` (`Control+Shift+.` on Mac) reloads the unpacked extension from disk, so
live tests always run the working tree. Check `chrome://extensions/shortcuts` if a key
is unassigned.

## Architecture

```
background.js         Service worker: commands, injection, clipboard (offscreen), toast/badge
inject-files.js       Ordered list of scripts injected per clip (shared with tests)
content.js            Orchestrator: ClipMD.clip(mode) → dispatch → frontmatter
lib/util.js           Extractor contract + DOM/markdown helpers
lib/latex.js          Math → sentinel tokens → verbatim TeX after Turndown
lib/transcript.js     Tag/heading/fence helpers for conversations, threads, comments
lib/yaml.js           Frontmatter (strings as JSON scalars)
extractors/           One file per site: { id, matches(), extract() → { meta, markdown, warnings } }
offscreen.html/js     Clipboard write
toast.js              Notification
tests/                node --test suites (jsdom harness)
tools/check-clip.mjs  Clipboard-output validator for live testing
```

Adding a site = one file in `extractors/` implementing the contract in `lib/util.js`, plus
its entry in `inject-files.js`.

## Limitations

- ChatGPT's API doesn't return uploaded file contents; attachments are listed by name.
- MathJax v3 pages whose MathJax state is unreachable fall back to reconstructing TeX from
  rendered glyphs (flagged in `clip_warnings`).
- X threads need you to be logged in to X (the API uses your session).
- Keyboard shortcut may not work in Arc (use the toolbar icon instead).
