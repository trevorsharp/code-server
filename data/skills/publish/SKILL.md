---
name: publish
description: Use when the user says "publish this", "publish that", "make this shareable", or asks to publish Markdown or an HTML page.
---

# Publish

Converts Markdown faithfully to restrained HTML with bordered tables and static syntax highlighting and publish written content as a simple, readable HTML page through Carvana Publish.

## Content Rules

- When the user says "publish this" or "publish that", use the referenced Markdown or previous answer faithfully. Do not rewrite, expand, summarize, or redesign it unless requested.
- Prefer Markdown as the source of truth. Do not manually reproduce Markdown structures as HTML.
- Keep the page content-first: semantic headings, paragraphs, lists, tables, links, blockquotes, and code blocks.
- Do not create cards, hero sections, gradients, decorative callouts, dashboards, animations, or other bespoke UI unless requested.
- The bundled renderer provides the only default styling: a centered readable container, system font, bordered tables, legible code blocks, and static syntax highlighting.

## Workflow

1. Choose a short lowercase project slug describing the content.
2. Create a working directory under `/tmp/opencode/<slug>` after verifying `/tmp/opencode` exists.
3. Write the content to `<slug>.md` with an H1 title. Preserve the user's wording and Markdown structure.
4. Render it with the bundled [render.js](./render.js) script to produce HTML.

   ```bash
   bun "render.js" "<input.md>" "<output.html>"
   ```

5. Read the generated HTML and verify the title, tables, links, and code blocks.
6. Enable the `Carvana Publish` MCP server if needed.
7. Request an upload URL for `index.html`, upload it with the returned `curl` command, and use the returned `viewUrl`. Never construct a published URL manually.
8. Set project access to `public` by default. In Carvana Publish, `public` means available to authenticated organization users. Honor explicit requests for private or user-restricted access.
9. Set a concise vanity alias when available.
10. Fetch the published URL to verify the deployed document before returning it.

## Updating Existing Pages

- Reuse the existing project name and alias when the user asks to modify a page already published in the conversation.
- Re-render from Markdown and replace `index.html`; do not hand-edit generated HTML.

## Renderer Behavior

- GitHub-flavored Markdown, including tables and task lists.
- Language-aware syntax highlighting through `highlight.js` at render time.
- No scripts, external stylesheets, fonts, CDNs, or runtime dependencies in the output.
- Raw HTML in Markdown is allowed when the user explicitly includes it.
- `render.js` is the bundled runtime. Editable TypeScript and build metadata live under `source/`.

## Failure Handling

- If a code language is unknown, render escaped code without highlighting.
- If publishing fails, retain the generated Markdown and HTML and report the exact failed step.
- Do not fall back to a custom-designed page.
