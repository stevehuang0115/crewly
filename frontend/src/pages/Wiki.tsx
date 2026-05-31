/**
 * Wiki Page
 *
 * Browse the LLM-wiki: pick a vault (global / team / project), explore
 * its file tree, read individual pages. Read-only for Phase 1; writes
 * happen via the agent skills (`wiki-queue-add` → `wiki-process-queue`
 * → `wiki-ingest`), not from this UI.
 *
 * Per spec v2.1 §1, vaults are:
 *   - global  → ~/.crewly/global-wiki/
 *   - team    → ~/.crewly/teams/<uuid>/wiki/
 *   - project → <project-root>/.crewly/wiki/
 *
 * @module pages/Wiki
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TEAM_QUERY_PARAM } from '../utils/team-chat.utils';
import {
  BookOpen,
  Folder,
  FileText,
  Lock,
  RefreshCw,
  AlertCircle,
  Search as SearchIcon,
  Link as LinkIcon,
  Clock,
  X,
  Upload,
  Download,
  Pencil,
  Layers,
  LayoutGrid,
  CheckCircle2,
  Lightbulb,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { WikiMarkdown } from '../components/Wiki/WikiMarkdown.js';
import { SopCatalogModal } from '../components/Wiki/SopCatalogModal.js';
import { WikiPageEditor, type OverlayFolder } from '../components/Wiki/WikiPageEditor.js';
import './Wiki.css';

/** Debounce delay (ms) between keystrokes and firing the search. */
const SEARCH_DEBOUNCE_MS = 250;

interface WikiVaultStats {
  totalMdCount: number;
  recentMdCount: number;
  queue: {
    pending: number;
    processed: number;
    total: number;
  };
}

export interface WikiVault {
  vaultPath: string;
  scope: 'global' | 'team' | 'project' | 'unknown';
  vaultId: string;
  label: string;
  stats: WikiVaultStats | null;
}

/**
 * Choose which vault to auto-select on first load.
 *
 * Precedence: a `?team=<id>` deep-link (matched against the team vault whose
 * `vaultId` equals the id) wins; otherwise the project vault; otherwise the
 * first vault. Returns `null` only when there are no vaults.
 *
 * @param vaults - The (sorted) list of discovered vaults.
 * @param teamParam - The `team` query-param value, or null when absent.
 * @returns The vault to select initially, or null when `vaults` is empty.
 */
export function pickInitialVault(
  vaults: WikiVault[],
  teamParam: string | null,
): WikiVault | null {
  if (vaults.length === 0) return null;
  const teamMatch = teamParam
    ? vaults.find((v) => v.scope === 'team' && v.vaultId === teamParam)
    : undefined;
  return teamMatch ?? vaults.find((v) => v.scope === 'project') ?? vaults[0];
}

interface WikiTreeNode {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  frozen?: boolean;
  /** Description from SCHEMA.md `hardcoded[].description`. Used as tooltip. */
  frozenDescription?: string;
  bytes?: number;
  modifiedAt?: string;
  children?: WikiTreeNode[];
}

/**
 * Friendly display names for the schema's frozen (canonical) top-level folders.
 * Keyed by the raw folder name returned in the tree. Folders not listed fall
 * back to their raw name. This de-scatters the "where do norms/SOPs live?"
 * confusion by giving the source-of-truth folders human labels.
 */
const CANONICAL_FOLDER_LABELS: Record<string, string> = {
  sop: 'SOPs',
  'sop-overrides': 'SOP Overrides',
  'team-norm': 'Team Norms',
  norms: 'Team Norms',
  okr: 'OKRs',
  okrs: 'OKRs',
  memory: 'Memory',
};

/**
 * Split a vault's top-level tree into canonical (schema-frozen) folders and
 * everything else. Pure so it can be unit-tested. Frozen top-level directories
 * are the engine's source of truth (SOPs / Team Norms / OKRs); the rest is the
 * working / llm-curated area.
 *
 * @param tree - Top-level tree nodes, or null while loading.
 * @returns `{ canonicalNodes, workingNodes }` preserving original order.
 */
export function partitionVaultTree(tree: WikiTreeNode[] | null): {
  canonicalNodes: WikiTreeNode[];
  workingNodes: WikiTreeNode[];
} {
  const canonicalNodes: WikiTreeNode[] = [];
  const workingNodes: WikiTreeNode[] = [];
  for (const node of tree ?? []) {
    if (node.type === 'directory' && node.frozen) canonicalNodes.push(node);
    else workingNodes.push(node);
  }
  return { canonicalNodes, workingNodes };
}

/**
 * Whether every canonical folder is empty (no child pages). Used to decide
 * when to show the "served from config, not materialised here" explainer.
 *
 * @param canonicalNodes - The frozen top-level folders.
 * @returns true when there is at least one canonical folder and all are empty.
 */
export function allCanonicalFoldersEmpty(canonicalNodes: WikiTreeNode[]): boolean {
  return (
    canonicalNodes.length > 0 &&
    canonicalNodes.every((n) => (n.children?.length ?? 0) === 0)
  );
}

interface PagePayload {
  vaultPath: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string;
  content: string;
}

interface WikiSearchSnippet {
  lineNumber: number;
  text: string;
}

interface WikiSearchHit {
  relativePath: string;
  filenameMatch: boolean;
  matchCount: number;
  snippets: WikiSearchSnippet[];
  /** Owning vault (all-vault search only). */
  vaultPath?: string;
  /** Owning vault label (all-vault search only). */
  vaultLabel?: string;
}

interface WikiBacklinkSnippet {
  lineNumber: number;
  text: string;
}

interface WikiBacklink {
  relativePath: string;
  snippets: WikiBacklinkSnippet[];
}

interface WikiRecentEntry {
  relativePath: string;
  bytes: number;
  modifiedAt: string;
  llmCurated: boolean;
}

interface WikiMissingConcept {
  /** The wikilink target referenced (e.g. `sam-as-tl`). */
  target: string;
  /** How many distinct unresolved references across the vault. */
  referenceCount: number;
  /** Sample source pages (capped at 10). */
  sources: string[];
}

interface WikiLintSnapshot {
  /** Surface for the UI: only the section we render right now. */
  missingConcepts: WikiMissingConcept[];
}

interface WikiMigrateProposedPage {
  sourceType:
    | 'decision'
    | 'pattern'
    | 'gotcha'
    | 'relationship'
    | 'learning-log'
    | 'loose-md'
    | 'memory-entry';
  sourceFile: string;
  sourceId: string;
  targetRelativePath: string;
  title: string;
  routingUncertain: boolean;
  skipReason?: string;
}

interface WikiMigrateScanPayload {
  legacyDetected: boolean;
  proposedPages: WikiMigrateProposedPage[];
  bootstrapNeeded: { project: boolean; global: boolean; teams: string[] };
  summary: {
    decisions: number;
    patterns: number;
    gotchas: number;
    relationships: number;
    learnings: number;
    looseMd: number;
    memoryEntries: number;
    alreadyMigrated: number;
  };
  applied?: number;
  skipped?: number;
  bootstrapped?: string[];
}

/** Human-readable per-sourceType labels for the migration banner. */
const SOURCE_TYPE_LABEL: Record<WikiMigrateProposedPage['sourceType'], string> = {
  decision: 'decisions',
  pattern: 'patterns',
  gotcha: 'gotchas',
  relationship: 'relationships',
  'learning-log': 'learnings',
  'loose-md': 'loose .md',
  'memory-entry': 'agent memory',
};

const SCOPE_LABEL: Record<WikiVault['scope'], string> = {
  global: 'Global',
  team: 'Team',
  project: 'Project',
  unknown: 'Unknown',
};

const SCOPE_ORDER: Record<WikiVault['scope'], number> = {
  global: 0,
  project: 1,
  team: 2,
  unknown: 3,
};

export function Wiki(): JSX.Element {
  // Deep-link from /teams: `?team=<id>` pre-selects that team's vault.
  // For team-scoped vaults the backend sets `vaultId` to the team id
  // (see wiki.controller listVaults), so we match on it directly.
  const [searchParams] = useSearchParams();
  const teamParam = searchParams.get(TEAM_QUERY_PARAM);
  // Deep-link: ?focus=sop|team-norm jumps straight to the first page under that
  // canonical folder once the tree loads (used by the team-page Norms/SOPs links).
  const focusParam = searchParams.get('focus');

  const [vaults, setVaults] = useState<WikiVault[]>([]);
  const [vaultsLoading, setVaultsLoading] = useState(true);
  const [vaultsError, setVaultsError] = useState<string | null>(null);

  const [selectedVault, setSelectedVault] = useState<WikiVault | null>(null);
  const [tree, setTree] = useState<WikiTreeNode[] | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [selectedPage, setSelectedPage] = useState<string | null>(null);
  // Tracks which (vault, focus) deep-link has been applied so it fires once.
  const [focusApplied, setFocusApplied] = useState<string | null>(null);
  // Whether the SOP catalog (install/uninstall) modal is open.
  const [catalogOpen, setCatalogOpen] = useState(false);
  // Open overlay-page editor (team norm / custom SOP), or null when closed.
  const [editor, setEditor] = useState<
    { folder: OverlayFolder; mode: 'create' | 'edit'; path?: string; content?: string } | null
  >(null);
  const [pageContent, setPageContent] = useState<PagePayload | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<WikiSearchHit[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  // Search scope: false = current vault only, true = all vaults (merged ranking).
  // The page-level global search defaults to all-vaults (the natural mental model).
  const [searchAll, setSearchAll] = useState(true);
  // Whether the global search overlay (header) is open.
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  // Keyboard-highlighted hit index in the overlay (-1 = none).
  const [activeHitIndex, setActiveHitIndex] = useState(-1);
  // Cross-vault click-through: page to open once the target vault is selected.
  const [pendingPage, setPendingPage] = useState<{ vaultPath: string; relativePath: string } | null>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [backlinks, setBacklinks] = useState<WikiBacklink[] | null>(null);
  const [backlinksLoading, setBacklinksLoading] = useState(false);

  const [recent, setRecent] = useState<WikiRecentEntry[] | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);

  const [lint, setLint] = useState<WikiLintSnapshot | null>(null);

  /**
   * Set of directory relativePaths CURRENTLY COLLAPSED in the tree, per
   * vault. Persisted to localStorage so users get back what they had.
   * Default (path absent from set) is expanded.
   */
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  // Reload collapsed set whenever the vault changes.
  useEffect(() => {
    if (!selectedVault) {
      setCollapsedFolders(new Set());
      return;
    }
    try {
      const raw = localStorage.getItem(`wiki-tree-collapsed:${selectedVault.vaultPath}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setCollapsedFolders(new Set(parsed.filter((s) => typeof s === 'string')));
          return;
        }
      }
    } catch {
      // ignore — bad localStorage entry, just start fresh
    }
    setCollapsedFolders(new Set());
  }, [selectedVault]);

  const toggleFolder = useCallback(
    (relativePath: string) => {
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(relativePath)) next.delete(relativePath);
        else next.add(relativePath);
        if (selectedVault) {
          try {
            localStorage.setItem(
              `wiki-tree-collapsed:${selectedVault.vaultPath}`,
              JSON.stringify([...next]),
            );
          } catch {
            // localStorage may be unavailable / full — degrade silently
          }
        }
        return next;
      });
    },
    [selectedVault],
  );

  const [migrateScan, setMigrateScan] = useState<WikiMigrateScanPayload | null>(null);
  const [migrateLoading, setMigrateLoading] = useState(false);
  const [migrateApplying, setMigrateApplying] = useState(false);
  const [migrateDismissed, setMigrateDismissed] = useState(false);
  const [migrateExpanded, setMigrateExpanded] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);
  const [migrateResult, setMigrateResult] = useState<WikiMigrateScanPayload | null>(null);

  // ---------------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------------

  const loadVaults = useCallback(async () => {
    setVaultsLoading(true);
    setVaultsError(null);
    try {
      const res = await fetch('/api/wiki/vaults');
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const sorted = (body.vaults as WikiVault[]).sort((a, b) => {
        const so = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
        if (so !== 0) return so;
        return a.label.localeCompare(b.label);
      });
      setVaults(sorted);
      // Auto-select if no selection yet. A `?team=` deep-link wins; otherwise
      // fall back to the project vault, then the first vault.
      if (sorted.length > 0 && !selectedVault) {
        setSelectedVault(pickInitialVault(sorted, teamParam));
      }
    } catch (err) {
      setVaultsError(err instanceof Error ? err.message : String(err));
    } finally {
      setVaultsLoading(false);
    }
  }, [selectedVault, teamParam]);

  const loadTree = useCallback(async (vaultPath: string) => {
    setTreeLoading(true);
    setTreeError(null);
    setTree(null);
    setSelectedPage(null);
    setPageContent(null);
    try {
      const res = await fetch(`/api/wiki/tree?vaultPath=${encodeURIComponent(vaultPath)}`);
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setTree(body.tree as WikiTreeNode[]);
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : String(err));
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadPage = useCallback(async (vaultPath: string, relativePath: string) => {
    setPageLoading(true);
    setPageError(null);
    setPageContent(null);
    try {
      const res = await fetch(
        `/api/wiki/page?vaultPath=${encodeURIComponent(vaultPath)}&relativePath=${encodeURIComponent(relativePath)}`,
      );
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setPageContent(body as PagePayload);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setPageLoading(false);
    }
  }, []);

  const loadSearch = useCallback(
    async (vaultPath: string, q: string, allVaults: boolean) => {
      setSearchLoading(true);
      setSearchError(null);
      try {
        const url = allVaults
          ? `/api/wiki/search-all?q=${encodeURIComponent(q)}`
          : `/api/wiki/search?vaultPath=${encodeURIComponent(vaultPath)}&q=${encodeURIComponent(q)}`;
        const res = await fetch(url);
        const body = await res.json();
        if (!res.ok || !body.success) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        setSearchHits(body.hits as WikiSearchHit[]);
        setSearchTruncated(Boolean(body.truncated));
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : String(err));
        setSearchHits([]);
      } finally {
        setSearchLoading(false);
      }
    },
    [],
  );

  const loadLint = useCallback(async (vaultPath: string) => {
    try {
      const res = await fetch('/api/wiki/lint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vaultPath, staleDays: 60 }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        setLint(null);
        return;
      }
      setLint({ missingConcepts: body.report?.missingConcepts ?? [] });
    } catch {
      setLint(null);
    }
  }, []);

  const runMigrateScan = useCallback(async () => {
    setMigrateLoading(true);
    setMigrateError(null);
    try {
      const res = await fetch('/api/wiki/migrate/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeAgentMemory: true }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setMigrateScan({
        legacyDetected: body.legacyDetected,
        proposedPages: body.proposedPages,
        bootstrapNeeded: body.bootstrapNeeded,
        summary: body.summary,
      });
    } catch (err) {
      setMigrateError(err instanceof Error ? err.message : String(err));
    } finally {
      setMigrateLoading(false);
    }
  }, []);

  const runMigrateApply = useCallback(async () => {
    setMigrateApplying(true);
    setMigrateError(null);
    try {
      const res = await fetch('/api/wiki/migrate/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, includeAgentMemory: true }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setMigrateResult({
        legacyDetected: body.legacyDetected,
        proposedPages: body.proposedPages,
        bootstrapNeeded: body.bootstrapNeeded,
        summary: body.summary,
        applied: body.applied,
        skipped: body.skipped,
        bootstrapped: body.bootstrapped,
      });
      setMigrateScan(null);
      // Refresh the vault list so newly-bootstrapped vaults show up.
      void loadVaults();
    } catch (err) {
      setMigrateError(err instanceof Error ? err.message : String(err));
    } finally {
      setMigrateApplying(false);
    }
  }, [loadVaults]);

  const loadRecent = useCallback(async (vaultPath: string) => {
    setRecentLoading(true);
    setRecent(null);
    try {
      const res = await fetch(`/api/wiki/recent?vaultPath=${encodeURIComponent(vaultPath)}&limit=8`);
      const body = await res.json();
      if (!res.ok || !body.success) {
        setRecent([]);
        return;
      }
      setRecent(body.entries as WikiRecentEntry[]);
    } catch {
      setRecent([]);
    } finally {
      setRecentLoading(false);
    }
  }, []);

  const loadBacklinks = useCallback(
    async (vaultPath: string, relativePath: string) => {
      setBacklinksLoading(true);
      setBacklinks(null);
      try {
        const res = await fetch(
          `/api/wiki/backlinks?vaultPath=${encodeURIComponent(vaultPath)}&relativePath=${encodeURIComponent(relativePath)}`,
        );
        const body = await res.json();
        if (!res.ok || !body.success) {
          setBacklinks([]);
          return;
        }
        setBacklinks(body.backlinks as WikiBacklink[]);
      } catch {
        setBacklinks([]);
      } finally {
        setBacklinksLoading(false);
      }
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  useEffect(() => {
    loadVaults();
  }, [loadVaults]);

  // One-shot migration probe on mount. Runs once; banner stays cached.
  useEffect(() => {
    runMigrateScan();
  }, [runMigrateScan]);

  /**
   * Atomic vault switch — bundles `setSelectedVault` + page-state reset
   * so the loadPage effect can't fire against the OLD selectedPage in a
   * fresh vault. (Bug B1, 2026-05-27: cross-vault selectedPage stuck →
   * `page_not_found` red error on team-vault click.)
   */
  const switchVault = useCallback((v: WikiVault) => {
    setSelectedVault(v);
    setSelectedPage(null);
    setPageContent(null);
    setPageError(null);
    setBacklinks(null);
  }, []);

  // Open a cross-vault search hit once its target vault becomes active.
  useEffect(() => {
    if (pendingPage && selectedVault?.vaultPath === pendingPage.vaultPath) {
      setSelectedPage(pendingPage.relativePath);
      setPendingPage(null);
    }
  }, [pendingPage, selectedVault]);

  /** Open a search hit's page (switching vault on a cross-vault hit), then close. */
  const handleHitSelect = useCallback(
    (rel: string, vaultPath?: string) => {
      if (vaultPath && vaultPath !== selectedVault?.vaultPath) {
        const target = vaults.find((v) => v.vaultPath === vaultPath);
        if (target) {
          switchVault(target);
          setPendingPage({ vaultPath, relativePath: rel });
          setSearchQuery('');
          setIsSearchOpen(false);
          return;
        }
      }
      setSelectedPage(rel);
      setSearchQuery('');
      setIsSearchOpen(false);
    },
    [selectedVault, vaults, switchVault],
  );

  /** Keyboard nav in the global search input: ↑/↓ highlight, Enter open, Esc close. */
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        if (searchQuery) setSearchQuery('');
        setIsSearchOpen(false);
        searchInputRef.current?.blur();
        return;
      }
      const hits = searchHits ?? [];
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveHitIndex((i) => Math.min(i + 1, hits.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveHitIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        const hit = hits[activeHitIndex];
        if (hit) handleHitSelect(hit.relativePath, hit.vaultPath);
      }
    },
    [searchHits, activeHitIndex, searchQuery, handleHitSelect],
  );

  // Close the search overlay on an outside click.
  useEffect(() => {
    if (!isSearchOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isSearchOpen]);

  useEffect(() => {
    if (selectedVault) {
      loadTree(selectedVault.vaultPath);
      loadRecent(selectedVault.vaultPath);
      loadLint(selectedVault.vaultPath);
    } else {
      setRecent(null);
      setLint(null);
    }
  }, [selectedVault, loadTree, loadRecent, loadLint]);

  useEffect(() => {
    if (selectedVault && selectedPage) {
      loadPage(selectedVault.vaultPath, selectedPage);
      loadBacklinks(selectedVault.vaultPath, selectedPage);
    } else {
      setBacklinks(null);
    }
  }, [selectedVault, selectedPage, loadPage, loadBacklinks]);

  // Debounced search — fires only after the user pauses typing. Re-runs when
  // the scope toggle (this vault / all vaults) flips.
  useEffect(() => {
    // All-vault search needs no selected vault; single-vault search does.
    if (!searchAll && !selectedVault) return;
    const q = searchQuery.trim();
    if (q.length === 0) {
      setSearchHits(null);
      setSearchError(null);
      setSearchTruncated(false);
      return;
    }
    const handle = setTimeout(() => {
      loadSearch(selectedVault?.vaultPath ?? '', q, searchAll);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchQuery, selectedVault, loadSearch, searchAll]);

  // Clear the active search whenever the user picks a different vault.
  useEffect(() => {
    setSearchQuery('');
    setSearchHits(null);
    setSearchError(null);
  }, [selectedVault?.vaultPath]);

  // ---------------------------------------------------------------------------
  // Vault summary derived from current state
  // ---------------------------------------------------------------------------

  const pageCount = useMemo(() => {
    if (!tree) return 0;
    let n = 0;
    const walk = (nodes: WikiTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'file') n++;
        if (node.children) walk(node.children);
      }
    };
    walk(tree);
    return n;
  }, [tree]);

  /**
   * Flat list of all .md file paths in the current vault tree. Used by the
   * wikilink resolver to match `[[target]]` against existing pages.
   */
  const allFilePaths = useMemo(() => {
    const out: string[] = [];
    if (!tree) return out;
    const walk = (nodes: WikiTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'file') out.push(node.relativePath);
        if (node.children) walk(node.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  /**
   * Partition the top-level tree into the canonical (schema-frozen) folders —
   * the single source of truth for SOPs / Team Norms / OKRs — and everything
   * else (the working / llm-curated area). Surfacing the canonical folders in
   * their own labelled group answers the "why are norms & SOPs scattered?"
   * confusion: they aren't, the UI just used to bury them in the flat list.
   */
  const { canonicalNodes, workingNodes } = useMemo(
    () => partitionVaultTree(tree),
    [tree],
  );

  /**
   * Apply the ?focus=<folder> deep-link: once the tree for the requested vault
   * has loaded, select the first page under that canonical folder. Fires once
   * per (vault, focus) pair; if the folder is empty (e.g. norms not authored
   * yet) it just marks the focus applied so the folder is shown but nothing is
   * force-selected.
   */
  useEffect(() => {
    if (!focusParam || !selectedVault || !tree) return;
    const key = `${selectedVault.vaultPath}:${focusParam}`;
    if (focusApplied === key) return;
    const first = allFilePaths.find(
      (p) => p === focusParam || p.startsWith(`${focusParam}/`),
    );
    if (first) setSelectedPage(first);
    setFocusApplied(key);
  }, [focusParam, selectedVault, tree, allFilePaths, focusApplied]);

  const handleWikilinkClick = useCallback(
    (target: string) => {
      const match = resolveWikilink(target, allFilePaths);
      if (match) {
        setSelectedPage(match);
      } else {
        setPageError(`Wikilink target not found in this vault: [[${target}]]`);
      }
    },
    [allFilePaths],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="wiki-page">
      <div className="wiki-header">
        <div className="wiki-header-main">
          <div className="wiki-header-title">
            <BookOpen size={22} />
            <h1>Wiki</h1>
          </div>
          <p className="wiki-header-subtitle">
            Agent-curated knowledge across global, team, and project vaults. Reads
            only — writes happen via the <code>wiki-queue-add</code> →{' '}
            <code>wiki-process-queue</code> agent flow.
          </p>
        </div>

        {/* Page-level global search */}
        <div className="wiki-global-search" ref={searchWrapRef}>
          <div className={`wiki-gsearch-box${isSearchOpen ? ' open' : ''}`}>
            <SearchIcon size={15} className="wiki-search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              className="wiki-gsearch-input"
              placeholder="Search the wiki…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setIsSearchOpen(true);
                setActiveHitIndex(-1);
              }}
              onFocus={() => setIsSearchOpen(true)}
              onKeyDown={handleSearchKeyDown}
              aria-label="Search wiki"
              aria-expanded={isSearchOpen}
              role="combobox"
              aria-controls="wiki-search-overlay"
            />
            {searchQuery ? (
              <button
                type="button"
                className="wiki-search-clear"
                onClick={() => {
                  setSearchQuery('');
                  setActiveHitIndex(-1);
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            ) : (
              <div className="wiki-search-scope" role="radiogroup" aria-label="Search scope">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!searchAll}
                  aria-label="Search this vault"
                  title="This vault"
                  className={`wiki-search-scope-btn${!searchAll ? ' active' : ''}`}
                  onClick={() => setSearchAll(false)}
                >
                  <Layers size={13} />
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={searchAll}
                  aria-label="Search all vaults"
                  title="All vaults"
                  className={`wiki-search-scope-btn${searchAll ? ' active' : ''}`}
                  onClick={() => setSearchAll(true)}
                >
                  <LayoutGrid size={13} />
                </button>
              </div>
            )}
          </div>

          {isSearchOpen && searchQuery.trim().length > 0 && (
            <div className="wiki-search-overlay" id="wiki-search-overlay" role="listbox">
              <div className="wiki-overlay-scope" role="radiogroup" aria-label="Search scope">
                <span className="wiki-overlay-scope-label">Scope</span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!searchAll}
                  className={`wiki-overlay-scope-btn${!searchAll ? ' active' : ''}`}
                  onClick={() => setSearchAll(false)}
                  data-testid="search-scope-this"
                >
                  <Layers size={12} /> This vault
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={searchAll}
                  className={`wiki-overlay-scope-btn${searchAll ? ' active' : ''}`}
                  onClick={() => setSearchAll(true)}
                  data-testid="search-scope-all"
                >
                  <LayoutGrid size={12} /> All vaults
                </button>
              </div>

              <div className="wiki-overlay-body">
                {searchError && (
                  <div className="wiki-error">
                    <AlertCircle size={14} /> {searchError}
                  </div>
                )}
                {searchLoading && <div className="wiki-loading">Searching…</div>}
                {!searchLoading && searchHits && searchHits.length > 0 && (
                  <SearchResults
                    hits={searchHits}
                    selected={selectedPage}
                    showVault={searchAll}
                    activeIndex={activeHitIndex}
                    onSelect={handleHitSelect}
                  />
                )}
                {!searchLoading && searchHits && searchHits.length === 0 && (
                  <div className="wiki-empty">
                    No results for <code>{searchQuery}</code>.
                  </div>
                )}
              </div>

              {searchHits && searchHits.length > 0 && (
                <div className="wiki-overlay-footer">
                  {searchHits.length} match{searchHits.length === 1 ? '' : 'es'}
                  {searchTruncated ? '+' : ''} · ↑↓ navigate · ↵ open · Esc close
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <MigrationBanner
        scan={migrateScan}
        loading={migrateLoading}
        applying={migrateApplying}
        expanded={migrateExpanded}
        dismissed={migrateDismissed}
        error={migrateError}
        result={migrateResult}
        onApply={runMigrateApply}
        onToggle={() => setMigrateExpanded((v) => !v)}
        onDismiss={() => setMigrateDismissed(true)}
        onCloseResult={() => setMigrateResult(null)}
      />

      <div className="wiki-grid">
        {/* Left: vault list */}
        <aside className="wiki-vaults">
          <div className="wiki-pane-header">
            <span>Vaults</span>
            <button
              type="button"
              className="wiki-refresh"
              onClick={() => loadVaults()}
              aria-label="Refresh vaults"
              disabled={vaultsLoading}
            >
              <RefreshCw size={14} className={vaultsLoading ? 'spin' : ''} />
            </button>
          </div>

          {vaultsError && (
            <div className="wiki-error">
              <AlertCircle size={14} /> {vaultsError}
            </div>
          )}
          {vaultsLoading && !vaults.length && <div className="wiki-loading">Loading…</div>}

          <div className="wiki-vault-list">
            {vaults.map((v) => {
              const isActive = selectedVault?.vaultPath === v.vaultPath;
              return (
                <button
                  type="button"
                  key={v.vaultPath}
                  className={`wiki-vault-item${isActive ? ' active' : ''}`}
                  onClick={() => switchVault(v)}
                >
                  <div className="wiki-vault-line">
                    <span className={`wiki-scope-pill scope-${v.scope}`}>
                      {SCOPE_LABEL[v.scope]}
                    </span>
                    <span className="wiki-vault-label" title={v.vaultPath}>
                      {v.label}
                    </span>
                  </div>
                  {v.stats && (
                    <div className="wiki-vault-stats">
                      {v.stats.totalMdCount} pages
                      {v.stats.queue.pending > 0 && (
                        <span className="wiki-vault-pending">
                          {' '}· {v.stats.queue.pending} pending
                        </span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Middle: file tree (or search results when query is active) */}
        <section className="wiki-tree-pane">
          <div className="wiki-pane-header">
            <span>
              {selectedVault ? selectedVault.label : 'Pick a vault'}
              {selectedVault && tree && (
                <span className="wiki-page-count"> · {pageCount}</span>
              )}
            </span>
          </div>
          {treeError && (
            <div className="wiki-error">
              <AlertCircle size={14} /> {treeError}
            </div>
          )}
          {treeLoading && <div className="wiki-loading">Loading tree…</div>}
          {tree && canonicalNodes.length > 0 && (
                <>
                  <div className="wiki-tree-group-label" title="Schema-frozen folders — the source of truth referenced by the engine. Agents can't overwrite these via the wiki.">
                    <Lock size={11} /> Canonical · source of truth
                  </div>
                  {canonicalNodes.some((n) => n.name === 'sop' || n.name === 'team-norm') && (
                    <div className="wiki-canonical-actions">
                      <button
                        type="button"
                        className="wiki-tree-group-action"
                        onClick={() => setCatalogOpen(true)}
                        data-testid="open-sop-catalog"
                        title="Browse the SOP catalog and install SOPs into this team"
                      >
                        <Download size={11} /> Install SOP
                      </button>
                      <button
                        type="button"
                        className="wiki-tree-group-action"
                        onClick={() => setEditor({ folder: 'sop', mode: 'create' })}
                        data-testid="new-sop"
                        title="Author a custom SOP for this team"
                      >
                        + SOP
                      </button>
                      <button
                        type="button"
                        className="wiki-tree-group-action"
                        onClick={() => setEditor({ folder: 'team-norm', mode: 'create' })}
                        data-testid="new-norm"
                        title="Author a team norm"
                      >
                        + Norm
                      </button>
                    </div>
                  )}
                  {allCanonicalFoldersEmpty(canonicalNodes) && (
                    <p className="wiki-tree-canonical-note">
                      Reserved folders. Team SOPs &amp; norms are currently
                      served to agents straight from <code>config/sops/</code>;
                      they haven&apos;t been materialised as wiki pages yet.
                    </p>
                  )}
                  <TreeView
                    nodes={canonicalNodes}
                    selected={selectedPage}
                    onSelect={(rel) => setSelectedPage(rel)}
                    collapsed={collapsedFolders}
                    onToggleFolder={toggleFolder}
                    labelOverrides={CANONICAL_FOLDER_LABELS}
                    rootClassName="wiki-tree--flush"
                  />
                  {workingNodes.length > 0 && (
                    <div className="wiki-tree-group-label">Working notes</div>
                  )}
                </>
              )}
              {tree && workingNodes.length > 0 && (
                <TreeView
                  nodes={workingNodes}
                  selected={selectedPage}
                  onSelect={(rel) => setSelectedPage(rel)}
                  collapsed={collapsedFolders}
                  onToggleFolder={toggleFolder}
                />
              )}
          {tree && tree.length === 0 && !treeLoading && (
            <div className="wiki-empty">
              Empty vault — no <code>.md</code> pages yet. They land here once
              agents queue + ingest worth-saving content.
            </div>
          )}
        </section>

        {/* Right: page content */}
        <main className="wiki-page-pane">
          <div className="wiki-pane-header">
            <span>{selectedPage ?? 'Pick a page'}</span>
            {pageContent && selectedPage &&
              (selectedPage.startsWith('sop/') || selectedPage.startsWith('team-norm/')) && (
                <button
                  type="button"
                  className="wiki-tree-group-action"
                  data-testid="edit-overlay-page"
                  onClick={() =>
                    setEditor({
                      folder: selectedPage.startsWith('team-norm/') ? 'team-norm' : 'sop',
                      mode: 'edit',
                      path: selectedPage,
                      content: pageContent.content,
                    })
                  }
                >
                  <Pencil size={11} /> Edit
                </button>
              )}
            {pageContent && (
              <span className="wiki-page-meta">
                {pageContent.bytes} B · modified{' '}
                {new Date(pageContent.modifiedAt).toLocaleString()}
              </span>
            )}
          </div>
          {pageError && (
            <div className="wiki-error">
              <AlertCircle size={14} /> {pageError}
            </div>
          )}
          {pageLoading && <div className="wiki-loading">Loading page…</div>}
          {pageContent && (
            <div className="wiki-page-body">
              <div className="wiki-page-content">
                <WikiMarkdown
                  content={pageContent.content}
                  onWikilinkClick={handleWikilinkClick}
                />
              </div>
              <BacklinksPanel
                backlinks={backlinks}
                loading={backlinksLoading}
                onSelect={(rel) => setSelectedPage(rel)}
              />
            </div>
          )}
          {!selectedPage && !pageLoading && !pageError && (
            <div className="wiki-empty-with-recent">
              <div className="wiki-empty">
                Click a page on the left to view its markdown content. Frozen
                folders (sop/, memory/, …) are visible but managed by the OSS
                code path — not editable here.
              </div>
              {selectedVault && lint && lint.missingConcepts.length > 0 && (
                <MissingConcepts
                  concepts={lint.missingConcepts}
                  onSelect={(target) => {
                    setSearchQuery(target);
                    setIsSearchOpen(true);
                  }}
                />
              )}
              {selectedVault && (
                <RecentActivity
                  entries={recent}
                  loading={recentLoading}
                  onSelect={(rel) => setSelectedPage(rel)}
                />
              )}
            </div>
          )}
        </main>
      </div>

      {catalogOpen && selectedVault && (
        <SopCatalogModal
          vaultPath={selectedVault.vaultPath}
          onClose={() => setCatalogOpen(false)}
          onChanged={() => loadTree(selectedVault.vaultPath)}
        />
      )}

      {editor && selectedVault && (
        <WikiPageEditor
          vaultPath={selectedVault.vaultPath}
          folder={editor.folder}
          mode={editor.mode}
          initialPath={editor.path}
          initialContent={editor.content}
          onClose={() => setEditor(null)}
          onSaved={(relativePath) => {
            setEditor(null);
            loadTree(selectedVault.vaultPath);
            // Select the saved page (or clear if it was deleted).
            setSelectedPage(relativePath);
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// Tree view (recursive)
// =============================================================================

interface TreeViewProps {
  nodes: WikiTreeNode[];
  selected: string | null;
  onSelect: (relativePath: string) => void;
  /**
   * Set of directory relativePaths that are currently COLLAPSED. Default
   * (path not in set) is expanded — matches earlier behavior so users who
   * haven't touched anything see the full tree.
   */
  collapsed: Set<string>;
  /** Toggle collapsed state for a folder (persists to localStorage). */
  onToggleFolder: (relativePath: string) => void;
  /**
   * Optional map of folder name → friendly display label. Applied only to
   * top-level rows (depth 0) so canonical folders read "SOPs" not "sop".
   */
  labelOverrides?: Record<string, string>;
  /** Extra class on the depth-0 root `<ul>` (e.g. to opt out of flex-grow). */
  rootClassName?: string;
  depth?: number;
}

function TreeView({
  nodes,
  selected,
  onSelect,
  collapsed,
  onToggleFolder,
  labelOverrides,
  rootClassName,
  depth = 0,
}: TreeViewProps): JSX.Element {
  return (
    <ul
      className={`wiki-tree${rootClassName ? ` ${rootClassName}` : ''}`}
      style={{ paddingLeft: depth === 0 ? 0 : 12 }}
    >
      {nodes.map((node) => {
        if (node.type === 'directory') {
          const frozenTooltip = node.frozenDescription
            ? `Frozen: ${node.frozenDescription}`
            : 'Frozen — OSS code references this path by name. Agents cannot write here via wiki-ingest.';
          const isCollapsed = collapsed.has(node.relativePath);
          const childCount = node.children?.length ?? 0;
          return (
            <li key={node.relativePath} className="wiki-tree-dir">
              <button
                type="button"
                className="wiki-tree-row dir"
                onClick={() => onToggleFolder(node.relativePath)}
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? 'Expand folder' : 'Collapse folder'}
              >
                {isCollapsed ? (
                  <ChevronRight size={12} className="wiki-tree-chevron" />
                ) : (
                  <ChevronDown size={12} className="wiki-tree-chevron" />
                )}
                <Folder size={14} />
                <span className="wiki-tree-name">
                  {(depth === 0 && labelOverrides?.[node.name]) || node.name}
                </span>
                {childCount > 0 && (
                  <span className="wiki-tree-child-count">{childCount}</span>
                )}
                {node.frozen && (
                  <span className="wiki-frozen-pill" title={frozenTooltip}>
                    <Lock size={10} /> frozen
                  </span>
                )}
              </button>
              {!isCollapsed && childCount > 0 && (
                <TreeView
                  nodes={node.children ?? []}
                  selected={selected}
                  onSelect={onSelect}
                  collapsed={collapsed}
                  onToggleFolder={onToggleFolder}
                  depth={depth + 1}
                />
              )}
              {!isCollapsed && childCount === 0 && (
                <div className="wiki-tree-empty-hint">No pages yet</div>
              )}
            </li>
          );
        }
        const active = selected === node.relativePath;
        return (
          <li key={node.relativePath}>
            <button
              type="button"
              className={`wiki-tree-row file${active ? ' active' : ''}`}
              onClick={() => onSelect(node.relativePath)}
            >
              <FileText size={14} />
              <span className="wiki-tree-name">{node.name}</span>
              {node.frozen && (
                <span className="wiki-frozen-pill" title="Frozen folder">
                  <Lock size={10} />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// =============================================================================
// Search results
// =============================================================================

interface SearchResultsProps {
  hits: WikiSearchHit[];
  selected: string | null;
  /** Show each hit's owning vault label (all-vault search). */
  showVault?: boolean;
  /** Keyboard-highlighted row index (-1/undefined = none). */
  activeIndex?: number;
  onSelect: (relativePath: string, vaultPath?: string) => void;
}

/**
 * Render the flat list of search hits returned by `/api/wiki/search[-all]`.
 * Each row is a single matching file with up to three snippet lines; in
 * all-vault mode each row is tagged with its owning vault.
 */
function SearchResults({ hits, selected, showVault, activeIndex, onSelect }: SearchResultsProps): JSX.Element {
  return (
    <ul className="wiki-search-results">
      {hits.map((hit, idx) => {
        const active = selected === hit.relativePath && !hit.vaultPath;
        const kbd = idx === activeIndex;
        return (
          <li key={`${hit.vaultPath ?? ''}:${hit.relativePath}`}>
            <button
              type="button"
              role="option"
              aria-selected={kbd}
              className={`wiki-search-hit${active ? ' active' : ''}${kbd ? ' kbd-active' : ''}`}
              onClick={() => onSelect(hit.relativePath, hit.vaultPath)}
            >
              <div className="wiki-search-path">
                <FileText size={13} /> {hit.relativePath}
                {hit.matchCount > 0 && (
                  <span className="wiki-search-count"> · {hit.matchCount}</span>
                )}
                {showVault && hit.vaultLabel && (
                  <span className="wiki-search-vault">{hit.vaultLabel}</span>
                )}
              </div>
              {hit.snippets.length > 0 && (
                <ul className="wiki-search-snippets">
                  {hit.snippets.map((s) => (
                    <li key={s.lineNumber}>
                      <span className="wiki-search-line">L{s.lineNumber}</span>{' '}
                      {s.text}
                    </li>
                  ))}
                </ul>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// =============================================================================
// Backlinks panel
// =============================================================================

interface BacklinksPanelProps {
  backlinks: WikiBacklink[] | null;
  loading: boolean;
  onSelect: (relativePath: string) => void;
}

/**
 * Render a small "Referenced by" section below the page content. Shows
 * every other page whose wikilinks resolve to the currently open page.
 */
function BacklinksPanel({ backlinks, loading, onSelect }: BacklinksPanelProps): JSX.Element | null {
  if (loading) {
    return (
      <div className="wiki-backlinks">
        <div className="wiki-backlinks-header">
          <LinkIcon size={13} /> Referenced by
        </div>
        <div className="wiki-loading">Scanning…</div>
      </div>
    );
  }
  if (!backlinks || backlinks.length === 0) return null;
  return (
    <div className="wiki-backlinks">
      <div className="wiki-backlinks-header">
        <LinkIcon size={13} /> Referenced by{' '}
        <span className="wiki-backlinks-count">{backlinks.length}</span>
      </div>
      <ul className="wiki-backlinks-list">
        {backlinks.map((bl) => (
          <li key={bl.relativePath}>
            <button
              type="button"
              className="wiki-backlink-row"
              onClick={() => onSelect(bl.relativePath)}
            >
              <div className="wiki-backlink-path">
                <FileText size={12} /> {bl.relativePath}
              </div>
              {bl.snippets.map((s) => (
                <div key={s.lineNumber} className="wiki-backlink-snippet">
                  <span className="wiki-search-line">L{s.lineNumber}</span> {s.text}
                </div>
              ))}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// Migration banner
// =============================================================================

interface MigrationBannerProps {
  scan: WikiMigrateScanPayload | null;
  loading: boolean;
  applying: boolean;
  expanded: boolean;
  dismissed: boolean;
  error: string | null;
  result: WikiMigrateScanPayload | null;
  onApply: () => void;
  onToggle: () => void;
  onDismiss: () => void;
  onCloseResult: () => void;
}

/**
 * Top-of-page banner that detects legacy `.crewly/knowledge/` data and
 * offers a one-click migration. Hidden when no legacy data is present
 * OR after the user dismisses it for the session.
 */
function MigrationBanner({
  scan,
  loading,
  applying,
  expanded,
  dismissed,
  error,
  result,
  onApply,
  onToggle,
  onDismiss,
  onCloseResult,
}: MigrationBannerProps): JSX.Element | null {
  // Success state takes priority — show a confirmation after apply.
  if (result) {
    return (
      <div className="wiki-migrate-banner wiki-migrate-success">
        <div className="wiki-migrate-row">
          <CheckCircle2 size={16} />
          <div className="wiki-migrate-text">
            Migration complete — {result.applied ?? 0} page
            {result.applied === 1 ? '' : 's'} imported
            {result.skipped ? `, ${result.skipped} skipped` : ''}
            {result.bootstrapped && result.bootstrapped.length > 0
              ? `; ${result.bootstrapped.length} vault${result.bootstrapped.length === 1 ? '' : 's'} bootstrapped`
              : ''}
            .
          </div>
          <button
            type="button"
            className="wiki-migrate-dismiss"
            onClick={onCloseResult}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }
  if (loading && !scan) return null;
  if (dismissed) return null;
  if (!scan?.legacyDetected) return null;
  const proposed = scan.proposedPages.filter((p) => !p.skipReason);
  if (proposed.length === 0 && !scan.bootstrapNeeded.project) {
    // Nothing to do — don't nag.
    return null;
  }

  // Count categories restricted to the NOT-yet-migrated subset. Without
  // this filter, the summary line would show the full legacy corpus
  // (including 538 already-migrated entries) and look like a wall of
  // imports — see B2 audit (2026-05-27).
  const newCounts: Record<string, number> = {};
  for (const p of proposed) {
    const label = SOURCE_TYPE_LABEL[p.sourceType] ?? p.sourceType;
    newCounts[label] = (newCounts[label] ?? 0) + 1;
  }
  const summaryBits = Object.entries(newCounts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`)
    .join(' · ');
  const alreadyMigrated = scan.summary.alreadyMigrated ?? 0;

  return (
    <div className="wiki-migrate-banner">
      <div className="wiki-migrate-row">
        <Upload size={16} />
        <div className="wiki-migrate-text">
          Detected legacy <code>.crewly/knowledge/</code> data:{' '}
          <strong>{proposed.length}</strong> new page{proposed.length === 1 ? '' : 's'} to import
          {summaryBits && <span className="wiki-migrate-counts"> ({summaryBits})</span>}
          {alreadyMigrated > 0 && (
            <span className="wiki-migrate-counts">
              {' '}· <strong>{alreadyMigrated}</strong> already migrated (skipped)
            </span>
          )}.
          {scan.bootstrapNeeded.project ||
          scan.bootstrapNeeded.global ||
          scan.bootstrapNeeded.teams.length > 0 ? (
            <span className="wiki-migrate-counts">
              {' '}
              Will also bootstrap{' '}
              {[
                scan.bootstrapNeeded.project && 'project vault',
                scan.bootstrapNeeded.global && 'global vault',
                scan.bootstrapNeeded.teams.length > 0 &&
                  `${scan.bootstrapNeeded.teams.length} team vault${
                    scan.bootstrapNeeded.teams.length === 1 ? '' : 's'
                  }`,
              ]
                .filter(Boolean)
                .join(', ')}
              .
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="wiki-migrate-btn"
          onClick={onToggle}
        >
          {expanded ? 'Hide preview' : 'Preview'}
        </button>
        <button
          type="button"
          className="wiki-migrate-btn primary"
          onClick={onApply}
          disabled={applying}
        >
          {applying ? 'Migrating…' : 'Migrate now'}
        </button>
        <button
          type="button"
          className="wiki-migrate-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss for this session"
        >
          <X size={14} />
        </button>
      </div>
      {error && (
        <div className="wiki-migrate-error">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      {expanded && (
        <ul className="wiki-migrate-preview">
          {proposed.slice(0, 40).map((p) => (
            <li key={p.sourceId}>
              <span className={`wiki-migrate-type type-${p.sourceType}`}>{p.sourceType}</span>
              <span className="wiki-migrate-title">{p.title}</span>
              <span className="wiki-migrate-arrow">→</span>
              <span className="wiki-migrate-target">{p.targetRelativePath}</span>
              {p.routingUncertain && (
                <span className="wiki-migrate-uncertain" title="Body mentions cross-project signals — review with wiki-lint after migration.">
                  uncertain scope
                </span>
              )}
            </li>
          ))}
          {proposed.length > 40 && (
            <li className="wiki-migrate-more">
              … {proposed.length - 40} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// =============================================================================
// Missing concepts (Karpathy lint "important concepts mentioned but lacking their own page")
// =============================================================================

interface MissingConceptsProps {
  concepts: WikiMissingConcept[];
  /** Called with the concept's target slug so the parent can drop it
   * into the search input — quickest way to see "who mentions this". */
  onSelect: (target: string) => void;
}

/**
 * Renders the top missing-concept signals from `wiki-lint`. Each row is
 * a clickable chip that drops the concept name into the search box, so
 * the user can see who's been referencing the missing concept and pick
 * a place to author its page.
 *
 * Hidden when the vault has no missing concepts (the wiki is in good
 * shape). Sorted by reference count desc (most-mentioned first) — that's
 * already the order the backend returns them.
 */
function MissingConcepts({ concepts, onSelect }: MissingConceptsProps): JSX.Element | null {
  if (!concepts || concepts.length === 0) return null;
  return (
    <div className="wiki-missing-concepts">
      <div className="wiki-missing-header">
        <Lightbulb size={13} /> Missing concepts{' '}
        <span className="wiki-missing-count">{concepts.length}</span>
      </div>
      <div className="wiki-missing-hint">
        These wikilink targets are referenced 3+ times across the vault but
        have no dedicated page. Authoring one for each will compound the
        wiki's value. Click to find references via search.
      </div>
      <ul className="wiki-missing-list">
        {concepts.slice(0, 12).map((c) => (
          <li key={c.target}>
            <button
              type="button"
              className="wiki-missing-row"
              onClick={() => onSelect(c.target)}
              title={`Referenced in ${c.sources.length} page${c.sources.length === 1 ? '' : 's'}`}
            >
              <span className="wiki-missing-count-badge">{c.referenceCount}×</span>
              <span className="wiki-missing-target">[[{c.target}]]</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// Recent activity widget
// =============================================================================

interface RecentActivityProps {
  entries: WikiRecentEntry[] | null;
  loading: boolean;
  onSelect: (relativePath: string) => void;
}

/**
 * Compact list of recently-modified pages in the currently-selected vault.
 * Helps a human user spot "what just landed here" without expanding the
 * tree. Hidden when there's no vault selected or the vault is empty.
 */
function RecentActivity({ entries, loading, onSelect }: RecentActivityProps): JSX.Element | null {
  if (loading) {
    return (
      <div className="wiki-recent">
        <div className="wiki-recent-header">
          <Clock size={13} /> Recently updated
        </div>
        <div className="wiki-loading">Loading…</div>
      </div>
    );
  }
  if (!entries || entries.length === 0) return null;
  return (
    <div className="wiki-recent">
      <div className="wiki-recent-header">
        <Clock size={13} /> Recently updated
      </div>
      <ul className="wiki-recent-list">
        {entries.map((entry) => (
          <li key={entry.relativePath}>
            <button
              type="button"
              className="wiki-recent-row"
              onClick={() => onSelect(entry.relativePath)}
            >
              <div className="wiki-recent-path">
                <FileText size={12} /> {entry.relativePath}
              </div>
              <div className="wiki-recent-meta">
                {formatRelativeTime(entry.modifiedAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Format an ISO timestamp as a coarse "X ago" string. Anything older than
 * a week falls back to the localized date string.
 */
function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return new Date(then).toLocaleDateString();
}

// =============================================================================
// Wikilink resolver
// =============================================================================

/**
 * Resolve a `[[wikilink]]` target against the flat list of `.md` files in
 * the current vault tree. Tries (in order):
 *  1. Exact relative-path match (with or without `.md` suffix).
 *  2. Suffix match — any path that ends with `<target>(.md)`.
 *  3. Basename match — any file whose name (without `.md`) equals target.
 * All comparisons are case-insensitive. Returns the matched relativePath, or
 * `null` when nothing matched.
 *
 * @param target - Wikilink target, e.g. `"anthropic"`, `"customers/anthropic"`.
 * @param paths - Flat list of `.md` relative paths in the vault.
 */
export function resolveWikilink(target: string, paths: string[]): string | null {
  const t = target.trim().toLowerCase();
  if (!t) return null;
  const tWithMd = t.endsWith('.md') ? t : `${t}.md`;
  const tNoMd = t.endsWith('.md') ? t.slice(0, -3) : t;

  let suffixMatch: string | null = null;
  let basenameMatch: string | null = null;

  for (const p of paths) {
    const lower = p.toLowerCase();
    if (lower === tWithMd || lower === t) return p;
    if (!suffixMatch && (lower.endsWith(`/${tWithMd}`) || lower.endsWith(`/${t}`))) {
      suffixMatch = p;
    }
    if (!basenameMatch) {
      const base = lower.split('/').pop() ?? '';
      const baseNoMd = base.endsWith('.md') ? base.slice(0, -3) : base;
      if (baseNoMd === tNoMd) basenameMatch = p;
    }
  }
  return suffixMatch ?? basenameMatch;
}

export default Wiki;
