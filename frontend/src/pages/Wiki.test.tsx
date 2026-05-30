/**
 * Tests for Wiki page helpers.
 *
 * The page itself depends on `fetch` + several effect-driven loaders;
 * these tests cover the pure helpers (`resolveWikilink`) where the
 * resolution logic lives. The interactive behavior (anchor → setSelectedPage)
 * is exercised end-to-end through `WikiMarkdown.test.tsx`.
 *
 * @module pages/Wiki.test
 */

import { describe, it, expect } from 'vitest';
import { resolveWikilink, pickInitialVault, type WikiVault } from './Wiki';

const VAULT = [
  'log.md',
  'index.md',
  'llm-curated/log.md',
  'llm-curated/customers/anthropic.md',
  'llm-curated/customers/Glitchy.md',
  'llm-curated/decisions/2026-05-22-crewly-pro-pricing.md',
  'llm-curated/patterns/auto-learning-loop.md',
  'memory/.gitkeep',
];

describe('resolveWikilink', () => {
  it('returns null for an empty target', () => {
    expect(resolveWikilink('', VAULT)).toBeNull();
    expect(resolveWikilink('   ', VAULT)).toBeNull();
  });

  it('returns null when no candidates match', () => {
    expect(resolveWikilink('does-not-exist', VAULT)).toBeNull();
  });

  it('matches an exact relative path with .md', () => {
    expect(resolveWikilink('llm-curated/customers/anthropic.md', VAULT)).toBe(
      'llm-curated/customers/anthropic.md',
    );
  });

  it('matches an exact relative path without .md', () => {
    expect(resolveWikilink('llm-curated/customers/anthropic', VAULT)).toBe(
      'llm-curated/customers/anthropic.md',
    );
  });

  it('matches a suffix when target is partial', () => {
    expect(resolveWikilink('customers/anthropic', VAULT)).toBe(
      'llm-curated/customers/anthropic.md',
    );
  });

  it('matches by basename when only the name is provided', () => {
    expect(resolveWikilink('anthropic', VAULT)).toBe('llm-curated/customers/anthropic.md');
  });

  it('is case-insensitive', () => {
    expect(resolveWikilink('Glitchy', VAULT)).toBe('llm-curated/customers/Glitchy.md');
    expect(resolveWikilink('glitchy', VAULT)).toBe('llm-curated/customers/Glitchy.md');
  });

  it('prefers exact + suffix matches over basename matches', () => {
    // Two files share the basename "log.md"; exact path wins.
    expect(resolveWikilink('log.md', VAULT)).toBe('log.md');
    // Suffix wins when there is no exact, but path is partial.
    expect(resolveWikilink('llm-curated/log', VAULT)).toBe('llm-curated/log.md');
  });

  it('returns null for an empty vault', () => {
    expect(resolveWikilink('anthropic', [])).toBeNull();
  });
});

describe('pickInitialVault', () => {
  const mk = (scope: WikiVault['scope'], vaultId: string): WikiVault => ({
    vaultPath: `/${scope}/${vaultId}`,
    scope,
    vaultId,
    label: vaultId,
    stats: null,
  });

  const VAULTS: WikiVault[] = [
    mk('global', 'global'),
    mk('project', 'closie'),
    mk('team', 'team-abc'),
    mk('team', 'team-xyz'),
  ];

  it('returns null when there are no vaults', () => {
    expect(pickInitialVault([], 'team-abc')).toBeNull();
  });

  it('selects the matching team vault when ?team= matches a team vaultId', () => {
    expect(pickInitialVault(VAULTS, 'team-xyz')?.vaultId).toBe('team-xyz');
  });

  it('falls back to the project vault when ?team= is absent', () => {
    expect(pickInitialVault(VAULTS, null)?.scope).toBe('project');
  });

  it('falls back to the project vault when ?team= matches no team vault', () => {
    expect(pickInitialVault(VAULTS, 'nonexistent')?.scope).toBe('project');
  });

  it('does not match a non-team vault that happens to share the id', () => {
    const vaults: WikiVault[] = [mk('global', 'team-abc'), mk('project', 'p')];
    // 'team-abc' here is a global vault's id, not a team vault — must not match.
    expect(pickInitialVault(vaults, 'team-abc')?.scope).toBe('project');
  });

  it('falls back to the first vault when there is no project vault', () => {
    const vaults: WikiVault[] = [mk('global', 'g'), mk('team', 't1')];
    expect(pickInitialVault(vaults, null)?.vaultId).toBe('g');
  });
});
