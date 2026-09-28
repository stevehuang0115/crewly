/**
 * Tests for the owner receipt service (#828): settings, the nightly send,
 * the window moving only on success, redaction of the final text.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createRequest, type Request } from '../../../types/v2/request.types.js';
import { OwnerReceiptService, getOwnerReceiptService, setOwnerReceiptService } from './owner-receipt.service.js';

/** 2026-09-26 21:00 EDT */
const NINE_PM = new Date('2026-09-27T01:00:00Z');

/**
 * A ticket created at `at`.
 *
 * @param n - Ticket number
 * @param at - ISO creation time
 * @param text - Description
 * @returns Request
 */
function ticket(n: number, at: string, text = `ask ${n}`): Request {
  return {
    ...createRequest({ sourceConversationItemId: `r${n}`, title: `t${n}`, description: text, ticketNumber: n }),
    createdAt: at,
    assignee: 'atlas',
    status: 'done',
  };
}

/**
 * A service over fixed data.
 *
 * @param opts.requests - Tickets
 * @param opts.clock - Mutable clock
 * @param opts.sender - Sender (default records and succeeds)
 * @param opts.statePath - State file (default in memory)
 * @returns Service and what it sent
 */
function build(opts: { requests: Request[]; clock: { now: Date }; sender?: (t: string) => Promise<boolean>; statePath?: string | null }) {
  const sent: string[] = [];
  const svc = new OwnerReceiptService({
    listRequests: async () => opts.requests,
    listWorkItems: async () => [],
    loadTeamIndex: async () => new Map([['atlas', 'Think Tank']]),
    sender:
      opts.sender ??
      (async (t) => {
        sent.push(t);
        return true;
      }),
    statePath: opts.statePath === undefined ? null : opts.statePath,
    now: () => opts.clock.now,
  });
  return { svc, sent };
}

describe('OwnerReceiptService', () => {
  it('generates from ticket data: the first receipt covers the local day', async () => {
    const clock = { now: NINE_PM };
    const { svc } = build({ requests: [ticket(1, '2026-09-26T15:00:00Z'), ticket(2, '2026-09-26T03:00:00Z')], clock });
    const { data, text } = await svc.generate();
    expect(data.window.basis).toBe('local_day');
    expect(data.askCount).toBe(1);
    expect(text).toContain('你提了 *1 件事*');
  });

  it('names the team lead in the team header when loadTeamLeadIndex is wired (Ava\'s reference: Think Tank（Atlas）)', async () => {
    const svc = new OwnerReceiptService({
      listRequests: async () => [ticket(1, '2026-09-26T15:00:00Z')],
      listWorkItems: async () => [],
      loadTeamIndex: async () => new Map([['atlas', 'Think Tank']]),
      loadTeamLeadIndex: async () => new Map([['Think Tank', 'Atlas']]),
      statePath: null,
      now: () => NINE_PM,
    });
    const { data, text } = await svc.generate();
    expect(data.teams[0]).toMatchObject({ team: 'Think Tank', lead: 'Atlas' });
    expect(text).toContain('*Think Tank（Atlas）*');
  });

  it('no lead shown when loadTeamLeadIndex is not wired at all (backward compatible)', async () => {
    const clock = { now: NINE_PM };
    const { svc } = build({ requests: [ticket(1, '2026-09-26T15:00:00Z')], clock });
    const { data, text } = await svc.generate();
    expect(data.teams[0]).toMatchObject({ team: 'Think Tank', lead: null });
    expect(text).toContain('*Think Tank*');
    expect(text).not.toContain('（Atlas）');
  });

  it('sends at the set local time, once per local day, and the next window starts where this one ended', async () => {
    const clock = { now: new Date('2026-09-27T00:59:00Z') }; // 20:59 EDT
    const requests = [ticket(1, '2026-09-26T15:00:00Z')];
    const { svc, sent } = build({ requests, clock });
    expect(await svc.tick()).toBeNull();
    clock.now = NINE_PM;
    expect(await svc.tick()).toMatchObject({ sent: true });
    clock.now = new Date('2026-09-27T02:00:00Z'); // 22:00, same local day
    expect(await svc.tick()).toBeNull();
    expect(sent).toHaveLength(1);
    expect((await svc.getState()).lastSentAt).toBe(NINE_PM.toISOString());

    // An ask sent after the receipt (23:30) is in the NEXT one, not lost.
    requests.push(ticket(2, '2026-09-27T03:30:00Z', 'late evening ask'));
    clock.now = new Date('2026-09-28T01:00:00Z'); // next day 21:00
    const second = await svc.tick();
    expect(second && second.data.window).toMatchObject({ from: NINE_PM.toISOString(), basis: 'since_last_receipt' });
    expect(second?.data.askCount).toBe(1);
    expect(second?.text).toContain('late evening ask');
  });

  it('the owner can change the time and zone, or turn it off', async () => {
    const clock = { now: NINE_PM };
    const { svc, sent } = build({ requests: [ticket(1, '2026-09-26T15:00:00Z')], clock });
    expect(await svc.updateSettings({ enabled: false })).toMatchObject({ ok: true });
    expect(await svc.tick()).toBeNull();
    await svc.updateSettings({ enabled: true, time: '22:30' });
    expect(await svc.tick()).toBeNull(); // 21:00 < 22:30
    await svc.updateSettings({ timezone: 'America/Los_Angeles', time: '18:00' }); // 18:00 PDT = 21:00 EDT
    expect(await svc.tick()).toMatchObject({ sent: true });
    expect(sent).toHaveLength(1);
    expect(await svc.updateSettings({ time: 'nine' })).toMatchObject({ ok: false });
  });

  it('a failed send does not move the window', async () => {
    const clock = { now: NINE_PM };
    const { svc } = build({ requests: [ticket(1, '2026-09-26T15:00:00Z')], clock, sender: async () => false });
    expect(await svc.send()).toMatchObject({ sent: false, reason: 'sender_failed' });
    expect((await svc.getState()).lastSentAt).toBeUndefined();
    const throwing = build({ requests: [], clock, sender: async () => { throw new Error('slack down'); } });
    expect(await throwing.svc.send()).toMatchObject({ sent: false, reason: 'sender_failed' });
  });

  it('without a sender it still generates, and says why it did not send', async () => {
    const svc = new OwnerReceiptService({
      listRequests: async () => [],
      listWorkItems: async () => [],
      loadTeamIndex: async () => new Map(),
      statePath: null,
      now: () => NINE_PM,
    });
    expect(await svc.send()).toMatchObject({ sent: false, reason: 'no_sender' });
  });

  it('the text that is sent never carries a secret', async () => {
    const clock = { now: NINE_PM };
    const { svc, sent } = build({
      requests: [ticket(1, '2026-09-26T15:00:00Z', 'rotate key sk-ant-abcdefghijklmnopqrstuvwxyz0123 today')],
      clock,
    });
    await svc.send();
    expect(sent[0]).not.toContain('sk-ant-abcdef');
    expect(sent[0]).toContain('[REDACTED');
  });

  it('the final redaction catches what no field redaction sees (a team name from team config)', async () => {
    const svc = new OwnerReceiptService({
      listRequests: async () => [ticket(1, '2026-09-26T15:00:00Z')],
      listWorkItems: async () => [],
      // Team names are not redacted field by field; only the final pass covers them.
      loadTeamIndex: async () => new Map([['atlas', 'Team ghp_abcdefghijklmnopqrstuvwxyz123456']]),
      statePath: null,
      now: () => NINE_PM,
    });
    const { text } = await svc.generate();
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(text).toContain('[REDACTED github_token]');
  });

  it('persists settings and the last send to its state file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-receipt-'));
    try {
      const file = path.join(dir, 'owner-receipt.json');
      const clock = { now: NINE_PM };
      const { svc } = build({ requests: [ticket(1, '2026-09-26T15:00:00Z')], clock, statePath: file });
      await svc.updateSettings({ time: '20:00' });
      await svc.send();
      const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(onDisk).toMatchObject({ settings: { time: '20:00' }, lastSentAt: NINE_PM.toISOString(), lastSentLocalDate: '2026-09-26' });
      // A fresh service over the same file sees it.
      expect((await build({ requests: [], clock, statePath: file }).svc.getState()).settings.time).toBe('20:00');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a manual send and a tick at the same moment send once', async () => {
    const clock = { now: NINE_PM };
    const { svc, sent } = build({ requests: [ticket(1, '2026-09-26T15:00:00Z')], clock });
    const [manual, ticked] = await Promise.all([svc.send(), svc.tick()]);
    // The tick's due check runs after the manual send, sees today done, and does not send.
    expect(manual).toMatchObject({ sent: true });
    expect(ticked).toBeNull();
    expect(sent).toHaveLength(1);
    // Two ticks at once: one send.
    const again = build({ requests: [ticket(1, '2026-09-26T15:00:00Z')], clock });
    await Promise.all([again.svc.tick(), again.svc.tick()]);
    expect(again.sent).toHaveLength(1);
  });

  it('singleton accessors', () => {
    const { svc } = build({ requests: [], clock: { now: NINE_PM } });
    setOwnerReceiptService(svc);
    expect(getOwnerReceiptService()).toBe(svc);
    setOwnerReceiptService(null);
    expect(getOwnerReceiptService()).toBeNull();
  });
});
