/**
 * Connector status checks for bundles: is Gmail / Canva / WhatsApp … connected?
 *
 * Each connector id maps to a probe; the backend factory passes the real
 * probes (Google / Canva / Microsoft token services through Cloud, the
 * WhatsApp and Slack services). A connector without a probe reads as
 * `unknown`, and a probe that throws reads as `unknown` too — the owner is
 * then pointed at /connections either way.
 *
 * @module services/bundle/bundle-connectors
 */

import type { BundleConnector, BundleConnectorState } from '../../types/solution-bundle.types.js';
import type { BundleConnectorApi } from './bundle-apply.service.js';

/** What a Google probe reports: connected accounts and their products. */
export interface GoogleProbeResult {
  connected: boolean;
  connections: Array<{ products: string[] }>;
}

/** Probes by connector id. */
export interface ConnectorProbes {
  'google-workspace'?: () => Promise<GoogleProbeResult>;
  [connectorId: string]: (() => Promise<boolean>) | (() => Promise<GoogleProbeResult>) | undefined;
}

/**
 * Whether a Google status covers the products a bundle needs.
 *
 * Products are checked across every connected account. A Cloud that does not
 * report products (older) counts as covering them once connected.
 *
 * @param status - Google probe result
 * @param products - Products the bundle needs (empty = any grant)
 * @returns Connected or not
 */
export function googleCovers(status: GoogleProbeResult, products: string[]): boolean {
  if (!status.connected) return false;
  if (products.length === 0) return true;
  const reported = status.connections.flatMap((c) => c.products ?? []);
  if (reported.length === 0) return true;
  return products.every((p) => reported.includes(p));
}

/**
 * A {@link BundleConnectorApi} over a set of probes.
 *
 * @param probes - Probes by connector id
 * @returns Checker
 */
export function createConnectorChecker(probes: ConnectorProbes): BundleConnectorApi {
  return {
    async check(connector: BundleConnector): Promise<BundleConnectorState['status']> {
      const probe = probes[connector.id];
      if (!probe) return 'unknown';
      try {
        if (connector.id === 'google-workspace') {
          const status = (await (probe as () => Promise<GoogleProbeResult>)());
          return googleCovers(status, connector.products ?? []) ? 'connected' : 'not_connected';
        }
        return (await (probe as () => Promise<boolean>)()) ? 'connected' : 'not_connected';
      } catch {
        return 'unknown';
      }
    },
  };
}
