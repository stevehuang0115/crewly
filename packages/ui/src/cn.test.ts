import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('lets later classes win for the same property', () => {
    expect(cn('border border-border-dark', 'border-red-500')).toBe('border border-red-500');
    expect(cn('h-10 px-4', 'h-8')).toBe('px-4 h-8');
  });

  it('treats token colors as colors, not sizes', () => {
    expect(cn('text-sm text-text-secondary-dark', 'text-primary')).toBe('text-sm text-primary');
    expect(cn('bg-surface-dark', 'bg-background-dark')).toBe('bg-background-dark');
  });

  it('treats the redesign tokens as colors too', () => {
    expect(cn('text-sm text-text-2', 'text-attention')).toBe('text-sm text-attention');
    expect(cn('border border-border-soft', 'border-border')).toBe('border border-border');
    expect(cn('bg-surface', 'bg-primary-soft')).toBe('bg-primary-soft');
  });

  it('skips falsy parts', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
});
