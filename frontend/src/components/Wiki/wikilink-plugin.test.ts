/**
 * Tests for the remark wikilink plugin.
 *
 * Exercises the AST transformer in isolation (no React) so failures point
 * at the plugin and not at react-markdown wiring.
 *
 * @module components/Wiki/wikilink-plugin.test
 */

import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Paragraph, Text, Link } from 'mdast';
import { remarkWikilink, WIKILINK_HREF_SCHEME } from './wikilink-plugin';

/**
 * Parse a markdown string, run the wikilink plugin, and return the AST.
 */
function parseWithPlugin(md: string): Root {
  const processor = unified().use(remarkParse).use(remarkWikilink());
  return processor.runSync(processor.parse(md)) as Root;
}

/**
 * Pull the inline children out of the first paragraph in a parsed doc.
 */
function firstParagraphChildren(tree: Root) {
  const para = tree.children.find((node): node is Paragraph => node.type === 'paragraph');
  if (!para) throw new Error('test fixture missing paragraph');
  return para.children;
}

describe('remarkWikilink', () => {
  it('leaves a plain paragraph untouched', () => {
    const tree = parseWithPlugin('hello world');
    const children = firstParagraphChildren(tree);
    expect(children).toHaveLength(1);
    expect(children[0].type).toBe('text');
    expect((children[0] as Text).value).toBe('hello world');
  });

  it('rewrites a single bare wikilink', () => {
    const tree = parseWithPlugin('see [[anthropic]] for context');
    const children = firstParagraphChildren(tree);
    expect(children).toHaveLength(3);
    expect((children[0] as Text).value).toBe('see ');
    expect(children[1].type).toBe('link');
    expect((children[1] as Link).url).toBe(`${WIKILINK_HREF_SCHEME}anthropic`);
    // alias defaults to target
    expect(((children[1] as Link).children[0] as Text).value).toBe('anthropic');
    expect((children[2] as Text).value).toBe(' for context');
  });

  it('rewrites a wikilink with explicit alias', () => {
    const tree = parseWithPlugin('see [[customers/anthropic|Anthropic]]');
    const children = firstParagraphChildren(tree);
    const link = children.find((c) => c.type === 'link') as Link;
    expect(link.url).toBe(`${WIKILINK_HREF_SCHEME}customers/anthropic`);
    expect((link.children[0] as Text).value).toBe('Anthropic');
  });

  it('rewrites multiple wikilinks in the same paragraph', () => {
    const tree = parseWithPlugin('[[a]] and [[b]] and [[c]]');
    const children = firstParagraphChildren(tree);
    const links = children.filter((c) => c.type === 'link') as Link[];
    expect(links.map((l) => l.url)).toEqual([
      `${WIKILINK_HREF_SCHEME}a`,
      `${WIKILINK_HREF_SCHEME}b`,
      `${WIKILINK_HREF_SCHEME}c`,
    ]);
  });

  it('does not rewrite inside inline code', () => {
    const tree = parseWithPlugin('use `[[notalink]]` in templates');
    const children = firstParagraphChildren(tree);
    expect(children.find((c) => c.type === 'link')).toBeUndefined();
  });

  it('trims whitespace around target and alias', () => {
    const tree = parseWithPlugin('see [[  spaced/target  |  Spaced  ]]');
    const children = firstParagraphChildren(tree);
    const link = children.find((c) => c.type === 'link') as Link;
    expect(link.url).toBe(`${WIKILINK_HREF_SCHEME}spaced/target`);
    expect((link.children[0] as Text).value).toBe('Spaced');
  });

  it('ignores text without [[ entirely (fast-path)', () => {
    const tree = parseWithPlugin('plain content without brackets here');
    const children = firstParagraphChildren(tree);
    expect(children).toHaveLength(1);
    expect((children[0] as Text).value).toBe('plain content without brackets here');
  });

  it('leaves an unmatched `[[` alone (no closing brackets)', () => {
    const tree = parseWithPlugin('write [[ and stop');
    const children = firstParagraphChildren(tree);
    expect(children.find((c) => c.type === 'link')).toBeUndefined();
  });
});
