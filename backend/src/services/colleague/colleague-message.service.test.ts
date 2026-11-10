import { ColleagueMessageService, type ColleagueDeps, type ColleagueRecord } from './colleague-message.service.js';
import { ColleagueLoopGuard } from './colleague-loop-guard.js';
import type { ColleagueWireMessage } from './colleague-message.types.js';
import type { DirectoryEntry } from '../slack/slack-directory.service.js';
import { COLLEAGUE_MESSAGE_CONSTANTS } from '../../constants.js';

function entry(over: Partial<DirectoryEntry>): DirectoryEntry {
  return {
    name: 'X', mention: null, botUserId: null, agentSession: 'x', team: 'T', machine: 'this machine',
    source: 'this-machine', inChannel: false, kind: 'agent', ...over,
  };
}

// This test file plays the Air: Fern (SteamFun) is local, Pia (Flopost) is on the Mac.
const fern = entry({ name: 'Fern', agentSession: 'steamfun-fern', team: 'SteamFun', instanceId: 'dev-air' });
const nova = entry({ name: 'Nova', agentSession: 'steamfun-nova', team: 'SteamFun', instanceId: 'dev-air' });
const pia = entry({ name: 'Pia', agentSession: 'flopost-pia', team: 'Flopost', machine: 'steves-mac', source: 'this-account', instanceId: 'dev-mac' });

function build(over: Partial<ColleagueDeps> = {}) {
  const records: ColleagueRecord[] = [];
  const sentRemote: Array<{ to: string; wire: ColleagueWireMessage }> = [];
  const delivered: Array<{ session: string; text: string }> = [];
  let n = 0;
  const deps: ColleagueDeps = {
    self: async () => ({ instanceId: 'dev-air', deviceName: 'iriss-air.lan' }),
    listDirectory: async () => [fern, nova, pia],
    listLocalAgents: async () => [fern, nova],
    describeLocal: async (s) => (s === 'steamfun-fern' ? { name: 'Fern', team: 'SteamFun' } : s === 'steamfun-nova' ? { name: 'Nova', team: 'SteamFun' } : null),
    deliverLocal: async (session, text) => { delivered.push({ session, text }); return { success: true }; },
    sendRemote: async (to, wire) => { sentRemote.push({ to, wire }); return { ok: true }; },
    isAccountMachine: (id) => id === 'dev-mac' || id === 'dev-air',
    isMachineOnline: () => true,
    record: (r) => records.push(r),
    newId: () => `id-${++n}`,
    now: () => Date.parse('2026-11-10T10:00:00Z'),
    ...over,
  };
  return { svc: new ColleagueMessageService(deps), deps, records, sentRemote, delivered };
}

describe('ColleagueMessageService.send', () => {
  it('sends to a colleague on another machine over the relay, addressed to that machine', async () => {
    const { svc, sentRemote, delivered } = build();
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'Can you send me the deck?' });
    expect(r).toMatchObject({ success: true, route: 'remote', messageId: 'id-1', to: { name: 'Pia', team: 'Flopost', machine: 'steves-mac', session: 'flopost-pia' } });
    expect(delivered).toEqual([]);
    expect(sentRemote).toHaveLength(1);
    expect(sentRemote[0].to).toBe('dev-mac');
    expect(sentRemote[0].wire).toMatchObject({
      v: 1, id: 'id-1', toSession: 'flopost-pia', text: 'Can you send me the deck?',
      from: { instanceId: 'dev-air', deviceName: 'iriss-air.lan', session: 'steamfun-fern', name: 'Fern', team: 'SteamFun' },
    });
  });

  it('carries replyTo on the wire', async () => {
    const { svc, sentRemote } = build();
    await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'Here it is', replyTo: 'orig-1' });
    expect(sentRemote[0].wire.replyTo).toBe('orig-1');
  });

  it('delivers to a colleague on this machine through local delivery, framed, without the relay', async () => {
    const { svc, sentRemote, delivered } = build();
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'nova', text: 'ping' });
    expect(r).toMatchObject({ success: true, route: 'local', note: 'Delivered to Nova.' });
    expect(sentRemote).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].session).toBe('steamfun-nova');
    expect(delivered[0].text).toContain('[Message from colleague Fern (team SteamFun, machine iriss-air.lan)');
    expect(delivered[0].text).toContain('message-colleague --to Fern --reply-to id-1');
  });

  it('reports a stopped local colleague as queued and being started', async () => {
    const { svc } = build({ deliverLocal: async () => ({ success: true, queued: true }) });
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'Nova', text: 'ping' });
    expect(r).toMatchObject({ success: true, queued: true });
    expect(r.note).toContain('being started');
  });

  it('reports a failed local delivery and still records the attempt', async () => {
    const { svc, records } = build({ deliverLocal: async () => ({ success: false, error: 'session gone' }) });
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'Nova', text: 'ping' });
    expect(r).toMatchObject({ success: false, code: 'delivery_failed' });
    expect(records.find((x) => x.direction === 'out')?.extra).toMatchObject({ delivered: false });
  });

  it('records both sides for a local exchange, and the sender side for a remote one', async () => {
    const local = build();
    await local.svc.send({ fromSession: 'steamfun-fern', to: 'Nova', text: 'ping' });
    expect(local.records.map((r) => [r.agentSession, r.direction])).toEqual([['steamfun-fern', 'out'], ['steamfun-nova', 'in']]);
    expect(local.records[0].peerLabel).toBe('Nova (SteamFun, iriss-air.lan)');

    const remote = build();
    await remote.svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'hi' });
    expect(remote.records).toHaveLength(1);
    expect(remote.records[0]).toMatchObject({ agentSession: 'steamfun-fern', direction: 'out', peerKey: 'dev-mac:flopost-pia', peerLabel: 'Pia (Flopost, steves-mac)', messageId: 'id-1', text: 'hi' });
  });

  it('answers not_found with the closest names and a pointer to list-colleagues', async () => {
    const { svc } = build();
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'Pi', text: 'hi' });
    expect(r).toMatchObject({ success: false, code: 'not_found' });
    expect(r.error).toContain('Pia (Flopost, steves-mac)');
    expect(r.error).toContain('list-colleagues');
  });

  it('says so when Cloud is down and only local agents can be found', async () => {
    const { svc } = build({ listDirectory: async () => null });
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'hi' });
    expect(r).toMatchObject({ success: false, code: 'not_found' });
    expect(r.error).toContain('Cloud is not reachable');
    const local = await svc.send({ fromSession: 'steamfun-fern', to: 'Nova', text: 'hi' });
    expect(local).toMatchObject({ success: true, route: 'local' });
  });

  it('does not guess between two colleagues with the same name', async () => {
    const pia2 = entry({ name: 'Pia', agentSession: 'other-pia', team: 'Other', machine: 'mac-mini', source: 'this-account', instanceId: 'dev-mini' });
    const { svc, sentRemote } = build({ listDirectory: async () => [fern, pia, pia2] });
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'hi' });
    expect(r).toMatchObject({ success: false, code: 'ambiguous' });
    expect(r.candidates).toHaveLength(2);
    expect(sentRemote).toEqual([]);
    const narrowed = await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', team: 'Other', text: 'hi' });
    expect(narrowed).toMatchObject({ success: true, route: 'remote' });
  });

  it('refuses a message to oneself, an empty one, an oversized one and a non-agent sender', async () => {
    const { svc } = build();
    expect(await svc.send({ fromSession: 'steamfun-fern', to: 'Fern', text: 'hi' })).toMatchObject({ code: 'self' });
    expect(await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: '   ' })).toMatchObject({ code: 'invalid' });
    expect(await svc.send({ fromSession: 'steamfun-fern', to: '', text: 'hi' })).toMatchObject({ code: 'invalid' });
    expect(await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'x'.repeat(COLLEAGUE_MESSAGE_CONSTANTS.MAX_TEXT_LENGTH + 1) })).toMatchObject({ code: 'invalid' });
    expect(await svc.send({ fromSession: 'not-an-agent', to: 'Pia', text: 'hi' })).toMatchObject({ code: 'invalid' });
    expect(await svc.send({ fromSession: '', to: 'Pia', text: 'hi' })).toMatchObject({ code: 'invalid' });
  });

  it('surfaces a relay failure and still records the attempt as not delivered', async () => {
    const { svc, records } = build({ sendRemote: async () => ({ ok: false, code: 'send_failed', error: 'Peer queue not found' }) });
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'hi' });
    expect(r).toMatchObject({ success: false, code: 'send_failed' });
    expect(r.error).toContain('Peer queue not found');
    expect(records[0].extra).toMatchObject({ delivered: false });
  });

  it('tells the sender when the target machine is offline that it is held for later', async () => {
    const { svc } = build({ isMachineOnline: () => false });
    const r = await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'hi' });
    expect(r.success).toBe(true);
    expect(r.note).toContain('offline');
    expect(r.note).toContain('back');
  });

  it('stops a back-and-forth at the loop cap and sends nothing more', async () => {
    const { svc, sentRemote } = build();
    for (let i = 0; i < COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES; i++) {
      expect((await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: `m${i}` })).success).toBe(true);
    }
    const capped = await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'one more' });
    expect(capped).toMatchObject({ success: false, code: 'loop_cap' });
    expect(capped.error).toContain('ask the owner');
    expect(sentRemote).toHaveLength(COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES);
    // Another colleague is unaffected.
    expect((await svc.send({ fromSession: 'steamfun-fern', to: 'Nova', text: 'hi' })).success).toBe(true);
  });
});

describe('ColleagueMessageService.receive', () => {
  const wire = (over: Partial<ColleagueWireMessage> = {}): ColleagueWireMessage => ({
    v: 1, id: 'in-1',
    from: { instanceId: 'dev-mac', deviceName: 'steves-mac', session: 'flopost-pia', name: 'Pia', team: 'Flopost' },
    toSession: 'steamfun-fern', text: 'Deck is in the shared folder.', sentAt: '2026-11-10T10:00:00.000Z', ...over,
  });

  it('delivers to the target agent framed as a colleague, not the owner, and records it', async () => {
    const { svc, delivered, records } = build();
    const out = await svc.receive(wire({ replyTo: 'id-0' }));
    expect(out).toEqual({ handled: true, delivered: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].session).toBe('steamfun-fern');
    expect(delivered[0].text).toContain('[Message from colleague Pia (team Flopost, machine steves-mac) — id in-1.');
    expect(delivered[0].text).toContain('not the owner');
    expect(delivered[0].text).toContain('message-colleague --to Pia --reply-to in-1');
    expect(delivered[0].text.endsWith('Deck is in the shared folder.')).toBe(true);
    expect(records).toEqual([
      expect.objectContaining({ agentSession: 'steamfun-fern', direction: 'in', peerKey: 'dev-mac:flopost-pia', peerLabel: 'Pia (Flopost, steves-mac)', messageId: 'in-1', extra: { replyTo: 'id-0', delivered: true } }),
    ]);
  });

  it('marks a message to an agent that was down as queued', async () => {
    const { svc, records } = build({ deliverLocal: async () => ({ success: true, queued: true }) });
    expect(await svc.receive(wire())).toEqual({ handled: true, delivered: true });
    expect(records[0].extra).toMatchObject({ queued: true });
  });

  it('ignores a payload that is not a colleague message', async () => {
    const { svc, delivered } = build();
    expect(await svc.receive({ nope: true })).toEqual({ handled: false, reason: 'malformed' });
    expect(delivered).toEqual([]);
  });

  it('ignores a sender that is not a machine of this account', async () => {
    const { svc, delivered } = build();
    const out = await svc.receive(wire({ from: { instanceId: 'dev-stranger', deviceName: 'x', session: 's', name: 'Eve' } }));
    expect(out).toEqual({ handled: false, reason: 'unknown_machine' });
    expect(delivered).toEqual([]);
  });

  it('drops a redelivery of the same message id', async () => {
    const { svc, delivered } = build();
    await svc.receive(wire());
    expect(await svc.receive(wire())).toEqual({ handled: true, delivered: false, reason: 'duplicate' });
    expect(delivered).toHaveLength(1);
  });

  it('does not deliver a message addressed to an agent that is not on this machine', async () => {
    const { svc, delivered } = build();
    expect(await svc.receive(wire({ toSession: 'ghost' }))).toEqual({ handled: true, delivered: false, reason: 'no_such_agent' });
    expect(delivered).toEqual([]);
  });

  it('does not wake a paused team', async () => {
    const { svc, delivered, records } = build({ isPaused: () => true });
    expect(await svc.receive(wire())).toEqual({ handled: true, delivered: false, reason: 'team_paused' });
    expect(delivered).toEqual([]);
    expect(records[0].extra).toMatchObject({ delivered: false, dropped: 'team_paused' });
  });

  it('drops messages past the loop cap, keeps them in the record, and wakes nobody', async () => {
    const { svc, delivered, records } = build();
    for (let i = 0; i < COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES; i++) {
      expect((await svc.receive(wire({ id: `in-${i}` }))).handled).toBe(true);
    }
    const out = await svc.receive(wire({ id: 'in-over' }));
    expect(out).toEqual({ handled: true, delivered: false, reason: 'loop_cap' });
    expect(delivered).toHaveLength(COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES);
    expect(records[records.length - 1].extra).toMatchObject({ dropped: 'loop_cap' });
  });

  it('counts sent and received messages of a pair together', async () => {
    const guard = new ColleagueLoopGuard({ maxMessages: 2 });
    const { deps } = build();
    const svc = new ColleagueMessageService(deps, guard);
    await svc.send({ fromSession: 'steamfun-fern', to: 'Pia', text: 'a' });
    await svc.receive(wire({ id: 'r1' }));
    expect(await svc.receive(wire({ id: 'r2' }))).toEqual({ handled: true, delivered: false, reason: 'loop_cap' });
  });

  it('reports a failed local delivery', async () => {
    const { svc } = build({ deliverLocal: async () => { throw new Error('boom'); } });
    expect(await svc.receive(wire())).toEqual({ handled: true, delivered: false, reason: 'boom' });
  });

  it('ignores its own message coming back', async () => {
    const { svc } = build();
    const out = await svc.receive(wire({ from: { instanceId: 'dev-air', deviceName: 'iriss-air.lan', session: 'steamfun-nova', name: 'Nova' } }));
    expect(out).toEqual({ handled: true, delivered: false, reason: 'own_message' });
  });
});
