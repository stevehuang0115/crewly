/**
 * Connections — every account this Crewly instance is connected to.
 *
 * Two sections: the channels you reach the orchestrator through, and the
 * accounts your agents act in on your behalf. A card expands to that
 * connector's own connect/disconnect UI; data connectors also carry the
 * role allowlist that decides which agents may use the grant.
 *
 * Opened with `?platform=<id>` (or the legacy `?tab=slack`) the matching
 * card starts expanded — that is where every OAuth flow returns to.
 *
 * @module pages/Connections
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Card } from '@crewly/ui';
import { ChevronDown, ChevronRight, Hash, Phone, MessageCircle, Send, MessageSquare, Mail, Palette, type LucideIcon } from 'lucide-react';
import { SlackTab } from '../components/Settings/SlackTab';
import { WhatsAppTab } from '../components/Settings/WhatsAppTab';
import { DiscordTab } from '../components/Settings/DiscordTab';
import { TelegramTab } from '../components/Settings/TelegramTab';
import { GoogleChatTab } from '../components/Settings/GoogleChatTab';
import { GoogleWorkspaceTab } from '../components/Settings/GoogleWorkspaceTab';
import { CanvaTab } from '../components/Settings/CanvaTab';
import { ConnectorAccessControl } from '../components/Connections/ConnectorAccessControl';
import { CONNECTORS, CONNECTOR_GROUPS, findConnector, type ConnectorId } from '../config/connectors';
import { fetchConnectorAccess, type ConnectorAccessMap } from '../services/connector.service';

/** Icon per connector. */
const ICONS: Record<ConnectorId, LucideIcon> = {
  slack: Hash,
  whatsapp: Phone,
  discord: MessageCircle,
  telegram: Send,
  'google-chat': MessageSquare,
  'google-workspace': Mail,
  canva: Palette,
};

/** Connect/disconnect UI per connector. */
const PANELS: Record<ConnectorId, React.FC> = {
  slack: SlackTab,
  whatsapp: WhatsAppTab,
  discord: DiscordTab,
  telegram: TelegramTab,
  'google-chat': GoogleChatTab,
  'google-workspace': GoogleWorkspaceTab,
  canva: CanvaTab,
};

/**
 * Which card to open on first render, from the URL: `?platform=<id>`, or
 * the legacy `?tab=slack` the Cloud Slack install still returns with.
 *
 * @returns The connector id, or null
 */
export function initialConnectorFromUrl(): ConnectorId | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('platform') ?? (params.get('tab') === 'slack' ? 'slack' : null);
    return findConnector(requested)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The Connections page.
 *
 * @returns Page component
 */
export const Connections: React.FC = () => {
  const [expanded, setExpanded] = useState<ConnectorId | null>(() => initialConnectorFromUrl());
  const [access, setAccess] = useState<ConnectorAccessMap>({});

  const loadAccess = useCallback(() => {
    fetchConnectorAccess()
      .then(setAccess)
      .catch(() => setAccess({}));
  }, []);

  useEffect(loadAccess, [loadAccess]);

  const toggle = (id: ConnectorId) => setExpanded((prev) => (prev === id ? null : id));

  return (
    <div className="p-6 space-y-6 max-w-3xl" data-testid="connections-page">
      <div>
        <h1 className="text-2xl font-bold">Connections</h1>
        <p className="text-sm text-text-secondary-dark mt-1">
          The accounts this Crewly instance is connected to — the channels you reach the orchestrator
          through, and the services your agents may act in on your behalf.
        </p>
      </div>

      {CONNECTOR_GROUPS.map((group) => (
        <section key={group.id} className="space-y-3" data-testid={`connector-group-${group.id}`}>
          <div>
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">{group.title}</h2>
            <p className="text-xs text-text-secondary-dark mt-0.5">{group.blurb}</p>
          </div>

          {CONNECTORS.filter((c) => c.group === group.id).map((connector) => {
            const Icon = ICONS[connector.id];
            const Panel = PANELS[connector.id];
            const isExpanded = expanded === connector.id;
            const allowedRoles = access[connector.id]?.allowedRoles ?? [];

            return (
              <Card
                key={connector.id}
                padding="none"
                className="overflow-hidden"
                data-testid={`connector-card-${connector.id}`}
              >
                {/* Disclosure header: a full-width row target, not a styled button */}
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  className="w-full flex items-center gap-4 p-4 text-left hover:bg-background-dark transition-colors"
                  onClick={() => toggle(connector.id)}
                  data-testid={`connector-toggle-${connector.id}`}
                >
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-background-dark border border-border-dark">
                    <Icon className="w-5 h-5 text-text-secondary-dark" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{connector.name}</span>
                      {connector.roleGated && allowedRoles.length > 0 && (
                        <Badge
                          variant="primary"
                          data-testid={`connector-restricted-${connector.id}`}
                        >
                          {allowedRoles.length} role{allowedRoles.length === 1 ? '' : 's'}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-text-secondary-dark mt-0.5 truncate">{connector.description}</p>
                  </div>
                  <div className="text-text-secondary-dark">
                    {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-border-dark p-6" data-testid={`connector-content-${connector.id}`}>
                    <Panel />
                    {connector.roleGated && (
                      <ConnectorAccessControl
                        connectorId={connector.id}
                        allowedRoles={allowedRoles}
                        onChange={(roles) => setAccess((prev) => ({ ...prev, [connector.id]: { allowedRoles: roles } }))}
                      />
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </section>
      ))}
    </div>
  );
};

export default Connections;
