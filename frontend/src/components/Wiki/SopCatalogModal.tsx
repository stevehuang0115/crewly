/**
 * SopCatalogModal — browse the SOP catalog (config/sops) and install/uninstall
 * SOPs into the current team. A team only "owns" a SOP once installed; the
 * wiki's sop/ folder then mirrors the team's installed set.
 *
 * @module components/Wiki/SopCatalogModal
 */

import { useCallback, useEffect, useState } from 'react';
import { X, Download, Check, AlertCircle } from 'lucide-react';
import './SopCatalogModal.css';

/** A catalog entry as returned by GET /api/wiki/sop-catalog. */
interface CatalogEntry {
  path: string;
  title: string;
  category: string;
  bytes: number;
  installed: boolean;
}

export interface SopCatalogModalProps {
  /** Absolute team vault path the install targets. */
  vaultPath: string;
  /** Close the modal. */
  onClose: () => void;
  /** Called after any install/uninstall so the caller can refresh the tree. */
  onChanged: () => void;
}

/**
 * Modal listing the SOP catalog with per-entry Install / Installed toggle.
 *
 * @param props - See {@link SopCatalogModalProps}.
 * @returns The catalog modal.
 */
export function SopCatalogModal({ vaultPath, onClose, onChanged }: SopCatalogModalProps): JSX.Element {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/wiki/sop-catalog?vaultPath=${encodeURIComponent(vaultPath)}`);
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
      setEntries(body.catalog as CatalogEntry[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [vaultPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (entry: CatalogEntry) => {
      setBusy(entry.path);
      setError(null);
      const action = entry.installed ? 'uninstall' : 'install';
      try {
        const res = await fetch(`/api/wiki/sop-catalog/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vaultPath, sopPath: entry.path }),
        });
        const body = await res.json();
        if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
        setEntries((prev) =>
          prev.map((e) => (e.path === entry.path ? { ...e, installed: !entry.installed } : e)),
        );
        onChanged();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [vaultPath, onChanged],
  );

  // Group entries by category for display.
  const grouped = entries.reduce<Record<string, CatalogEntry[]>>((acc, e) => {
    (acc[e.category] ??= []).push(e);
    return acc;
  }, {});
  const installedCount = entries.filter((e) => e.installed).length;

  return (
    <div className="sop-catalog-backdrop" onClick={onClose} role="presentation">
      <div
        className="sop-catalog-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="SOP catalog"
        data-testid="sop-catalog-modal"
      >
        <div className="sop-catalog-header">
          <div>
            <h2>SOP Catalog</h2>
            <p className="sop-catalog-sub">
              Install SOPs from the shared catalog into this team. {installedCount} installed.
            </p>
          </div>
          <button type="button" className="sop-catalog-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="sop-catalog-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div className="sop-catalog-body">
          {loading && <div className="sop-catalog-loading">Loading catalog…</div>}
          {!loading && entries.length === 0 && (
            <div className="sop-catalog-empty">No SOPs in the catalog.</div>
          )}
          {!loading &&
            Object.entries(grouped).map(([category, items]) => (
              <div key={category} className="sop-catalog-group">
                <div className="sop-catalog-group-label">{category}</div>
                {items.map((entry) => (
                  <div key={entry.path} className="sop-catalog-row" data-testid={`sop-row-${entry.path}`}>
                    <div className="sop-catalog-row-info">
                      <span className="sop-catalog-row-title">{entry.title}</span>
                      <span className="sop-catalog-row-path">{entry.path}</span>
                    </div>
                    <button
                      type="button"
                      className={`sop-catalog-btn${entry.installed ? ' installed' : ''}`}
                      disabled={busy === entry.path}
                      onClick={() => toggle(entry)}
                      data-testid={`sop-toggle-${entry.path}`}
                    >
                      {entry.installed ? (
                        <>
                          <Check size={13} /> Installed
                        </>
                      ) : (
                        <>
                          <Download size={13} /> Install
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

export default SopCatalogModal;
