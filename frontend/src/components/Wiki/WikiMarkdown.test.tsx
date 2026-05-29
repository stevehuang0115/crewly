/**
 * WikiMarkdown component tests.
 *
 * Cover rendering of common markdown features (paragraphs, code blocks,
 * GFM tables, links) and the wikilink click handler. We rely on
 * `@testing-library/react` + `vitest` per the project's conventions.
 *
 * @module components/Wiki/WikiMarkdown.test
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WikiMarkdown } from './WikiMarkdown';

describe('WikiMarkdown', () => {
  it('renders a paragraph as a <p>', () => {
    render(<WikiMarkdown content="hello world" />);
    const para = screen.getByText('hello world');
    expect(para.tagName.toLowerCase()).toBe('p');
  });

  it('renders headings', () => {
    render(<WikiMarkdown content={'# Title\n\nbody'} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Title');
  });

  it('renders fenced code blocks with a <code> child', () => {
    render(<WikiMarkdown content={'```ts\nconst x = 1;\n```'} />);
    const code = document.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('const x = 1;');
  });

  it('renders a GFM table', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n';
    render(<WikiMarkdown content={md} />);
    const cells = screen.getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['1', '2']);
  });

  it('renders external links with target=_blank', () => {
    render(<WikiMarkdown content="[crewly](https://crewlyai.com)" />);
    const link = screen.getByRole('link', { name: 'crewly' });
    expect(link.getAttribute('href')).toBe('https://crewlyai.com');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('renders [[wikilink]] as an anchor and fires onWikilinkClick on click', () => {
    const onClick = vi.fn();
    render(
      <WikiMarkdown
        content="see [[customers/anthropic|Anthropic]] for context"
        onWikilinkClick={onClick}
      />,
    );
    const link = screen.getByRole('link', { name: 'Anthropic' });
    expect(link.getAttribute('href')).toBe('wikilink:customers/anthropic');
    expect(link.classList.contains('wiki-md-wikilink')).toBe(true);
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith('customers/anthropic');
  });

  it('does not fire onWikilinkClick for external links', () => {
    const onClick = vi.fn();
    render(<WikiMarkdown content="[ext](https://x.com)" onWikilinkClick={onClick} />);
    const link = screen.getByRole('link', { name: 'ext' });
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders without onWikilinkClick (no-op handler is fine)', () => {
    render(<WikiMarkdown content="see [[anthropic]]" />);
    const link = screen.getByRole('link', { name: 'anthropic' });
    // No throw on click.
    expect(() => fireEvent.click(link)).not.toThrow();
  });
});
