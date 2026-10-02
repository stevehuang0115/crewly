/**
 * SearchToggle — a search icon that opens a search box.
 *
 * The Tickets pages are not searched daily, so the box stays out of the way
 * (specs/2026-10-02-ui-redesign.md, simplify rule 7) until it is opened or
 * holds a query.
 *
 * @module components/Tickets/SearchToggle
 */

import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

/** Props for {@link SearchToggle}. */
export interface SearchToggleProps {
  value: string;
  onChange: (value: string) => void;
  /** Placeholder and accessible name of the box */
  placeholder: string;
  /** Test id of the input */
  'data-testid'?: string;
}

/**
 * Render the toggle and, when open or non-empty, the box.
 *
 * @param props - {@link SearchToggleProps}
 * @returns The control
 */
export const SearchToggle: React.FC<SearchToggleProps> = ({ value, onChange, placeholder, 'data-testid': testId }) => {
  const [open, setOpen] = useState(value !== '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shown = open || value !== '';

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!shown) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={placeholder}
        title={placeholder}
        className="inline-flex h-9 w-9 items-center justify-center rounded-2xl text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('');
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (value === '') setOpen(false);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        className="h-9 w-full rounded-2xl border border-border bg-bg pl-9 pr-8 text-sm text-text placeholder:text-text-3 focus:border-primary-text/60 focus:outline-none"
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            setOpen(false);
          }}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-text-3 hover:text-text"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
