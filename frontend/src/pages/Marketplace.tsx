/**
 * Marketplace panels: Browse and Submissions (Marketplace hub tabs).
 *
 * Browse lists registry items (skills, 3D models, roles, MCP tools) as
 * compact rows: name, one quiet line (type · author · description), the
 * install state as a word, and at most two actions (Install, or Uninstall,
 * or Update + Remove). Version, rating, downloads, licence, tags and README
 * are on the item's detail page, which a row opens. Type and sort sit
 * behind the Filter button next to the search box. The "Connectors" type
 * lists the connectors and hands off to Connections, which owns Connect.
 *
 * Submissions lists skills submitted for review, with Approve / Reject on
 * pending ones; a row opens to its description and review notes.
 *
 * @module pages/Marketplace
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { ArrowUp, Package, RefreshCw, Search, Upload, Plug, PanelRightOpen } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { CONNECTORS, CONNECTOR_GROUPS } from '../config/connectors';
import {
  Alert,
  Button,
  CompactRow,
  EmptyState,
  FilterButton,
  IconButton,
  LoadingSpinner,
  ShowAll,
  StatusLabel,
  type FilterValue,
  type OverflowMenuItem,
} from '@crewly/ui';
import {
  fetchMarketplaceItems,
  installMarketplaceItem,
  uninstallMarketplaceItem,
  updateMarketplaceItem,
  refreshMarketplaceRegistry,
  fetchSubmissions,
  reviewMarketplaceSubmission,
} from '../services/marketplace.service';
import type { MarketplaceSubmission } from '../services/marketplace.service';
import type { MarketplaceItemWithStatus, MarketplaceItemType, SortOption } from '../types/marketplace.types';
import { useToast } from '../hooks/useToast';
import ToastContainer from '../components/Toast';
import { ROUTES } from '../constants/routes.constants';
import { formatRelative } from '../components/Triggers/schedule.utils';
import { ITEM_TYPE_LABEL } from '../components/Marketplace/marketplace-format';

export { ITEM_TYPE_LABEL, formatDownloads } from '../components/Marketplace/marketplace-format';

/**
 * `connector` is not a marketplace item type: connectors are not installed,
 * they are authorised against your own account. The type lists them for
 * discovery and hands off to Connections, which owns the Connect button.
 */
const CONNECTORS_TYPE = 'connector' as const;

type TypeFilter = MarketplaceItemType | 'all' | typeof CONNECTORS_TYPE;

/** Type filter options (the old category tabs). */
const TYPE_OPTIONS: { label: string; value: Exclude<TypeFilter, 'all'> }[] = [
  { label: 'Skills', value: 'skill' },
  { label: '3D Models', value: 'model' },
  { label: 'Roles', value: 'role' },
  { label: 'MCP Tools', value: 'mcp_tool' },
  { label: 'Connectors', value: CONNECTORS_TYPE },
];

/** Sort options. */
const SORT_OPTIONS: { label: string; value: SortOption }[] = [
  { label: 'Popular', value: 'popular' },
  { label: 'Highest Rated', value: 'rating' },
  { label: 'Newest', value: 'newest' },
];

/** Rows visible before "Show all N". */
const LIST_LIMIT = 5;

/** Which Marketplace panel to render. */
export type MarketplaceView = 'browse' | 'submissions';

/** Props for {@link Marketplace}. */
export interface MarketplaceProps {
  /** Panel to render (default Browse) */
  view?: MarketplaceView;
  /** Reports the number of pending submissions (for the tab pill) */
  onPendingCount?: (count: number) => void;
}

/**
 * Marketplace Browse / Submissions panel.
 *
 * @param props - {@link MarketplaceProps}
 * @returns The panel
 */
export default function Marketplace({ view = 'browse', onPendingCount }: MarketplaceProps = {}) {
  const { toasts, addToast, dismissToast } = useToast();
  return (
    <>
      {view === 'browse' ? <BrowsePanel addToast={addToast} /> : <SubmissionsPanel addToast={addToast} onPendingCount={onPendingCount} />}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

type AddToast = ReturnType<typeof useToast>['addToast'];

// =============================================================================
// Browse
// =============================================================================

/** The registry list with search, Filter (type, sort) and refresh. */
function BrowsePanel({ addToast }: { addToast: AddToast }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<MarketplaceItemWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterValue>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [operatingOn, setOperatingOn] = useState<string | null>(null);

  const activeType: TypeFilter = (filters.type?.[0] as TypeFilter | undefined) ?? 'all';
  const sortBy: SortOption = (filters.sort?.[0] as SortOption | undefined) ?? 'popular';

  const loadItems = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchMarketplaceItems({
        type: activeType === 'all' || activeType === CONNECTORS_TYPE ? undefined : activeType,
        search: searchQuery || undefined,
        sort: sortBy,
      });
      setItems(data);
    } catch {
      setError('Failed to load marketplace items');
    } finally {
      setLoading(false);
    }
  }, [activeType, searchQuery, sortBy]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  /** Run one install-state action and reload. */
  const operate = async (
    id: string,
    fn: (id: string) => Promise<{ success: boolean; message?: string }>,
    done: string,
    failed: string,
  ) => {
    setOperatingOn(id);
    try {
      const result = await fn(id);
      addToast(result.message || `${done} ${id}`, result.success ? 'success' : 'error');
      await loadItems();
    } catch (err) {
      addToast(err instanceof Error ? err.message : failed, 'error');
    }
    setOperatingOn(null);
  };

  const handleInstall = (id: string) => operate(id, installMarketplaceItem, 'Installed', 'Install failed');
  const handleUninstall = (id: string) => operate(id, uninstallMarketplaceItem, 'Uninstalled', 'Uninstall failed');
  const handleUpdate = (id: string) => operate(id, updateMarketplaceItem, 'Updated', 'Update failed');

  const handleRefresh = async () => {
    try {
      await refreshMarketplaceRegistry();
      addToast('Registry refreshed', 'success');
      await loadItems();
    } catch {
      addToast('Failed to refresh registry', 'error');
    }
  };

  const openDetail = (id: string) => navigate(`${ROUTES.marketplace}/${encodeURIComponent(id)}`);

  const matchingConnectors = (groupId: string) =>
    CONNECTORS.filter((c) => c.group === groupId).filter(
      (c) => !searchQuery.trim() || `${c.name} ${c.description}`.toLowerCase().includes(searchQuery.trim().toLowerCase()),
    );

  return (
    <div className="space-y-5" data-testid="marketplace-browse">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="marketplace-search" className="sr-only">Search marketplace</label>
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden="true" />
          <input
            id="marketplace-search"
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-2xl border border-border bg-surface pl-9 pr-3 text-sm text-text placeholder:text-text-3 focus:border-primary focus:outline-none"
          />
        </div>
        <FilterButton
          value={filters}
          onChange={setFilters}
          groups={[
            { id: 'type', label: 'Type', single: true, options: TYPE_OPTIONS },
            { id: 'sort', label: 'Sort', single: true, options: SORT_OPTIONS },
          ]}
        />
        <IconButton
          icon={RefreshCw}
          variant="outline"
          onClick={() => void handleRefresh()}
          aria-label="Refresh marketplace"
          title="Refresh marketplace"
        />
      </div>

      {activeType === CONNECTORS_TYPE ? (
        <div className="space-y-6" data-testid="marketplace-connectors">
          <p className="text-[13px] text-text-2">
            Connectors are not installed — you authorise them against your own account, and can revoke them at any
            time. Manage them on{' '}
            <Link to={ROUTES.connections} className="font-semibold text-primary-text hover:underline">
              Connections
            </Link>
            .
          </p>
          {CONNECTOR_GROUPS.map((group) => {
            const list = matchingConnectors(group.id);
            if (list.length === 0) return null;
            return (
              <section key={group.id} aria-label={group.title} className="space-y-2">
                <h2 className="px-1 text-[15px] font-semibold text-text">{group.title}</h2>
                <div className="overflow-hidden rounded-2xl border border-border-soft bg-surface">
                  {list.map((connector) => (
                    <CompactRow
                      key={connector.id}
                      data-testid={`marketplace-connector-${connector.id}`}
                      leading={<Plug className="h-4 w-4 text-text-3" aria-hidden="true" />}
                      primary={connector.name}
                      meta={connector.description}
                      actions={[
                        <Link
                          key="connect"
                          to={`${ROUTES.connections}?platform=${connector.id}`}
                          className="inline-flex h-8 items-center rounded-2xl bg-primary-soft px-3 text-sm font-semibold text-primary-text transition-colors hover:bg-primary/20"
                        >
                          Connect →
                        </Link>,
                      ]}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : loading ? (
        <LoadingSpinner size="md" text="Loading marketplace..." className="py-16" />
      ) : error ? (
        <Alert variant="error">{error}</Alert>
      ) : items.length === 0 ? (
        <EmptyState icon={Package} title="No items found." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border-soft bg-surface">
          <ShowAll limit={LIST_LIMIT}>
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                busy={operatingOn === item.id}
                onOpen={() => openDetail(item.id)}
                onInstall={() => void handleInstall(item.id)}
                onUninstall={() => void handleUninstall(item.id)}
                onUpdate={() => void handleUpdate(item.id)}
              />
            ))}
          </ShowAll>
        </div>
      )}
    </div>
  );
}

/** Props for one registry item row. */
interface ItemRowProps {
  item: MarketplaceItemWithStatus;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  onUpdate: () => void;
}

/** One registry item: name, type · author · description, install state, ≤2 actions. */
function ItemRow({ item, busy, onOpen, onInstall, onUninstall, onUpdate }: ItemRowProps) {
  const overflow: OverflowMenuItem[] = [{ label: 'View details', icon: PanelRightOpen, onClick: onOpen }];
  let actions: [ReactNode] | [ReactNode, ReactNode] | undefined;
  let trailing: ReactNode = null;

  if (item.installStatus === 'not_installed') {
    actions = [
      <Button key="install" variant="primary" size="sm" icon={Package} onClick={onInstall} loading={busy}>
        {busy ? 'Installing...' : 'Install'}
      </Button>,
    ];
  } else if (item.installStatus === 'installed') {
    trailing = <StatusLabel tone="success" size="sm">Installed</StatusLabel>;
    actions = [
      <Button key="uninstall" variant="outline" size="sm" onClick={onUninstall} loading={busy}>
        {busy ? 'Removing...' : 'Uninstall'}
      </Button>,
    ];
  } else if (item.installStatus === 'update_available') {
    trailing = <StatusLabel tone="attention" size="sm">Update available</StatusLabel>;
    actions = [
      <Button key="update" variant="primary" size="sm" icon={ArrowUp} onClick={onUpdate} loading={busy}>
        {busy ? 'Updating...' : 'Update'}
      </Button>,
      <Button key="remove" variant="outline" size="sm" onClick={onUninstall} disabled={busy}>
        Remove
      </Button>,
    ];
  }

  return (
    <CompactRow
      data-testid={`marketplace-item-${item.id}`}
      primary={item.name}
      meta={
        <>
          <span>{ITEM_TYPE_LABEL[item.type] ?? item.type}</span>
          <span aria-hidden="true"> · </span>
          <span>by {item.author}</span>
          {item.description && (
            <>
              <span aria-hidden="true"> · </span>
              <span title={item.description}>{item.description}</span>
            </>
          )}
        </>
      }
      onClick={onOpen}
      trailing={trailing}
      actions={actions}
      overflow={overflow}
      overflowLabel={`More actions for ${item.name}`}
    />
  );
}

// =============================================================================
// Submissions
// =============================================================================

/** Status tone per submission review status. */
const SUBMISSION_TONE: Record<MarketplaceSubmission['status'], 'attention' | 'success' | 'danger'> = {
  pending: 'attention',
  approved: 'success',
  rejected: 'danger',
};

/** Status word per submission review status. */
const SUBMISSION_LABEL: Record<MarketplaceSubmission['status'], string> = {
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Skills submitted for review, with Approve / Reject on pending ones. */
function SubmissionsPanel({ addToast, onPendingCount }: { addToast: AddToast; onPendingCount?: (n: number) => void }) {
  const [submissions, setSubmissions] = useState<MarketplaceSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operatingOn, setOperatingOn] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const loadSubmissions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchSubmissions();
      setSubmissions(data);
      onPendingCount?.(data.filter((s) => s.status === 'pending').length);
    } catch {
      setError('Failed to load submissions');
    } finally {
      setLoading(false);
    }
  }, [onPendingCount]);

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  const handleReview = async (id: string, action: 'approve' | 'reject') => {
    setOperatingOn(id);
    try {
      const result = await reviewMarketplaceSubmission(id, action);
      addToast(result.message || `${action === 'approve' ? 'Approved' : 'Rejected'}`, result.success ? 'success' : 'error');
      await loadSubmissions();
      // An approved skill should show up in Browse.
      if (action === 'approve') await refreshMarketplaceRegistry();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Review failed', 'error');
    }
    setOperatingOn(null);
  };

  return (
    <div className="space-y-5" data-testid="marketplace-submissions">
      <p className="text-[13px] text-text-2">
        Submit skills via CLI:{' '}
        <code className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs text-text">crewly publish path/to/skill --submit</code>
      </p>

      {loading ? (
        <LoadingSpinner size="md" text="Loading submissions..." className="py-16" />
      ) : error ? (
        <Alert variant="error">{error}</Alert>
      ) : submissions.length === 0 ? (
        <EmptyState icon={Upload} title="No submissions yet." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border-soft bg-surface">
          <ShowAll limit={LIST_LIMIT}>
            {submissions.map((sub) => {
              const busy = operatingOn === sub.id;
              const open = openId === sub.id;
              return (
                <div key={sub.id} className="border-b border-border-soft last:border-b-0" data-testid={`submission-${sub.id}`}>
                  <CompactRow
                    className="border-b-0"
                    primary={sub.name}
                    meta={`by ${sub.author} · ${sub.category} · ${formatRelative(sub.submittedAt) || new Date(sub.submittedAt).toLocaleDateString()}`}
                    onClick={() => setOpenId(open ? null : sub.id)}
                    selected={open}
                    trailing={<StatusLabel tone={SUBMISSION_TONE[sub.status] ?? 'danger'} size="sm">{SUBMISSION_LABEL[sub.status] ?? sub.status}</StatusLabel>}
                    actions={
                      sub.status === 'pending'
                        ? [
                            <Button key="approve" variant="success" size="sm" onClick={() => void handleReview(sub.id, 'approve')} loading={busy}>
                              {busy ? '...' : 'Approve'}
                            </Button>,
                            <Button key="reject" variant="outline" size="sm" onClick={() => void handleReview(sub.id, 'reject')} disabled={busy}>
                              Reject
                            </Button>,
                          ]
                        : undefined
                    }
                  />
                  {open && (
                    <div className="space-y-2 px-4 pb-4 text-sm" data-testid={`submission-detail-${sub.id}`}>
                      <p className="text-text-2">{sub.description}</p>
                      <p className="text-[13px] text-text-3">
                        Version {sub.version} · submitted {new Date(sub.submittedAt).toLocaleString()}
                      </p>
                      {sub.reviewNotes && <p className="text-[13px] italic text-text-2">Review: {sub.reviewNotes}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </ShowAll>
        </div>
      )}
    </div>
  );
}
