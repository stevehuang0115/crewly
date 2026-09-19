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
import { MessageSquare, Phone, Hash, Send, MessageCircle, Mail, Palette, ChevronRight, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SlackTab } from './SlackTab';
import { WhatsAppTab } from './WhatsAppTab';
import { GoogleChatTab } from './GoogleChatTab';
import { TelegramTab } from './TelegramTab';
import { DiscordTab } from './DiscordTab';
import { GoogleWorkspaceTab } from './GoogleWorkspaceTab';
import { CanvaTab } from './CanvaTab';

// =============================================================================
// Types
// =============================================================================

/**
 * Supported messaging platform identifiers
 */
type PlatformId = 'slack' | 'whatsapp' | 'discord' | 'telegram' | 'google-chat' | 'google-workspace' | 'canva';

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
  /**
   * Which section the card sits in. `messaging` = a channel people talk to
   * the orchestrator through; `data` = an account whose content and tools
   * the agents may use.
   */
  group: IntegrationGroup;
}

/** The two kinds of connection this tab manages. */
type IntegrationGroup = 'messaging' | 'data';

/** Section headings, in render order. */
const GROUPS: { id: IntegrationGroup; title: string; blurb: string }[] = [
  {
    id: 'messaging',
    title: 'Messaging',
    blurb: 'Channels you talk to the orchestrator through, from anywhere.',
  },
  {
    id: 'data',
    title: 'Data & content',
    blurb: 'Accounts whose files and tools your agents may read and write on your behalf.',
  },
];

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
    group: 'messaging',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Connect via WhatsApp Web to communicate with the orchestrator from your phone.',
    icon: Phone,
    available: true,
    component: WhatsAppTab,
    group: 'messaging',
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Connect a Discord bot to communicate with the orchestrator via Discord server.',
    icon: MessageCircle,
    available: true,
    component: DiscordTab,
    group: 'messaging',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Connect a Telegram bot for messaging the orchestrator via Telegram.',
    icon: Send,
    available: true,
    component: TelegramTab,
    group: 'messaging',
  },
  {
    id: 'google-chat',
    name: 'Google Chat',
    description: 'Connect Google Chat for workspace communication with the orchestrator.',
    icon: MessageSquare,
    available: true,
    component: GoogleChatTab,
    group: 'messaging',
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Let agents read your Gmail and Drive (Docs, Sheets, Slides), send mail, manage your Calendar and create documents.',
    icon: Mail,
    available: true,
    component: GoogleWorkspaceTab,
    group: 'data',
  },
  {
    id: 'canva',
    name: 'Canva',
    description: 'Let agents find, create, upload to and export your Canva designs (posters, stories, decks, videos).',
    icon: Palette,
    available: true,
    component: CanvaTab,
    group: 'data',
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
/**
 * Platform to open on first render, from the URL: `?tab=slack` (the Cloud
 * Slack install flow returns here) or `?platform=<id>`.
 *
 * @returns The platform id or null
 */
export function initialPlatformFromUrl(): PlatformId | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('platform') ?? (params.get('tab') === 'slack' ? 'slack' : null);
    return PLATFORMS.some((p) => p.id === requested && p.available) ? (requested as PlatformId) : null;
  } catch {
    return null;
  }
}

export const IntegrationsTab: React.FC = () => {
  const [expandedPlatform, setExpandedPlatform] = useState<PlatformId | null>(() => initialPlatformFromUrl());

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
        <h2 className="text-xl font-semibold">Integrations</h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          The accounts this Crewly instance is connected to — the channels you reach the orchestrator
          through, and the services your agents may act in on your behalf.
        </p>
      </div>

      {/* Platform cards, one section per group */}
      {GROUPS.map((group) => (
        <section key={group.id} className="space-y-3" data-testid={`integration-group-${group.id}`}>
          <div>
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">{group.title}</h3>
            <p className="text-xs text-text-secondary-dark mt-0.5">{group.blurb}</p>
          </div>
        {PLATFORMS.filter((p) => p.group === group.id).map((platform) => {
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
        </section>
      ))}
    </div>
  );
};

export default IntegrationsTab;
