// inject-files.js — scripts injected (in order) into the page for every clip.
// Single source of truth: loaded by background.js via importScripts and by tests/harness.mjs.
self.CLIPMD_FILES = [
  'lib/turndown.min.js',
  'lib/readability.min.js',
  'lib/util.js',
  'lib/latex.js',
  'lib/yaml.js',
  'lib/transcript.js',
  'toast.js',
  'extractors/lesswrong.js',
  'extractors/substack.js',
  'extractors/twitter-article.js',
  'extractors/twitter-thread.js',
  'extractors/claude-conversation.js',
  'extractors/chatgpt-conversation.js',
  'extractors/generic.js',
  'content.js',
];
