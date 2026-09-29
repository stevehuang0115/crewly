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
 * A ticket created and finished at `at`, with the agent's answer.
 *
 * @param n - Ticket number
 * @param at - ISO creation (and completion) time
 * @param text - Description (the owner's words)
 * @param result - The agent's answer (default: an outcome line)
 * @returns Request
 */
function ticket(n: number, at: string, text = `ask ${n}`, result = `第 ${n} 份周报写好了，放在团队 wiki 里`): Request {
  return {
    ...createRequest({ sourceConversationItemId: `r${n}`, title: `t${n}`, description: text, ticketNumber: n }),
    createdAt: at,
    completedAt: at,
    assignee: 'atlas',
    status: 'done',
    result,
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
    expect(text).toBe('*Crewly 小票 · 9/26 周六*\n*今天做完的*\n• Think Tank：第 1 份周报写好了，放在团队 wiki 里');
  });

  it('sends nothing when nothing was done and nothing waits on the owner; the window still moves (2026-09-28)', async () => {
    const clock = { now: NINE_PM };
    const { svc, sent } = build({ requests: [ticket(1, '2026-09-25T15:00:00Z')], clock });
    const r = await svc.tick();
    expect(r).toMatchObject({ sent: false, reason: 'nothing_to_say', text: '' });
    expect(sent).toHaveLength(0);
    expect((await svc.getState())).toMatchObject({ lastSentAt: NINE_PM.toISOString(), lastSentLocalDate: '2026-09-26' });
    // Not retried every minute for the rest of the day.
    clock.now = new Date('2026-09-27T01:30:00Z');
    expect(await svc.tick()).toBeNull();
  });

  it('names who asks on a decision when loadAgentNameIndex is wired', async () => {
    const waiting: Request = {
      ...ticket(3, '2026-09-26T15:00:00Z', '帮我draft一封回信'),
      status: 'waiting_confirmation',
      requiresConfirmation: true,
      submittedAt: '2026-09-26T20:00:00Z',
      reply: { at: '2026-09-26T20:00:00Z', by: 'atlas', messageId: 'm', excerpt: '草稿好了。语气要再正式一点吗？' },
    };
    const svc = new OwnerReceiptService({
      listRequests: async () => [waiting],
      listWorkItems: async () => [],
      loadTeamIndex: async () => new Map([['atlas', 'Think Tank']]),
      loadAgentNameIndex: async () => new Map([['atlas', 'Atlas']]),
      statePath: null,
      now: () => NINE_PM,
    });
    const { text } = await svc.generate();
    expect(text).toBe('*Crewly 小票 · 9/26 周六*\n*需要你决定的*\n• Atlas：语气要再正式一点吗？');
  });

  it('keeps the team lead in the data when loadTeamLeadIndex is wired (the Slack text names teams only)', async () => {
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
    expect(text).toContain('• Think Tank：');
  });

  it('no lead shown when loadTeamLeadIndex is not wired at all (backward compatible)', async () => {
    const clock = { now: NINE_PM };
    const { svc } = build({ requests: [ticket(1, '2026-09-26T15:00:00Z')], clock });
    const { data, text } = await svc.generate();
    expect(data.teams[0]).toMatchObject({ team: 'Think Tank', lead: null });
    expect(text).toContain('• Think Tank：');
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
    requests.push(ticket(2, '2026-09-27T03:30:00Z', 'late evening ask', '深夜那件事也做完了，结果发在原来的对话里'));
    clock.now = new Date('2026-09-28T01:00:00Z'); // next day 21:00
    const second = await svc.tick();
    expect(second && second.data.window).toMatchObject({ from: NINE_PM.toISOString(), basis: 'since_last_receipt' });
    expect(second?.data.askCount).toBe(1);
    expect(second?.text).toContain('深夜那件事也做完了');
    // Never the owner's own words, never a ticket number.
    expect(second?.text).not.toContain('late evening ask');
    expect(second?.text).not.toMatch(/TKT-/);
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
    const throwing = build({ requests: [ticket(1, '2026-09-26T15:00:00Z')], clock, sender: async () => { throw new Error('slack down'); } });
    expect(await throwing.svc.send()).toMatchObject({ sent: false, reason: 'sender_failed' });
  });

  it('without a sender it still generates, and says why it did not send', async () => {
    const svc = new OwnerReceiptService({
      listRequests: async () => [ticket(1, '2026-09-26T15:00:00Z')],
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
      requests: [ticket(1, '2026-09-26T15:00:00Z', 'rotate the key', '换好了新的 key sk-ant-abcdefghijklmnopqrstuvwxyz0123 已经生效')],
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
