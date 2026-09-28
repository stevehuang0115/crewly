/**
 * Tests for FreshTaskConversationService — fresh Claude Code conversation per
 * new task, with the old one saved first.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FreshTaskConversationService,
  decideFreshConversation,
  freshConversationNote,
  freshTaskConversationEnvEnabled,
  rootWorkItemId,
  type FreshTaskDeps,
  type FreshTaskDecisionInput,
} from './fresh-task-conversation.service.js';
import { claudeTranscriptPath } from './runtime-session-recovery.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

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
    ['other work in progress', { otherActiveRoots: ['task-c'] }],
  ])('does not clear: %s', (reason, override) => {
    expect(decideFreshConversation({ ...base, ...(override as Partial<FreshTaskDecisionInput>) })).toEqual({ clear: false, reason });
  });
  it('active work with the new root itself does not block', () => {
    expect(decideFreshConversation({ ...base, otherActiveRoots: ['task-b'] }).clear).toBe(true);
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

  const wi = (id: string): Pick<WorkItem, 'id'> => ({ id });

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

  it('after /clear, stores the id of the new transcript that mentions the session', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    // Another agent sharing the cwd started a conversation too — not ours.
    let polls = 0;
    (deps.sleep as jest.Mock).mockImplementation(async (ms: number) => {
      clock += ms;
      if (ms === 1_000 && ++polls === 2) {
        writeTranscript('someone-else', [{ type: 'user', message: { content: 'poll for other-agent' } }]);
        writeTranscript('new-id', [{ type: 'user', message: { content: `[CREWLY-DISPATCH] {"sessionName":"${SESSION}"}` } }]);
        // mtime must be after the clear
        const t = new Date(clock);
        fs.utimesSync(path.join(transcriptDir, 'new-id.jsonl'), t, t);
        fs.utimesSync(path.join(transcriptDir, 'someone-else.jsonl'), t, t);
      }
    });
    // Real file mtimes are "now"; make the clear time comparable.
    clock = Date.now();

    await svc.prepareForTask(SESSION, wi('task-b'));
    await settle();

    expect(deps.updateSessionId).toHaveBeenCalledWith(SESSION, 'new-id');
    expect(deps.clearSessionId).not.toHaveBeenCalled();
  });

  it('clears the stored id when no new transcript appears in time', async () => {
    const svc = FreshTaskConversationService.createForTesting(deps);
    await svc.prepareForTask(SESSION, wi('task-a'));
    await svc.prepareForTask(SESSION, wi('task-b'));
    await settle();
    expect(deps.updateSessionId).not.toHaveBeenCalled();
    expect(deps.clearSessionId).toHaveBeenCalledWith(SESSION);
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

  it('freshConversationNote names the handover file and the wiki', () => {
    expect(freshConversationNote('/h/x.md')).toBe(
      'Fresh conversation for this task — your earlier work is in /h/x.md and your wiki; read them only if this task needs it.',
    );
  });
});
