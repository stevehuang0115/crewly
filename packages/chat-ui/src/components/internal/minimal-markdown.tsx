/**
 * Minimal, dependency-free markdown renderer.
 *
 * Intentionally tiny: we support only the subset of markdown Phase 1
 * acceptance criterion #4 names — **bold**, *italic*, `code`, lists —
 * plus plain paragraphs. No raw HTML, no autolinking of arbitrary URLs,
 * no images-via-markdown (attachments are inlined by the caller).
 *
 * Rationale: pulling in `react-markdown` adds ~40KB for Phase 1; we'll
 * upgrade when Sam asks for richer content.
 *
 * @module components/internal/minimal-markdown
 */

import { Fragment } from 'react';

/**
 * Render a markdown-ish string into safe React nodes.
 *
 * Strategy: split on blank lines into blocks, detect list blocks,
 * otherwise emit a paragraph with inline formatting parsed.
 */
export function renderMinimalMarkdown(src: string): JSX.Element {
  const blocks = src.replace(/\r\n/g, '\n').split(/\n\n+/);
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </>
  );
}

function Block({ block }: { block: string }): JSX.Element {
  const lines = block.split('\n');
  const isBulleted = lines.every((l) => /^\s*[-*]\s+/.test(l));
  const isOrdered = lines.every((l) => /^\s*\d+\.\s+/.test(l));

  if (isBulleted && lines.length > 0) {
    return (
      <ul className="my-1 list-disc pl-5">
        {lines.map((l, i) => (
          <li key={i}>{renderInline(l.replace(/^\s*[-*]\s+/, ''))}</li>
        ))}
      </ul>
    );
  }
  if (isOrdered && lines.length > 0) {
    return (
      <ol className="my-1 list-decimal pl-5">
        {lines.map((l, i) => (
          <li key={i}>{renderInline(l.replace(/^\s*\d+\.\s+/, ''))}</li>
        ))}
      </ol>
    );
  }
  return <p className="whitespace-pre-wrap">{renderInline(block)}</p>;
}

/**
 * Inline parser — handles **bold**, *italic*, `code`. Uses a single
 * regex split so order-of-operations is predictable.
 */
function renderInline(text: string): JSX.Element {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (/^\*[^*]+\*$/.test(part)) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        if (/^`[^`]+`$/.test(part)) {
          return (
            <code key={i} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-slate-800">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
