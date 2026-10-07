/**
 * Remote MCP servers card on the Connections page.
 *
 * The owner pastes a server URL (Zoho MCP first, any streamable-HTTP MCP
 * server the same way) and names it — one paste field, nothing to run in a
 * terminal, so it works from a phone. Each server then lists its masked
 * host, a Test button (MCP initialize + tools/list), rename, remove, and its
 * own "which agents may use this" control (`mcp:<id>`).
 *
 * The URL is a secret: it is sent once, never shown again (the API only
 * returns scheme + host).
 *
 * @module components/Connections/RemoteMcpTab
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Pencil, PlugZap, Trash2 } from 'lucide-react';
import { Alert, Button, Card, Input } from '@crewly/ui';
import { FilterPill } from '@crewly/ui/FilterPill';
import { ConnectorAccessControl } from './ConnectorAccessControl';
import { REMOTE_MCP_PRESETS, type RemoteMcpPreset } from '../../config/connectors';
import type { ConnectorAccessMap } from '../../services/connector.service';
import {
  addRemoteMcp,
  listRemoteMcp,
  removeRemoteMcp,
  renameRemoteMcp,
  testRemoteMcp,
  type RemoteMcpServerView,
  type RemoteMcpTestResult,
} from '../../services/remote-mcp.service';

/** Shown after every change. */
export const NEXT_START_NOTE = 'Agents pick this up the next time they start.';

/** Props. */
export interface RemoteMcpTabProps {
  /** Every connector's allowlist (the page loads it once). */
  access?: ConnectorAccessMap;
  /** Called after an allowlist change, with the connector id and roles. */
  onAccessChange?: (connectorId: string, roles: string[]) => void;
}

/**
 * The card body.
 *
 * @param props - Access map and change callback
 * @returns The panel
 */
export const RemoteMcpTab: React.FC<RemoteMcpTabProps> = ({ access = {}, onAccessChange }) => {
  const [servers, setServers] = useState<RemoteMcpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preset, setPreset] = useState<RemoteMcpPreset>(REMOTE_MCP_PRESETS[0]);
  const [label, setLabel] = useState(REMOTE_MCP_PRESETS[0].label);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [tests, setTests] = useState<Record<string, RemoteMcpTestResult | 'running'>>({});
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setServers(await listRemoteMcp());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load remote MCP servers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pickPreset = (p: RemoteMcpPreset) => {
    // Keep a name the owner typed; replace only the previous preset's default.
    if (!label.trim() || label === preset.label) setLabel(p.label);
    setPreset(p);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const { server } = await addRemoteMcp({ label: label.trim(), url: url.trim(), provider: preset.id });
      setUrl('');
      setNotice(`${server.label} added. ${NEXT_START_NOTE}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the server');
    } finally {
      setAdding(false);
    }
  };

  const runTest = async (id: string) => {
    setTests((prev) => ({ ...prev, [id]: 'running' }));
    try {
      const result = await testRemoteMcp(id);
      setTests((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [id]: { ok: false, error: err instanceof Error ? err.message : 'Test failed' } }));
    }
  };

  const saveRename = async () => {
    if (!renaming) return;
    setError(null);
    try {
      await renameRemoteMcp(renaming.id, renaming.label.trim());
      setRenaming(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the server');
    }
  };

  const remove = async (server: RemoteMcpServerView) => {
    if (!window.confirm(`Remove ${server.label}? Agents lose its tools the next time they start.`)) return;
    setError(null);
    try {
      await removeRemoteMcp(server.id);
      setNotice(`${server.label} removed. ${NEXT_START_NOTE}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the server');
    }
  };

  return (
    <div className="space-y-4" data-testid="remote-mcp-panel">
      {error && <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert variant="success" onClose={() => setNotice(null)}>{notice}</Alert>}

      {!loading && servers.length === 0 && (
        <p className="text-sm text-text-2" data-testid="remote-mcp-empty">No remote MCP servers yet.</p>
      )}

      {servers.map((server) => {
        const test = tests[server.id];
        return (
          <Card key={server.id} padding="md" data-testid={`remote-mcp-server-${server.id}`}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                {renaming?.id === server.id ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      label="Name"
                      value={renaming.label}
                      onChange={(e) => setRenaming({ id: server.id, label: e.target.value })}
                      data-testid={`remote-mcp-rename-input-${server.id}`}
                    />
                    <Button size="sm" onClick={() => void saveRename()} data-testid={`remote-mcp-rename-save-${server.id}`}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="text-[15px] font-semibold text-text">{server.label}</div>
                )}
                <div className="mt-0.5 truncate text-[13px] text-text-2" data-testid={`remote-mcp-host-${server.id}`}>
                  {server.urlMasked} · tools appear as <code>{server.id}</code>
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="secondary" onClick={() => void runTest(server.id)} disabled={test === 'running'} data-testid={`remote-mcp-test-${server.id}`}>
                  <PlugZap className="h-3.5 w-3.5" aria-hidden="true" /> {test === 'running' ? 'Testing…' : 'Test'}
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Rename ${server.label}`} onClick={() => setRenaming({ id: server.id, label: server.label })} data-testid={`remote-mcp-rename-${server.id}`}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button size="sm" variant="danger-ghost" aria-label={`Remove ${server.label}`} onClick={() => void remove(server)} data-testid={`remote-mcp-remove-${server.id}`}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>

            {test && test !== 'running' && (
              <div className="mt-3" data-testid={`remote-mcp-test-result-${server.id}`}>
                {test.ok ? (
                  <Alert variant="success">
                    Connected — {test.toolCount} tool{test.toolCount === 1 ? '' : 's'}
                    {test.tools.length > 0 ? `: ${test.tools.slice(0, 12).join(', ')}${test.toolCount > 12 ? ', …' : ''}` : ''}
                  </Alert>
                ) : (
                  <Alert variant="error">{'error' in test ? test.error : 'Test failed'}</Alert>
                )}
              </div>
            )}

            <ConnectorAccessControl
              connectorId={server.connectorId}
              allowedRoles={access[server.connectorId]?.allowedRoles ?? []}
              onChange={(roles) => onAccessChange?.(server.connectorId, roles)}
            />
          </Card>
        );
      })}

      <form onSubmit={(e) => void add(e)} className="space-y-3 rounded-xl border border-border-soft p-4" data-testid="remote-mcp-add-form">
        <div className="text-sm font-semibold text-text">Add a server</div>
        <div className="flex flex-wrap gap-2">
          {REMOTE_MCP_PRESETS.map((p) => (
            <FilterPill key={p.id} isActive={preset.id === p.id} onClick={() => pickPreset(p)} data-testid={`remote-mcp-preset-${p.id}`}>
              {p.label}
            </FilterPill>
          ))}
        </div>
        <p className="text-[13px] text-text-2" data-testid="remote-mcp-help">
          {preset.help}
          {preset.setupUrl && (
            <>
              {' '}
              <a href={preset.setupUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary-text">
                Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </>
          )}
        </p>
        <Input
          label="Server URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="url"
          fullWidth
          helperText="It works like a password: keep it private. Crewly stores it on this machine only."
          data-testid="remote-mcp-url"
        />
        <Input label="Name" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth data-testid="remote-mcp-label" />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={adding || !url.trim() || !label.trim()} data-testid="remote-mcp-add">
            {adding ? 'Adding…' : 'Add server'}
          </Button>
          <span className="text-xs text-text-3">{NEXT_START_NOTE}</span>
        </div>
      </form>
    </div>
  );
};

export default RemoteMcpTab;
