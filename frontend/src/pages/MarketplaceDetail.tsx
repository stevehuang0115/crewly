/**
 * Marketplace Detail Page
 *
 * Displays full details for a single marketplace item including
 * name, description, metadata, and README content.
 *
 * @module pages/MarketplaceDetail
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Star, Download, Package, Check, ArrowUp,
  User, Calendar, Tag, Shield,
} from 'lucide-react';
import { fetchMarketplaceItem, installMarketplaceItem, uninstallMarketplaceItem } from '../services/marketplace.service';
import type { MarketplaceItemWithStatus, MarketplaceItemType } from '../types/marketplace.types';
import { useToast } from '../hooks/useToast';
import ToastContainer from '../components/Toast';
import { ConfirmDialog } from '../components/UI/ConfirmDialog';

/** CSS class mapping for item type badges */
const typeBadgeColor: Record<MarketplaceItemType, string> = {
  skill: 'bg-blue-500/20 text-blue-400',
  model: 'bg-primary/20 text-primary',
  role: 'bg-emerald-500/20 text-emerald-400',
  mcp_tool: 'bg-orange-500/20 text-orange-400',
};

/**
 * Format a download count for compact display.
 *
 * @param n - Download count
 * @returns Formatted string
 */
function formatDownloads(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Marketplace detail page component.
 *
 * Fetches a single item by route param :id and renders its full information
 * including metadata sidebar, description, and README content.
 *
 * @returns The marketplace detail page JSX
 */
export default function MarketplaceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<MarketplaceItemWithStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operating, setOperating] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const { toasts, addToast, dismissToast } = useToast();

  useEffect(() => {
    if (!id) return;
    loadItem(id);
  }, [id]);

  /**
   * Load a single marketplace item from the API.
   *
   * @param itemId - The item ID to fetch
   */
  const loadItem = async (itemId: string) => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchMarketplaceItem(itemId);
      setItem(data);
    } catch {
      setError('Failed to load item details');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Install the current item.
   */
  const handleInstall = async () => {
    if (!item) return;
    setOperating(true);
    try {
      const result = await installMarketplaceItem(item.id);
      addToast(result.message || `Installed ${item.name}`, result.success ? 'success' : 'error');
      await loadItem(item.id);
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Install failed', 'error');
    }
    setOperating(false);
  };

  /**
   * Uninstall the current item after confirmation.
   */
  const handleUninstallConfirm = async () => {
    if (!item) return;
    setShowUninstallConfirm(false);
    setOperating(true);
    try {
      const result = await uninstallMarketplaceItem(item.id);
      addToast(result.message || `Uninstalled ${item.name}`, result.success ? 'success' : 'error');
      await loadItem(item.id);
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Uninstall failed', 'error');
    }
    setOperating(false);
  };

  if (loading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="text-center py-16 text-gray-400" role="status">
          Loading item details...
        </div>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <button
          onClick={() => navigate('/marketplace')}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Marketplace
        </button>
        <div className="text-center py-16 text-red-400" role="alert">
          {error || 'Item not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back navigation */}
      <button
        onClick={() => navigate('/marketplace')}
        className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors"
        data-testid="back-to-marketplace"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Marketplace
      </button>

      {/* Header */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-white" data-testid="item-name">
                {item.name}
              </h1>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${typeBadgeColor[item.type]}`}>
                {item.type}
              </span>
              <span className="text-xs text-gray-500">v{item.version}</span>
              {item.installStatus === 'installed' && (
                <Check className="w-4 h-4 text-green-400" aria-label="Installed" />
              )}
              {item.installStatus === 'update_available' && (
                <ArrowUp className="w-4 h-4 text-yellow-400" aria-label="Update available" />
              )}
            </div>

            <p className="text-gray-400 mb-4" data-testid="item-description">
              {item.description}
            </p>

            {/* Metadata row */}
            <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500">
              <span className="flex items-center gap-1">
                <User className="w-3.5 h-3.5" />
                {item.author}
              </span>
              <span className="flex items-center gap-1">
                <Star className="w-3.5 h-3.5 text-yellow-500" />
                {item.rating.toFixed(1)}
              </span>
              <span className="flex items-center gap-1">
                <Download className="w-3.5 h-3.5" />
                {formatDownloads(item.downloads)}
              </span>
              <span className="flex items-center gap-1">
                <Shield className="w-3.5 h-3.5" />
                {item.license}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                {new Date(item.updatedAt).toLocaleDateString()}
              </span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 shrink-0">
            {item.installStatus === 'not_installed' && (
              <button
                onClick={handleInstall}
                disabled={operating}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-primary hover:bg-primary/90 text-white rounded-lg disabled:opacity-50 transition-colors"
                data-testid="install-btn"
              >
                <Package className="w-4 h-4" />
                {operating ? 'Installing...' : 'Install'}
              </button>
            )}
            {item.installStatus === 'installed' && (
              <button
                onClick={() => setShowUninstallConfirm(true)}
                disabled={operating}
                className="px-4 py-2 text-sm bg-gray-800 hover:bg-red-900/50 text-gray-300 hover:text-red-300 rounded-lg disabled:opacity-50 transition-colors"
                data-testid="uninstall-btn"
              >
                {operating ? 'Removing...' : 'Uninstall'}
              </button>
            )}
            {item.installStatus === 'update_available' && (
              <>
                <button
                  onClick={handleInstall}
                  disabled={operating}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg disabled:opacity-50 transition-colors"
                >
                  <ArrowUp className="w-4 h-4" />
                  {operating ? 'Updating...' : 'Update'}
                </button>
                <button
                  onClick={() => setShowUninstallConfirm(true)}
                  disabled={operating}
                  className="px-4 py-2 text-sm bg-gray-800 hover:bg-red-900/50 text-gray-300 hover:text-red-300 rounded-lg disabled:opacity-50 transition-colors"
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tags */}
      {item.tags && item.tags.length > 0 && (
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          <Tag className="w-4 h-4 text-gray-500" />
          {item.tags.map(tag => (
            <span
              key={tag}
              className="px-2 py-0.5 bg-gray-800 text-gray-400 text-xs rounded-full"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* README / Content area */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6" data-testid="readme-section">
        <h2 className="text-lg font-semibold text-white mb-4">README</h2>
        <div className="prose prose-invert prose-sm max-w-none text-gray-300">
          {item.metadata?.readme ? (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {String(item.metadata.readme)}
            </pre>
          ) : (
            <p className="text-gray-500 italic">
              No README available for this item.
            </p>
          )}
        </div>
      </div>

      {/* Uninstall confirmation */}
      <ConfirmDialog
        isOpen={showUninstallConfirm}
        onCancel={() => setShowUninstallConfirm(false)}
        onConfirm={handleUninstallConfirm}
        title="Uninstall Item"
        message={`Are you sure you want to uninstall ${item.name}? This action cannot be undone.`}
        confirmLabel="Uninstall"
        confirmVariant="danger"
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
