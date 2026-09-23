/**
 * "Which agents may use this" — the per-connector role allowlist.
 *
 * A connector is one grant for the whole instance, so by default every
 * agent can use it. Picking roles here narrows that: only those roles get
 * past the backend gate (`requireConnectorAccess`). `orchestrator` is a
 * role like any other — leave it out and even the orc is refused.
 *
 * @module components/Connections/ConnectorAccessControl
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { rolesService } from '../../services/roles.service';
import { updateConnectorAccess } from '../../services/connector.service';
import { Alert } from '@crewly/ui/Alert';

/** Props. */
export interface ConnectorAccessControlProps {
  connectorId: string;
  /** Roles currently allowed (empty = every agent). */
  allowedRoles: string[];
  /** Called with the stored roles after a successful save. */
  onChange?: (roles: string[]) => void;
}

/** The orchestrator is not in the roles catalog but can be allowed/denied. */
const ORCHESTRATOR_ROLE = 'orchestrator';

/**
 * Role chips; clicking toggles. No chips selected = every agent.
 *
 * @param props - Connector id, current roles, change callback
 * @returns The control
 */
export const ConnectorAccessControl: React.FC<ConnectorAccessControlProps> = ({ connectorId, allowedRoles, onChange }) => {
  const [roles, setRoles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>(allowedRoles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSelected(allowedRoles), [allowedRoles]);

  useEffect(() => {
    let cancelled = false;
    rolesService
      .listRoles()
      .then((list) => {
        if (cancelled) return;
        const names = list.filter((r) => !r.isHidden).map((r) => r.name.toLowerCase());
        setRoles([...new Set([ORCHESTRATOR_ROLE, ...names])]);
      })
      .catch(() => {
        if (!cancelled) setRoles([ORCHESTRATOR_ROLE]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (next: string[]) => {
      const previous = selected;
      setSelected(next);
      setBusy(true);
      setError(null);
      try {
        const stored = await updateConnectorAccess(connectorId, next);
        setSelected(stored);
        onChange?.(stored);
      } catch (err) {
        setSelected(previous);
        setError(err instanceof Error ? err.message : 'Could not save');
      } finally {
        setBusy(false);
      }
    },
    [connectorId, onChange, selected],
  );

  const toggle = (role: string) => {
    void save(selected.includes(role) ? selected.filter((r) => r !== role) : [...selected, role]);
  };

  const everyAgent = selected.length === 0;

  return (
    <div className="mt-6 pt-6 border-t border-border-dark" data-testid={`connector-access-${connectorId}`}>
      <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-1">
        <Users className="w-3.5 h-3.5" />
        Which agents may use this
      </div>
      <p className="text-xs text-text-secondary-dark mb-3">
        {everyAgent
          ? 'Every agent on this instance can use it. Pick roles to narrow that.'
          : `Only these roles can use it — everyone else gets a "not allowed" error naming them.`}
      </p>

      {error && <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => !everyAgent && void save([])}
          disabled={busy}
          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
            everyAgent
              ? 'bg-primary/15 text-primary border-primary/40'
              : 'bg-background-dark text-text-secondary-dark border-border-dark hover:text-text-primary-dark'
          } ${busy ? 'opacity-50' : ''}`}
          data-testid={`connector-access-${connectorId}-every`}
        >
          Every agent
        </button>
        {roles.map((role) => {
          const on = selected.includes(role);
          return (
            <button
              key={role}
              type="button"
              onClick={() => toggle(role)}
              disabled={busy}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                on
                  ? 'bg-primary/15 text-primary border-primary/40'
                  : 'bg-background-dark text-text-secondary-dark border-border-dark hover:text-text-primary-dark'
              } ${busy ? 'opacity-50' : ''}`}
              data-testid={`connector-access-${connectorId}-role-${role}`}
            >
              {role}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ConnectorAccessControl;
