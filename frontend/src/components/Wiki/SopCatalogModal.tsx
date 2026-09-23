/**
 * SopCatalogModal — browse the SOP catalog (config/sops) and install/uninstall
 * SOPs into the current team. A team only "owns" a SOP once installed; the
 * wiki's sop/ folder then mirrors the team's installed set.
 *
 * @module components/Wiki/SopCatalogModal
 */

import { useCallback, useEffect, useState } from 'react';
import { Download, Check } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import { EmptyState } from '@crewly/ui/EmptyState';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Modal } from '@crewly/ui/Modal';

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
    <Modal isOpen onClose={onClose} title="SOP Catalog" size="xl" data-testid="sop-catalog-modal">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary-dark -mt-2">
          Install SOPs from the shared catalog into this team. {installedCount} installed.
        </p>

        {error && (
          <Alert variant="error" size="sm">
            {error}
          </Alert>
        )}

        <div className="max-h-[60vh] overflow-y-auto space-y-4">
          {loading && <LoadingSpinner size="sm" text="Loading catalog…" className="py-6" />}
          {!loading && entries.length === 0 && (
            <EmptyState compact title="No SOPs in the catalog." />
          )}
          {!loading &&
            Object.entries(grouped).map(([category, items]) => (
              <div key={category} className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary-dark">{category}</div>
                {items.map((entry) => (
                  <div
                    key={entry.path}
                    className="flex items-center justify-between gap-3 rounded-2xl px-3 py-2 hover:bg-background-dark"
                    data-testid={`sop-row-${entry.path}`}
                  >
                    <div className="min-w-0 flex flex-col">
                      <span className="text-sm text-text-primary-dark truncate">{entry.title}</span>
                      <span className="text-xs font-mono text-text-secondary-dark truncate">{entry.path}</span>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant={entry.installed ? 'secondary' : 'primary'}
                      icon={entry.installed ? Check : Download}
                      className={entry.installed ? 'text-emerald-400' : ''}
                      disabled={busy === entry.path}
                      onClick={() => toggle(entry)}
                      data-testid={`sop-toggle-${entry.path}`}
                    >
                      {entry.installed ? 'Installed' : 'Install'}
                    </Button>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>
    </Modal>
  );
}

export default SopCatalogModal;
