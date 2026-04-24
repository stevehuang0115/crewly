/**
 * Tests for MCP tool definitions. These are schema-level sanity checks —
 * every tool must have a name, description, and object-shaped input schema.
 * The server module advertises these verbatim over MCP, so shape drift
 * here is a protocol-level contract break.
 */

import { TOOL_DEFINITIONS } from './mcp-tool-definitions.js';

describe('TOOL_DEFINITIONS', () => {
  it('exposes 12 tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(12);
  });

  it('has unique tool names prefixed with "crewly_"', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^crewly_/);
    }
  });

  it('includes every expected tool', () => {
    const names = new Set<string>(TOOL_DEFINITIONS.map((t) => t.name));
    const expected = [
      'crewly_get_teams',
      'crewly_create_team',
      'crewly_assign_task',
      'crewly_get_status',
      'crewly_recall_memory',
      'crewly_send_message',
      'crewly_credential_list',
      'crewly_credential_add_api_key',
      'crewly_credential_oauth_import_gemini_cli',
      'crewly_credential_clear_gemini_cli_file',
      'crewly_credential_delete',
      'crewly_execute_skill',
    ];
    for (const name of expected) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('every tool has non-empty description and object inputSchema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('tools that require fields declare them in the schema', () => {
    const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));
    expect(
      (byName['crewly_create_team'].inputSchema as { required?: string[] }).required,
    ).toEqual(['name', 'members']);
    expect(
      (byName['crewly_assign_task'].inputSchema as { required?: string[] }).required,
    ).toEqual(['teamId', 'memberId', 'task']);
    expect(
      (byName['crewly_recall_memory'].inputSchema as { required?: string[] }).required,
    ).toEqual(['query']);
    expect(
      (byName['crewly_send_message'].inputSchema as { required?: string[] }).required,
    ).toEqual(['message']);
    expect(
      (byName['crewly_credential_add_api_key'].inputSchema as { required?: string[] }).required,
    ).toEqual(['name', 'provider', 'value']);
    expect(
      (byName['crewly_credential_delete'].inputSchema as { required?: string[] }).required,
    ).toEqual(['id']);
    expect(
      (byName['crewly_execute_skill'].inputSchema as { required?: string[] }).required,
    ).toEqual(['skillId']);
  });
});
