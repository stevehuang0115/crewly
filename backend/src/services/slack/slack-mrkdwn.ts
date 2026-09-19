/**
 * Markdown → Slack mrkdwn.
 *
 * Agents write GitHub-flavoured markdown (`**bold**`, `# heading`, `- item`,
 * `[text](url)`) and, when they pass a reply through a shell argument, the
 * newlines often arrive as the two characters `\n`. Slack renders none of
 * that: it wants `*bold*`, no headings, `•` bullets, `<url|text>` links and
 * real newlines. Code fences and inline code are left untouched.
 *
 * @module services/slack/slack-mrkdwn
 */

/**
 * Convert markdown to Slack mrkdwn.
 *
 * @param text - Markdown (possibly with literal `\n` sequences)
 * @returns Text Slack renders as intended
 *
 * @example
 * toSlackMrkdwn('**Done**\\n\\n- one') // '*Done*\n\n• one'
 */
export function toSlackMrkdwn(text: string): string {
  if (!text) return text;
  // Split on code fences so nothing inside them is rewritten.
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : convertProse(part)))
    .join('');
}

function convertProse(text: string): string {
  // Literal "\n" from shell quoting → real newline (only when the text has
  // no real newlines to begin with, so genuine escaped sequences in prose
  // that already wraps are left alone).
  let out = text.includes('\n') ? text : text.replace(/\\n/g, '\n');
  // Inline code is opaque too.
  const segments = out.split(/(`[^`\n]*`)/g);
  out = segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg;
      let s = seg;
      // Headings → bold line.
      s = s.replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '*$1*');
      // Links: [text](url) → <url|text>.
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
      // Bold: **x** / __x__ → *x*.
      s = s.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '*$1*');
      // Strikethrough: ~~x~~ → ~x~.
      s = s.replace(/~~(.+?)~~/g, '~$1~');
      // Bullets: "- item" / "* item" at line start → "• item" (keep indent).
      s = s.replace(/^(\s*)[-*]\s+(?=\S)/gm, '$1• ');
      return s;
    })
    .join('');
  return out;
}
