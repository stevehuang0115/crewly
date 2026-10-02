/**
 * PageHeader Component
 *
 * The one page-header pattern of the redesign: title (24px/800) and a
 * one-line subtitle on the left, the primary action(s) on the right, tabs
 * directly underneath. On phones the actions wrap under the title.
 *
 * @module components/UI/PageHeader
 */

import React from 'react';
import { cn } from './cn';

export interface PageHeaderProps {
  /** Page title */
  title: React.ReactNode;
  /** One short line under the title (keep it to one line) */
  subtitle?: React.ReactNode;
  /** Primary action(s), right-aligned. At most two buttons plus an OverflowMenu. */
  actions?: React.ReactNode;
  /** Shown above the title: a back link or breadcrumb on detail pages */
  eyebrow?: React.ReactNode;
  /** Tab strip under the header, usually an `<UnderlineTabs>` */
  tabs?: React.ReactNode;
  /** Additional CSS classes on the <header> */
  className?: string;
  'data-testid'?: string;
}

/**
 * Page header: title, subtitle, actions, tabs.
 *
 * @param props - {@link PageHeaderProps}
 * @returns A <header> block
 *
 * @example
 * ```tsx
 * <PageHeader
 *   title="Tickets"
 *   subtitle="Everything your crew is working on"
 *   actions={<Button icon={Plus}>New ticket</Button>}
 *   tabs={<UnderlineTabs tabs={tabs} value={tab} onChange={setTab} />}
 * />
 * ```
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  actions,
  eyebrow,
  tabs,
  className,
  'data-testid': testId = 'page-header',
}) => (
  <header className={cn('mb-6', className)} data-testid={testId}>
    {eyebrow && <div className="mb-2 text-[13px] text-text-2">{eyebrow}</div>}
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-2xl font-extrabold leading-8 tracking-tight text-text">{title}</h1>
        {subtitle && <p className="mt-0.5 truncate text-sm text-text-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
    {tabs && <div className="mt-4">{tabs}</div>}
  </header>
);

PageHeader.displayName = 'PageHeader';
