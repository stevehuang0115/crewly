/**
 * Tooltip Component
 *
 * A short label shown when the wrapped element is hovered or focused.
 * Pure CSS (group-hover / group-focus-within), so it works without a
 * portal or positioning library; keep the content to a few words.
 *
 * @module components/UI/Tooltip
 */

import React from 'react';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** The tooltip text */
  content: React.ReactNode;
  /** Where the tooltip appears relative to the trigger */
  side?: TooltipSide;
  /** Show it without hover (for static previews and onboarding hints) */
  open?: boolean;
  /** The element the tooltip describes */
  children: React.ReactNode;
  className?: string;
}

const SIDE_CLASSES: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
};

/**
 * Hover/focus tooltip.
 *
 * @param props - {@link TooltipProps}
 * @returns The trigger wrapped with its tooltip
 *
 * @example
 * ```tsx
 * <Tooltip content="Restart agent"><IconButton icon={RefreshCw} aria-label="Restart" /></Tooltip>
 * ```
 */
export const Tooltip: React.FC<TooltipProps> = ({ content, side = 'top', open = false, children, className = '' }) => (
  <span className={`group relative inline-flex ${className}`}>
    {children}
    <span
      role="tooltip"
      className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-[0.5rem] border border-border-dark bg-surface-dark px-2 py-1 text-xs text-text-primary-dark shadow-lg transition-opacity ${SIDE_CLASSES[side]} ${open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}
    >
      {content}
    </span>
  </span>
);
