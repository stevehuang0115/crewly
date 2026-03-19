/**
 * Cloud Connection Banner
 *
 * Displays a banner for CrewlyAI Cloud connection status.
 * When disconnected, shows a "Connect to Cloud" prompt.
 * When connected, shows the subscription tier badge with disconnect option.
 * Includes an inline connect modal for token input.
 *
 * @module components/CloudConnectionBanner
 */

import React, { useState } from 'react';
import { Cloud, X, Loader2, LogOut } from 'lucide-react';
import { IconButton, Badge, Button, Input, Modal, ModalFooter } from './UI';
import { useCloudConnection } from '../hooks/useCloudConnection';
import type { CloudTier } from '../types';

// ========================= Constants =========================

/** Maps tier values to display labels */
const TIER_LABELS: Record<CloudTier, string> = {
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

/** Maps tier values to badge variants */
const TIER_BADGE_VARIANTS: Record<CloudTier, 'default' | 'primary' | 'success' | 'warning' | 'info'> = {
  free: 'default',
  pro: 'primary',
  enterprise: 'success',
};

// ========================= Component =========================

/**
 * Banner for managing CrewlyAI Cloud connection.
 *
 * Shows different states:
 * - Loading: nothing rendered
 * - Disconnected: "Connect to CrewlyAI Cloud" banner with connect button
 * - Connected: tier badge with disconnect option
 * - Dismissed: nothing rendered (until page refresh)
 *
 * @returns CloudConnectionBanner component or null
 */
export const CloudConnectionBanner: React.FC = () => {
  const { isConnected, tier, isLoading, isActioning, error, connect, disconnect } = useCloudConnection();
  const [dismissed, setDismissed] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [token, setToken] = useState('');
  const [cloudUrl, setCloudUrl] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  if (isLoading || dismissed) {
    return null;
  }

  const handleConnect = async () => {
    if (!token.trim()) {
      setModalError('API token is required');
      return;
    }
    setModalError(null);
    const success = await connect(token.trim(), cloudUrl.trim() || undefined);
    if (success) {
      setShowModal(false);
      setToken('');
      setCloudUrl('');
    } else {
      setModalError(error || 'Connection failed. Check your token and try again.');
    }
  };

  const handleDisconnect = async () => {
    await disconnect();
  };

  const handleOpenModal = () => {
    setToken('');
    setCloudUrl('');
    setModalError(null);
    setShowModal(true);
  };

  // Connected state: show tier badge with disconnect option
  if (isConnected && tier) {
    return (
      <div className="flex items-center justify-between px-4 py-2 border-b bg-emerald-500/10 border-emerald-500/30">
        <div className="flex items-center gap-3">
          <Cloud className="shrink-0 text-emerald-400" size={18} />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-emerald-300">Connected to CrewlyAI Cloud</span>
            <Badge variant={TIER_BADGE_VARIANTS[tier]} size="sm">
              {TIER_LABELS[tier]}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDisconnect}
            disabled={isActioning}
          >
            {isActioning ? (
              <Loader2 className="animate-spin mr-1" size={14} />
            ) : (
              <LogOut className="mr-1" size={14} />
            )}
            Disconnect
          </Button>
          <IconButton
            icon={X}
            onClick={() => setDismissed(true)}
            variant="ghost"
            size="sm"
            aria-label="Dismiss cloud banner"
          />
        </div>
      </div>
    );
  }

  // Disconnected state: show connect prompt
  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 border-b bg-violet-500/10 border-violet-500/30">
        <div className="flex items-center gap-3">
          <Cloud className="shrink-0 text-violet-400" size={18} />
          <span className="text-sm text-violet-200/80">
            Connect to <span className="font-semibold text-violet-300">CrewlyAI Cloud</span> for premium templates and features.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={handleOpenModal}
          >
            Connect
          </Button>
          <IconButton
            icon={X}
            onClick={() => setDismissed(true)}
            variant="ghost"
            size="sm"
            aria-label="Dismiss cloud banner"
          />
        </div>
      </div>

      {/* Connect Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title="Connect to CrewlyAI Cloud"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary-dark">
            Enter your CrewlyAI Cloud API token to unlock premium templates and features.
          </p>
          <Input
            label="API Token"
            type="password"
            placeholder="crewly_cloud_..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            error={modalError || undefined}
            fullWidth
            autoFocus
          />
          <Input
            label="Cloud URL (optional)"
            type="text"
            placeholder="https://api.crewlyai.com"
            value={cloudUrl}
            onChange={(e) => setCloudUrl(e.target.value)}
            helperText="Leave blank to use the default cloud endpoint."
            fullWidth
          />
        </div>
        <ModalFooter>
          <Button
            variant="ghost"
            onClick={() => setShowModal(false)}
            disabled={isActioning}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConnect}
            disabled={isActioning || !token.trim()}
          >
            {isActioning ? (
              <>
                <Loader2 className="animate-spin mr-1.5" size={14} />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
};

CloudConnectionBanner.displayName = 'CloudConnectionBanner';
