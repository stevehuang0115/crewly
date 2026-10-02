/**
 * CollapsibleSection Component
 *
 * A section that starts collapsed behind a one-line header: the redesign's
 * "More" and "Advanced" blocks. Content stays mounted while collapsed
 * (hidden), so form state survives toggling; pass `unmountWhenClosed` for
 * heavy content that should not load until opened.
 *
 * @module components/UI/CollapsibleSection
 */

import React, { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn';

export interface CollapsibleSectionProps {
  /** Header text ("Advanced", "More") */
  title: React.ReactNode;
  /** One quiet line next to the title, e.g. what is inside ("Probe interval, per-agent chains") */
  summary?: React.ReactNode;
  /** Section content */
  children: React.ReactNode;
  /** Initial state when uncontrolled (default closed) */
  defaultOpen?: boolean;
  /** Controlled open state */
  open?: boolean;
  /** Called when the header is toggled */
  onOpenChange?: (open: boolean) => void;
  /** Do not render the content while closed */
  unmountWhenClosed?: boolean;
  /** Additional CSS classes on the section */
  className?: string;
  'data-testid'?: string;
}

/**
 * Collapsed-by-default section.
 *
 * @param props - {@link CollapsibleSectionProps}
 * @returns A <section> with a toggle header
 *
 * @example
 * ```tsx
 * <CollapsibleSection title="Advanced" summary="Probe interval and per-agent chains">
 *   <ProbeIntervalField />
 * </CollapsibleSection>
 * ```
 */
export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  summary,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  unmountWhenClosed = false,
  className,
  'data-testid': testId = 'collapsible-section',
}) => {
  const [internal, setInternal] = useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : internal;
  const contentId = useId();

  const toggle = () => {
    if (!controlled) setInternal(!open);
    onOpenChange?.(!open);
  };

  return (
    <section className={cn('border-t border-border-soft pt-3', className)} data-testid={testId}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center gap-2 py-1 text-left text-sm font-semibold text-text-2 transition-colors hover:text-text"
      >
        <ChevronRight className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span>{title}</span>
        {summary && !open && <span className="min-w-0 truncate text-[13px] font-normal text-text-3">{summary}</span>}
      </button>
      {(open || !unmountWhenClosed) && (
        <div id={contentId} hidden={!open} className="pt-3">
          {children}
        </div>
      )}
    </section>
  );
};

CollapsibleSection.displayName = 'CollapsibleSection';
