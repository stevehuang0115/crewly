/**
 * remark plugin that rewrites `[[wikilink]]` and `[[wikilink|alias]]` text
 * occurrences inside markdown into link nodes pointing at a `wikilink:` URL.
 *
 * The rendered link's `href` is `wikilink:<target>` (preserved verbatim, no
 * URL-encoding) so `<WikiMarkdown>`'s anchor override can dispatch the click
 * without re-parsing.
 *
 * @module components/Wiki/wikilink-plugin
 */

import type { Plugin } from 'unified';
import type { Root, Text, PhrasingContent, Link } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

/** href scheme used for wikilink anchors. Matched by WikiMarkdown's link override. */
export const WIKILINK_HREF_SCHEME = 'wikilink:';

/** Matches `[[target]]` or `[[target|alias]]`; target/alias capture groups. */
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

/**
 * Convert one text node containing zero or more `[[wikilink]]` occurrences
 * into a sequence of (text | link) nodes. Returns null when there is no
 * wikilink so the visitor can skip the node untouched.
 */
function splitTextNode(node: Text): PhrasingContent[] | null {
  const value = node.value;
  if (!value.includes('[[')) return null;

  WIKILINK_RE.lastIndex = 0;
  const parts: PhrasingContent[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let found = false;

  while ((match = WIKILINK_RE.exec(value)) !== null) {
    found = true;
    const [full, rawTarget, rawAlias] = match;
    const target = rawTarget.trim();
    const alias = (rawAlias ?? rawTarget).trim();
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }
    const link: Link = {
      type: 'link',
      url: `${WIKILINK_HREF_SCHEME}${target}`,
      title: null,
      children: [{ type: 'text', value: alias }],
    };
    parts.push(link);
    lastIndex = match.index + full.length;
  }

  if (!found) return null;
  if (lastIndex < value.length) {
    parts.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return parts;
}

/**
 * Factory for the remark plugin. Use as:
 * `<ReactMarkdown remarkPlugins={[remarkWikilink()]}>...`
 */
export function remarkWikilink(): Plugin<[], Root> {
  return () => (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      // Skip text inside an existing link — avoid double-rewriting.
      // (inlineCode stores its content as `value`, not text children, so
      //  the visitor never enters it.)
      if (parent.type === 'link') return;
      const replacement = splitTextNode(node as Text);
      if (replacement) {
        parent.children.splice(index, 1, ...replacement);
        return [SKIP, index + replacement.length];
      }
    });
  };
}
