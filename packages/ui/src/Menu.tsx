/**
 * Menu Component
 *
 * A button that opens a list of actions (the "⋯" or "Actions ▾" pattern).
 * Closes on outside click, Escape, or picking an item. For choosing a value
 * use Dropdown; for a bare ⋯ trigger OverflowMenu is the shorthand.
 *
 * @module components/UI/Menu
 */

import React, { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: LucideIcon;
  /** Destructive action, shown in red */
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item */
  separator?: boolean;
}

export interface MenuProps {
  /** The element that opens the menu (usually a Button or IconButton) */
  trigger: React.ReactElement;
  items: MenuItem[];
  /** Which edge of the trigger the menu lines up with */
  align?: 'start' | 'end';
  /** Open on first render (for static previews) */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Action menu opened from a trigger.
 *
 * @param props - {@link MenuProps}
 * @returns The trigger plus its menu
 *
 * @example
 * ```tsx
 * <Menu trigger={<IconButton icon={MoreVertical} aria-label="Actions" variant="ghost" />}
 *   items={[{ label: 'Rename', onSelect: rename }, { label: 'Delete', onSelect: remove, danger: true, separator: true }]} />
 * ```
 */
export const Menu: React.FC<MenuProps> = ({ trigger, items, align = 'end', defaultOpen = false, className = '' }) => {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerEl = React.cloneElement(trigger, {
    onClick: (e: React.MouseEvent) => {
      trigger.props.onClick?.(e);
      setOpen((o) => !o);
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
  });

  return (
    <div ref={ref} className={`relative inline-flex h-fit ${className}`}>
      {triggerEl}
      {open && (
        <div
          role="menu"
          className={`absolute top-full mt-1 z-50 min-w-[10rem] rounded-2xl border border-border-dark bg-surface-dark p-1 shadow-lg ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <React.Fragment key={`${item.label}-${i}`}>
                {item.separator && i > 0 && <div className="my-1 h-px bg-border-dark" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={`flex w-full items-center gap-2 rounded-[0.75rem] px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    item.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-text-primary-dark hover:bg-background-dark'
                  }`}
                >
                  {Icon && <Icon className="w-4 h-4 shrink-0" />}
                  {item.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
};
