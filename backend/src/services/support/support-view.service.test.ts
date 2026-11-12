/**
 * Tests for the support view (crewly#1558): who may read, which grant and
 * machine a read goes to, what is noted as a private source and what is
 * written to this machine's Activity log.
 */

import { SUPPORT_VIEW_CONSTANTS } from '../../constants.js';
import type { ActivityEntryInput } from '../activity/activity-log.service.js';
import { SupportViewError, type SupportRead, type SupportViewGrant, type SupportViewMachine } from './support-client.types.js';
import { SupportViewService, describeSupportRead, type SupportViewDeps } from './support-view.service.js';

const V = SUPPORT_VIEW_CONSTANTS;
const F = V.FAILURES;

const GRANT: SupportViewGrant = { id: 'g1', grantorEmail: 'steve@example.com', grantorName: 'Steve', role: 'viewer', includePrivate: false, agentAccess: true, instanceId: null };
const GRANT_2: SupportViewGrant = { id: 'g2', grantorEmail: 'amy@example.com', role: 'admin', includePrivate: true, instanceId: null };
const MAC: SupportViewMachine = { instanceId: 'i1', deviceName: 'Studio Mac', relayQueueId: 'q-secret-1', live: true, lastSeenAt: '2026-11-12T00:00:00Z' };
const AIR: SupportViewMachine = { instanceId: 'i2', deviceName: 'Air', relayQueueId: 'q-secret-2', live: false };

interface Opts {
  grants?: SupportViewGrant[];
  machines?: Record<string, SupportViewMachine[] | Error>;
  read?: jest.Mock;
  allowed?: () => Promise<boolean>;
  actor?: { id: string; role: string } | (() => { id: string; role: string });
  displayName?: SupportViewDeps['displayName'];
  notePrivate?: SupportViewDeps['notePrivate'];
  record?: SupportViewDeps['record'];
}

function make(opts: Opts = {}) {
  const written: ActivityEntryInput[] = [];
  const noted: Array<[string, string, string]> = [];
  const read = opts.read ?? jest.fn(async () => ({ agents: [{ name: 'Their Dev' }] }));
  const listGrants = jest.fn(async () => opts.grants ?? [GRANT]);
  const listMachines = jest.fn(async (grantId: string) => {
    const m = (opts.machines ?? { g1: [MAC], g2: [MAC, AIR] })[grantId] ?? [];
    if (m instanceof Error) throw m;
    return m;
  });
  const warn = jest.fn();
  const actor = opts.actor ?? { id: 'owner', role: 'owner' };
  const view = new SupportViewService({
    client: { listGrants, listMachines, read },
    allowed: opts.allowed ?? (async () => true),
    displayName: opts.displayName ?? (async () => 'Nova'),
    actingFor: typeof actor === 'function' ? actor : () => actor,
    notePrivate: opts.notePrivate ?? ((s, p, c) => void noted.push([s, p, c])),
    record: opts.record ?? ((e) => void written.push(e)),
    logger: { warn },
  });
  return { view, written, noted, read, listGrants, listMachines, warn };
}

async function failure(promise: Promise<unknown>): Promise<SupportViewError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SupportViewError);
    return error as SupportViewError;
  }
  throw new Error('expected the call to fail');
}

const AGENTS: SupportRead = { area: 'agents' };

describe('describeSupportRead', () => {
  it('names each read without its content', () => {
    expect(describeSupportRead({ area: 'agents' })).toBe('the agents list');
    expect(describeSupportRead({ area: 'conversations' })).toBe('the conversations list');
    expect(describeSupportRead({ area: 'errors' })).toBe('recent errors');
    expect(describeSupportRead({ area: 'messages', conversationId: 'slack-C1' })).toBe('messages of conversation slack-C1');
    expect(describeSupportRead({ area: 'settings' } as unknown as SupportRead)).toBe('something');
  });
});

describe('SupportViewService.grants', () => {
  it('lists received grants with their machines, never a relay queue id', async () => {
    const { view } = make({ grants: [GRANT, GRANT_2] });
    const grants = await view.grants('crewly-nova');
    expect(grants).toEqual([
      { id: 'g1', grantorEmail: 'steve@example.com', grantorName: 'Steve', role: 'viewer', includePrivate: false, agentAccess: true, machines: [{ instanceId: 'i1', deviceName: 'Studio Mac', live: true, lastSeenAt: '2026-11-12T00:00:00Z' }] },
      {
        id: 'g2',
        grantorEmail: 'amy@example.com',
        role: 'admin',
        includePrivate: true,
        agentAccess: null,
        machines: [
          { instanceId: 'i1', deviceName: 'Studio Mac', live: true, lastSeenAt: '2026-11-12T00:00:00Z' },
          { instanceId: 'i2', deviceName: 'Air', live: false },
        ],
      },
    ]);
    expect(JSON.stringify(grants)).not.toContain('q-secret');
  });

  it('keeps a grant whose machines could not be listed, and says so', async () => {
    const { view } = make({ machines: { g1: new SupportViewError(F.ACCESS_ENDED) } });
    const [grant] = await view.grants('crewly-nova');
    expect(grant.machines).toEqual([]);
    expect(grant.machinesError).toMatch(/ended/);
    const odd = make({ machines: { g1: new Error('boom') } });
    expect((await odd.view.grants('crewly-nova'))[0].machinesError).toBe('The machines could not be listed.');
  });

  it('is refused while the owner of this machine has it off, without asking Cloud', async () => {
    const { view, listGrants } = make({ allowed: async () => false });
    expect((await failure(view.grants('crewly-nova'))).code).toBe(F.TURNED_OFF_HERE);
    expect(listGrants).not.toHaveBeenCalled();
  });
});

describe('SupportViewService.read gate', () => {
  it('is refused while the setting is off or unreadable, and the refusal is in the Activity log', async () => {
    for (const allowed of [async () => false, async () => { throw new Error('settings unreadable'); }]) {
      const { view, read, listGrants, written, noted } = make({ allowed });
      const error = await failure(view.read('crewly-nova', {}, AGENTS));
      expect(error.code).toBe(F.TURNED_OFF_HERE);
      expect(error.status).toBe(403);
      expect(listGrants).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(noted).toHaveLength(0);
      expect(written).toEqual([expect.objectContaining({ action: V.ACTIONS.REFUSED, after: expect.objectContaining({ outcome: F.TURNED_OFF_HERE }) })]);
    }
  });

  it('is refused to a session working for someone other than the owner', async () => {
    const { view, read, written } = make({ actor: { id: 'p-amy', role: 'member' } });
    expect((await failure(view.read('crewly-nova', {}, AGENTS))).code).toBe(F.OWNER_ONLY);
    expect(read).not.toHaveBeenCalled();
    expect(written[0].after).toMatchObject({ outcome: F.OWNER_ONLY });
    const broken = make({
      actor: () => {
        throw new Error('people unreadable');
      },
    });
    expect((await failure(broken.view.read('crewly-nova', {}, AGENTS))).code).toBe(F.OWNER_ONLY);
  });
});

describe('SupportViewService.read', () => {
  it('reads the only machine of the only grant under the agent\'s name', async () => {
    const { view, read } = make();
    const result = await view.read('crewly-nova', {}, { area: 'conversations', limit: 5 });
    expect(read).toHaveBeenCalledWith(MAC, { area: 'conversations', limit: 5 }, 'Nova');
    expect(result).toEqual({
      grant: { id: 'g1', grantorEmail: 'steve@example.com', grantorName: 'Steve', includePrivate: false },
      machine: { instanceId: 'i1', deviceName: 'Studio Mac' },
      data: { agents: [{ name: 'Their Dev' }] },
    });
    expect(JSON.stringify(result)).not.toContain('q-secret');
  });

  it('sends a name the relay accepts when the display name is unknown or unusable', async () => {
    const unknown = make({ displayName: async () => undefined });
    await unknown.view.read('crewly-team-ming', {}, AGENTS);
    expect(unknown.read.mock.calls[0][2]).toBe('crewly-team-ming');
    const failing = make({ displayName: async () => { throw new Error('storage down'); } });
    await failing.view.read('crewly-nova', {}, AGENTS);
    expect(failing.read.mock.calls[0][2]).toBe('crewly-nova');
    const odd = make({ displayName: async () => 'Nova (QA)' });
    await odd.view.read('crewly-nova', {}, AGENTS);
    expect(odd.read.mock.calls[0][2]).toBe('Nova QA');
  });

  it('notes the read as a private source under the grantor, not the owner', async () => {
    const { view, noted } = make();
    await view.read('crewly-nova', {}, AGENTS);
    expect(noted).toEqual([['crewly-nova', 'support:steve@example.com', 'support-access']]);
    const noEmail = make({ grants: [{ ...GRANT, grantorEmail: '' }] });
    await noEmail.view.read('crewly-nova', {}, AGENTS);
    expect(noEmail.noted).toEqual([['crewly-nova', 'support:g1', 'support-access']]);
  });

  it('notes nothing when the read failed', async () => {
    const { view, noted } = make({ read: jest.fn(async () => { throw new SupportViewError(F.OFFLINE); }) });
    await failure(view.read('crewly-nova', {}, AGENTS));
    expect(noted).toHaveLength(0);
  });

  it('still answers when the private-source note or the Activity log fails', async () => {
    const { view, warn } = make({
      notePrivate: () => {
        throw new Error('tracker down');
      },
      record: () => {
        throw new Error('log down');
      },
    });
    await expect(view.read('crewly-nova', {}, AGENTS)).resolves.toMatchObject({ data: expect.anything() });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('writes a read to the Activity log: which agent, whose account, which machine, what, the outcome, never the content', async () => {
    const { view, written } = make({ read: jest.fn(async () => ({ messages: [{ text: 'TOP SECRET CONTENT' }] })) });
    await view.read('crewly-nova', {}, { area: 'messages', conversationId: 'slack-C1' });
    expect(written).toEqual([
      {
        actor: { type: 'agent', id: 'crewly-nova', via: 'support-view' },
        action: 'support-view.read',
        target: { type: 'support-grant', id: 'g1' },
        after: {
          agent: 'Nova',
          area: 'messages',
          conversationId: 'slack-C1',
          outcome: 'ok',
          grantId: 'g1',
          grantorEmail: 'steve@example.com',
          role: 'viewer',
          includePrivate: false,
          machine: 'Studio Mac',
          instanceId: 'i1',
        },
        note: 'Agent Nova (crewly-nova) read messages of conversation slack-C1 on Studio Mac of steve@example.com through support access',
      },
    ]);
    expect(JSON.stringify(written)).not.toContain('TOP SECRET');
    expect(JSON.stringify(written)).not.toContain('q-secret');
  });

  it('writes a failed read with its reason', async () => {
    const { view, written } = make({ read: jest.fn(async () => { throw new SupportViewError(F.AGENT_ACCESS_OFF); }) });
    expect((await failure(view.read('crewly-nova', {}, AGENTS))).code).toBe(F.AGENT_ACCESS_OFF);
    expect(written[0]).toMatchObject({
      action: 'support-view.refused',
      target: { type: 'support-grant', id: 'g1' },
      after: { outcome: F.AGENT_ACCESS_OFF, area: 'agents', machine: 'Studio Mac' },
      note: 'Agent Nova (crewly-nova) could not read the agents list on Studio Mac of steve@example.com through support access: agent_access_off',
    });
  });

  it('turns an unexpected error into a plain failure and logs it', async () => {
    const { view, written, warn } = make({ read: jest.fn(async () => { throw new Error('boom with details'); }) });
    const error = await failure(view.read('crewly-nova', {}, AGENTS));
    expect(error.code).toBe(F.FAILED);
    expect(error.message).not.toContain('boom');
    expect(warn).toHaveBeenCalled();
    expect(written[0].after).toMatchObject({ outcome: F.FAILED });
  });

  it('does not send when the grantor has agent access off, and lets the relay decide when Cloud did not say', async () => {
    const off = make({ grants: [{ ...GRANT, agentAccess: false }] });
    expect((await failure(off.view.read('crewly-nova', {}, AGENTS))).code).toBe(F.AGENT_ACCESS_OFF);
    expect(off.read).not.toHaveBeenCalled();
    expect(off.listMachines).not.toHaveBeenCalled();
    const { agentAccess: _unsaid, ...unsaidGrant } = GRANT;
    const unsaid = make({ grants: [unsaidGrant] });
    await unsaid.view.read('crewly-nova', {}, AGENTS);
    expect(unsaid.read).toHaveBeenCalledTimes(1);
  });
});

describe('SupportViewService grant and machine choice', () => {
  it('says access ended when this account received none', async () => {
    const { view, written } = make({ grants: [] });
    const error = await failure(view.read('crewly-nova', {}, AGENTS));
    expect(error.code).toBe(F.ACCESS_ENDED);
    expect(written[0]).toMatchObject({ target: { id: 'none' }, note: expect.stringContaining('of another account') });
  });

  it('asks which one when several accounts gave access and none was named', async () => {
    const { view, read } = make({ grants: [GRANT, GRANT_2] });
    const error = await failure(view.read('crewly-nova', {}, AGENTS));
    expect(error.code).toBe(F.CHOOSE);
    expect(error.status).toBe(409);
    expect(error.choices).toEqual(['steve@example.com (grant g1)', 'amy@example.com (grant g2)']);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([['g1'], ['steve@example.com'], ['STEVE@Example.com'], ['steve'], [' Steve ']])('picks a grant named %p by id, email or name', async (named) => {
    const { view, read } = make({ grants: [GRANT, GRANT_2] });
    const result = await view.read('crewly-nova', { grant: named }, AGENTS);
    expect(result.grant.id).toBe('g1');
    expect(read).toHaveBeenCalledWith(MAC, AGENTS, 'Nova');
  });

  it('says access ended for a name that matches no grant, and asks again when it matches several', async () => {
    const { view } = make({ grants: [GRANT, GRANT_2] });
    const none = await failure(view.read('crewly-nova', { grant: 'bob@example.com' }, AGENTS));
    expect(none.code).toBe(F.ACCESS_ENDED);
    expect(none.choices).toHaveLength(2);
    const twins = make({ grants: [GRANT, { ...GRANT_2, grantorName: 'steve' }] });
    expect((await failure(twins.view.read('crewly-nova', { grant: 'Steve' }, AGENTS))).code).toBe(F.CHOOSE);
  });

  it('asks which machine when the grant reaches several, and picks one by name or id', async () => {
    const { view, read } = make({ grants: [GRANT_2] });
    const error = await failure(view.read('crewly-nova', {}, AGENTS));
    expect(error.code).toBe(F.CHOOSE);
    expect(error.choices).toEqual(['Studio Mac (online, id i1)', 'Air (offline, id i2)']);
    await view.read('crewly-nova', { machine: 'air' }, AGENTS);
    expect(read).toHaveBeenLastCalledWith(AIR, AGENTS, 'Nova');
    await view.read('crewly-nova', { machine: 'i1' }, AGENTS);
    expect(read).toHaveBeenLastCalledWith(MAC, AGENTS, 'Nova');
  });

  it('says so when no machine matches, when two share a name, and when the grant reaches none', async () => {
    const { view } = make({ grants: [GRANT_2] });
    const none = await failure(view.read('crewly-nova', { machine: 'Mini' }, AGENTS));
    expect(none.code).toBe(F.NOT_FOUND);
    expect(none.choices).toHaveLength(2);
    const twins = make({ machines: { g1: [MAC, { ...AIR, deviceName: 'studio mac' }] } });
    expect((await failure(twins.view.read('crewly-nova', { machine: 'Studio Mac' }, AGENTS))).code).toBe(F.CHOOSE);
    const empty = make({ machines: { g1: [] } });
    expect((await failure(empty.view.read('crewly-nova', {}, AGENTS))).code).toBe(F.OFFLINE);
  });

  it('refuses a selector that is too long or holds control characters', async () => {
    const { view, read } = make();
    expect((await failure(view.read('crewly-nova', { grant: 'x'.repeat(201) }, AGENTS))).code).toBe(F.INVALID);
    expect((await failure(view.read('crewly-nova', { machine: 'a\u0000b' }, AGENTS))).code).toBe(F.INVALID);
    expect(read).not.toHaveBeenCalled();
    // An empty selector is the same as none.
    await expect(view.read('crewly-nova', { grant: '  ', machine: '' }, AGENTS)).resolves.toBeDefined();
  });
});
