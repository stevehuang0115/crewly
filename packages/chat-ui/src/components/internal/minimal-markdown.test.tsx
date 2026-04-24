import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderMinimalMarkdown } from './minimal-markdown';

describe('renderMinimalMarkdown', () => {
  it('renders plain text as a paragraph', () => {
    render(<div>{renderMinimalMarkdown('hello world')}</div>);
    expect(screen.getByText('hello world').tagName.toLowerCase()).toBe('p');
  });

  it('parses **bold**, *italic*, and `code` inline', () => {
    const { container } = render(
      <div>{renderMinimalMarkdown('here is **bold**, *italic*, and `code`.')}</div>,
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code');
  });

  it('renders a bulleted list block', () => {
    const { container } = render(
      <div>{renderMinimalMarkdown('- one\n- two\n- three')}</div>,
    );
    expect(container.querySelectorAll('ul li')).toHaveLength(3);
  });

  it('renders an ordered list block', () => {
    const { container } = render(
      <div>{renderMinimalMarkdown('1. one\n2. two')}</div>,
    );
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('splits blocks on blank lines', () => {
    const { container } = render(
      <div>{renderMinimalMarkdown('first\n\nsecond')}</div>,
    );
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });
});
