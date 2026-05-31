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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  Wiki,
  resolveWikilink,
  pickInitialVault,
  partitionVaultTree,
  allCanonicalFoldersEmpty,
  type WikiVault,
} from './Wiki';

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

describe('partitionVaultTree', () => {
  const dir = (name: string, frozen?: boolean) => ({
    name,
    relativePath: name,
    type: 'directory' as const,
    frozen,
  });
  const file = (name: string) => ({
    name,
    relativePath: name,
    type: 'file' as const,
  });

  it('returns empty groups for a null tree', () => {
    expect(partitionVaultTree(null)).toEqual({ canonicalNodes: [], workingNodes: [] });
  });

  it('routes frozen top-level directories to canonical and the rest to working', () => {
    const tree = [dir('sop', true), dir('team-norm', true), dir('llm-curated'), file('index.md')];
    const { canonicalNodes, workingNodes } = partitionVaultTree(tree);
    expect(canonicalNodes.map((n) => n.name)).toEqual(['sop', 'team-norm']);
    expect(workingNodes.map((n) => n.name)).toEqual(['llm-curated', 'index.md']);
  });

  it('treats frozen files (not directories) as working content', () => {
    const tree = [{ ...file('pinned.md'), frozen: true }];
    const { canonicalNodes, workingNodes } = partitionVaultTree(tree);
    expect(canonicalNodes).toHaveLength(0);
    expect(workingNodes).toHaveLength(1);
  });
});

describe('allCanonicalFoldersEmpty', () => {
  const emptyDir = (name: string) => ({
    name,
    relativePath: name,
    type: 'directory' as const,
    frozen: true,
    children: [],
  });

  it('is false when there are no canonical folders', () => {
    expect(allCanonicalFoldersEmpty([])).toBe(false);
  });

  it('is true when every canonical folder has no children', () => {
    expect(allCanonicalFoldersEmpty([emptyDir('sop'), emptyDir('team-norm')])).toBe(true);
  });

  it('is false when at least one canonical folder has children', () => {
    const filled = {
      ...emptyDir('sop'),
      children: [{ name: 'a.md', relativePath: 'sop/a.md', type: 'file' as const }],
    };
    expect(allCanonicalFoldersEmpty([filled, emptyDir('team-norm')])).toBe(false);
  });
});

describe('Wiki global search (page-level header)', () => {
  const okJson = (body: Record<string, unknown>) =>
    ({ ok: true, status: 200, json: async () => ({ success: true, ...body }) }) as Response;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/wiki/vaults')) return okJson({ vaults: [] });
        if (u.includes('/api/wiki/search-all')) return okJson({ hits: [], truncated: false, vaultPath: '', query: 'q' });
        if (u.includes('/api/wiki/migrate/scan')) return okJson({ legacyDetected: false, proposedPages: [] });
        return okJson({});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderWiki = () => render(<MemoryRouter><Wiki /></MemoryRouter>);

  it('renders the global search in the header (not the column)', async () => {
    renderWiki();
    expect(await screen.findByLabelText('Search wiki')).toBeInTheDocument();
  });

  it('opens the results overlay on type and closes on Escape', async () => {
    renderWiki();
    const input = await screen.findByLabelText('Search wiki');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'pricing' } });
    // Overlay (with the scope control) appears as soon as there's a query.
    await waitFor(() => expect(screen.getByTestId('search-scope-all')).toBeInTheDocument());
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('search-scope-all')).not.toBeInTheDocument());
  });

  it('defaults the scope to all vaults', async () => {
    renderWiki();
    const input = await screen.findByLabelText('Search wiki');
    fireEvent.change(input, { target: { value: 'x' } });
    await waitFor(() => expect(screen.getByTestId('search-scope-all')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('search-scope-this')).toHaveAttribute('aria-checked', 'false');
  });
});
