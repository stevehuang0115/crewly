import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical, LucideIcon } from 'lucide-react';

export interface OverflowMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface OverflowMenuProps {
  items: OverflowMenuItem[];
  align?: 'top-right' | 'bottom-right';
  buttonClassName?: string;
  menuClassName?: string;
  icon?: LucideIcon;
}

export const OverflowMenu: React.FC<OverflowMenuProps> = ({
  items,
  align = 'bottom-right',
  buttonClassName = 'text-text-secondary-dark hover:text-primary transition-colors',
  menuClassName = '',
  icon: Icon = MoreVertical,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" className={buttonClassName} onClick={() => setOpen(v => !v)} aria-label="More options">
        <Icon className="w-4 h-4" />
      </button>
      {open && (
        <div
          className={`absolute z-10 w-44 bg-surface-dark border border-border-dark rounded-2xl shadow-lg p-1 ${
            align === 'bottom-right' ? 'right-0 top-8' : 'right-0 bottom-8'
          } ${menuClassName}`}
        >
          {items.map((item, idx) => (
            <button
              key={idx}
              className={`w-full text-left px-3 py-2 text-sm rounded-[0.5rem] hover:bg-background-dark ${item.danger ? 'text-red-300' : ''}`}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default OverflowMenu;

