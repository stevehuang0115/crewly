/**
 * OverflowMenu Component
 *
 * The "⋯" button holding a row's or page's secondary actions. In the
 * redesign every row shows at most two actions; the rest live here.
 * Closes on outside click, Escape, or picking an item.
 *
 * Backward compatible: the original props (`items` with `label`/`onClick`/
 * `danger`, `align`, `buttonClassName`, `menuClassName`, `icon`) behave as
 * before; `icon`/`disabled`/`separator` items and the `label`/`defaultOpen`
 * props are additions. Pass `icon={MoreHorizontal}` for the "⋯" glyph used
 * by the redesign (the default stays the vertical dots existing pages use).
 *
 * @module components/UI/OverflowMenu
 */

import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical, LucideIcon } from 'lucide-react';

export interface OverflowMenuItem {
  label: string;
  onClick: () => void;
  /** Destructive action, shown in red */
  danger?: boolean;
  /** Optional leading icon */
  icon?: LucideIcon;
  disabled?: boolean;
  /** Draw a divider above this item */
  separator?: boolean;
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  align?: 'top-right' | 'bottom-right';
  buttonClassName?: string;
  menuClassName?: string;
  icon?: LucideIcon;
  /** Accessible name of the trigger (default "More options") */
  label?: string;
  /** Open on first render (static previews / design artboards) */
  defaultOpen?: boolean;
}

/**
 * "⋯" trigger plus its action menu.
 *
 * @param props - {@link OverflowMenuProps}
 * @returns The trigger and, when open, the menu
 *
 * @example
 * ```tsx
 * <OverflowMenu icon={MoreHorizontal} label="More actions for CE-81" items={[
 *   { label: 'Remind me tomorrow', onClick: remind },
 *   { label: 'Skip', onClick: skip, separator: true },
 * ]} />
 * ```
 */
export const OverflowMenu: React.FC<OverflowMenuProps> = ({
  items,
  align = 'bottom-right',
  buttonClassName = 'text-text-secondary-dark hover:text-primary transition-colors',
  menuClassName = '',
  icon: Icon = MoreVertical,
  label = 'More options',
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute z-10 w-44 bg-surface-dark border border-border-dark rounded-2xl shadow-lg p-1 ${
            align === 'bottom-right' ? 'right-0 top-8' : 'right-0 bottom-8'
          } ${menuClassName}`}
        >
          {items.map((item, idx) => {
            const ItemIcon = item.icon;
            return (
              <React.Fragment key={idx}>
                {item.separator && idx > 0 && <div className="my-1 h-px bg-border-soft" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={`flex w-full items-center gap-2 text-left px-3 py-2 text-sm rounded-[0.5rem] hover:bg-background-dark disabled:opacity-50 disabled:cursor-not-allowed ${item.danger ? 'text-red-300' : ''}`}
                  onClick={() => {
                    setOpen(false);
                    item.onClick();
                  }}
                >
                  {ItemIcon && <ItemIcon className="w-4 h-4 shrink-0" aria-hidden="true" />}
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

export default OverflowMenu;
