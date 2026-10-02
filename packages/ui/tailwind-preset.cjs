/**
 * Crewly design tokens for Tailwind v3 hosts (the OSS frontend).
 *
 * Every colour resolves to a CSS variable from tokens.css, so a theme is a
 * matter of redefining variables (see tokens.css). The host must load
 * tokens.css (the OSS frontend imports it from src/index.css; dist/styles.css
 * inlines it). Colours use the `--c-*` RGB channels so opacity modifiers
 * (`bg-primary/10`) keep working.
 *
 * Names:
 * - Legacy names (`background-dark`, `surface-dark`, …) are kept and point at
 *   the same tokens, so existing pages render exactly as before.
 * - New names (`bg`, `surface`, `text-2`, `attention`, …) match the redesign
 *   tokens one to one: `bg-surface`, `text-text-2`, `border-border-soft`,
 *   `bg-attention-soft`, `text-primary-text`.
 *
 * theme.css (Tailwind v4, Cloud portal) mirrors this list — change one,
 * change both (src/tokens.test.ts checks it).
 *
 * @type {import('tailwindcss').Config}
 */

/** `rgb(var(--c-name) / <alpha-value>)` — a channel token with opacity support. */
const channel = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/** Plain-variable token (already carries its own alpha, e.g. the *-soft fills). */
const plain = (name) => `var(--${name})`;

/** Legacy name → token. Same values as before the token migration. */
const legacy = {
  primary: channel('primary'),
  'background-dark': channel('bg'),
  'surface-dark': channel('surface'),
  'text-primary-dark': channel('text'),
  'text-secondary-dark': channel('text-2'),
  'border-dark': channel('border'),
};

/** Redesign tokens (specs/2026-10-02-ui-redesign.md §Tokens). */
const tokens = {
  bg: channel('bg'),
  surface: channel('surface'),
  'surface-2': channel('surface-2'),
  'surface-hover': channel('surface-hover'),
  border: channel('border'),
  'border-soft': channel('border-soft'),
  text: channel('text'),
  'text-2': channel('text-2'),
  'text-3': channel('text-3'),
  'primary-text': channel('primary-text'),
  'primary-soft': plain('primary-soft'),
  'on-primary': channel('on-primary'),
  attention: channel('attention'),
  'attention-soft': plain('attention-soft'),
  success: channel('success'),
  'success-soft': plain('success-soft'),
  danger: channel('danger'),
  'danger-soft': plain('danger-soft'),
  'muted-dot': channel('muted-dot'),
};

module.exports = {
  theme: {
    extend: {
      // Radii are not mapped: components use rounded-2xl (16px = --radius),
      // rounded-[0.5rem] (8px = --radius-sm) and rounded-3xl (24px =
      // --radius-lg), which mean the same size in v3 and v4 hosts, or
      // `rounded-[var(--radius)]` directly.
      colors: { ...legacy, ...tokens },
    },
  },
};
