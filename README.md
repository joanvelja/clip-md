# clip.md

Chrome extension. Clips web pages to Markdown on your clipboard. No server, no build step.

## What it clips

| Site | How | What you get |
|------|-----|-------------|
| **X Articles** | Normalizes the non-standard div-based DOM to semantic HTML | Full article with headings, images, video stills |
| **X Threads** | Scrolls to unroll, captures incrementally (handles virtualized timeline) | Stitched thread with images, card links, quote tweets |
| **LessWrong / AF** | Fetches raw markdown via GraphQL API | LaTeX preserved (`$...$`, `$$...$$`), no MathJax artifacts |
| **Substack** | Score-based detection (works on custom domains like astralcodexten.com) | Full article with figures and footnotes |
| **Everything else** | Readability extraction | Best-effort article content |

Copies YAML-frontmattered Markdown to clipboard:

```
---
title: "Some Post"
url: https://example.com/post
author: someone
date: 2026-04-09
type: lesswrong
karma: 142
---

Post content with $\LaTeX$ preserved...
```

## Install

1. Clone this repo
2. `chrome://extensions` → Developer mode → Load unpacked → select the repo folder
3. Click the toolbar icon or press `Ctrl+Shift+M` (Chrome) / `Control+Shift+M` (Mac)
4. Right-click a selection → "Clip selection as Markdown"

## Architecture

MV3, ~40KB custom code + vendored Turndown and Readability.

Scripts are injected on-demand when you clip (no persistent content scripts). Pipeline: background injects libs + extractors + orchestrator → extractor detects site → LaTeX preprocessing → Turndown → YAML frontmatter → offscreen clipboard write → toast.

Adding a new site = one file in `extractors/` implementing `canHandle()`, `priority`, and `extract()`.

## Files

```
manifest.json          MV3 manifest
background.js          Service worker — commands, injection, clipboard routing
content.js             Orchestrator — extractor dispatch, Turndown, frontmatter
offscreen.html/js      Clipboard write (offscreen document, avoids focus issues)
trigger.js             Persistent content script for programmatic triggering
toast.js               Non-blocking notification
lib/latex.js           KaTeX, MathJax v2/v3 → raw LaTeX or Unicode approximation
lib/yaml.js            YAML frontmatter escaping
lib/turndown.min.js    Vendored HTML→Markdown
lib/readability.min.js Vendored article extraction
extractors/            Site-specific extractors
```

## Limitations

- X thread unrolling takes a few seconds (scrolls the page, restores position after)
- MathJax v3 on non-LW sites: source LaTeX is consumed by the renderer, so we reconstruct it from the DOM (`$J_{m} = p_{m} \cdot s_{m}$`). Close but not identical to the original source.
- Card links from X use t.co redirects (they work, but the URL is shortened)
- Keyboard shortcut may not work in Arc (use toolbar icon instead)
