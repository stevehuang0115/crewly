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

import { useEffect, useState, useCallback, useMemo } from 'react';
import { BookOpen, Folder, FileText, Lock, RefreshCw, AlertCircle } from 'lucide-react';
import './Wiki.css';

interface WikiVaultStats {
  totalMdCount: number;
  recentMdCount: number;
  queue: {
    pending: number;
    processed: number;
    total: number;
  };
}

interface WikiVault {
  vaultPath: string;
  scope: 'global' | 'team' | 'project' | 'unknown';
  vaultId: string;
  label: string;
  stats: WikiVaultStats | null;
}

interface WikiTreeNode {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  frozen?: boolean;
  bytes?: number;
  modifiedAt?: string;
  children?: WikiTreeNode[];
}

interface PagePayload {
  vaultPath: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string;
  content: string;
}

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
  const [vaults, setVaults] = useState<WikiVault[]>([]);
  const [vaultsLoading, setVaultsLoading] = useState(true);
  const [vaultsError, setVaultsError] = useState<string | null>(null);

  const [selectedVault, setSelectedVault] = useState<WikiVault | null>(null);
  const [tree, setTree] = useState<WikiTreeNode[] | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [selectedPage, setSelectedPage] = useState<string | null>(null);
  const [pageContent, setPageContent] = useState<PagePayload | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

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
      // Auto-select the project vault if no selection yet.
      if (sorted.length > 0 && !selectedVault) {
        const initial = sorted.find((v) => v.scope === 'project') ?? sorted[0];
        setSelectedVault(initial);
      }
    } catch (err) {
      setVaultsError(err instanceof Error ? err.message : String(err));
    } finally {
      setVaultsLoading(false);
    }
  }, [selectedVault]);

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

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  useEffect(() => {
    loadVaults();
  }, [loadVaults]);

  useEffect(() => {
    if (selectedVault) {
      loadTree(selectedVault.vaultPath);
    }
  }, [selectedVault, loadTree]);

  useEffect(() => {
    if (selectedVault && selectedPage) {
      loadPage(selectedVault.vaultPath, selectedPage);
    }
  }, [selectedVault, selectedPage, loadPage]);

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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="wiki-page">
      <div className="wiki-header">
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
                  onClick={() => setSelectedVault(v)}
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

        {/* Middle: file tree */}
        <section className="wiki-tree-pane">
          <div className="wiki-pane-header">
            <span>
              {selectedVault ? selectedVault.label : 'Pick a vault'}
              {selectedVault && tree && <span className="wiki-page-count"> · {pageCount}</span>}
            </span>
          </div>
          {treeError && (
            <div className="wiki-error">
              <AlertCircle size={14} /> {treeError}
            </div>
          )}
          {treeLoading && <div className="wiki-loading">Loading tree…</div>}
          {tree && (
            <TreeView
              nodes={tree}
              selected={selectedPage}
              onSelect={(rel) => setSelectedPage(rel)}
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
            <pre className="wiki-page-content">{pageContent.content}</pre>
          )}
          {!selectedPage && !pageLoading && !pageError && (
            <div className="wiki-empty">
              Click a page on the left to view its markdown content. Frozen
              folders (sop/, memory/, …) are visible but managed by the OSS
              code path — not editable here.
            </div>
          )}
        </main>
      </div>
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
  depth?: number;
}

function TreeView({ nodes, selected, onSelect, depth = 0 }: TreeViewProps): JSX.Element {
  return (
    <ul className="wiki-tree" style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      {nodes.map((node) => {
        if (node.type === 'directory') {
          return (
            <li key={node.relativePath} className="wiki-tree-dir">
              <div className="wiki-tree-row dir">
                <Folder size={14} />
                <span className="wiki-tree-name">{node.name}</span>
                {node.frozen && (
                  <span className="wiki-frozen-pill" title="Frozen — OSS code references this path">
                    <Lock size={10} /> frozen
                  </span>
                )}
              </div>
              {node.children && node.children.length > 0 && (
                <TreeView
                  nodes={node.children}
                  selected={selected}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
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

export default Wiki;
