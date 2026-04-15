/**
 * Custom Dropdown — dark-themed select replacement.
 *
 * Renders a trigger button + floating popover menu instead of the native
 * OS `<select>`. Fully keyboard accessible (arrow keys, Enter, Escape).
 * Closes on outside click and on selection.
 *
 * @module components/UI/Dropdown
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Check } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownProps {
  /** Available options */
  options: DropdownOption[];
  /** Currently selected value */
  value?: string;
  /** Called when selection changes */
  onChange?: (value: string) => void;
  /** Placeholder when nothing is selected */
  placeholder?: string;
  /** Show error styling */
  error?: boolean;
  /** Disable the dropdown */
  disabled?: boolean;
  /** Show loading state */
  loading?: boolean;
  /** Additional CSS classes for the trigger */
  className?: string;
  /** aria-label for the trigger */
  'aria-label'?: string;
  /** Minimum width of the popover (default: match trigger width) */
  popoverMinWidth?: number;
  /** HTML id for the trigger element */
  id?: string;
  /** Whether the field is required (visual only) */
  required?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export const Dropdown: React.FC<DropdownProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  error = false,
  disabled = false,
  loading = false,
  className = '',
  'aria-label': ariaLabel,
  popoverMinWidth,
  id,
}) => {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        menuRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Focus first item when opening
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setFocusedIndex(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  const select = useCallback((opt: DropdownOption) => {
    if (opt.disabled) return;
    onChange?.(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex((prev) => {
          let next = prev + 1;
          while (next < options.length && options[next].disabled) next++;
          return next < options.length ? next : prev;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((prev) => {
          let next = prev - 1;
          while (next >= 0 && options[next].disabled) next--;
          return next >= 0 ? next : prev;
        });
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < options.length) {
          select(options[focusedIndex]);
        }
        break;
      case 'Home':
        e.preventDefault();
        setFocusedIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusedIndex(options.length - 1);
        break;
    }
  }, [open, focusedIndex, options, select]);

  // Scroll focused item into view
  useEffect(() => {
    if (!open || focusedIndex < 0) return;
    const el = menuRef.current?.querySelector(`[data-index="${focusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, focusedIndex]);

  return (
    <div className={`relative inline-block ${className}`}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled || loading}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        className={[
          'flex items-center justify-between gap-2 w-full',
          'bg-background-dark border rounded-lg px-3 py-2 text-sm',
          'transition-colors cursor-pointer',
          'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50',
          error
            ? 'border-red-500 focus:border-red-500 focus:ring-red-500/50'
            : 'border-border-dark hover:border-primary/30',
          (disabled || loading) && 'opacity-50 cursor-not-allowed',
          !selectedOption && 'text-text-secondary-dark',
          selectedOption && 'text-text-primary-dark',
        ].filter(Boolean).join(' ')}
      >
        <span className="truncate">{loading ? 'Loading...' : displayLabel}</span>
        <ChevronDown className={[
          'w-4 h-4 flex-shrink-0 transition-transform',
          open && 'rotate-180',
          error ? 'text-red-500' : 'text-text-secondary-dark',
        ].filter(Boolean).join(' ')} />
      </button>

      {/* Popover menu */}
      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-activedescendant={focusedIndex >= 0 ? `dropdown-opt-${focusedIndex}` : undefined}
          className="absolute z-50 mt-1 w-full min-w-[160px] bg-surface-dark border border-border-dark rounded-lg shadow-xl overflow-hidden"
          style={popoverMinWidth ? { minWidth: popoverMinWidth } : undefined}
        >
          <div className="max-h-[240px] overflow-y-auto py-1">
            {options.map((opt, i) => {
              const isSelected = opt.value === value;
              const isFocused = i === focusedIndex;
              return (
                <div
                  key={opt.value}
                  id={`dropdown-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled}
                  onClick={() => select(opt)}
                  onMouseEnter={() => setFocusedIndex(i)}
                  className={[
                    'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors',
                    opt.disabled && 'opacity-40 cursor-not-allowed',
                    isFocused && !opt.disabled && 'bg-primary/10',
                    isSelected
                      ? 'text-primary font-medium'
                      : 'text-text-primary-dark',
                    !isFocused && !isSelected && 'hover:bg-background-dark/50',
                  ].filter(Boolean).join(' ')}
                >
                  {/* Checkmark for selected */}
                  <span className="w-4 flex-shrink-0">
                    {isSelected && <Check className="w-4 h-4" />}
                  </span>
                  <span className="truncate">{opt.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

Dropdown.displayName = 'Dropdown';
