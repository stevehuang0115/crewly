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
import { ConfirmDialog } from '@crewly/ui/ConfirmDialog';
import { Alert, Badge, Button, Card, LoadingSpinner } from '@crewly/ui';
import type { BadgeVariant } from '@crewly/ui';

/** Badge variant per item type */
const typeBadgeVariant: Record<MarketplaceItemType, BadgeVariant> = {
  skill: 'info',
  model: 'primary',
  role: 'success',
  mcp_tool: 'warning',
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
        <LoadingSpinner size="md" text="Loading item details..." className="py-16" />
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Button
          variant="ghost"
          size="sm"
          icon={ArrowLeft}
          onClick={() => navigate('/marketplace')}
          className="mb-6"
        >
          Back to Marketplace
        </Button>
        <Alert variant="error">
          {error || 'Item not found'}
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back navigation */}
      <Button
        variant="ghost"
        size="sm"
        icon={ArrowLeft}
        onClick={() => navigate('/marketplace')}
        className="mb-6"
        data-testid="back-to-marketplace"
      >
        Back to Marketplace
      </Button>

      {/* Header */}
      <Card padding="lg" className="mb-6">
        <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-text-primary-dark" data-testid="item-name">
                {item.name}
              </h1>
              <Badge variant={typeBadgeVariant[item.type]}>
                {item.type}
              </Badge>
              <span className="text-xs text-text-secondary-dark">v{item.version}</span>
              {item.installStatus === 'installed' && (
                <Check className="w-4 h-4 text-green-400" aria-label="Installed" />
              )}
              {item.installStatus === 'update_available' && (
                <ArrowUp className="w-4 h-4 text-yellow-400" aria-label="Update available" />
              )}
            </div>

            <p className="text-text-secondary-dark mb-4" data-testid="item-description">
              {item.description}
            </p>

            {/* Metadata row */}
            <div className="flex flex-wrap items-center gap-4 text-sm text-text-secondary-dark">
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
              <Button
                variant="primary"
                icon={Package}
                onClick={handleInstall}
                loading={operating}
                data-testid="install-btn"
              >
                {operating ? 'Installing...' : 'Install'}
              </Button>
            )}
            {item.installStatus === 'installed' && (
              <Button
                variant="outline"
                className="hover:text-rose-400"
                onClick={() => setShowUninstallConfirm(true)}
                loading={operating}
                data-testid="uninstall-btn"
              >
                {operating ? 'Removing...' : 'Uninstall'}
              </Button>
            )}
            {item.installStatus === 'update_available' && (
              <>
                <Button
                  variant="warning"
                  icon={ArrowUp}
                  onClick={handleInstall}
                  loading={operating}
                >
                  {operating ? 'Updating...' : 'Update'}
                </Button>
                <Button
                  variant="outline"
                  className="hover:text-rose-400"
                  onClick={() => setShowUninstallConfirm(true)}
                  disabled={operating}
                >
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Tags */}
      {item.tags && item.tags.length > 0 && (
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          <Tag className="w-4 h-4 text-text-secondary-dark" />
          {item.tags.map(tag => (
            <Badge key={tag} variant="default">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* README / Content area */}
      <Card padding="lg" data-testid="readme-section">
        <h2 className="text-lg font-semibold text-text-primary-dark mb-4">README</h2>
        <div className="prose prose-invert prose-sm max-w-none text-text-primary-dark">
          {item.metadata?.readme ? (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {String(item.metadata.readme)}
            </pre>
          ) : (
            <p className="text-text-secondary-dark italic">
              No README available for this item.
            </p>
          )}
        </div>
      </Card>

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
