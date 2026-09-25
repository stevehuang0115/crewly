# pdf-tools — agent instructions

- **Making a document someone will read:** write Markdown (or styled HTML when
  layout matters), then `render`. Check the result: `info` for the page count,
  and open or `read` it before sending. Send the file itself (`core/attach-file`),
  not a path.
- **Someone sent a PDF:** `read` it (with `pages` for long files, `textFile` to
  keep all of it) before answering. If the result has a `note` about no text
  layer, say the PDF is scanned instead of guessing its content.
- **Several parts** (cover + body + appendix): pass them as `inputs` in order;
  existing PDFs can be parts too.
- **`needsSetup: true`** in any result: tell the user in one line that you are
  installing the PDF tools (about 3 minutes), run
  `install-skill --id pdf-tools`, and continue when `[SKILL INSTALLED]` arrives.
