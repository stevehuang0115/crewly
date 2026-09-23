/**
 * Crewly design tokens for Tailwind v3 hosts (the OSS frontend).
 * Mirrors theme.css (Tailwind v4, Cloud portal) — change one, change both.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: '#2a73ea',
        'background-dark': '#111721',
        'surface-dark': '#1a222c',
        'text-primary-dark': '#f6f7f8',
        'text-secondary-dark': '#9ab0d9',
        'border-dark': '#313a48',
      },
    },
  },
};
