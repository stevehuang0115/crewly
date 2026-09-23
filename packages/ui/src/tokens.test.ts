/**
 * The two token files (Tailwind v4 theme.css for the Cloud portal, v3 preset
 * for the OSS frontend) must define the same colors, or the two apps drift
 * apart again — the reason this package exists.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

describe('design tokens', () => {
  it('theme.css and the Tailwind preset agree on every color', () => {
    const css = readFileSync(path.join(root, 'theme.css'), 'utf8');
    const fromCss = Object.fromEntries(
      [...css.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{3,8});/gi)].map((m) => [m[1], m[2].toLowerCase()]),
    );
    const preset = require(path.join(root, 'tailwind-preset.cjs')) as { theme: { extend: { colors: Record<string, string> } } };
    const fromPreset = Object.fromEntries(Object.entries(preset.theme.extend.colors).map(([k, v]) => [k, v.toLowerCase()]));

    expect(Object.keys(fromCss).length).toBeGreaterThan(0);
    expect(fromCss).toEqual(fromPreset);
  });
});
