/**
 * Marketplace Page
 *
 * Displays a browsable and searchable marketplace of skills, 3D models, and roles.
 * Users can filter by type, search, sort, and install/uninstall/update items.
 *
 * @module pages/Marketplace
 */

import { useState, useEffect, useCallback } from 'react';
import { Store, Download, Star, RefreshCw, Package, Check, ArrowUp, Upload, Clock, CheckCircle, XCircle, Plug } from 'lucide-react';
import { PageToolbar } from '../components/UI/PageToolbar';
import { Dropdown } from '../components/UI/Dropdown';
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
const tabs: { label: string; value: MarketplaceItemType | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Skills', value: 'skill' },
  { label: '3D Models', value: 'model' },
  { label: 'Roles', value: 'role' },
  { label: 'MCP Tools', value: 'mcp_tool' },
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
const typeBadgeColor: Record<MarketplaceItemType, string> = {
  skill: 'bg-blue-500/20 text-blue-400',
  model: 'bg-primary/20 text-primary',
  role: 'bg-emerald-500/20 text-emerald-400',
  mcp_tool: 'bg-orange-500/20 text-orange-400',
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
  const [activeType, setActiveType] = useState<MarketplaceItemType | 'all'>('all');
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
        type: activeType === 'all' ? undefined : activeType,
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
        <div className="flex items-center gap-3">
          <Store className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold text-text-primary-dark">Marketplace</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-gray-900 rounded-lg p-1" role="tablist" aria-label="View mode">
            <button
              onClick={() => setViewMode('browse')}
              role="tab"
              aria-selected={viewMode === 'browse'}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === 'browse' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              <Package className="w-3.5 h-3.5" />
              Browse
            </button>
            <button
              onClick={() => setViewMode('submissions')}
              role="tab"
              aria-selected={viewMode === 'submissions'}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === 'submissions' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              Submissions
            </button>
          </div>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
            aria-label="Refresh marketplace"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
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
          {loading ? (
            <div className="text-center py-16 text-gray-400" role="status">Loading marketplace...</div>
          ) : error ? (
            <div className="text-center py-16 text-red-400" role="alert">{error}</div>
          ) : items.length === 0 ? (
            <div className="text-center py-16 text-gray-400">No items found.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors"
                  data-testid={`marketplace-item-${item.id}`}
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${typeBadgeColor[item.type]}`}>
                        {item.type}
                      </span>
                      <span className="text-xs text-gray-500">v{item.version}</span>
                    </div>
                    {item.installStatus === 'installed' && (
                      <Check className="w-4 h-4 text-green-400" aria-label="Installed" />
                    )}
                    {item.installStatus === 'update_available' && (
                      <ArrowUp className="w-4 h-4 text-yellow-400" aria-label="Update available" />
                    )}
                  </div>

                  {/* Card body */}
                  <h3 className="text-base font-semibold text-white mb-1">{item.name}</h3>
                  <p className="text-sm text-gray-400 mb-3 line-clamp-2">{item.description}</p>

                  {/* Metadata */}
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-4">
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
                      <button
                        onClick={() => handleInstall(item.id)}
                        disabled={operatingOn === item.id}
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 text-white rounded-lg disabled:opacity-50 transition-colors"
                      >
                        <Package className="w-3 h-3" />
                        {operatingOn === item.id ? 'Installing...' : 'Install'}
                      </button>
                    )}
                    {item.installStatus === 'installed' && (
                      <button
                        onClick={() => handleUninstall(item.id)}
                        disabled={operatingOn === item.id}
                        className="flex-1 px-3 py-1.5 text-sm bg-gray-800 hover:bg-red-900/50 text-gray-300 hover:text-red-300 rounded-lg disabled:opacity-50 transition-colors"
                      >
                        {operatingOn === item.id ? 'Removing...' : 'Uninstall'}
                      </button>
                    )}
                    {item.installStatus === 'update_available' && (
                      <>
                        <button
                          onClick={() => handleUpdate(item.id)}
                          disabled={operatingOn === item.id}
                          className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg disabled:opacity-50 transition-colors"
                        >
                          <ArrowUp className="w-3 h-3" />
                          {operatingOn === item.id ? 'Updating...' : 'Update'}
                        </button>
                        <button
                          onClick={() => handleUninstall(item.id)}
                          disabled={operatingOn === item.id}
                          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-red-900/50 text-gray-300 hover:text-red-300 rounded-lg disabled:opacity-50 transition-colors"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {viewMode === 'submissions' && (
        <>
          {/* Submissions header */}
          <div className="mb-6">
            <p className="text-sm text-gray-400">
              Submit skills via CLI: <code className="bg-gray-800 px-2 py-0.5 rounded text-xs text-gray-300">crewly publish path/to/skill --submit</code>
            </p>
          </div>

          {/* Submissions list */}
          {loading ? (
            <div className="text-center py-16 text-gray-400" role="status">Loading submissions...</div>
          ) : error ? (
            <div className="text-center py-16 text-red-400" role="alert">{error}</div>
          ) : submissions.length === 0 ? (
            <div className="text-center py-16 text-gray-400">No submissions yet.</div>
          ) : (
            <div className="space-y-3">
              {submissions.map((sub) => (
                <div
                  key={sub.id}
                  className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors"
                  data-testid={`submission-${sub.id}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-base font-semibold text-white">{sub.name}</h3>
                        <span className="text-xs text-gray-500">v{sub.version}</span>
                        <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          sub.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' :
                          sub.status === 'approved' ? 'bg-green-500/20 text-green-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {sub.status === 'pending' && <Clock className="w-3 h-3" />}
                          {sub.status === 'approved' && <CheckCircle className="w-3 h-3" />}
                          {sub.status === 'rejected' && <XCircle className="w-3 h-3" />}
                          {sub.status}
                        </span>
                      </div>
                      <p className="text-sm text-gray-400 mb-2">{sub.description}</p>
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <span>by {sub.author}</span>
                        <span>{sub.category}</span>
                        <span>{new Date(sub.submittedAt).toLocaleDateString()}</span>
                      </div>
                      {sub.reviewNotes && (
                        <p className="mt-2 text-xs text-gray-400 italic">Review: {sub.reviewNotes}</p>
                      )}
                    </div>
                    {sub.status === 'pending' && (
                      <div className="flex gap-2 ml-4">
                        <button
                          onClick={() => handleReview(sub.id, 'approve')}
                          disabled={operatingOn === sub.id}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg disabled:opacity-50 transition-colors"
                        >
                          <CheckCircle className="w-3 h-3" />
                          {operatingOn === sub.id ? '...' : 'Approve'}
                        </button>
                        <button
                          onClick={() => handleReview(sub.id, 'reject')}
                          disabled={operatingOn === sub.id}
                          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-red-900/50 text-gray-300 hover:text-red-300 rounded-lg disabled:opacity-50 transition-colors"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
