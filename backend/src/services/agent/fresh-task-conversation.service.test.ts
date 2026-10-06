/**
 * Tests for FreshTaskConversationService — fresh Claude Code conversation per
 * new task, with the old one saved first.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FreshTaskConversationService,
  isFreshTaskAgentBusy,
  contextCapReorientation,
  decideContextCap,
  memberContextCapTokens,
  decideFreshConversation,
  freshConversationNote,
  freshTaskConversationEnvEnabled,
  rootWorkItemId,
  type FreshTaskDeps,
  type FreshTaskDecisionInput,
  type ContextCapDecisionInput,
} from './fresh-task-conversation.service.js';
import { claudeTranscriptPath } from './runtime-session-recovery.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { STANDING_ANSWERS_CONSTANTS } from '../../constants.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    }),
  },
}));

const SESSION = 'team-leo-1234';
const CWD = '/work/project';
const OLD_ID = 'old-conversation-id';

describe('rootWorkItemId', () => {
  it('strips retry / verify / review suffixes', () => {
    expect(rootWorkItemId('abc')).toBe('abc');
    expect(rootWorkItemId('abc:retry:2')).toBe('abc');
    expect(rootWorkItemId('abc:verify:abc')).toBe('abc');
    expect(rootWorkItemId('abc:review:max_retries')).toBe('abc');
    expect(rootWorkItemId('abc:retry:1:retry:2')).toBe('abc');
    expect(rootWorkItemId('abc:retry:1:verify:abc:retry:1')).toBe('abc');
  });
  it('leaves unrelated colons alone', () => {
    expect(rootWorkItemId('request:r1:respond_to_user')).toBe('request:r1:respond_to_user');
  });
});

describe('freshTaskConversationEnvEnabled', () => {
  it('defaults on; 0/false/off disable', () => {
    expect(freshTaskConversationEnvEnabled({})).toBe(true);
    expect(freshTaskConversationEnvEnabled({ CREWLY_FRESH_TASK_CONVERSATION: '1' })).toBe(true);
    for (const v of ['0', 'false', 'OFF', 'no']) {
      expect(freshTaskConversationEnvEnabled({ CREWLY_FRESH_TASK_CONVERSATION: v })).toBe(false);
    }
  });
});

describe('decideFreshConversation', () => {
  const base: FreshTaskDecisionInput = {
    sessionName: SESSION,
    runtimeType: 'claude-code',
    previousRoot: 'task-a',
    newRoot: 'task-b',
    enabled: true,
    busy: false,
    recentDelivery: false,
    otherActiveRoots: [],
  };
  it('clears for an idle Claude Code member on a different root', () => {
    expect(decideFreshConversation(base)).toEqual({ clear: true, reason: 'new task' });
  });
  it.each([
    ['orchestrator', { sessionName: 'crewly-orc' }],
    ['not claude-code', { runtimeType: 'codex-cli' }],
    ['disabled', { enabled: false }],
    ['first task', { previousRoot: null }],
    ['same task', { newRoot: 'task-a' }],
    ['busy', { busy: true }],
    ['recent delivery', { recentDelivery: true }],
    ['already working on it', { alreadyStarted: true }],
    ['other work in progress', { otherActiveRoots: ['task-c'] }],
  ])('does not clear: %s', (reason, override) => {
    expect(decideFreshConversation({ ...base, ...(override as Partial<FreshTaskDecisionInput>) })).toEqual({ clear: false, reason });
  });
  it('active work with the new root itself does not block', () => {
    expect(decideFreshConversation({ ...base, otherActiveRoots: ['task-b'] }).clear).toBe(true);
  });
});

describe('memberContextCapTokens', () => {
  it('defaults to 200k; 0 disables; junk falls back to the default', () => {
    expect(memberContextCapTokens({})).toBe(200_000);
    expect(memberContextCapTokens({ CREWLY_MEMBER_CONTEXT_CAP_TOKENS: '250000' })).toBe(250_000);
    expect(memberContextCapTokens({ CREWLY_MEMBER_CONTEXT_CAP_TOKENS: '0' })).toBe(0);
    expect(memberContextCapTokens({ CREWLY_MEMBER_CONTEXT_CAP_TOKENS: 'lots' })).toBe(200_000);
    expect(memberContextCapTokens({ CREWLY_MEMBER_CONTEXT_CAP_TOKENS: '-5' })).toBe(200_000);
  });
});

describe('decideContextCap', () => {
  const base: ContextCapDecisionInput = {
    sessionName: SESSION,
    runtimeType: 'claude-code',
    capTokens: 300_000,
    enabled: true,
    contextTokens: 650_000,
    busy: false,
    quietMs: 60_000,
    deliveryActive: false,
    queuedMessages: false,
    lastCapAt: null,
    now: 10_000_000,
    activeWorkItemId: 'wi-1',
  };
  it('caps an idle Claude Code member over the cap that is on a WorkItem', () => {
    expect(decideContextCap(base)).toEqual({ clear: true, reason: 'context over cap' });
  });
  it.each([
    ['orchestrator', { sessionName: 'crewly-orc' }],
    ['not claude-code', { runtimeType: 'codex-cli' }],
    ['cap off', { capTokens: 0 }],
    ['disabled', { enabled: false }],
    ['under cap', { contextTokens: 300_000 }],
    ['under cap', { contextTokens: null }],
    ['rate limited', { lastCapAt: 10_000_000 - 19 * 60_000 }],
    ['busy', { busy: true }],
    ['not quiet long enough', { quietMs: 5_000 }],
    ['not quiet long enough', { quietMs: null }],
    ['delivery in progress', { deliveryActive: true }],
    ['messages queued', { queuedMessages: true }],
  ])('%s: no cap', (reason, override) => {
    expect(decideContextCap({ ...base, ...(override as Partial<ContextCapDecisionInput>) })).toEqual({ clear: false, reason });
  });
  it('caps a member working from chat with no WorkItem too', () => {
    expect(decideContextCap({ ...base, activeWorkItemId: null })).toEqual({ clear: true, reason: 'context over cap' });
  });
  it('the rate limit lapses after 20 minutes', () => {
    expect(decideContextCap({ ...base, lastCapAt: 10_000_000 - 20 * 60_000 }).clear).toBe(true);
  });
});

describe('contextCapReorientation', () => {
  it('is one tagged line carrying the WorkItem id, its title and the handover path', () => {
    const line = contextCapReorientation({
      workItem: { id: 'wi-42', title: 'Build the login page' },
      handoverPath: '/h/leo.md',
      contextTokens: 650_123,
    });
    expect(line).toBe(
      '[CREWLY-CONTEXT-CAP] Your conversation reached 650,123 tokens, so it was saved and restarted. ' +
        'You are on WorkItem wi-42 ("Build the login page"). Your handover is in /h/leo.md (also in your wiki) — read it, then continue that WorkItem where you left off.',
    );
    expect(line).not.toContain('\n');
  });
  it('with no WorkItem, carries the handover path and says to carry on', () => {
    const line = contextCapReorientation({ workItem: null, handoverPath: '/h/milo.md', contextTokens: 210_000 });
    expect(line).toContain('[CREWLY-CONTEXT-CAP]');
    expect(line).toContain('/h/milo.md');
    expect(line).not.toContain('WorkItem');
    expect(line).not.toContain('\n');
  });
});

describe('FreshTaskConversationService', () => {
  let tmp: string;
  let claudeHome: string;
  let crewlyHome: string;
  let clock: number;
  let events: string[];
  let deps: FreshTaskDeps;
  let transcriptDir: string;

  const wi = (id: string): Pick<WorkItem, 'id' | 'metadata'> => ({ id });
  const standingRefreshWi = (id: string): Pick<WorkItem, 'id' | 'metadata'> => ({
    id,
    metadata: { kind: STANDING_ANSWERS_CONSTANTS.WORKITEM_KIND },
  });

  /** Let background work (new-conversation tracking) run to completion. */
  const settle = async () => {
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
  };

  const writeTranscript = (id: string, lines: object[]) => {
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-task-'));
    claudeHome = path.join(tmp, 'claude');
    crewlyHome = path.join(tmp, 'crewly');
    transcriptDir = path.dirname(claudeTranscriptPath({ sessionId: OLD_ID, cwd: CWD, claudeHome }));
    clock = 1_000_000;
    events = [];
    writeTranscript(OLD_ID, [
      { type: 'user', timestamp: 't1', message: { content: 'Build the login page' } },
      {
        type: 'assistant',
        timestamp: 't2',
        message: { content: [{ type: 'text', text: 'Login page done.' }], usage: { input_tokens: 10, cache_read_input_tokens: 200_000 } },
      },
    ]);
    deps = {
      getSessionInfo: jest.fn(() => ({ runtimeType: 'claude-code', cwd: CWD, sessionId: OLD_ID })),
      getClaimedSessionIds: jest.fn(() => new Set<string>()),
      updateSessionId: jest.fn((_s: string, id: string) => { events.push(`update:${id}`); }),
      clearSessionId: jest.fn(() => { events.push('clearId'); }),
      isBusy: jest.fn(async () => false),
      settingEnabled: jest.fn(async () => true),
      getActiveItems: jest.fn(async () => []),
      writeToSession: jest.fn((_s: string, data: string) => {
        events.push(`write:${JSON.stringify(data)}`);
        return true;
      }),
      remember: jest.fn(async () => { events.push('remember'); return 'id'; }),
      crewlyHome: () => crewlyHome,
      claudeHome,
      now: () => clock,
      sleep: jest.fn(async (ms: number) => { clock += ms; }),
      env: {},
      listSessions: jest.fn(() => [SESSION]),
      hasQueuedMessages: jest.fn(() => false),
      getQuietMs: jest.fn(() => 60_000),
      sendMessage: jest.fn(async (_s: string, text: string) => {
        events.push(`send:${text}`);
        return true;
      }),
    };
  });

  afterEach(() => {
    FreshTaskConversationService.resetInstance();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('first task: records the root, does not clear', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    expect(await svc.prepareForTask(SESSION, wi('task-a'))).toEqual({ cleared: false });
    expect(svc.getLastRoot(SESSION)).toBe('task-a');
    expect(deps.writeToSession).not.toHaveBeenCalled();
  });

  it('retries / verifies of the same task keep the conversation', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    expect((await svc.prepareForTask(SESSION, wi('task-a:retry:1'))).cleared).toBe(false);
    expect((await svc.prepareForTask(SESSION, wi('task-a:verify:task-a'))).cleared).toBe(false);
    expect(deps.writeToSession).not.toHaveBeenCalled();
  });

  it('new task: writes the handover and calls remember BEFORE writing /clear', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    (deps.writeToSession as jest.Mock).mockImplementation((_s: string, data: string) => {
      if (data === '/clear\r') {
        // The handover is on disk by the time /clear is written.
        const files = fs.readdirSync(path.join(crewlyHome, 'handover'));
        events.push(`handover-files:${files.length}`);
      }
      events.push(`write:${JSON.stringify(data)}`);
      return true;
    });

    const result = await svc.prepareForTask(SESSION, wi('task-b'));

    expect(result.cleared).toBe(true);
    expect(result.handoverPath).toMatch(new RegExp(`handover/${SESSION}-.*\\.md$`));
    const handover = fs.readFileSync(result.handoverPath as string, 'utf-8');
    expect(handover).toContain('Build the login page');
    expect(handover).toContain('Login page done.');
    expect(handover).toContain('task-a');

    const iRemember = events.indexOf('remember');
    const iEsc = events.indexOf(`write:${JSON.stringify('\x1b')}`);
    const iClear = events.indexOf(`write:${JSON.stringify('/clear\r')}`);
    expect(iRemember).toBeGreaterThanOrEqual(0);
    expect(iRemember).toBeLessThan(iEsc);
    expect(iEsc).toBeLessThan(iClear);
    expect(events).toContain('handover-files:1');
    expect(deps.sleep).toHaveBeenCalledWith(200);

    const rememberArgs = (deps.remember as jest.Mock).mock.calls[0][0];
    expect(rememberArgs.agentId).toBe(SESSION);
    expect(rememberArgs.content.length).toBeLessThanOrEqual(4_000);
    expect(rememberArgs.content).toContain(result.handoverPath);
    expect(svc.getLastRoot(SESSION)).toBe('task-b');
    await settle();
  });

  it('after /clear, stores the id of the new transcript that carries this task, not one that only names the agent', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    // Another agent sharing the cwd started a conversation too — not ours.
    let polls = 0;
    (deps.sleep as jest.Mock).mockImplementation(async (ms: number) => {
      clock += ms;
      if (ms === 1_000 && ++polls === 2) {
        const ts = new Date(clock).toISOString();
        // Another agent's fresh conversation that talks ABOUT this agent (the
        // 2026-09-28 bug: Atlas was handed Ella's conversation this way).
        writeTranscript('someone-else', [{ type: 'user', timestamp: ts, message: { content: `ask ${SESSION} about it` } }]);
        // An older conversation of anyone, written to just now.
        writeTranscript('older', [{ type: 'user', timestamp: new Date(clock - 3_600_000).toISOString(), message: { content: `task-b ${SESSION}` } }]);
        writeTranscript('new-id', [{ type: 'user', timestamp: ts, message: { content: `[CREWLY-DISPATCH] WorkItem task-b {"sessionName":"${SESSION}"}` } }]);
        // mtime must be after the clear
        const t = new Date(clock);
        fs.utimesSync(path.join(transcriptDir, 'new-id.jsonl'), t, t);
        fs.utimesSync(path.join(transcriptDir, 'someone-else.jsonl'), t, t);
        fs.utimesSync(path.join(transcriptDir, 'older.jsonl'), t, t);
      }
    });
    // Real file mtimes are "now"; make the clear time comparable.
    clock = Date.now();

    await svc.prepareForTask(SESSION, wi('task-b'));
    await settle();

    expect(deps.updateSessionId).toHaveBeenCalledWith(SESSION, 'new-id');
    expect(deps.clearSessionId).not.toHaveBeenCalled();
  });

  it('a session on another Claude Code account finds its transcript in that account\'s config dir (#942)', async () => {
    // The transcript was written under `claudeHome`, which here plays the
    // account's config dir; there is no test-wide Claude home override.
    const accountDeps: FreshTaskDeps = { ...deps, claudeHome: undefined, claudeAccountHome: jest.fn(() => claudeHome) };
    const svc = FreshTaskConversationService.createForTesting(accountDeps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    const result = await svc.prepareForTask(SESSION, wi('task-b'));
    expect(result.cleared).toBe(true);
    expect(fs.readFileSync(result.handoverPath as string, 'utf-8')).toContain('Login page done.');
    expect(accountDeps.claudeAccountHome).toHaveBeenCalledWith(SESSION);
    await settle();
  });

  it('without the account home the same transcript is not found and nothing is cleared', async () => {
    const svc = FreshTaskConversationService.createForTesting({ ...deps, claudeHome: undefined, claudeAccountHome: () => null });
    await svc.prepareForTask(SESSION, wi('task-a'));
    expect((await svc.prepareForTask(SESSION, wi('task-b'))).cleared).toBe(false);
  });

  it('clears the stored id when no new transcript appears in time', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    await svc.prepareForTask(SESSION, wi('task-b'));
    await settle();
    expect(deps.updateSessionId).not.toHaveBeenCalled();
    expect(deps.clearSessionId).toHaveBeenCalledWith(SESSION);
  });

  it('a standing-refresh WorkItem never clears, even for an idle member on a different root', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    const result = await svc.prepareForTask(SESSION, standingRefreshWi('standing-refresh-page-1'));
    expect(result).toEqual({ cleared: false });
    expect(deps.writeToSession).not.toHaveBeenCalled();
  });

  it('a standing-refresh WorkItem does not overwrite the stored root — the next real task still sees the real previous root', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    await svc.prepareForTask(SESSION, standingRefreshWi('standing-refresh-page-1'));
    expect(svc.getLastRoot(SESSION)).toBe('task-a');

    // The next real task on a different root still triggers a normal clear,
    // proving the refresh never got recorded as the "previous" root.
    const result = await svc.prepareForTask(SESSION, wi('task-b'));
    expect(result.cleared).toBe(true);
  });

  it('an agent that started a turn after the first check is not cleared (last look, crewly#1015 §4)', async () => {
    const isBusy = jest.fn(async () => false);
    const svc = FreshTaskConversationService.createForTesting({ ...deps, isBusy });
    await svc.prepareForTask(SESSION, wi('task-a'));
    // Idle at the decision, mid-turn at the last look.
    isBusy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await svc.prepareForTask(SESSION, wi('task-b'))).cleared).toBe(false);
    expect(deps.writeToSession).not.toHaveBeenCalled();
    expect(svc.getLastRoot(SESSION)).toBe('task-b');
  });

  it('isFreshTaskAgentBusy: the runtime turn state wins over a quiet screen', () => {
    const quiet = { workingInProgress: false, ptyQuietMs: 60_000 };
    expect(isFreshTaskAgentBusy({ ...quiet, turnState: 'turn' })).toBe(true);
    expect(isFreshTaskAgentBusy({ ...quiet, turnState: 'background' })).toBe(true);
    expect(isFreshTaskAgentBusy({ ...quiet, turnState: 'idle' })).toBe(false);
    expect(isFreshTaskAgentBusy({ ...quiet, turnState: 'unknown' })).toBe(false);
    expect(isFreshTaskAgentBusy({ ...quiet, turnState: null, workingInProgress: true })).toBe(true);
    expect(isFreshTaskAgentBusy({ turnState: 'unknown', workingInProgress: false, ptyQuietMs: 1_000 })).toBe(true);
    expect(isFreshTaskAgentBusy({ turnState: null, workingInProgress: false, ptyQuietMs: null })).toBe(false);
  });

  it('busy agent: no clear, but the new root is recorded', async () => {
    const svc = FreshTaskConversationService.createForTesting({ ...deps, isBusy: jest.fn(async () => true) });
    await svc.prepareForTask(SESSION, wi('task-a'));
    expect((await svc.prepareForTask(SESSION, wi('task-b'))).cleared).toBe(false);
    expect(deps.writeToSession).not.toHaveBeenCalled();
    expect(svc.getLastRoot(SESSION)).toBe('task-b');
  });

  it.each([
    ['non-Claude runtime', { getSessionInfo: () => ({ runtimeType: 'codex-cli', cwd: CWD, sessionId: OLD_ID }) }],
    ['env kill-switch', { env: { CREWLY_FRESH_TASK_CONVERSATION: '0' } }],
    ['settings flag off', { settingEnabled: async () => false }],
    ['other work running', { getActiveItems: async () => [{ id: 'task-c', target: SESSION, status: 'running' } as WorkItem] }],
    ['unknown conversation id', { getSessionInfo: () => ({ runtimeType: 'claude-code', cwd: CWD }) }],
  ])('%s: no clear', async (_label, override) => {
    const svc = FreshTaskConversationService.createForTesting({ ...deps, ...(override as Partial<FreshTaskDeps>) });
    await svc.prepareForTask(SESSION, wi('task-a'));
    expect((await svc.prepareForTask(SESSION, wi('task-b'))).cleared).toBe(false);
    expect(deps.writeToSession).not.toHaveBeenCalled();
    expect(deps.remember).not.toHaveBeenCalled();
  });

  it('orchestrator: never clears', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask('crewly-orc', wi('task-a'));
    expect((await svc.prepareForTask('crewly-orc', wi('task-b'))).cleared).toBe(false);
    expect(deps.writeToSession).not.toHaveBeenCalled();
  });

  it('a message delivered moments ago blocks the clear; an old one does not', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    svc.noteDelivery(SESSION);
    expect((await svc.prepareForTask(SESSION, wi('task-b'))).cleared).toBe(false);
    clock += 31_000;
    expect((await svc.prepareForTask(SESSION, wi('task-c'))).cleared).toBe(true);
    await settle();
  });

  it('persists the last root across a backend restart', async () => {
    let svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    svc = FreshTaskConversationService.createForTesting(deps);
    expect(svc.getLastRoot(SESSION)).toBe('task-a');
    expect((await svc.prepareForTask(SESSION, wi('task-a:retry:1'))).cleared).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(crewlyHome, 'fresh-task-conversation.json'), 'utf-8')).sessions[SESSION].root).toBe('task-a');
  });

  it('never throws into dispatch', async () => {
    const svc = FreshTaskConversationService.createForTesting({
      ...deps,
      getSessionInfo: () => { throw new Error('boom'); },
    });
    await expect(svc.prepareForTask(SESSION, wi('task-a'))).resolves.toEqual({ cleared: false });
  });

  describe('waitIfClearing', () => {
    it('returns at once when nothing is in flight', async () => {
      const svc = FreshTaskConversationService.createForTesting(deps);
      await expect(svc.waitIfClearing(SESSION, 10)).resolves.toBeUndefined();
    });

    it('waits for an in-flight clear to finish', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const svc = FreshTaskConversationService.createForTesting({
        ...deps,
        sleep: jest.fn(async (ms: number) => {
          clock += ms;
          if (ms === 2_000) await gate; // hold at the post-/clear pause
        }),
      });
      await svc.prepareForTask(SESSION, wi('task-a'));
      const prepare = svc.prepareForTask(SESSION, wi('task-b'));
      await new Promise((r) => setImmediate(r));

      let waited = false;
      const waiter = svc.waitIfClearing(SESSION, 5_000).then(() => { waited = true; });
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(waited).toBe(false);

      release();
      await prepare;
      await waiter;
      expect(waited).toBe(true);
      await settle();
    });

    it('is bounded when a clear hangs', async () => {
      const svc = FreshTaskConversationService.createForTesting({
        ...deps,
        sleep: jest.fn(async (ms: number) => {
          clock += ms;
          if (ms === 2_000) await new Promise(() => undefined); // never resolves
        }),
      });
      await svc.prepareForTask(SESSION, wi('task-a'));
      void svc.prepareForTask(SESSION, wi('task-b'));
      await new Promise((r) => setImmediate(r));
      const started = Date.now();
      await svc.waitIfClearing(SESSION, 30);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  it('a delivery in progress blocks the new-task clear until it ends', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    const end = svc.beginDelivery(SESSION);
    expect(svc.isDelivering(SESSION)).toBe(true);
    expect((await svc.prepareForTask(SESSION, wi('task-b'))).cleared).toBe(false);
    end();
    end(); // idempotent
    expect(svc.isDelivering(SESSION)).toBe(false);
  });

  describe('idle-boundary context cap', () => {
    const ACTIVE: WorkItem = {
      id: 'wi-long',
      title: 'Migrate the billing service',
      target: SESSION,
      status: 'running',
      startedAt: new Date(0).toISOString(),
    } as WorkItem;

    const bigTranscript = (tokens: number) =>
      writeTranscript(OLD_ID, [
        { type: 'user', timestamp: 't1', message: { content: 'Migrate billing' } },
        {
          type: 'assistant',
          timestamp: 't2',
          message: { content: [{ type: 'text', text: 'Step 412 done.' }], usage: { input_tokens: 10, cache_read_input_tokens: tokens } },
        },
      ]);

    beforeEach(() => {
      bigTranscript(650_000);
      deps.getActiveItems = jest.fn(async () => [ACTIVE]);
    });

    it('over the cap and idle: handover + remember, then Escape + /clear, then the one-line re-orientation', async () => {
      const svc = FreshTaskConversationService.createForTesting(deps);
      const result = await svc.capContextIfNeeded(SESSION);

      expect(result).toMatchObject({ capped: true, workItemId: 'wi-long' });
      const handover = fs.readFileSync(result.handoverPath as string, 'utf-8');
      expect(handover).toContain('Step 412 done.');
      expect(handover).toContain('still on the same WorkItem');
      const iRemember = events.indexOf('remember');
      const iClear = events.indexOf(`write:${JSON.stringify('/clear\r')}`);
      const iSend = events.findIndex((e) => e.startsWith('send:'));
      expect(iRemember).toBeGreaterThanOrEqual(0);
      expect(iRemember).toBeLessThan(iClear);
      expect(iClear).toBeLessThan(iSend);
      const line = events[iSend].slice('send:'.length);
      expect(line).toContain('[CREWLY-CONTEXT-CAP]');
      expect(line).toContain('wi-long');
      expect(line).toContain(result.handoverPath as string);
      // Same task: the recorded root is not changed by a cap.
      expect(svc.getLastRoot(SESSION)).toBeNull();
      await settle();
    });

    it('tracks the new conversation by the WorkItem id in the re-orientation line', async () => {
      clock = Date.now();
      (deps.sendMessage as jest.Mock).mockImplementation(async (_s: string, text: string) => {
        const ts = new Date(clock).toISOString();
        writeTranscript('other-agent', [{ type: 'user', timestamp: ts, message: { content: `talk to ${SESSION}` } }]);
        writeTranscript('capped-new', [{ type: 'user', timestamp: ts, message: { content: text } }]);
        return true;
      });
      const svc = FreshTaskConversationService.createForTesting(deps);
      expect((await svc.capContextIfNeeded(SESSION)).capped).toBe(true);
      await settle();
      expect(deps.updateSessionId).toHaveBeenCalledWith(SESSION, 'capped-new');
      expect(deps.clearSessionId).not.toHaveBeenCalled();
    });

    it('no WorkItem: still capped, re-oriented and tracked by the handover path', async () => {
      deps.getActiveItems = jest.fn(async () => []);
      clock = Date.now();
      (deps.sendMessage as jest.Mock).mockImplementation(async (_s: string, text: string) => {
        writeTranscript('chat-new', [{ type: 'user', timestamp: new Date(clock).toISOString(), message: { content: text } }]);
        return true;
      });
      const svc = FreshTaskConversationService.createForTesting(deps);
      const result = await svc.capContextIfNeeded(SESSION);
      expect(result).toMatchObject({ capped: true, workItemId: undefined });
      const line = (deps.sendMessage as jest.Mock).mock.calls[0][1] as string;
      expect(line).toContain(result.handoverPath as string);
      await settle();
      expect(deps.updateSessionId).toHaveBeenCalledWith(SESSION, 'chat-new');
    });

    it('under the cap: nothing', async () => {
      bigTranscript(150_000);
      const svc = FreshTaskConversationService.createForTesting(deps);
      expect(await svc.capContextIfNeeded(SESSION)).toEqual({ capped: false, reason: 'under cap' });
      expect(deps.writeToSession).not.toHaveBeenCalled();
    });

    it('honours CREWLY_MEMBER_CONTEXT_CAP_TOKENS (lower cap trips, 0 disables)', async () => {
      bigTranscript(250_000);
      let svc = FreshTaskConversationService.createForTesting({ ...deps, env: { CREWLY_MEMBER_CONTEXT_CAP_TOKENS: '200000' } });
      expect((await svc.capContextIfNeeded(SESSION)).capped).toBe(true);
      await settle();
      svc = FreshTaskConversationService.createForTesting({ ...deps, env: { CREWLY_MEMBER_CONTEXT_CAP_TOKENS: '0' } });
      expect(await svc.capContextIfNeeded(SESSION)).toEqual({ capped: false, reason: 'cap off' });
      expect(await svc.runContextCapSweep()).toEqual({});
    });

    it.each([
      ['busy', { isBusy: async () => true }, 'busy'],
      ['recently written PTY', { getQuietMs: () => 5_000 }, 'not quiet long enough'],
      ['queued messages', { hasQueuedMessages: () => true }, 'messages queued'],
      ['fresh-conversation kill switch', { env: { CREWLY_FRESH_TASK_CONVERSATION: 'off' } }, 'disabled'],
      ['settings off', { settingEnabled: async () => false }, 'disabled'],
      ['not claude-code', { getSessionInfo: () => ({ runtimeType: 'codex-cli', cwd: CWD, sessionId: OLD_ID }) }, 'not claude-code'],
    ])('%s: no cap', async (_label, override, reason) => {
      const svc = FreshTaskConversationService.createForTesting({ ...deps, ...(override as Partial<FreshTaskDeps>) });
      expect(await svc.capContextIfNeeded(SESSION)).toEqual({ capped: false, reason });
      expect(deps.writeToSession).not.toHaveBeenCalled();
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('never the orchestrator', async () => {
      const svc = FreshTaskConversationService.createForTesting(deps);
      expect(await svc.capContextIfNeeded('crewly-orc')).toEqual({ capped: false, reason: 'orchestrator' });
    });

    it('not while a message is being delivered or was just delivered', async () => {
      const svc = FreshTaskConversationService.createForTesting(deps);
      const end = svc.beginDelivery(SESSION);
      expect((await svc.capContextIfNeeded(SESSION)).reason).toBe('delivery in progress');
      end(); // ending counts as a delivery just now
      expect((await svc.capContextIfNeeded(SESSION)).reason).toBe('delivery in progress');
      clock += 31_000;
      expect((await svc.capContextIfNeeded(SESSION)).capped).toBe(true);
      await settle();
    });

    it('at most once per 20 minutes per session', async () => {
      const svc = FreshTaskConversationService.createForTesting(deps);
      expect((await svc.capContextIfNeeded(SESSION)).capped).toBe(true);
      await settle();
      clock += 10 * 60_000;
      expect(await svc.capContextIfNeeded(SESSION)).toEqual({ capped: false, reason: 'rate limited' });
      clock += 11 * 60_000;
      expect((await svc.capContextIfNeeded(SESSION)).capped).toBe(true);
      await settle();
    });

    it('re-checks busy right before the clear', async () => {
      let calls = 0;
      const svc = FreshTaskConversationService.createForTesting({ ...deps, isBusy: jest.fn(async () => ++calls > 1) });
      expect(await svc.capContextIfNeeded(SESSION)).toEqual({ capped: false, reason: 'busy' });
      expect(deps.writeToSession).not.toHaveBeenCalled();
    });

    it('terminal writes wait for a running cap (it is in the same in-flight chain)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const svc = FreshTaskConversationService.createForTesting({
        ...deps,
        sleep: jest.fn(async (ms: number) => {
          clock += ms;
          if (ms === 2_000) await gate;
        }),
      });
      const cap = svc.capContextIfNeeded(SESSION);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      let waited = false;
      const waiter = svc.waitIfClearing(SESSION, 5_000).then(() => { waited = true; });
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(waited).toBe(false);
      release();
      await cap;
      await waiter;
      expect(waited).toBe(true);
      await settle();
    });

    it('the sweep checks every registered member but not the orchestrator', async () => {
      const svc = FreshTaskConversationService.createForTesting({ ...deps, listSessions: () => ['crewly-orc', SESSION] });
      const results = await svc.runContextCapSweep();
      expect(Object.keys(results)).toEqual([SESSION]);
      expect(results[SESSION].capped).toBe(true);
      await settle();
    });

    it('never throws', async () => {
      const svc = FreshTaskConversationService.createForTesting({ ...deps, getSessionInfo: () => { throw new Error('boom'); } });
      await expect(svc.capContextIfNeeded(SESSION)).resolves.toEqual({ capped: false, reason: 'error' });
    });
  });

  it('freshConversationNote names the handover file and the wiki', () => {
    expect(freshConversationNote('/h/x.md')).toBe(
      'Fresh conversation for this task — your earlier work is in /h/x.md and your wiki; read them only if this task needs it.',
    );
  });
});
