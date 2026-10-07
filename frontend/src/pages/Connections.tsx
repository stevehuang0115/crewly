/**
 * Connections — every account this Crewly instance is connected to.
 *
 * Two sections: the channels you reach the orchestrator through, and the
 * accounts your agents act in on your behalf. A card expands to that
 * connector's own connect/disconnect UI; data connectors also carry the
 * role allowlist that decides which agents may use the grant. Remote MCP
 * servers (Zoho MCP …) carry one allowlist per server inside their card.
 *
 * Opened with `?platform=<id>` (or the legacy `?tab=slack`) the matching
 * card starts expanded — that is where every OAuth flow returns to.
 *
 * @module pages/Connections
 */

import React, { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@crewly/ui';
import { ChevronDown, ChevronRight, Hash, Phone, MessageCircle, Send, MessageSquare, Mail, Palette, ListChecks, Server, type LucideIcon } from 'lucide-react';
import { SlackTab } from '../components/Settings/SlackTab';
import { WhatsAppTab } from '../components/Settings/WhatsAppTab';
import { DiscordTab } from '../components/Settings/DiscordTab';
import { TelegramTab } from '../components/Settings/TelegramTab';
import { GoogleChatTab } from '../components/Settings/GoogleChatTab';
import { GoogleWorkspaceTab } from '../components/Settings/GoogleWorkspaceTab';
import { CanvaTab } from '../components/Settings/CanvaTab';
import { MicrosoftTodoTab } from '../components/Settings/MicrosoftTodoTab';
import { ConnectorAccessControl } from '../components/Connections/ConnectorAccessControl';
import { RemoteMcpTab } from '../components/Connections/RemoteMcpTab';
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
  'microsoft-todo': ListChecks,
  'remote-mcp': Server,
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
  'microsoft-todo': MicrosoftTodoTab,
  'remote-mcp': RemoteMcpTab,
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
    <div className="max-w-3xl" data-testid="connections-page">
      <PageHeader
        title="Connections"
        subtitle="Where you reach the orchestrator, and the accounts your agents may act in for you"
      />

      <div className="space-y-8">
        {CONNECTOR_GROUPS.map((group) => (
          <section key={group.id} aria-labelledby={`connector-group-title-${group.id}`} data-testid={`connector-group-${group.id}`}>
            <h2 id={`connector-group-title-${group.id}`} className="text-[15px] font-semibold text-text">{group.title}</h2>
            <p className="mt-0.5 text-[13px] text-text-2">{group.blurb}</p>

            <div className="mt-3 overflow-hidden rounded-2xl border border-border-soft bg-surface">
              {CONNECTORS.filter((c) => c.group === group.id).map((connector) => {
                const Icon = ICONS[connector.id];
                const Panel = PANELS[connector.id];
                const isExpanded = expanded === connector.id;
                const allowedRoles = access[connector.id]?.allowedRoles ?? [];

                return (
                  <div
                    key={connector.id}
                    className="border-b border-border-soft last:border-b-0"
                    data-testid={`connector-card-${connector.id}`}
                  >
                    {/* Disclosure header: one compact row; details on click */}
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={`connector-content-${connector.id}`}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                      onClick={() => toggle(connector.id)}
                      data-testid={`connector-toggle-${connector.id}`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.5rem] bg-surface-2">
                        <Icon className="h-4 w-4 text-text-2" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-semibold text-text">{connector.name}</span>
                          {connector.roleGated && allowedRoles.length > 0 && (
                            <span
                              className="shrink-0 text-xs font-semibold text-primary-text"
                              data-testid={`connector-restricted-${connector.id}`}
                            >
                              {allowedRoles.length} role{allowedRoles.length === 1 ? '' : 's'}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[13px] text-text-2">{connector.description}</span>
                      </span>
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
                      )}
                    </button>

                    {isExpanded && (
                      <div
                        id={`connector-content-${connector.id}`}
                        className="border-t border-border-soft bg-bg/40 p-4 sm:p-6"
                        data-testid={`connector-content-${connector.id}`}
                      >
                        {connector.id === 'remote-mcp' ? (
                          <RemoteMcpTab
                            access={access}
                            onAccessChange={(id, roles) => setAccess((prev) => ({ ...prev, [id]: { allowedRoles: roles } }))}
                          />
                        ) : (
                          <Panel />
                        )}
                        {connector.roleGated && (
                          <ConnectorAccessControl
                            connectorId={connector.id}
                            allowedRoles={allowedRoles}
                            onChange={(roles) => setAccess((prev) => ({ ...prev, [connector.id]: { allowedRoles: roles } }))}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

export default Connections;
