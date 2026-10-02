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
  ArrowLeft, Star, Download, Package, ArrowUp,
  User, Calendar, Tag, Shield,
} from 'lucide-react';
import { fetchMarketplaceItem, installMarketplaceItem, uninstallMarketplaceItem } from '../services/marketplace.service';
import type { MarketplaceItemWithStatus } from '../types/marketplace.types';
import { useToast } from '../hooks/useToast';
import ToastContainer from '../components/Toast';
import { ConfirmDialog } from '@crewly/ui/ConfirmDialog';
import { Alert, Button, LoadingSpinner, PageHeader, StatusLabel } from '@crewly/ui';
import { ITEM_TYPE_LABEL, formatDownloads } from '../components/Marketplace/marketplace-format';
import { ROUTES } from '../constants/routes.constants';

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

  const back = (
    <button
      type="button"
      onClick={() => navigate(ROUTES.marketplace)}
      className="inline-flex items-center gap-1 font-semibold text-primary-text hover:underline"
      data-testid="back-to-marketplace"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Marketplace
    </button>
  );

  if (loading) {
    return (
      <div className="max-w-4xl">
        <LoadingSpinner size="md" text="Loading item details..." className="py-16" />
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="max-w-4xl">
        <div className="mb-4 text-[13px]">{back}</div>
        <Alert variant="error">{error || 'Item not found'}</Alert>
      </div>
    );
  }

  const actions = (
    <>
      {item.installStatus === 'not_installed' && (
        <Button variant="primary" icon={Package} onClick={handleInstall} loading={operating} data-testid="install-btn">
          {operating ? 'Installing...' : 'Install'}
        </Button>
      )}
      {item.installStatus === 'installed' && (
        <Button
          variant="outline"
          onClick={() => setShowUninstallConfirm(true)}
          loading={operating}
          data-testid="uninstall-btn"
        >
          {operating ? 'Removing...' : 'Uninstall'}
        </Button>
      )}
      {item.installStatus === 'update_available' && (
        <>
          <Button variant="primary" icon={ArrowUp} onClick={handleInstall} loading={operating}>
            {operating ? 'Updating...' : 'Update'}
          </Button>
          <Button variant="outline" onClick={() => setShowUninstallConfirm(true)} disabled={operating}>
            Remove
          </Button>
        </>
      )}
    </>
  );

  return (
    <div className="max-w-4xl">
      <PageHeader
        eyebrow={back}
        title={<span data-testid="item-name">{item.name}</span>}
        actions={actions}
      />

      <p className="-mt-3 mb-3 text-[15px] text-text" data-testid="item-description">
        {item.description}
      </p>

      {/* One quiet meta line; the install state as a word */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-2" data-testid="item-meta">
        {item.installStatus === 'installed' && <StatusLabel tone="success" size="sm">Installed</StatusLabel>}
        {item.installStatus === 'update_available' && <StatusLabel tone="attention" size="sm">Update available</StatusLabel>}
        <span>{ITEM_TYPE_LABEL[item.type] ?? item.type}</span>
        <span>v{item.version}</span>
        <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />{item.author}</span>
        <span className="inline-flex items-center gap-1" title="Rating"><Star className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />{item.rating.toFixed(1)}</span>
        <span className="inline-flex items-center gap-1" title="Installs"><Download className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />{formatDownloads(item.downloads)}</span>
        <span className="inline-flex items-center gap-1" title="Licence"><Shield className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />{item.license}</span>
        <span className="inline-flex items-center gap-1" title="Last updated"><Calendar className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />{new Date(item.updatedAt).toLocaleDateString()}</span>
      </div>

      {item.tags && item.tags.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <Tag className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />
          {item.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-2">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* README */}
      <section className="border-t border-border-soft pt-6" data-testid="readme-section">
        <h2 className="mb-3 text-[15px] font-semibold text-text">README</h2>
        <div className="max-w-none text-sm text-text">
          {item.metadata?.readme ? (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{String(item.metadata.readme)}</pre>
          ) : (
            <p className="italic text-text-2">No README available for this item.</p>
          )}
        </div>
      </section>

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
