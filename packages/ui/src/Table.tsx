/**
 * Table Component
 *
 * Styled table primitives for lists of records (agents, machines, runs,
 * invoices). Compose them like a native table; the pieces carry the Crewly
 * borders, header style and row hover.
 *
 * @module components/UI/Table
 */

import React from 'react';

type Props<T> = T & { className?: string; children?: React.ReactNode };

/**
 * Scroll container + table.
 *
 * @example
 * ```tsx
 * <Table>
 *   <TableHead><TableRow><TableHeader>Name</TableHeader></TableRow></TableHead>
 *   <TableBody><TableRow><TableCell>Ella</TableCell></TableRow></TableBody>
 * </Table>
 * ```
 */
export const Table: React.FC<Props<React.TableHTMLAttributes<HTMLTableElement> & {
  /** Draw the rounded outer border (off when the table sits inside a Card) */
  bordered?: boolean;
  /** Classes for the scroll container */
  containerClassName?: string;
}>> = ({ className = '', bordered = true, containerClassName = '', children, ...rest }) => (
  <div className={`w-full overflow-x-auto ${bordered ? 'rounded-2xl border border-border-dark' : ''} ${containerClassName}`}>
    <table className={`w-full text-sm ${className}`} {...rest}>
      {children}
    </table>
  </div>
);

/** Header row group. */
export const TableHead: React.FC<Props<React.HTMLAttributes<HTMLTableSectionElement>>> = ({ className = '', children, ...rest }) => (
  <thead className={`bg-surface-dark ${className}`} {...rest}>
    {children}
  </thead>
);

/** Body row group. */
export const TableBody: React.FC<Props<React.HTMLAttributes<HTMLTableSectionElement>>> = ({ className = '', children, ...rest }) => (
  <tbody className={`divide-y divide-border-dark ${className}`} {...rest}>
    {children}
  </tbody>
);

/** A row; `interactive` adds hover and pointer for clickable rows. */
export const TableRow: React.FC<Props<React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }>> = ({
  className = '',
  interactive = false,
  children,
  ...rest
}) => (
  <tr className={`${interactive ? 'cursor-pointer hover:bg-surface-dark/60 transition-colors' : ''} ${className}`} {...rest}>
    {children}
  </tr>
);

/** Column header cell. */
export const TableHeader: React.FC<Props<React.ThHTMLAttributes<HTMLTableCellElement>>> = ({ className = '', children, ...rest }) => (
  <th
    className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary-dark border-b border-border-dark ${className}`}
    {...rest}
  >
    {children}
  </th>
);

/** Body cell. */
export const TableCell: React.FC<Props<React.TdHTMLAttributes<HTMLTableCellElement>>> = ({ className = '', children, ...rest }) => (
  <td className={`px-4 py-3 text-text-primary-dark ${className}`} {...rest}>
    {children}
  </td>
);
