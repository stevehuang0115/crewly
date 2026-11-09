/**
 * Tests for the connector use audit (issue #969).
 *
 * @module services/connector/connector-use-audit.service.test
 */

import { ConnectorUseAuditService, CONNECTOR_USE_ACTIONS, getConnectorUseAudit, setConnectorUseAuditForTesting } from './connector-use-audit.service.js';
import { runAsActor, type Actor } from '../people/acting-for.service.js';
import type { ActivityEntryInput } from '../activity/activity-log.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const agent = { type: 'agent' as const, id: 'a-dev', via: 'agent-badge' };
const owner = { type: 'owner' as const, via: 'owner-session' };
const alice: Actor = { id: 'UALICE', role: 'member', name: 'Alice' };

function make(now: { t: number }, windowMs = 60_000, maxKeys?: number) {
  const written: ActivityEntryInput[] = [];
  const audit = new ConnectorUseAuditService({ record: (e) => written.push(e), now: () => now.t, windowMs, ...(maxKeys ? { maxKeys } : {}) });
  return { audit, written };
}

describe('allowed', () => {
  it('writes who used which connection, acting for whom, and says later uses are not logged', () => {
    const { audit, written } = make({ t: 1000 });
    expect(audit.allowed({ connectorId: 'google-workspace', actor: agent, actingFor: alice, what: '/drive/search' })).toBe(true);
    expect(written).toHaveLength(1);
    const e = written[0];
    expect(e.action).toBe(CONNECTOR_USE_ACTIONS.ALLOWED);
    expect(e.actor).toEqual(agent);
    expect(e.target).toEqual({ type: 'connector', id: 'google-workspace' });
    expect(e.after).toEqual({ actingFor: 'UALICE', actingForRole: 'member', what: '/drive/search' });
    expect(e.note).toContain('agent a-dev used google-workspace acting for Alice (/drive/search)');
    expect(e.note).toContain('not logged');
  });

  it('collapses uses by the same actor, connection and person inside the window', () => {
    const now = { t: 1000 };
    const { audit, written } = make(now, 60_000);
    expect(audit.allowed({ connectorId: 'canva', actor: agent, actingFor: alice })).toBe(true);
    now.t += 30_000;
    expect(audit.allowed({ connectorId: 'canva', actor: agent, actingFor: alice })).toBe(false);
    now.t += 30_000;
    expect(audit.allowed({ connectorId: 'canva', actor: agent, actingFor: alice })).toBe(true);
    expect(written).toHaveLength(2);
  });

  it('keeps separate windows per actor, connection and person', () => {
    const { audit, written } = make({ t: 1000 });
    audit.allowed({ connectorId: 'canva', actor: agent, actingFor: alice });
    audit.allowed({ connectorId: 'canva', actor: { type: 'agent', id: 'a-ops' }, actingFor: alice });
    audit.allowed({ connectorId: 'google-workspace', actor: agent, actingFor: alice });
    audit.allowed({ connectorId: 'canva', actor: agent, actingFor: { id: 'owner', role: 'owner', name: 'Owner' } });
    audit.allowed({ connectorId: 'canva', actor: agent, actingFor: alice });
    expect(written).toHaveLength(4);
  });

  it('reads the person from the acting-for context when none is passed, and writes none outside one', () => {
    const { audit, written } = make({ t: 1000 }, 3_600_000);
    runAsActor(alice, () => audit.allowed({ connectorId: 'canva', actor: agent }));
    audit.allowed({ connectorId: 'canva', actor: owner });
    expect(written[0].after).toEqual({ actingFor: 'UALICE', actingForRole: 'member' });
    expect(written[1].after).toEqual({});
    expect(written[1].note).toBe('the owner used canva; further uses in the next hour are not logged');
  });

  it('forgets the oldest keys past the cap so memory stays bounded', () => {
    const { audit, written } = make({ t: 1000 }, 60_000, 2);
    audit.allowed({ connectorId: 'c1', actor: agent, actingFor: alice });
    audit.allowed({ connectorId: 'c2', actor: agent, actingFor: alice });
    audit.allowed({ connectorId: 'c3', actor: agent, actingFor: alice });
    // c1 was dropped, so it is written again inside the window
    expect(audit.allowed({ connectorId: 'c1', actor: agent, actingFor: alice })).toBe(true);
    expect(audit.allowed({ connectorId: 'c3', actor: agent, actingFor: alice })).toBe(false);
    expect(written).toHaveLength(4);
  });

  it('reset() reopens every window', () => {
    const { audit, written } = make({ t: 1000 });
    audit.allowed({ connectorId: 'canva', actor: agent, actingFor: alice });
    audit.reset();
    audit.allowed({ connectorId: 'canva', actor: agent, actingFor: alice });
    expect(written).toHaveLength(2);
  });
});

describe('refused', () => {
  it('writes a role refusal every time, with the allowed roles', () => {
    const { audit, written } = make({ t: 1000 });
    audit.refused({ connectorId: 'canva', actor: agent, actingFor: alice, reason: 'role_not_allowed', allowedRoles: ['ops', 'support'] });
    audit.refused({ connectorId: 'canva', actor: agent, actingFor: alice, reason: 'role_not_allowed', allowedRoles: ['ops', 'support'] });
    expect(written).toHaveLength(2);
    const e = written[0];
    expect(e.action).toBe(CONNECTOR_USE_ACTIONS.REFUSED);
    expect(e.after).toEqual({ reason: 'role_not_allowed', actingFor: 'UALICE', actingForRole: 'member', allowedRoles: ['ops', 'support'] });
    expect(e.note).toBe('agent a-dev was refused canva: role of a-dev is not on the allowlist (allowed: ops, support)');
  });

  it('writes a grant refusal naming the person and who authorized the grant', () => {
    const { audit, written } = make({ t: 1000 });
    audit.refused({ connectorId: 'google-workspace', actor: agent, actingFor: alice, reason: 'grant_not_shared', authorizedBy: 'Bob', what: 'gmail' });
    expect(written[0].after).toEqual({ reason: 'grant_not_shared', actingFor: 'UALICE', actingForRole: 'member', authorizedBy: 'Bob', what: 'gmail' });
    expect(written[0].note).toBe('agent a-dev was refused google-workspace (gmail): the grant is not shared with Alice (authorized by Bob)');
  });

  it('describes Crewly itself and an unknown person', () => {
    const { audit, written } = make({ t: 1000 });
    audit.refused({ connectorId: 'canva', actor: { type: 'system', id: 'scheduler' }, actingFor: null, reason: 'grant_not_shared' });
    expect(written[0].note).toBe('Crewly (scheduler) was refused canva: the grant is not shared with the person this call acts for');
  });
});

describe('singleton', () => {
  afterEach(() => setConnectorUseAuditForTesting(null));

  it('hands out one instance and lets tests replace it', () => {
    const a = getConnectorUseAudit();
    expect(getConnectorUseAudit()).toBe(a);
    const mine = new ConnectorUseAuditService({ record: () => undefined });
    setConnectorUseAuditForTesting(mine);
    expect(getConnectorUseAudit()).toBe(mine);
  });
});
