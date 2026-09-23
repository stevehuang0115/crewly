/**
 * Marketplace Page
 *
 * Displays a browsable and searchable marketplace of skills, 3D models, and roles.
 * Users can filter by type, search, sort, and install/uninstall/update items.
 *
 * @module pages/Marketplace
 */

import { useState, useEffect, useCallback } from 'react';
import { Download, Star, RefreshCw, Package, Check, ArrowUp, Upload, Clock, CheckCircle, XCircle, Plug } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageToolbar } from '@crewly/ui/PageToolbar';
import { CONNECTORS, CONNECTOR_GROUPS } from '../config/connectors';
import { Dropdown } from '@crewly/ui/Dropdown';
import { Alert, Badge, Button, Card, EmptyState, LoadingSpinner, SegmentedControl } from '@crewly/ui';
import type { BadgeVariant } from '@crewly/ui';
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

/** Tab options for filtering by item type */
/**
 * `connector` is not a marketplace item type: connectors are not installed,
 * they are authorised against your own account. The tab lists them for
 * discovery and hands off to Connections, which owns the Connect button.
 */
const CONNECTORS_TAB = 'connector' as const;

const tabs: { label: string; value: MarketplaceItemType | 'all' | typeof CONNECTORS_TAB }[] = [
  { label: 'All', value: 'all' },
  { label: 'Skills', value: 'skill' },
  { label: '3D Models', value: 'model' },
  { label: 'Roles', value: 'role' },
  { label: 'MCP Tools', value: 'mcp_tool' },
  { label: 'Connectors', value: CONNECTORS_TAB },
];

/** Sort options for the dropdown */
const sortOptions: { label: string; value: SortOption }[] = [
  { label: 'Popular', value: 'popular' },
  { label: 'Highest Rated', value: 'rating' },
  { label: 'Newest', value: 'newest' },
];

/**
 * Format a download count for compact display.
 *
 * Numbers at or above 1000 are displayed as e.g. "1.5k".
 *
 * @param n - Download count
 * @returns Formatted string
 */
function formatDownloads(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** CSS class mapping for item type badges */
const typeBadgeVariant: Record<MarketplaceItemType, BadgeVariant> = {
  skill: 'info',
  model: 'primary',
  role: 'success',
  mcp_tool: 'warning',
};

/** Badge colour per submission review status. */
const submissionBadgeVariant: Record<MarketplaceSubmission['status'], BadgeVariant> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
};

/**
 * Marketplace page component.
 *
 * Renders a grid of marketplace items with filtering, search, sort controls,
 * and install/uninstall/update actions on each item card.
 *
 * @returns The marketplace page JSX
 */
/** View modes for the marketplace page */
type ViewMode = 'browse' | 'submissions';

export default function Marketplace() {
  const [viewMode, setViewMode] = useState<ViewMode>('browse');
  const [items, setItems] = useState<MarketplaceItemWithStatus[]>([]);
  const [submissions, setSubmissions] = useState<MarketplaceSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeType, setActiveType] = useState<MarketplaceItemType | 'all' | typeof CONNECTORS_TAB>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('popular');
  const [operatingOn, setOperatingOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toasts, addToast, dismissToast } = useToast();

  /**
   * Load marketplace items from the API with current filter/sort state.
   */
  const loadItems = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchMarketplaceItems({
        type: activeType === 'all' || activeType === CONNECTORS_TAB ? undefined : activeType,
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

  useEffect(() => { loadItems(); }, [loadItems]);

  /**
   * Handle installing a marketplace item.
   *
   * @param id - Item ID to install
   */
  const handleInstall = async (id: string) => {
    setOperatingOn(id);
    try {
      const result = await installMarketplaceItem(id);
      addToast(result.message || `Installed ${id}`, result.success ? 'success' : 'error');
      await loadItems();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Install failed';
      addToast(msg, 'error');
    }
    setOperatingOn(null);
  };

  /**
   * Handle uninstalling a marketplace item.
   *
   * @param id - Item ID to uninstall
   */
  const handleUninstall = async (id: string) => {
    setOperatingOn(id);
    try {
      const result = await uninstallMarketplaceItem(id);
      addToast(result.message || `Uninstalled ${id}`, result.success ? 'success' : 'error');
      await loadItems();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Uninstall failed';
      addToast(msg, 'error');
    }
    setOperatingOn(null);
  };

  /**
   * Handle updating a marketplace item.
   *
   * @param id - Item ID to update
   */
  const handleUpdate = async (id: string) => {
    setOperatingOn(id);
    try {
      const result = await updateMarketplaceItem(id);
      addToast(result.message || `Updated ${id}`, result.success ? 'success' : 'error');
      await loadItems();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      addToast(msg, 'error');
    }
    setOperatingOn(null);
  };

  /**
   * Handle refreshing the marketplace registry.
   */
  const handleRefresh = async () => {
    try {
      await refreshMarketplaceRegistry();
      addToast('Registry refreshed', 'success');
      await loadItems();
    } catch {
      addToast('Failed to refresh registry', 'error');
    }
  };

  /**
   * Load submissions from the API.
   */
  const loadSubmissions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchSubmissions();
      setSubmissions(data);
    } catch {
      setError('Failed to load submissions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewMode === 'submissions') {
      loadSubmissions();
    }
  }, [viewMode, loadSubmissions]);

  /**
   * Handle reviewing a submission.
   *
   * @param id - Submission ID
   * @param action - 'approve' or 'reject'
   */
  const handleReview = async (id: string, action: 'approve' | 'reject') => {
    setOperatingOn(id);
    try {
      const result = await reviewMarketplaceSubmission(id, action);
      addToast(result.message || `${action === 'approve' ? 'Approved' : 'Rejected'}`, result.success ? 'success' : 'error');
      await loadSubmissions();
      if (action === 'approve') {
        // Refresh the registry so the approved skill appears in browse
        await refreshMarketplaceRegistry();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Review failed';
      addToast(msg, 'error');
    }
    setOperatingOn(null);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary-dark">Marketplace</h1>
          <p className="text-sm text-text-secondary-dark">Browse and install skills, models, and tools.</p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl<'browse' | 'submissions'>
            aria-label="Marketplace view"
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'browse', label: 'Browse', icon: Package },
              { value: 'submissions', label: 'Submissions', icon: Upload },
            ]}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            onClick={handleRefresh}
            aria-label="Refresh marketplace"
          >
            Refresh
          </Button>
        </div>
      </div>

      {viewMode === 'browse' && (
        <>
          {/* Filters */}
          <PageToolbar
            tabs={tabs.map((tab) => ({ value: tab.value, label: tab.label }))}
            activeTab={activeType}
            onTabChange={(v) => setActiveType(v as typeof activeType)}
            searchPlaceholder="Search..."
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            searchDebounceMs={0}
            trailing={
              <Dropdown
                options={sortOptions}
                value={sortBy}
                onChange={(v) => setSortBy(v as SortOption)}
                aria-label="Sort by"
                className="w-[140px]"
              />
            }
            className="mb-6"
          />

          {/* Content */}
          {activeType === CONNECTORS_TAB ? (
            <div className="space-y-6" data-testid="marketplace-connectors">
              <p className="text-sm text-text-secondary-dark">
                Connectors are not installed — you authorise them against your own account, and can revoke
                them at any time. Manage them on{' '}
                <Link to="/connections" className="text-primary hover:underline">Connections</Link>.
              </p>
              {CONNECTOR_GROUPS.map((group) => (
                <section key={group.id} className="space-y-3">
                  <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">{group.title}</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {CONNECTORS.filter((c) => c.group === group.id)
                      .filter((c) => !searchQuery.trim() || `${c.name} ${c.description}`.toLowerCase().includes(searchQuery.trim().toLowerCase()))
                      .map((connector) => (
                        <Card
                          key={connector.id}
                          padding="lg"
                          className="flex flex-col hover:border-primary/30 transition-colors"
                          data-testid={`marketplace-connector-${connector.id}`}
                        >
                          <div className="flex items-center gap-2 mb-3">
                            <Plug className="w-4 h-4 text-primary" />
                            <Badge variant="primary">connector</Badge>
                          </div>
                          <h3 className="text-sm font-semibold mb-1">{connector.name}</h3>
                          <p className="text-xs text-text-secondary-dark leading-relaxed flex-1">{connector.description}</p>
                          <Link
                            to={`/connections?platform=${connector.id}`}
                            className="mt-4 inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-2xl bg-primary/10 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
                          >
                            Connect →
                          </Link>
                        </Card>
                      ))}
                  </div>
                </section>
              ))}
            </div>
          ) : loading ? (
            <LoadingSpinner size="md" text="Loading marketplace..." className="py-16" />
          ) : error ? (
            <Alert variant="error">{error}</Alert>
          ) : items.length === 0 ? (
            <EmptyState icon={Package} title="No items found." />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {items.map((item) => (
                <Card
                  key={item.id}
                  padding="lg"
                  className="hover:border-primary/30 transition-colors"
                  data-testid={`marketplace-item-${item.id}`}
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={typeBadgeVariant[item.type]}>
                        {item.type}
                      </Badge>
                      <span className="text-xs text-text-secondary-dark">v{item.version}</span>
                    </div>
                    {item.installStatus === 'installed' && (
                      <Check className="w-4 h-4 text-green-400" aria-label="Installed" />
                    )}
                    {item.installStatus === 'update_available' && (
                      <ArrowUp className="w-4 h-4 text-yellow-400" aria-label="Update available" />
                    )}
                  </div>

                  {/* Card body */}
                  <h3 className="text-base font-semibold text-text-primary-dark mb-1">{item.name}</h3>
                  <p className="text-sm text-text-secondary-dark mb-3 line-clamp-2">{item.description}</p>

                  {/* Metadata */}
                  <div className="flex items-center justify-between text-xs text-text-secondary-dark mb-4">
                    <span>by {item.author}</span>
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-yellow-500" />
                        {item.rating.toFixed(1)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Download className="w-3 h-3" />
                        {formatDownloads(item.downloads)}
                      </span>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex gap-2">
                    {item.installStatus === 'not_installed' && (
                      <Button
                        variant="primary"
                        size="sm"
                        icon={Package}
                        className="flex-1"
                        onClick={() => handleInstall(item.id)}
                        loading={operatingOn === item.id}
                      >
                        {operatingOn === item.id ? 'Installing...' : 'Install'}
                      </Button>
                    )}
                    {item.installStatus === 'installed' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 hover:text-rose-400"
                        onClick={() => handleUninstall(item.id)}
                        loading={operatingOn === item.id}
                      >
                        {operatingOn === item.id ? 'Removing...' : 'Uninstall'}
                      </Button>
                    )}
                    {item.installStatus === 'update_available' && (
                      <>
                        <Button
                          variant="warning"
                          size="sm"
                          icon={ArrowUp}
                          className="flex-1"
                          onClick={() => handleUpdate(item.id)}
                          loading={operatingOn === item.id}
                        >
                          {operatingOn === item.id ? 'Updating...' : 'Update'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="hover:text-rose-400"
                          onClick={() => handleUninstall(item.id)}
                          disabled={operatingOn === item.id}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {viewMode === 'submissions' && (
        <>
          {/* Submissions header */}
          <div className="mb-6">
            <p className="text-sm text-text-secondary-dark">
              Submit skills via CLI: <code className="bg-background-dark px-2 py-0.5 rounded text-xs text-text-primary-dark">crewly publish path/to/skill --submit</code>
            </p>
          </div>

          {/* Submissions list */}
          {loading ? (
            <LoadingSpinner size="md" text="Loading submissions..." className="py-16" />
          ) : error ? (
            <Alert variant="error">{error}</Alert>
          ) : submissions.length === 0 ? (
            <EmptyState icon={Upload} title="No submissions yet." />
          ) : (
            <div className="space-y-3">
              {submissions.map((sub) => (
                <Card
                  key={sub.id}
                  padding="lg"
                  className="hover:border-primary/30 transition-colors"
                  data-testid={`submission-${sub.id}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-base font-semibold text-text-primary-dark">{sub.name}</h3>
                        <span className="text-xs text-text-secondary-dark">v{sub.version}</span>
                        <Badge variant={submissionBadgeVariant[sub.status] ?? 'error'} className="gap-1">
                          {sub.status === 'pending' && <Clock className="w-3 h-3" />}
                          {sub.status === 'approved' && <CheckCircle className="w-3 h-3" />}
                          {sub.status === 'rejected' && <XCircle className="w-3 h-3" />}
                          {sub.status}
                        </Badge>
                      </div>
                      <p className="text-sm text-text-secondary-dark mb-2">{sub.description}</p>
                      <div className="flex items-center gap-4 text-xs text-text-secondary-dark">
                        <span>by {sub.author}</span>
                        <span>{sub.category}</span>
                        <span>{new Date(sub.submittedAt).toLocaleDateString()}</span>
                      </div>
                      {sub.reviewNotes && (
                        <p className="mt-2 text-xs text-text-secondary-dark italic">Review: {sub.reviewNotes}</p>
                      )}
                    </div>
                    {sub.status === 'pending' && (
                      <div className="flex gap-2 ml-4">
                        <Button
                          variant="success"
                          size="sm"
                          icon={CheckCircle}
                          onClick={() => handleReview(sub.id, 'approve')}
                          loading={operatingOn === sub.id}
                        >
                          {operatingOn === sub.id ? '...' : 'Approve'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="hover:text-rose-400"
                          onClick={() => handleReview(sub.id, 'reject')}
                          disabled={operatingOn === sub.id}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
