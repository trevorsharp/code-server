#!/usr/bin/env bun

import path from 'node:path';
import { marked } from 'marked';
import hljs from 'highlight.js';

const [inputPath, outputPath, explicitTitle] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error('Usage: render.ts <input.md> <output.html> [title]');
  process.exit(1);
}

const markdown = await Bun.file(inputPath).text();
const markdownTitle = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
const title = explicitTitle || markdownTitle || path.basename(inputPath, path.extname(inputPath));

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

marked.use({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = lang?.split(/\s+/)[0];
      const highlighted = language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text);
      const languageClass = language ? ` language-${escapeHtml(language)}` : '';
      return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>\n`;
    }
  }
});

const content = marked.parse(markdown);
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; color: #1f2328; background: #fff; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; }
    main { max-width: 900px; margin: 0 auto; padding: 32px 24px 64px; }
    h1, h2, h3, h4 { line-height: 1.25; margin: 1.5em 0 .6em; }
    h1 { margin-top: 0; }
    a { color: #0969da; }
    table { width: 100%; border-collapse: collapse; margin: 1em 0; }
    th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; }
    th { background: #f6f8fa; }
    blockquote { margin-left: 0; padding-left: 16px; color: #59636e; border-left: 4px solid #d0d7de; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
    :not(pre) > code { padding: .15em .35em; background: #eff1f3; border-radius: 3px; }
    pre { overflow-x: auto; padding: 16px; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4px; }
    .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #cf222e; }
    .hljs-string, .hljs-attr, .hljs-template-tag { color: #0a3069; }
    .hljs-title, .hljs-title.function_, .hljs-section { color: #8250df; }
    .hljs-number, .hljs-variable, .hljs-template-variable { color: #0550ae; }
    .hljs-comment, .hljs-quote { color: #6e7781; font-style: italic; }
    .hljs-built_in, .hljs-type { color: #953800; }
    img { max-width: 100%; }
    hr { border: 0; border-top: 1px solid #d0d7de; }
  </style>
</head>
<body>
  <main>
${content}
  </main>
</body>
</html>
`;

await Bun.write(outputPath, html);
