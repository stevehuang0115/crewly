/**
 * ListSearch — the small search field next to a list's Filter button
 * (redesign: one Filter button, a search box only where people look things
 * up). Token colours only; the label is visually hidden.
 *
 * @module components/common/ListSearch
 */

import React, { useId } from 'react';
import { Search } from 'lucide-react';

export interface ListSearchProps {
  /** Accessible label ("Search teams") */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Placeholder (defaults to the label + "…") */
  placeholder?: string;
  className?: string;
}

/**
 * Search input with a leading icon.
 *
 * @param props - {@link ListSearchProps}
 * @returns The field
 */
export const ListSearch: React.FC<ListSearchProps> = ({ label, value, onChange, placeholder, className }) => {
  const id = useId();
  return (
    <div className={`relative min-w-[160px] max-w-[320px] flex-1 ${className ?? ''}`}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden="true" />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? `${label}…`}
        className="h-9 w-full rounded-2xl border border-border-soft bg-transparent pl-9 pr-3 text-sm text-text placeholder:text-text-3 focus:border-primary-text/50 focus:outline-none"
      />
    </div>
  );
};

export default ListSearch;
