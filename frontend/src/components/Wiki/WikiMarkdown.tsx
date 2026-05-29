/**
 * Wiki markdown renderer.
 *
 * Wraps `react-markdown` with GFM (tables, strikethrough, task lists),
 * `rehype-highlight` syntax highlighting, and the project-local
 * `remarkWikilink` plugin so `[[name]]` becomes a clickable anchor.
 *
 * Wikilinks fire via `onWikilinkClick(target)` instead of navigating the
 * browser — the parent (Wiki.tsx) resolves the target against the current
 * vault's tree and updates `selectedPage`.
 *
 * @module components/Wiki/WikiMarkdown
 */

import { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { remarkWikilink, WIKILINK_HREF_SCHEME } from './wikilink-plugin.js';

export interface WikiMarkdownProps {
  /** Raw markdown content to render. */
  content: string;
  /**
   * Called when a `[[wikilink]]` is clicked. The argument is the wikilink
   * target verbatim (no URL-encoding). Parent decides how to resolve it.
   */
  onWikilinkClick?: (target: string) => void;
}

/**
 * Render markdown with GFM + syntax highlighting + wikilink navigation.
 *
 * @example
 * ```tsx
 * <WikiMarkdown
 *   content="See [[customers/anthropic]] for the pricing decision."
 *   onWikilinkClick={(target) => navigate(target)}
 * />
 * ```
 */
export function WikiMarkdown({ content, onWikilinkClick }: WikiMarkdownProps): JSX.Element {
  const handleAnchorClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href: string | undefined) => {
      if (!href || !href.startsWith(WIKILINK_HREF_SCHEME)) return;
      event.preventDefault();
      if (onWikilinkClick) {
        onWikilinkClick(href.slice(WIKILINK_HREF_SCHEME.length));
      }
    },
    [onWikilinkClick],
  );

  return (
    <div className="wiki-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikilink()]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        // Default urlTransform strips unknown schemes; preserve `wikilink:` so
        // we can detect + intercept clicks. Other schemes still get the default
        // safety treatment via the explicit allowlist.
        urlTransform={(url) => {
          if (typeof url === 'string' && url.startsWith(WIKILINK_HREF_SCHEME)) return url;
          if (/^(https?:|mailto:|tel:|#|\/|\.\.?\/)/i.test(url)) return url;
          return '';
        }}
        components={{
          a: ({ href, children, node: _node, ...rest }) => {
            const isWikilink = typeof href === 'string' && href.startsWith(WIKILINK_HREF_SCHEME);
            if (isWikilink) {
              return (
                <a
                  {...rest}
                  href={href}
                  className="wiki-md-wikilink"
                  onClick={(e) => handleAnchorClick(e, href)}
                >
                  {children}
                </a>
              );
            }
            return (
              <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default WikiMarkdown;
