/**
 * Connector access API client — which agent roles may use a connected
 * account (`/api/connectors/access`).
 *
 * @module services/connector.service
 */

/** Connector id → allowed roles (empty = every agent). */
export type ConnectorAccessMap = Record<string, { allowedRoles: string[] }>;

/**
 * Read every connector's role allowlist.
 *
 * @returns The map; `{}` when the request fails (the UI then shows "every agent")
 */
export async function fetchConnectorAccess(): Promise<ConnectorAccessMap> {
  const res = await fetch('/api/connectors/access');
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || data.error || 'Failed to read connector access');
  return (data.data ?? {}) as ConnectorAccessMap;
}

/**
 * Replace a connector's allowlist.
 *
 * @param connectorId - Connector id
 * @param allowedRoles - Roles allowed; empty opens it to every agent
 * @returns The stored roles
 */
export async function updateConnectorAccess(connectorId: string, allowedRoles: string[]): Promise<string[]> {
  const res = await fetch(`/api/connectors/access/${encodeURIComponent(connectorId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowedRoles }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || data.error || 'Failed to update connector access');
  return (data.data?.allowedRoles ?? []) as string[];
}
