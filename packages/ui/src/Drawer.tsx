/**
 * Drawer Component
 *
 * A panel that slides over the page from the side — detail views, settings
 * for one item, a chat thread — when a centered Modal would hide too much of
 * the context behind it.
 *
 * @module components/UI/Drawer
 */

import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  /** Secondary line under the title */
  subtitle?: React.ReactNode;
  side?: 'right' | 'left';
  size?: 'sm' | 'md' | 'lg';
  /** Pinned to the bottom (actions) */
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** No header and no body padding — for nav sidebars that lay out their own content */
  bare?: boolean;
  'data-testid'?: string;
}

const SIZE_CLASSES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' } as const;

/**
 * Side drawer with a dimmed backdrop; Escape and backdrop click close it.
 *
 * @param props - {@link DrawerProps}
 * @returns The drawer, or null when closed
 *
 * @example
 * ```tsx
 * <Drawer isOpen={open} onClose={() => setOpen(false)} title="Ella">…</Drawer>
 * ```
 */
export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  side = 'right',
  size = 'md',
  footer,
  children,
  className = '',
  bare = false,
  'data-testid': testId,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" data-testid={testId}>
      <div className="absolute inset-0 bg-background-dark/80 backdrop-blur-sm" onClick={onClose} data-testid="drawer-backdrop" />
      <div
        className={`relative flex h-full w-full ${SIZE_CLASSES[size]} flex-col bg-surface-dark border-border-dark shadow-xl ${
          side === 'right' ? 'ml-auto border-l' : 'mr-auto border-r'
        } ${className}`}
      >
        {!bare && (
        <div className="flex items-start justify-between gap-4 border-b border-border-dark p-5">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-semibold text-text-primary-dark truncate">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-text-secondary-dark">{subtitle}</p>}
          </div>
          <IconButton icon={X} aria-label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>
        )}
        <div className={`flex-1 overflow-y-auto ${bare ? '' : 'p-5'}`}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-3 border-t border-border-dark p-4">{footer}</div>}
      </div>
    </div>
  );
};
