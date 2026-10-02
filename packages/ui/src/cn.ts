/**
 * Class-name joiner that resolves Tailwind conflicts: a caller's className
 * wins over the component's defaults for the same property
 * (`<Card className="border-red-500">` beats the built-in border color).
 *
 * @module components/UI/cn
 */

import { extendTailwindMerge } from 'tailwind-merge';

// Our token colors (bg-surface-dark, text-text-secondary-dark, …) are
// arbitrary names to tailwind-merge; teaching it they are colors keeps
// e.g. `text-text-secondary-dark` from being mistaken for a font size.
const TOKEN_COLORS = [
  'primary', 'background-dark', 'surface-dark', 'border-dark', 'text-primary-dark', 'text-secondary-dark',
  // Redesign tokens (tokens.css): `text-text-2` is a colour, not a size.
  'bg', 'surface', 'surface-2', 'surface-hover', 'border', 'border-soft', 'text', 'text-2', 'text-3',
  'primary-text', 'primary-soft', 'on-primary', 'attention', 'attention-soft', 'success', 'success-soft',
  'danger', 'danger-soft', 'muted-dot',
];

const twMerge = extendTailwindMerge({
  extend: {
    theme: { colors: TOKEN_COLORS },
  },
});

/**
 * Join class names, dropping falsy parts; later classes override earlier
 * ones that set the same Tailwind property.
 *
 * @param parts - Class strings, or falsy values to skip
 * @returns The merged class string
 *
 * @example
 * ```ts
 * cn('px-4 bg-primary', active && 'bg-surface-dark') // 'px-4 bg-surface-dark'
 * ```
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(' '));
}
