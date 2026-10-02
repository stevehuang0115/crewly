/**
 * UnderlineTabs Component
 *
 * The one tab style of the redesign: text tabs with an underline on the
 * active one (`--primary-text`), counts as small pills. Controlled: the page
 * owns the value. In the OSS app, `useTabParam` (frontend/src/hooks) keeps it
 * in `?tab=` so every tab is linkable; this package stays router-free.
 *
 * @module components/UI/UnderlineTabs
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';

export interface UnderlineTab {
  /** Value stored in `?tab=` (lowercase, URL-safe) */
  value: string;
  /** Visible label */
  label: string;
  /** Count pill; hidden when undefined / null */
  count?: number | null;
  /** Show the count pill in the attention colour (something needs the owner) */
  attention?: boolean;
  /** Optional leading icon */
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface UnderlineTabsProps {
  tabs: UnderlineTab[];
  /** Active tab value */
  value: string;
  /** Called with the new value when a tab is picked */
  onChange: (value: string) => void;
  /** Accessible name for the tab strip */
  'aria-label'?: string;
  /**
   * Prefix for tab / panel ids. Tab = `${idPrefix}-tab-${value}`,
   * panel = `${idPrefix}-panel-${value}` (give your panel that id).
   */
  idPrefix?: string;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Underline tab strip with count pills.
 *
 * @param props - {@link UnderlineTabsProps}
 * @returns A role="tablist" strip
 *
 * @example
 * ```tsx
 * const [tab, setTab] = useTabParam(['board', 'requests', 'runs'], 'board');
 * <UnderlineTabs value={tab} onChange={setTab} aria-label="Tickets views"
 *   tabs={[{ value: 'board', label: 'Board' }, { value: 'requests', label: 'Requests', count: 4 }]} />
 * ```
 */
export const UnderlineTabs: React.FC<UnderlineTabsProps> = ({
  tabs,
  value,
  onChange,
  'aria-label': ariaLabel,
  idPrefix = 'tabs',
  className,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const enabled = tabs.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.value === value);
    let next: UnderlineTab | undefined;
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    const el = e.currentTarget.querySelector<HTMLElement>(`[data-tab-value="${next.value}"]`);
    el?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn('flex gap-6 overflow-x-auto border-b border-border-soft', className)}
    >
      {tabs.map((tab) => {
        const active = tab.value === value;
        const Icon = tab.icon;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.value}`}
            aria-controls={`${idPrefix}-panel-${tab.value}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={tab.disabled}
            data-tab-value={tab.value}
            onClick={() => !active && onChange(tab.value)}
            className={cn(
              '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 pb-2.5 pt-1 text-sm font-semibold whitespace-nowrap transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              active ? 'border-primary-text text-primary-text' : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
            {tab.label}
            {tab.count !== undefined && tab.count !== null && (
              <span
                className={cn(
                  'min-w-[1.25rem] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold leading-none tabular-nums',
                  tab.attention ? 'bg-attention-soft text-attention' : active ? 'bg-primary-soft text-primary-text' : 'bg-surface-2 text-text-2',
                )}
                data-testid={`tab-count-${tab.value}`}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

UnderlineTabs.displayName = 'UnderlineTabs';
