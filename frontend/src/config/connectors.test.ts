/**
 * Tests for the connector catalog.
 *
 * @module config/connectors.test
 */

import { describe, it, expect } from 'vitest';
import { CONNECTORS, CONNECTOR_GROUPS, REMOTE_MCP_PRESETS, findConnector } from './connectors';

describe('connector catalog', () => {
  it('has unique ids, each in a known group', () => {
    expect(new Set(CONNECTORS.map((c) => c.id)).size).toBe(CONNECTORS.length);
    const groups = new Set(CONNECTOR_GROUPS.map((g) => g.id));
    for (const c of CONNECTORS) expect(groups.has(c.group)).toBe(true);
  });

  it('lists Remote MCP servers as a data connector gated per server', () => {
    expect(findConnector('remote-mcp')).toMatchObject({ group: 'data', roleGated: false });
    expect(findConnector('nope')).toBeUndefined();
  });

  it('offers Zoho first, with its setup help', () => {
    expect(REMOTE_MCP_PRESETS[0]).toEqual({
      id: 'zoho',
      label: 'Zoho',
      help: 'Create a server at mcp.zoho.com, pick the Zoho apps it may use, then paste its URL here.',
      setupUrl: 'https://mcp.zoho.com',
    });
    expect(REMOTE_MCP_PRESETS.map((p) => p.id)).toContain('custom');
  });
});
