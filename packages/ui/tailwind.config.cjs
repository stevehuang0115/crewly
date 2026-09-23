/**
 * Builds dist/styles.css: every class the components use, plus the token
 * utilities an app composing with them needs (safelisted, since no source
 * here uses all of them).
 *
 * @type {import('tailwindcss').Config}
 */
const tokens = ['primary', 'background-dark', 'surface-dark', 'border-dark', 'text-primary-dark', 'text-secondary-dark'];

module.exports = {
  // The design-sync previews are scanned too: they are the reference
  // compositions, and their layout classes must exist for them to render.
  content: ['./src/**/*.tsx', '!./src/**/*.test.tsx', './.design-sync/previews/**/*.tsx'],
  presets: [require('./tailwind-preset.cjs')],
  safelist: [
    { pattern: new RegExp(`^(bg|text|border|ring|divide)-(${tokens.join('|')})(/(5|10|20|30|50|60|80|90))?$`), variants: ['hover', 'focus'] },
    // Layout vocabulary for apps composed from these components (the Claude
    // Design agent writes its own page glue with these).
    { pattern: /^(p|px|py|pt|pb|m|mx|my|mt|mb|gap|gap-x|gap-y|space-y|space-x)-(0|0\.5|1|1\.5|2|3|4|5|6|8|10|12|16)$/ },
    { pattern: /^(grid-cols)-(1|2|3|4|6|12)$/, variants: ['sm', 'md', 'lg'] },
    { pattern: /^(col-span)-(1|2|3|4|6|12|full)$/ },
    { pattern: /^(w|h)-(4|5|6|8|10|12|16|20|24|32|40|48|64|80|96|full|screen|auto)$/ },
    { pattern: /^max-w-(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|full|screen-xl)$/ },
    { pattern: /^(flex|inline-flex|grid|block|hidden|flex-col|flex-row|flex-wrap|flex-1|shrink-0|grow|items-(start|center|end|stretch)|justify-(start|center|end|between)|self-(start|center|end))$/ },
    { pattern: /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl)$/ },
    { pattern: /^font-(normal|medium|semibold|bold)$/ },
    { pattern: /^(truncate|min-w-0|overflow-hidden|overflow-auto|min-h-screen|mx-auto|text-center|text-right|uppercase|tracking-wide)$/ },
  ],
  theme: {
    fontFamily: {
      sans: ['Nunito', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      mono: ['SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', 'monospace'],
    },
  },
};
