/**
 * Tests for the support audit: every call written, identical reads collapsed (crewly#1558).
 */

import { SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import type { ActivityEntryInput } from '../activity/activity-log.service.js';
import { SupportAuditService, supportActor } from './support-audit.service.js';
import { supportCallerFromEnvelope } from './support.types.js';

const A = SUPPORT_ACCESS_CONSTANTS.ACTIONS;
const caller = supportCallerFromEnvelope({
  grantId: 'g1',
  role: 'viewer',
  includePrivate: false,
  granteeEmail: 'help@crewlyai.com',
  granteeAccountId: 'acct-b',
  replyQueueId: 'q-b',
});

const agentCaller = supportCallerFromEnvelope({
  grantId: 'g1',
  role: 'viewer',
  includePrivate: false,
  granteeEmail: 'help@crewlyai.com',
  granteeAccountId: 'acct-b',
  replyQueueId: 'q-b',
  actor: 'agent',
  agentName: 'Nova',
});

function make() {
  const written: ActivityEntryInput[] = [];
  let now = 1_000_000;
  const audit = new SupportAuditService({ record: (e) => written.push(e), now: () => now, windowMs: 60_000 });
  return { audit, written, tick: (ms: number) => (now += ms) };
}

describe('supportActor', () => {
  it('names the grantee by email, else account id', () => {
    expect(supportActor(caller)).toEqual({ type: 'support', id: 'help@crewlyai.com', via: 'support-grant' });
    expect(supportActor({ ...caller, granteeEmail: '' })).toMatchObject({ id: 'acct-b' });
    expect(supportActor(null)).toMatchObject({ id: 'unknown' });
  });

  it('marks an agent of the grantee account in the actor', () => {
    expect(supportActor(agentCaller)).toEqual({ type: 'support', id: 'help@crewlyai.com', via: 'support-grant-agent' });
    expect(supportActor(supportCallerFromEnvelope({ ...agentCaller, actor: 'person' }))).toMatchObject({ via: 'support-grant' });
  });
});

describe('SupportAuditService', () => {
  it('writes a read with who, role, path and outcome', () => {
    const { audit, written } = make();
    expect(audit.note({ caller, method: 'GET', path: '/support/agents', outcome: 'ok', status: 200 })).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor: { type: 'support', id: 'help@crewlyai.com' },
      action: A.READ,
      target: { type: 'support-path', id: '/support/agents' },
      after: { method: 'GET', path: '/support/agents', outcome: 'ok', status: 200, granteeEmail: 'help@crewlyai.com', role: 'viewer', grantId: 'g1' },
    });
  });

  it('keeps the text of a person read as it was', () => {
    const { audit, written } = make();
    audit.note({ caller, method: 'GET', path: '/support/agents', outcome: 'ok', status: 200 });
    audit.note({ caller: supportCallerFromEnvelope({ ...agentCaller, actor: 'person', agentName: undefined }), method: 'GET', path: '/support/errors', outcome: 'ok', status: 200 });
    expect(written[0].note).toBe('Support (viewer) help@crewlyai.com read GET /api/support/agents; the same read in the next 1 minutes is not logged again');
    expect(written[0].after).not.toHaveProperty('sentBy');
    expect(written[0].after).not.toHaveProperty('agentName');
    expect(written[1].note).toMatch(/^Support \(viewer\) help@crewlyai\.com read GET/);
  });

  it('says a read was made by an agent of the grantee account, with its name', () => {
    const { audit, written } = make();
    audit.note({ caller: agentCaller, method: 'GET', path: '/support/conversations/c1/messages?cursor=x', outcome: 'ok', status: 200 });
    expect(written[0]).toMatchObject({
      actor: { type: 'support', id: 'help@crewlyai.com', via: 'support-grant-agent' },
      action: A.READ,
      after: { sentBy: 'agent', agentName: 'Nova', granteeEmail: 'help@crewlyai.com', grantId: 'g1' },
    });
    expect(written[0].note).toMatch(/^Support \(viewer\) agent Nova of help@crewlyai\.com read GET \/api\/support\/conversations\/c1\/messages/);
  });

  it('says an agent without a usable name is an agent of the grantee account', () => {
    const { audit, written } = make();
    const nameless = supportCallerFromEnvelope({ ...agentCaller, agentName: undefined });
    audit.note({ caller: nameless, method: 'POST', path: '/support/agents/a/restart', outcome: 'refused', status: 403, code: 'support_agent_read_only' });
    expect(written[0].action).toBe(A.REFUSED);
    expect(written[0].after).toMatchObject({ sentBy: 'agent', code: 'support_agent_read_only' });
    expect(written[0].after).not.toHaveProperty('agentName');
    expect(written[0].note).toBe('Support (viewer) an agent of help@crewlyai.com was refused POST /api/support/agents/a/restart (support_agent_read_only)');
  });

  it('collapses per sender: a person, and each agent, has its own window', () => {
    const { audit, written } = make();
    const other = supportCallerFromEnvelope({ ...agentCaller, agentName: 'Vera' });
    expect(audit.note({ caller, method: 'GET', path: '/support/agents', outcome: 'ok', status: 200 })).toBe(true);
    expect(audit.note({ caller: agentCaller, method: 'GET', path: '/support/agents', outcome: 'ok', status: 200 })).toBe(true);
    expect(audit.note({ caller: other, method: 'GET', path: '/support/agents', outcome: 'ok', status: 200 })).toBe(true);
    expect(audit.note({ caller: agentCaller, method: 'GET', path: '/support/agents', outcome: 'ok', status: 200 })).toBe(false);
    expect(audit.note({ caller, method: 'GET', path: '/support/agents', outcome: 'ok', status: 200 })).toBe(false);
    expect(written).toHaveLength(3);
  });

  it('collapses an identical read inside the window, pages of one conversation included', () => {
    const { audit, written, tick } = make();
    audit.note({ caller, method: 'GET', path: '/support/conversations/c1/messages', outcome: 'ok', status: 200 });
    expect(audit.note({ caller, method: 'GET', path: '/support/conversations/c1/messages?cursor=x', outcome: 'ok', status: 200 })).toBe(false);
    expect(audit.note({ caller, method: 'GET', path: '/support/conversations/c2/messages', outcome: 'ok', status: 200 })).toBe(true);
    tick(61_000);
    expect(audit.note({ caller, method: 'GET', path: '/support/conversations/c1/messages', outcome: 'ok', status: 200 })).toBe(true);
    expect(written).toHaveLength(3);
  });

  it('writes every refusal and every action', () => {
    const { audit, written } = make();
    audit.note({ caller, method: 'POST', path: '/support/agents/a/restart', outcome: 'ok', status: 200 });
    audit.note({ caller, method: 'POST', path: '/support/agents/a/restart', outcome: 'ok', status: 200 });
    audit.note({ caller, method: 'GET', path: '/teams', outcome: 'refused', status: 403, code: 'support_path_refused' });
    audit.note({ caller, method: 'GET', path: '/teams', outcome: 'refused', status: 403, code: 'support_path_refused' });
    expect(written.map((e) => e.action)).toEqual([A.ACTION, A.ACTION, A.REFUSED, A.REFUSED]);
    expect(written[2].after).toMatchObject({ code: 'support_path_refused' });
  });

  it('writes an unidentified caller as unknown', () => {
    const { audit, written } = make();
    audit.note({ caller: null, method: 'GET', path: '/support/agents', outcome: 'refused', status: 400 });
    expect(written[0].actor).toMatchObject({ type: 'support', id: 'unknown' });
  });

  it('drops the oldest keys past the cap', () => {
    const written: ActivityEntryInput[] = [];
    const audit = new SupportAuditService({ record: (e) => written.push(e), now: () => 0, windowMs: 60_000, maxKeys: 1 });
    audit.note({ caller, method: 'GET', path: '/support/a', outcome: 'ok', status: 200 });
    audit.note({ caller, method: 'GET', path: '/support/b', outcome: 'ok', status: 200 });
    expect(audit.note({ caller, method: 'GET', path: '/support/a', outcome: 'ok', status: 200 })).toBe(true);
    audit.reset();
    expect(audit.note({ caller, method: 'GET', path: '/support/a', outcome: 'ok', status: 200 })).toBe(true);
  });
});
