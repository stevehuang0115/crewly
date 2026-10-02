/**
 * The token files must agree, or the OSS frontend and the Cloud portal drift
 * apart again — the reason this package exists:
 * - tokens.css holds the values (CSS variables, dark theme);
 * - tailwind-preset.cjs (v3, OSS frontend) and theme.css (v4, Cloud portal)
 *   expose the same colour names.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const css = readFileSync(path.join(root, 'theme.css'), 'utf8');
const tokensCss = readFileSync(path.join(root, 'tokens.css'), 'utf8');
const preset = require(path.join(root, 'tailwind-preset.cjs')) as { theme: { extend: { colors: Record<string, string> } } };
const presetColors = preset.theme.extend.colors;

/** `--c-name: 42 115 234;` → { name: '#2a73ea' } from the first (dark) block. */
function darkChannels(): Record<string, string> {
  const dark = tokensCss.slice(0, tokensCss.indexOf("[data-theme='light'] {"));
  const out: Record<string, string> = {};
  for (const m of dark.matchAll(/--c-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    out[m[1]] = '#' + [m[2], m[3], m[4]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }
  return out;
}

/** Token a preset colour points at (`rgb(var(--c-bg) / …)` → 'bg'). */
function presetToken(value: string): string | null {
  const m = value.match(/var\(--(?:c-)?([\w-]+)\)/);
  return m ? m[1] : null;
}

describe('design tokens', () => {
  it('tokens.css defines every channel the preset uses', () => {
    const channels = darkChannels();
    for (const [name, value] of Object.entries(presetColors)) {
      const token = presetToken(value);
      expect(token, name).not.toBeNull();
      if (value.includes('--c-')) expect(channels[token as string], `${name} → --c-${token}`).toBeDefined();
      else expect(tokensCss, `${name} → --${token}`).toContain(`--${token}:`);
    }
  });

  it('legacy names keep their old values (theme.css hex === dark token)', () => {
    const channels = darkChannels();
    const fromCss = Object.fromEntries(
      [...css.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{3,8});/gi)].map((m) => [m[1], m[2].toLowerCase()]),
    );
    expect(Object.keys(fromCss).length).toBeGreaterThan(0);
    for (const [name, hex] of Object.entries(fromCss)) {
      expect(presetColors[name], `preset has ${name}`).toBeDefined();
      expect(channels[presetToken(presetColors[name]) as string], name).toBe(hex);
    }
  });

  it('theme.css and the Tailwind preset expose the same colour names', () => {
    const cssNames = [...css.matchAll(/--color-([\w-]+):/g)].map((m) => m[1]).sort();
    expect(cssNames).toEqual(Object.keys(presetColors).sort());
  });

  it('tokens.css keeps the redesign values', () => {
    expect(darkChannels()).toMatchObject({
      bg: '#111721',
      surface: '#1a222c',
      'surface-2': '#212a36',
      'surface-hover': '#242e3b',
      border: '#313a48',
      'border-soft': '#262f3c',
      text: '#f6f7f8',
      'text-2': '#9ab0d9',
      'text-3': '#7488ab',
      primary: '#2a73ea',
      'primary-text': '#6ea2f5',
      attention: '#f0a33a',
      success: '#34c38f',
      danger: '#f06a6a',
      'muted-dot': '#5b6779',
    });
  });

  it('has an empty light-theme block to fill in later', () => {
    expect(tokensCss).toMatch(/\[data-theme='light'\]\s*\{\s*\}/);
  });
});
