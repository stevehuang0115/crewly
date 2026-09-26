/**
 * Replay (#828): the owner's real Slack messages of 2026-09-26 (Ava's window,
 * 0:00–14:00 EDT) → ticket intake (#827) → the receipt data layer.
 *
 * Compared with Ava's hand-made receipt (`.crewly/research/2026-09-26-owner-receipt/detail.md`:
 * 43 messages → 31 asks). The count is reported, not forced to match; the
 * reasons for the difference are pinned below.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TicketIntakeService, type IntakeMessage, type TicketRequestStore } from '../ticket-intake.service.js';
import { createRequest, isValidRequestTransition, type CreateRequestInput, type Request, type UpdateRequestInput } from '../../../types/v2/request.types.js';
import { buildReceiptData } from './owner-receipt-data.js';
import { renderReceiptSlack } from './owner-receipt.renderer.js';

interface FixtureMessage { at: string; owner: boolean; text: string }
interface FixtureThread { channel: string; thread: string; messages: FixtureMessage[] }

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'owner-receipt.replay-2026-09-26.fixture.json'), 'utf8'),
) as { threads: FixtureThread[] };

/** Who a message went to: the agent mentioned, else the channel's agent. */
const MENTION: Record<string, string> = {
  U0C2ZK849ND: 'atlas',
  U0C30GRCPT4: 'ella',
  U0C45AW5G80: 'personal-assistant',
  U0C3D68441F: 'sam',
  U0C3LHD5SG7: 'rex',
};
const CHANNEL_AGENT: Record<string, string> = {
  C0C2Y1FRCP7: 'owen',
  C0C2QCGE9K9: 'atlas',
  C0C46TTBNNP: 'ella',
  C0C2WMFB9EF: 'ella',
  D0AC7NF5N7L: 'crewly-orc',
};
const TEAM: Record<string, string> = {
  owen: 'CE',
  atlas: 'Think Tank',
  ella: 'Crewly Marketing',
  rex: 'Crewly Marketing',
  sam: 'Crewly Product',
  'personal-assistant': 'Personal Assistant',
  'crewly-orc': 'Orchestrator',
};

/** In-memory Request store that stamps each ticket with the message's time. */
class ReplayStore implements TicketRequestStore {
  readonly items = new Map<string, Request>();
  clock = '';
  constructor(private readonly dir: string) {}
  async create(input: CreateRequestInput): Promise<Request> {
    const r = { ...createRequest({ ...input, intentLevel: input.intentLevel ?? 'L1', intentCategory: input.intentCategory ?? 'other' }), createdAt: this.clock, updatedAt: this.clock };
    this.items.set(r.id, r);
    return { ...r };
  }
  async getById(id: string): Promise<Request | null> {
    const r = this.items.get(id);
    return r ? { ...r } : null;
  }
  async listAll(): Promise<Request[]> {
    return [...this.items.values()].map((r) => ({ ...r })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (b.ticketNumber ?? 0) - (a.ticketNumber ?? 0));
  }
  async update(id: string, updates: UpdateRequestInput): Promise<Request> {
    const r = this.items.get(id);
    if (!r) throw new Error(`Request not found: ${id}`);
    if (updates.status && updates.status !== r.status && !isValidRequestTransition(r.status, updates.status)) throw new Error('bad transition');
    const next = { ...r, ...updates } as Request;
    this.items.set(id, next);
    return { ...next };
  }
  getRequestsDir(): string {
    return this.dir;
  }
}

describe('replay — 2026-09-26, the owner\'s real messages → tickets → receipt', () => {
  it('turns 43 messages into one receipt line per ticket; reports the ask count against Ava\'s 31', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-replay-'));
    try {
      const store = new ReplayStore(dir);
      const intake = new TicketIntakeService({ requests: store });
      const all = FIXTURE.threads
        .flatMap((t) => t.messages.map((m, i) => ({ ...m, channel: t.channel, thread: t.thread, i })))
        .sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i);
      let owners = 0;
      const created: string[] = [];
      const seenKey = new Set<string>();
      for (const m of all) {
        if (m.owner) owners += 1;
        const mention = /<@([A-Z0-9]+)>/.exec(m.text)?.[1];
        const message: IntakeMessage = {
          text: m.text,
          isOwner: m.owner,
          origin: {
            channel: m.channel.startsWith('D') ? 'slack-dm' : 'slack-channel',
            ref: `slack-${m.channel}-${m.thread}-${m.i}`,
            threadRef: `slack:${m.channel}:${m.thread}`,
            author: m.owner ? 'owner' : 'agent',
          },
          conversationRef: `slack:${m.channel}`,
          targetAgent: (mention && MENTION[mention]) || CHANNEL_AGENT[m.channel],
          ...(/\[Slack File:/.test(m.text) ? { attachments: [{ name: 'file' }] } : {}),
        };
        store.clock = m.at;
        const outcome = await intake.intakeWithOutcome(message);
        const key = `${m.thread}@${m.at.slice(11, 16)}`;
        const firstAtKey = !seenKey.has(key);
        if (m.owner) seenKey.add(key);
        if (m.owner && firstAtKey && (outcome.action === 'created' || outcome.action === 'created_in_thread')) created.push(key);
        if (m.owner && process.env.REPLAY_TRACE) {
          // eslint-disable-next-line no-console
          console.log(`TRACE ${m.at.slice(11, 16)}Z ${m.channel.slice(-4)}/${m.thread.slice(-6)} ${outcome.action}${outcome.action === 'ignored' ? `:${outcome.reason}` : ''} | ${m.text.replace(/\n/g, ' ⏎ ').slice(0, 70)}`);
        }
      }

      const data = buildReceiptData({
        requests: await store.listAll(),
        workItems: [],
        window: { from: '2026-09-26T04:00:00.000Z', to: '2026-09-26T18:00:00.000Z', basis: 'explicit', timezone: 'America/New_York' },
        teamOf: (s) => TEAM[s] ?? null,
        now: new Date('2026-09-26T18:00:00Z'),
      });
      const ids = data.teams.flatMap((t) => t.asks.map((a) => a.ticketId));
      const perTeam = Object.fromEntries(data.teams.map((t) => [t.team, t.asks.length]));

      // Examined: the same 43 owner messages Ava classified.
      expect(owners).toBe(43);
      // Every ticket created in the window is on the receipt exactly once.
      expect(ids).toHaveLength(store.items.size);
      expect(new Set(ids).size).toBe(ids.length);
      expect(data.askCount).toBe(store.items.size);

      // Against Ava's own classification (detail.md §3): 25 of the 43
      // messages open an ask; 4 of them carry several, giving 31.
      const avaSet = new Set(AVA_ASK_MESSAGES);
      const falseTickets = created.filter((k) => !avaSet.has(k));
      const missed = AVA_ASK_MESSAGES.filter((k) => !created.includes(k));
      // eslint-disable-next-line no-console
      console.log(
        `[replay 2026-09-26] owner messages 43 → tickets ${data.askCount} (Ava: 31 asks from 25 messages); ` +
          `tickets that are Ava asks ${created.length - falseTickets.length}/${created.length}; ` +
          `Ava ask-messages ticketed ${AVA_ASK_MESSAGES.length - missed.length}/${AVA_ASK_MESSAGES.length}; by team ${JSON.stringify(perTeam)}`,
      );
      expect(AVA_ASK_MESSAGES).toHaveLength(25);
      // Precision: every ticket the replay opened is one of Ava's asks.
      expect(falseTickets).toEqual([]);
      // Recall, pinned: the 12 missed messages are listed in AVA_MISSED with why.
      expect(missed.sort()).toEqual(Object.keys(AVA_MISSED).sort());
      // 31 = 13 tickets + 12 missed messages + 6 from Ava splitting 4 messages.
      expect(data.askCount).toBe(REPLAY_ASKS);
      expect(REPLAY_ASKS + missed.length + AVA_MULTI_ASK_EXTRA).toBe(31);
      expect(renderReceiptSlack(data)).toContain(`你提了 *${REPLAY_ASKS} 件事*`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The replay's ask count today (pinned so a change is visible; see the test). */
const REPLAY_ASKS = 13;

/**
 * The 25 messages Ava counts as opening an ask (detail.md §3), as
 * `<thread ts>@<HH:MM UTC>` (EDT + 4h). Where two owner messages share a
 * minute in a thread, the first is meant.
 */
const AVA_ASK_MESSAGES = [
  '1790393955.772969@04:02', '1790395573.810609@04:06', '1790396208.076299@04:16', '1790396208.076299@12:13',
  '1790396208.076299@12:22', '1790425131.498609@12:27', '1790395573.810609@12:28', '1790425131.498609@12:38',
  '1790369526.643189@14:29', '1790369526.643189@14:34', '1790425131.498609@14:35', '1790425131.498609@14:36',
  '1790396208.076299@14:37', '1790371564.426649@14:39', '1790369526.643189@14:47', '1790425131.498609@14:50',
  '1790425131.498609@14:52', '1790396208.076299@14:53', '1790425131.498609@14:59', '1790425131.498609@15:03',
  '1790369526.643189@15:21', '1790425131.498609@17:20', '1790396208.076299@17:23', '1790369526.643189@17:36',
  '1790425131.498609@17:37',
];

/** Ava split 4 messages into several asks (08:13 → 2, 08:27 → 2, 10:50 → 4, 13:23 → 2): +6 asks. */
const AVA_MULTI_ASK_EXTRA = 6;

/** Ava's ask-messages the replay did not ticket, and why (#827 design, not a data gap). */
const AVA_MISSED: Record<string, string> = {
  '1790393955.772969@04:02': '「登陆了 再试试看」: its thread\'s ticket predates the window, so it is top level here and reads as a query',
  '1790396208.076299@12:13': 'numbered reply to the agent\'s list (1. 修 2. …搜索一下吗) — a follow-up by #827\'s rule',
  '1790396208.076299@12:22': 'answers the agent (第一个可以发 / rfe那个可以写)',
  '1790395573.810609@12:28': 'answers the agent (好的 主要是负责…)',
  '1790369526.643189@14:34': 'long spoken discussion on topic A',
  '1790425131.498609@14:35': 'approves the agent\'s proposal (好的 开issue可以的)',
  '1790396208.076299@14:37': 'suggestion on the current work (要不发到文章上给我preview看看)',
  '1790369526.643189@14:47': 'long spoken discussion on topic A',
  '1790396208.076299@14:53': 'feedback on the current work (整体看可以 但是少了一些…)',
  '1790425131.498609@15:03': 'clarification (我只是想着和orca对比而已)',
  '1790369526.643189@15:21': 'long spoken discussion on topic A',
  '1790369526.643189@17:36': 'feedback on the current draft (基本上可以，但是还可以再斟酌打磨)',
};
