import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OWNER_MESSAGE_WATCHDOG_CONSTANTS as C } from '../../constants.js';
import {
  OwnerMessageWatchdogService,
  isAcknowledgement,
  ownerMessageKey,
  type NudgeOutcome,
  type OwnerMessageEntry,
  type OwnerMessageTrackInput,
  type OwnerMessageWatchdogDeps,
} from './owner-message-watchdog.service.js';

const MIN = 60 * 1000;

function slackInput(over: Partial<OwnerMessageTrackInput> = {}): OwnerMessageTrackInput {
  return {
    surface: 'slack',
    slackChannelId: 'D0OWNER',
    threadTs: '1790000000.000100',
    sourceTs: '1790000000.000100',
    chatChannelId: 'chan-ella',
    responsible: 'ella',
    recipients: ['ella'],
    required: true,
    text: 'Can you update the EFT sheet?',
    ...over,
  };
}

function chatInput(over: Partial<OwnerMessageTrackInput> = {}): OwnerMessageTrackInput {
  return {
    surface: 'chat',
    chatChannelId: 'chan-portal',
    messageId: 'msg-1',
    responsible: 'ella',
    recipients: ['ella'],
    required: true,
    text: 'What is the status of the report?',
    ...over,
  };
}

interface Harness {
  service: OwnerMessageWatchdogService;
  clock: { t: number };
  nudges: Array<{ entry: OwnerMessageEntry; waited: number }>;
  notes: Array<{ entry: OwnerMessageEntry; text: string }>;
  busy: Set<string>;
  placeholder: { visible: boolean };
  login: Map<string, { runtime: string; runtimeCmd: string }>;
  nudgeOutcome: { value: NudgeOutcome };
}

function makeHarness(over: Partial<OwnerMessageWatchdogDeps> = {}, clockStart = 1_000_000): Harness {
  const clock = { t: clockStart };
  const nudges: Harness['nudges'] = [];
  const notes: Harness['notes'] = [];
  const busy = new Set<string>();
  const placeholder = { visible: false };
  const login = new Map<string, { runtime: string; runtimeCmd: string }>();
  const nudgeOutcome: Harness['nudgeOutcome'] = { value: { outcome: 'sent' } };
  const service = new OwnerMessageWatchdogService({
    isBusy: (s) => busy.has(s),
    hasVisiblePlaceholder: () => placeholder.visible,
    nudge: async (entry, waited) => {
      nudges.push({ entry: { ...entry }, waited });
      return nudgeOutcome.value;
    },
    postNote: async (entry, text) => {
      notes.push({ entry: { ...entry }, text });
      return true;
    },
    loginRequired: (s) => login.get(s) ?? null,
    displayNameOf: (s) => (s === 'ella' ? 'Ella' : s),
    now: () => clock.t,
    ...over,
  });
  return { service, clock, nudges, notes, busy, placeholder, login, nudgeOutcome };
}

describe('isAcknowledgement', () => {
  it.each(['好', '好的', 'ok', 'OK!', '👍', '谢谢', '谢谢！', 'thanks', 'Thank you.', '  嗯嗯 '])('treats "%s" as an ack', (t) => {
    expect(isAcknowledgement(t)).toBe(true);
  });

  it.each(['可以', '行', '好的，顺便把表也发我', 'ok but why?', '帮我查一下', '👍 then do the next one'])(
    'does not treat "%s" as an ack',
    (t) => {
      expect(isAcknowledgement(t)).toBe(false);
    },
  );
});

describe('ownerMessageKey', () => {
  it('keys slack by channel + message ts and chat by channel + message id', () => {
    expect(ownerMessageKey(slackInput())).toBe('slack:D0OWNER:1790000000.000100');
    expect(ownerMessageKey(chatInput())).toBe('chat:chan-portal:msg-1');
    expect(ownerMessageKey({ surface: 'chat', chatChannelId: 'c' })).toBeNull();
  });
});

describe('OwnerMessageWatchdogService', () => {
  describe('tracking', () => {
    it('does not track acknowledgements', () => {
      const h = makeHarness();
      expect(h.service.track(slackInput({ text: '好的' }))).toBeNull();
      expect(h.service.size).toBe(0);
    });

    it('dedupes: a second delivery of the same message updates the one entry', () => {
      const h = makeHarness();
      h.service.track(slackInput({ responsible: 'orc-router', recipients: ['orc-router'], required: false }));
      h.service.track(slackInput({ responsible: 'ella', recipients: ['ella'], required: true }));
      expect(h.service.size).toBe(1);
      const [row] = h.service.list();
      expect(row.responsible).toBe('ella');
      expect(row.required).toBe(true);
      expect(row.recipients).toEqual(expect.arrayContaining(['orc-router', 'ella']));
    });

    it('an answer that beat the tracking call (fast agent, slow co-recipient) counts', () => {
      const h = makeHarness();
      const receivedAt = h.clock.t;
      h.clock.t += 20 * 1000;
      h.service.noteSlackAnswer('D0OWNER', '1790000000.000100', 'post');
      h.clock.t += 90 * 1000; // dispatch returns after a cold start elsewhere
      expect(h.service.track(slackInput({ receivedAt }))).toBeNull();
      expect(h.service.size).toBe(0);
    });

    it('an answer from before the message (to an earlier question in the thread) does not count', () => {
      const h = makeHarness();
      h.service.noteChatAnswer('chan-portal', null, false);
      h.clock.t += 1000;
      expect(h.service.track(chatInput({ receivedAt: h.clock.t }))).not.toBeNull();
    });

    it('never re-tracks a message that was already answered', () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.service.noteSlackAnswer('D0OWNER', '1790000000.000100', 'test');
      expect(h.service.track(slackInput())).toBeNull();
      expect(h.service.size).toBe(0);
    });
  });

  describe('timeline', () => {
    it('reply in time → cleared, no nudge, no note', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.clock.t += 5 * MIN;
      h.service.noteSlackAnswer('D0OWNER', '1790000000.000100', 'post');
      h.clock.t += 30 * MIN;
      await h.service.tick();
      expect(h.nudges).toHaveLength(0);
      expect(h.notes).toHaveLength(0);
      expect(h.service.size).toBe(0);
    });

    it('an answer in another thread of the same DM does not clear it', () => {
      const h = makeHarness();
      h.service.track(slackInput());
      expect(h.service.noteSlackAnswer('D0OWNER', '1790000099.000100', 'post')).toBe(0);
      expect(h.service.noteSlackAnswer('D0OWNER', undefined, 'top-level')).toBe(0);
      expect(h.service.size).toBe(1);
    });

    it('no reply → nudge at T1 → one note at T2', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS - 1;
      await h.service.tick();
      expect(h.nudges).toHaveLength(0);

      h.clock.t += 1;
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
      expect(h.nudges[0].waited).toBe(C.NUDGE_AFTER_MS / MIN);
      expect(h.notes).toHaveLength(0);

      h.clock.t = 1_000_000 + C.NOTE_AFTER_MS;
      await h.service.tick();
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].text).toContain('Ella');
      expect(h.notes[0].text).toContain("I've sent a reminder");
      expect(h.service.size).toBe(0);

      // Nothing more, ever.
      h.clock.t += 60 * MIN;
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
      expect(h.notes).toHaveLength(1);
    });

    it('an answer after the nudge but before T2 clears it (no note)', async () => {
      const h = makeHarness();
      h.service.track(chatInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
      h.service.noteChatAnswer('chan-portal', null, false);
      h.clock.t += 30 * MIN;
      await h.service.tick();
      expect(h.notes).toHaveLength(0);
    });

    it('a late nudge still gets MIN_NOTE_GAP_AFTER_NUDGE_MS before the note', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.busy.add('ella');
      h.placeholder.visible = true;
      h.clock.t += 30 * MIN; // extended while visibly working
      await h.service.tick();
      expect(h.nudges).toHaveLength(0);
      h.busy.delete('ella'); // turn ended, still no answer
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
      h.clock.t += C.MIN_NOTE_GAP_AFTER_NUDGE_MS - 1;
      await h.service.tick();
      expect(h.notes).toHaveLength(0);
      h.clock.t += 1;
      await h.service.tick();
      expect(h.notes).toHaveLength(1);
    });

    it('busy with a visible placeholder → extended instead of nagged, then a note at the cap', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.busy.add('ella');
      h.placeholder.visible = true;
      for (const m of [10, 20, 40, 59]) {
        h.clock.t = 1_000_000 + m * MIN;
        await h.service.tick();
      }
      expect(h.nudges).toHaveLength(0);
      expect(h.notes).toHaveLength(0);
      h.clock.t = 1_000_000 + C.BUSY_EXTEND_CAP_MS;
      await h.service.tick();
      expect(h.nudges).toHaveLength(0);
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].text).toContain('is still working on your message');
    });

    it('a placeholder showing while the agent is idle is not "working": nudged at T1', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.placeholder.visible = true;
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
    });

    it('chat: an interim note counts as a visible placeholder while the agent is busy', async () => {
      const h = makeHarness();
      h.service.track(chatInput());
      h.service.noteChatAnswer('chan-portal', null, true);
      h.busy.add('ella');
      h.clock.t += 25 * MIN;
      await h.service.tick();
      expect(h.nudges).toHaveLength(0);
      expect(h.notes).toHaveLength(0);
      expect(h.service.size).toBe(1);
    });

    it('huddle chat answers must be in the message thread', () => {
      const h = makeHarness();
      h.service.track(chatInput({ chatChannelId: 'huddle-1', messageId: 'root-1', chatThreadId: 'root-1' }));
      expect(h.service.noteChatAnswer('huddle-1', 'other-root', false)).toBe(0);
      expect(h.service.noteChatAnswer('huddle-1', null, false)).toBe(0);
      expect(h.service.noteChatAnswer('huddle-1', 'root-1', false)).toBe(1);
    });

    it('a nudge that cannot reach the agent → note at once, with the reason', async () => {
      const h = makeHarness();
      h.nudgeOutcome.value = { outcome: 'blocked', reason: 'asleep', detail: 'No team member found' };
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].text).toContain("isn't running");
      expect(h.notes[0].text).toContain('No team member found');
      expect(h.service.size).toBe(0);
    });

    // specs/2026-10-02-spend-cap.md: a capped agent starts no new turn, so a
    // nudge would only queue again — the owner is told why instead.
    it('daily token cap → no nudge, one note naming the cap and how to boost it', async () => {
      const h = makeHarness({ spendCapped: (s) => (s === 'ella' ? { capTokens: 5_000_000, scope: 'agent' } : null) });
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      expect(h.nudges).toHaveLength(0);
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].text).toBe(
        '⏳ Still waiting on Ella — Ella hit its daily token cap (5M tokens). Your message is kept and delivered when the cap resets at midnight or you boost it (reply `boost Ella by 10M today` or `unlimited today for Ella`).',
      );
      expect(h.notes[0].text).not.toMatch(/[\u4e00-\u9fff]/);
      expect(h.service.size).toBe(0);
    });

    it('daily token cap on the orc → the note says "orc" in the boost command', async () => {
      const h = makeHarness({ spendCapped: () => ({ capTokens: 2_500_000, scope: 'team', teamName: 'CE' }) });
      h.service.track(slackInput({ responsible: 'crewly-orc', recipients: ['crewly-orc'] }));
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      expect(h.notes[0].text).toContain('crewly-orc hit its daily token cap (2.5M tokens for team CE)');
      expect(h.notes[0].text).toContain('`boost orc by 10M today`');
    });

    it('login required → no nudge, one note with the one-tap fix, and the message is kept (not dropped)', async () => {
      const h = makeHarness();
      h.login.set('ella', { runtime: 'Claude', runtimeCmd: 'claude' });
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      expect(h.nudges).toHaveLength(0);
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].text).toBe(
        "⏳ Still waiting on Ella — Claude on this machine is signed out. Reply `login` here to sign in from your phone (or `relogin claude`); your message is kept and re-delivered once it's signed in.",
      );
      expect(h.service.size).toBe(1);
      expect(h.service.list()[0].stage).toBe('login_wait');

      // Hours later, still signed out: no second note, still kept.
      h.clock.t += 7 * 60 * 60 * 1000;
      await h.service.tick();
      expect(h.notes).toHaveLength(1);
      expect(h.nudges).toHaveLength(0);
      expect(h.service.size).toBe(1);
    });

    it('re-delivers a parked message when the login is back (resumeAfterLogin), then follows the normal timeline', async () => {
      const h = makeHarness();
      h.login.set('ella', { runtime: 'Claude', runtimeCmd: 'claude' });
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      h.login.delete('ella');
      // A different runtime's login does not release it.
      expect(await h.service.resumeAfterLogin({ runtimeCmd: 'codex' })).toBe(0);
      expect(await h.service.resumeAfterLogin({ runtimeCmd: 'claude', sessions: ['ella'] })).toBe(1);
      expect(h.nudges).toHaveLength(1);
      expect(h.service.list()[0].stage).toBe('nudged');
      // The agent answers: the entry clears.
      h.service.noteSlackAnswer('D0OWNER', '1790000000.000100', 'post');
      expect(h.service.size).toBe(0);
    });

    it('a parked message goes on by itself once its agent no longer needs a sign-in', async () => {
      const h = makeHarness();
      h.login.set('ella', { runtime: 'Claude', runtimeCmd: 'claude' });
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      h.login.delete('ella');
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
    });

    it('drops a parked message after LOGIN_WAIT_DROP_MS', async () => {
      const h = makeHarness();
      h.login.set('ella', { runtime: 'Claude', runtimeCmd: 'claude' });
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      h.clock.t += C.LOGIN_WAIT_DROP_MS;
      await h.service.tick();
      expect(h.service.size).toBe(0);
    });

    it('notes are English (owner-facing UI is English-first)', async () => {
      const h = makeHarness();
      h.nudgeOutcome.value = { outcome: 'blocked', reason: 'error' };
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].text).toContain('reason unknown');
      expect(h.notes[0].text).not.toMatch(/[\u4e00-\u9fff]/);
      for (const key of ['NOTE_LOGIN_TEXT', 'NOTE_ASLEEP_TEXT', 'NOTE_ERROR_TEXT', 'NOTE_BUSY_CAP_TEXT', 'NOTE_SILENT_TEXT', 'NOTE_UNKNOWN_DETAIL', 'NOTE_SPEND_CAP_TEXT'] as const) {
        expect(C[key]).not.toMatch(/[\u4e00-\u9fff]/);
      }
    });

    it('optional-only message: nudged agent finishing a turn without answering closes it quietly', async () => {
      const h = makeHarness();
      h.service.track(slackInput({ required: false, responsible: 'lead', recipients: ['lead', 'ella'] }));
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
      h.service.noteAgentTurn('lead', true);
      h.service.noteAgentTurn('lead', false);
      h.clock.t += 30 * MIN;
      await h.service.tick();
      expect(h.notes).toHaveLength(0);
      expect(h.service.size).toBe(0);
    });

    it('required message: the nudged agent ending its turn silently still gets the note', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.clock.t += C.NUDGE_AFTER_MS;
      await h.service.tick();
      h.service.noteAgentTurn('ella', true);
      h.service.noteAgentTurn('ella', false);
      h.clock.t = 1_000_000 + C.NOTE_AFTER_MS;
      await h.service.tick();
      expect(h.notes).toHaveLength(1);
    });
  });

  // crewly#1015 §2: the in-process orc failed ~80 turns ("No output
  // generated", out of credit); the owner's messages were dropped, and the
  // only sign was a "hasn't replied" note that then stopped tracking.
  describe('failed turns', () => {
    it('tells the owner once with the reason, keeps the message, and re-delivers it on a timer', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.clock.t += 2 * MIN;
      expect(await h.service.noteTurnFailed('ella', 'the model account is out of credit')).toBe(1);
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].text).toBe(
        "⚠️ Ella couldn't answer your message — its run failed (the model account is out of credit). Your message is kept and delivered again once Ella is working.",
      );
      // A second failure: no second note.
      await h.service.noteTurnFailed('ella', 'the model account is out of credit');
      expect(h.notes).toHaveLength(1);
      // No "hasn't replied" note while parked; re-delivered after FAILED_RETRY_MS.
      h.clock.t += C.NOTE_AFTER_MS;
      await h.service.tick();
      expect(h.notes).toHaveLength(1);
      expect(h.nudges).toHaveLength(0);
      h.clock.t += C.FAILED_RETRY_MS;
      await h.service.tick();
      expect(h.nudges).toHaveLength(1);
      expect(h.service.list()[0].stage).toBe('nudged');
    });

    it('re-delivers at once when the agent completes a turn again', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      await h.service.noteTurnFailed('ella', 'the model run failed');
      expect(await h.service.resumeAfterRecovery('ella')).toBe(1);
      expect(h.nudges).toHaveLength(1);
      expect(await h.service.resumeAfterRecovery('ella')).toBe(0);
    });

    it('leaves other agents and sign-in waits alone; drops after a day', async () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.service.track(slackInput({ sourceTs: '2.2', threadTs: '2.2', responsible: 'owen', recipients: ['owen'] }));
      expect(await h.service.noteTurnFailed('ella', 'x')).toBe(1);
      expect(h.service.list().find((e) => e.responsible === 'owen')?.stage).toBe('waiting');
      h.clock.t += C.LOGIN_WAIT_DROP_MS + MIN;
      await h.service.tick();
      expect(h.service.list().find((e) => e.responsible === 'ella')).toBeUndefined();
    });
  });

  describe('closing', () => {
    it('reply --none by the responsible agent closes; a mere recipient cannot', () => {
      const h = makeHarness();
      h.service.track(slackInput({ recipients: ['ella', 'owen'] }));
      expect(h.service.closeByAgent('owen', { chatChannelId: 'chan-ella' })).toBe(0);
      expect(h.service.closeByAgent('ella', { chatChannelId: 'chan-ella' })).toBe(1);
      expect(h.service.size).toBe(0);
    });

    it('owedBy lists what an agent holds, oldest first', () => {
      const h = makeHarness();
      h.service.track(chatInput({ messageId: 'a' }));
      h.clock.t += 1000;
      h.service.track(chatInput({ messageId: 'b', responsible: 'owen', recipients: ['owen', 'ella'] }));
      expect(h.service.owedBy('ella').map((e) => e.messageId)).toEqual(['a', 'b']);
      expect(h.service.owedBy('owen').map((e) => e.messageId)).toEqual(['b']);
    });
  });

  describe('restart persistence', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'owner-watchdog-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('restores open messages and resumes the timeline; answered keys stay deduped', async () => {
      const storePath = path.join(dir, C.STORE_FILENAME);
      const first = makeHarness({ storePath });
      first.service.track(slackInput());
      first.service.track(chatInput());
      first.service.noteChatAnswer('chan-portal', null, false);
      first.clock.t += C.NUDGE_AFTER_MS;
      await first.service.tick();
      expect(first.nudges).toHaveLength(1);
      expect(existsSync(storePath)).toBe(true);
      expect(JSON.parse(readFileSync(storePath, 'utf8')).entries).toHaveLength(1);

      const second = makeHarness({ storePath }, first.clock.t);
      expect(second.service.size).toBe(1);
      expect(second.service.list()[0].stage).toBe('nudged');
      expect(second.service.track(chatInput())).toBeNull(); // answered before the restart
      second.clock.t = 1_000_000 + C.NOTE_AFTER_MS;
      await second.service.tick();
      expect(second.nudges).toHaveLength(0); // no second nudge after the restart
      expect(second.notes).toHaveLength(1);
    });

    it('drops messages restored after a long downtime without a note', async () => {
      const storePath = path.join(dir, C.STORE_FILENAME);
      const first = makeHarness({ storePath });
      first.service.track(slackInput());
      const second = makeHarness({ storePath }, first.clock.t + C.STALE_DROP_MS + 1);
      await second.service.tick();
      expect(second.notes).toHaveLength(0);
      expect(second.nudges).toHaveLength(0);
      expect(second.service.size).toBe(0);
    });
  });

  describe('list', () => {
    it('reports where, who, age and stage', () => {
      const h = makeHarness();
      h.service.track(slackInput());
      h.clock.t += 3 * MIN;
      expect(h.service.list()).toEqual([
        expect.objectContaining({
          key: 'slack:D0OWNER:1790000000.000100',
          where: 'D0OWNER:1790000000.000100',
          responsible: 'ella',
          ageMinutes: 3,
          stage: 'waiting',
          preview: 'Can you update the EFT sheet?',
        }),
      ]);
    });
  });
});
