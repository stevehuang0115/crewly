/**
 * IntegrationsTab Component
 *
 * Messaging integrations configuration in Settings.
 * Shows available messaging platforms (Slack, WhatsApp, Discord, Telegram, Google Chat)
 * with connect/disconnect UI for each.
 *
 * @module components/Settings/IntegrationsTab
 */

import React, { useState } from 'react';
import { MessageSquare, Phone, Hash, Send, MessageCircle, ChevronRight, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SlackTab } from './SlackTab';
import { WhatsAppTab } from './WhatsAppTab';
import { GoogleChatTab } from './GoogleChatTab';
import { TelegramTab } from './TelegramTab';
import { DiscordTab } from './DiscordTab';

// =============================================================================
// Types
// =============================================================================

/**
 * Supported messaging platform identifiers
 */
type PlatformId = 'slack' | 'whatsapp' | 'discord' | 'telegram' | 'google-chat';

/**
 * Configuration for a messaging platform card
 */
interface PlatformConfig {
  /** Platform identifier */
  id: PlatformId;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Icon component */
  icon: LucideIcon;
  /** Whether the integration is available (has backend support) */
  available: boolean;
  /** Detail component to render when expanded */
  component?: React.FC;
}

// =============================================================================
// Platform Definitions
// =============================================================================

/**
 * All supported messaging platforms with their configuration
 */
const PLATFORMS: PlatformConfig[] = [
  {
    id: 'slack',
    name: 'Slack',
    description: 'Connect your Slack workspace for team communication with the orchestrator.',
    icon: Hash,
    available: true,
    component: SlackTab,
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Connect via WhatsApp Web to communicate with the orchestrator from your phone.',
    icon: Phone,
    available: true,
    component: WhatsAppTab,
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Connect a Discord bot to communicate with the orchestrator via Discord server.',
    icon: MessageCircle,
    available: true,
    component: DiscordTab,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Connect a Telegram bot for messaging the orchestrator via Telegram.',
    icon: Send,
    available: true,
    component: TelegramTab,
  },
  {
    id: 'google-chat',
    name: 'Google Chat',
    description: 'Connect Google Chat for workspace communication with the orchestrator.',
    icon: MessageSquare,
    available: true,
    component: GoogleChatTab,
  },
];

// =============================================================================
// Component
// =============================================================================

/**
 * IntegrationsTab component for managing messaging platform integrations
 *
 * Shows a list of available platforms as expandable cards. Each card
 * can be expanded to show the platform-specific configuration UI.
 *
 * @returns IntegrationsTab component
 */
export const IntegrationsTab: React.FC = () => {
  const [expandedPlatform, setExpandedPlatform] = useState<PlatformId | null>(null);

  /**
   * Toggle platform card expansion
   */
  const togglePlatform = (id: PlatformId) => {
    setExpandedPlatform((prev) => (prev === id ? null : id));
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">Messaging Integrations</h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          Connect messaging platforms to communicate with the orchestrator from anywhere.
        </p>
      </div>

      {/* Platform Cards */}
      <div className="space-y-3">
        {PLATFORMS.map((platform) => {
          const isExpanded = expandedPlatform === platform.id;
          const Icon = platform.icon;

          return (
            <div
              key={platform.id}
              className="bg-surface-dark border border-border-dark rounded-lg overflow-hidden"
              data-testid={`platform-card-${platform.id}`}
            >
              {/* Card Header (always visible) */}
              <button
                className={`w-full flex items-center gap-4 p-4 text-left transition-colors ${
                  platform.available
                    ? 'hover:bg-background-dark cursor-pointer'
                    : 'opacity-60 cursor-default'
                }`}
                onClick={() => platform.available && togglePlatform(platform.id)}
                disabled={!platform.available}
                data-testid={`platform-toggle-${platform.id}`}
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-background-dark border border-border-dark">
                  <Icon className="w-5 h-5 text-text-secondary-dark" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{platform.name}</span>
                    {!platform.available && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-background-dark text-text-secondary-dark border border-border-dark">
                        Coming Soon
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary-dark mt-0.5 truncate">
                    {platform.description}
                  </p>
                </div>

                {platform.available && (
                  <div className="text-text-secondary-dark">
                    {isExpanded ? (
                      <ChevronDown className="w-5 h-5" />
                    ) : (
                      <ChevronRight className="w-5 h-5" />
                    )}
                  </div>
                )}
              </button>

              {/* Expanded Content */}
              {isExpanded && platform.component && (
                <div className="border-t border-border-dark p-6" data-testid={`platform-content-${platform.id}`}>
                  <platform.component />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default IntegrationsTab;
