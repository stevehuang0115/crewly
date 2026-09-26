/**
 * Tests for runtime session recovery: preset/resume flags, Codex rollout
 * discovery, nested-session env stripping.
 *
 * @module services/agent/runtime-session-recovery.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildHandoverSummary,
  claudeTranscriptPath,
  lastTurnContextTokens,
  orcFreshContextTokens,
  conversationExists,
  discoverAntigravityConversationId,
  discoverCodexSessionId,
  planRuntimeSessionFlags,
  stripNestedClaudeSessionEnv,
  toAntigravityResumeFlag,
  toCodexResumeCommand,
  waitForAntigravityConversationId,
  waitForCodexSessionId,
} from './runtime-session-recovery.js';

describe('planRuntimeSessionFlags', () => {
  it('launches a fresh Claude Code agent with a preset --session-id that must be persisted', () => {
    const plan = planRuntimeSessionFlags({ runtimeType: 'claude-code', isRestored: false, storedSessionId: null, autoResume: true, newId: () => 'uuid-1' });
    expect(plan.flags).toEqual(['--session-id', 'uuid-1']);
    expect(plan.presetSessionId).toBe('uuid-1');
    expect(plan.resumeSessionId).toBeNull();
  });

  it('resumes a Claude Code agent with its stored id (restored flag or not); a fresh id when auto-resume is off or the transcript is gone', () => {
    const on = planRuntimeSessionFlags({ runtimeType: 'claude-code', isRestored: true, storedSessionId: 'old', autoResume: true, newId: () => 'x' });
    expect(on.flags).toEqual(['--resume', 'old']);
    expect(on.resumeSessionId).toBe('old');
    // The persistence "restored" flag is not required — a stored id is.
    expect(planRuntimeSessionFlags({ runtimeType: 'claude-code', isRestored: false, storedSessionId: 'old', autoResume: true, newId: () => 'x' }).flags).toEqual(['--resume', 'old']);
    const gone = planRuntimeSessionFlags({ runtimeType: 'claude-code', isRestored: false, storedSessionId: 'old', autoResume: true, conversationExists: false, newId: () => 'fresh' });
    expect(gone.flags).toEqual(['--session-id', 'fresh']);
    expect(gone.note).toContain('no longer exists');
    const off = planRuntimeSessionFlags({ runtimeType: 'claude-code', isRestored: true, storedSessionId: 'old', autoResume: false, newId: () => 'new' });
    expect(off.flags).toEqual(['--session-id', 'new']);
    expect(off.note).toContain('disabled');
  });

  it('Codex: resume id on restore, nothing to inject on a fresh launch; other runtimes get nothing', () => {
    expect(planRuntimeSessionFlags({ runtimeType: 'codex-cli', isRestored: true, storedSessionId: 'c1', autoResume: true })).toMatchObject({ flags: [], resumeSessionId: 'c1' });
    expect(planRuntimeSessionFlags({ runtimeType: 'codex-cli', isRestored: false, storedSessionId: null, autoResume: true })).toMatchObject({ flags: [], resumeSessionId: null, presetSessionId: null });
    expect(planRuntimeSessionFlags({ runtimeType: 'gemini-cli', isRestored: true, storedSessionId: 'g', autoResume: true })).toMatchObject({ flags: [], resumeSessionId: null });
  });
});

describe('Antigravity CLI conversations', () => {
  const ID_A = '75e715be-ea13-400e-8e4a-0358e87d170c';
  const ID_B = '537e402c-83b8-4f69-9bf1-04729ba3ea7f';
  let configDir: string;
  let cwd: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-conv-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-'));
    fs.mkdirSync(path.join(configDir, 'conversations'));
    fs.mkdirSync(path.join(configDir, 'cache'));
  });
  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  /** Create a conversation the way agy 1.2.11 lays it out (db + brain dir). */
  function conversation(id: string, log?: string): void {
    fs.writeFileSync(path.join(configDir, 'conversations', `${id}.db`), '');
    const logs = path.join(configDir, 'brain', id, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    if (log) fs.writeFileSync(path.join(logs, 'transcript.jsonl'), log);
  }

  /** Write cache/last_conversations.json. */
  function lastConversation(map: Record<string, string>): void {
    fs.writeFileSync(path.join(configDir, 'cache', 'last_conversations.json'), JSON.stringify(map, null, 2));
  }

  it('plans a fresh start (id discovered later) and a resume with --conversation=<id>', () => {
    const fresh = planRuntimeSessionFlags({ runtimeType: 'antigravity-cli', isRestored: false, storedSessionId: null, autoResume: true });
    expect(fresh).toMatchObject({ flags: [], resumeSessionId: null, presetSessionId: null });
    const resumed = planRuntimeSessionFlags({ runtimeType: 'antigravity-cli', isRestored: true, storedSessionId: ID_A, autoResume: true, conversationExists: true });
    expect(resumed).toMatchObject({ flags: [`--conversation=${ID_A}`], resumeSessionId: ID_A });
    const gone = planRuntimeSessionFlags({ runtimeType: 'antigravity-cli', isRestored: true, storedSessionId: ID_A, autoResume: true, conversationExists: false });
    expect(gone.flags).toEqual([]);
  });

  it('builds the resume flag agy prints on exit, stripping anything unsafe', () => {
    expect(toAntigravityResumeFlag(ID_A)).toBe(`--conversation=${ID_A}`);
    expect(toAntigravityResumeFlag(`${ID_A}; rm -rf ~`)).toBe(`--conversation=${ID_A}rm-rf`);
  });

  it('knows whether a conversation still exists', () => {
    conversation(ID_A);
    expect(conversationExists({ runtimeType: 'antigravity-cli', sessionId: ID_A, cwd, antigravityConfigDir: configDir })).toBe(true);
    expect(conversationExists({ runtimeType: 'antigravity-cli', sessionId: ID_B, cwd, antigravityConfigDir: configDir })).toBe(false);
  });

  it('finds nothing before the first prompt creates a conversation', () => {
    expect(discoverAntigravityConversationId({ configDir, cwd, notBeforeMs: Date.now() })).toBeNull();
    fs.rmSync(path.join(configDir, 'conversations'), { recursive: true });
    expect(discoverAntigravityConversationId({ configDir, cwd, notBeforeMs: Date.now() })).toBeNull();
  });

  it('takes the workspace\'s latest conversation from last_conversations.json (realpath or as given)', () => {
    const launchedAt = Date.now();
    conversation(ID_A);
    lastConversation({ [fs.realpathSync(cwd)]: ID_A });
    expect(discoverAntigravityConversationId({ configDir, cwd, notBeforeMs: launchedAt })).toBe(ID_A);
  });

  it('ignores conversations from before the launch and ones another agent claimed', () => {
    conversation(ID_A);
    lastConversation({ [fs.realpathSync(cwd)]: ID_A });
    expect(discoverAntigravityConversationId({ configDir, cwd, notBeforeMs: Date.now() + 60_000 })).toBeNull();
    expect(discoverAntigravityConversationId({ configDir, cwd, notBeforeMs: 0, claimed: new Set([ID_A]) })).toBeNull();
  });

  it('prefers the conversation whose logs mention this agent\'s prompt file, even when another agent in the same folder started later', () => {
    conversation(ID_A, '{"type":"user","text":"Read the file at /home/me/.crewly/prompts/team-dev-1-init.md and follow all instructions in it."}\n');
    conversation(ID_B, '{"type":"user","text":"Read the file at /home/me/.crewly/prompts/team-dev-2-init.md"}\n');
    lastConversation({ [fs.realpathSync(cwd)]: ID_B });
    expect(discoverAntigravityConversationId({ configDir, cwd, notBeforeMs: 0, marker: 'team-dev-1-init.md' })).toBe(ID_A);
    expect(discoverAntigravityConversationId({ configDir, cwd, notBeforeMs: 0, marker: 'team-dev-2-init.md' })).toBe(ID_B);
    // No log mentions the marker yet: fall back to the workspace cache.
    expect(discoverAntigravityConversationId({ configDir, cwd, notBeforeMs: 0, marker: 'team-dev-3-init.md' })).toBe(ID_B);
  });

  it('polls until the conversation appears', async () => {
    let polls = 0;
    const found = await waitForAntigravityConversationId({
      configDir,
      cwd,
      notBeforeMs: 0,
      timeoutMs: 60_000,
      intervalMs: 1,
      sleep: async () => {
        polls++;
        if (polls === 2) {
          conversation(ID_A);
          lastConversation({ [path.resolve(cwd)]: ID_A });
        }
      },
    });
    expect(found).toBe(ID_A);
    // Timing out: the only conversation belongs to another agent.
    expect(
      await waitForAntigravityConversationId({ configDir, cwd, notBeforeMs: 0, claimed: new Set([ID_A]), timeoutMs: 0, intervalMs: 1, sleep: async () => undefined }),
    ).toBeNull();
  });
});

describe('toCodexResumeCommand', () => {
  it('turns the configured launch into a resume with the id last, keeping approval/sandbox flags', () => {
    expect(toCodexResumeCommand('codex -a never -s danger-full-access', '01a0-b5a6')).toBe('codex resume -a never -s danger-full-access 01a0-b5a6');
    expect(toCodexResumeCommand('cd /x && codex --full-auto', 'id;rm -rf')).toBe('cd /x && codex resume --full-auto idrm-rf');
    expect(toCodexResumeCommand('codex resume --last', 'id')).toBe('codex resume --last');
    expect(toCodexResumeCommand('claude --dangerously-skip-permissions', 'id')).toBe('claude --dangerously-skip-permissions');
  });
});

describe('stripNestedClaudeSessionEnv', () => {
  it('drops the parent-session markers and keeps user configuration', () => {
    const out = stripNestedClaudeSessionEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      PATH: '/bin',
    });
    expect(out).toEqual({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' });
  });
});

describe('discoverCodexSessionId', () => {
  let home: string;
  const T0 = Date.UTC(2026, 8, 18, 17, 53, 34); // 2026-09-18T17:53:34Z

  function rollout(day: string, id: string, cwd: string, mtimeMs: number, extra = ''): string {
    const dir = path.join(home, 'sessions', day);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `rollout-${day.replace(/\//g, '-')}T00-00-00-${id}.jsonl`);
    const meta = { timestamp: 'x', type: 'session_meta', payload: { session_id: id, id, cwd, originator: 'codex-tui' } };
    fs.writeFileSync(p, `${JSON.stringify(meta)}\n${extra}`);
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return p;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns the earliest unclaimed rollout for the cwd written after launch', () => {
    rollout('2026/09/18', 'old-one', '/opt/app', T0 - 60_000); // before launch
    rollout('2026/09/18', 'other-cwd', '/elsewhere', T0 + 1_000);
    rollout('2026/09/18', 'ours', '/opt/app', T0 + 2_000);
    rollout('2026/09/18', 'next-agent', '/opt/app', T0 + 9_000);
    const found = discoverCodexSessionId({ codexHome: home, cwd: '/opt/app', notBeforeMs: T0 });
    expect(found?.sessionId).toBe('ours');
    const second = discoverCodexSessionId({ codexHome: home, cwd: '/opt/app', notBeforeMs: T0, claimed: new Set(['ours']) });
    expect(second?.sessionId).toBe('next-agent');
    expect(discoverCodexSessionId({ codexHome: home, cwd: '/nope', notBeforeMs: T0 })).toBeNull();
  });

  it('reads a session_meta line longer than 8 KB (Codex embeds its base instructions)', () => {
    const dir = path.join(home, 'sessions', '2026/09/18');
    fs.mkdirSync(dir, { recursive: true });
    const meta = { type: 'session_meta', payload: { session_id: 'big-one', id: 'big-one', cwd: '/opt/app', base_instructions: { text: 'x'.repeat(40_000) } } };
    const p = path.join(dir, 'rollout-2026-09-18T00-00-00-big-one.jsonl');
    fs.writeFileSync(p, `${JSON.stringify(meta)}\n{"type":"turn"}\n`);
    fs.utimesSync(p, (T0 + 3_000) / 1000, (T0 + 3_000) / 1000);
    expect(discoverCodexSessionId({ codexHome: home, cwd: '/opt/app', notBeforeMs: T0 })?.sessionId).toBe('big-one');
  });

  it('conversationExists finds a Codex rollout by id anywhere under sessions/, and a Claude transcript by cwd slug', () => {
    rollout('2026/08/01', 'old-codex', '/opt/app', T0 - 86_400_000 * 40);
    expect(conversationExists({ runtimeType: 'codex-cli', sessionId: 'old-codex', cwd: '/opt/app', codexHome: home })).toBe(true);
    expect(conversationExists({ runtimeType: 'codex-cli', sessionId: 'nope', cwd: '/opt/app', codexHome: home })).toBe(false);
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    try {
      const slugDir = path.join(claudeHome, 'projects', '-Users-me-proj-crewly');
      fs.mkdirSync(slugDir, { recursive: true });
      fs.writeFileSync(path.join(slugDir, 'abc.jsonl'), '{}');
      expect(conversationExists({ runtimeType: 'claude-code', sessionId: 'abc', cwd: '/Users/me/proj/crewly', claudeHome })).toBe(true);
      expect(conversationExists({ runtimeType: 'claude-code', sessionId: 'zzz', cwd: '/Users/me/proj/crewly', claudeHome })).toBe(false);
      expect(conversationExists({ runtimeType: 'gemini-cli', sessionId: 'any', cwd: '/x' })).toBe(true);
    } finally {
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it('tolerates a missing home, malformed first lines and non-rollout files', () => {
    expect(discoverCodexSessionId({ codexHome: path.join(home, 'missing'), cwd: '/x', notBeforeMs: T0 })).toBeNull();
    const dir = path.join(home, 'sessions', '2026/09/18');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-bad.jsonl'), 'not json\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    expect(discoverCodexSessionId({ codexHome: home, cwd: '/x', notBeforeMs: T0 })).toBeNull();
  });

  it('waitForCodexSessionId polls until the file appears, and gives up on timeout', async () => {
    let ticks = 0;
    const sleep = async () => {
      ticks += 1;
      if (ticks === 2) rollout('2026/09/18', 'late', '/opt/app', T0 + 3_000);
    };
    const found = await waitForCodexSessionId({ codexHome: home, cwd: '/opt/app', notBeforeMs: T0, timeoutMs: 10_000, intervalMs: 1, sleep });
    expect(found?.sessionId).toBe('late');
    const none = await waitForCodexSessionId({ codexHome: home, cwd: '/never', notBeforeMs: T0, timeoutMs: 0, intervalMs: 1, sleep: async () => undefined });
    expect(none).toBeNull();
  });
});

describe('an orchestrator conversation too big to carry on', () => {
  // One machine's orc re-read 612k tokens every turn, 0.1% of it new, and the
  // history grew ~64k a day because it was resumed across every restart.
  let dir: string;
  const line = (o: unknown) => JSON.stringify(o);
  const turn = (id: string, read: number, write = 0) =>
    line({ type: 'assistant', timestamp: 't', message: { id, content: [{ type: 'text', text: `answer ${id}` }], usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-convo-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the size of the last real turn, skipping zero-usage bookkeeping', () => {
    const file = path.join(dir, 'c.jsonl');
    fs.writeFileSync(file, [
      turn('m1', 100_000),
      turn('m2', 611_575, 730),
      line({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
      '',
    ].join('\n'));
    expect(lastTurnContextTokens(file)).toBe(5 + 611_575 + 730);
  });

  it('knows nothing about a missing or empty transcript', () => {
    expect(lastTurnContextTokens(path.join(dir, 'missing.jsonl'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
    expect(lastTurnContextTokens(path.join(dir, 'empty.jsonl'))).toBeNull();
  });

  it('hands over what was said, not the tool traffic or system reminders', () => {
    const file = path.join(dir, 'c.jsonl');
    fs.writeFileSync(file, [
      line({ type: 'user', timestamp: 't1', message: { content: 'Slack: please draft the Sunrun email' } }),
      line({ type: 'user', timestamp: 't1', message: { content: '<system-reminder>ignore me</system-reminder>' } }),
      line({ type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] } }),
      line({ type: 'assistant', timestamp: 't3', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat big' } }, { type: 'text', text: 'Drafted, not sent.' }] } }),
      '',
    ].join('\n'));

    const summary = buildHandoverSummary(file);

    expect(summary).toContain('please draft the Sunrun email');
    expect(summary).toContain('Drafted, not sent.');
    expect(summary).not.toContain('ignore me');
    expect(summary).not.toContain('xxxxx');
    expect(summary).not.toContain('cat big');
  });

  it('keeps the handover short however long the conversation was', () => {
    const file = path.join(dir, 'c.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(line({ type: 'user', timestamp: `t${i}`, message: { content: `message ${i} ` + 'y'.repeat(2000) } }));
    fs.writeFileSync(file, lines.join('\n'));

    const summary = buildHandoverSummary(file);

    expect(summary.length).toBeLessThanOrEqual(16_000 + 200);
    // Newest last: the end of the conversation is what survives.
    expect(summary).toContain('message 499');
    expect(summary).not.toContain('message 0 ');
  });

  it('finds the transcript where Claude Code keeps it', () => {
    expect(claudeTranscriptPath({ sessionId: 'abc', cwd: '/Users/me/proj.x', claudeHome: '/h/.claude' })).toBe(
      '/h/.claude/projects/-Users-me-proj-x/abc.jsonl',
    );
  });

  it('starts fresh above 300k unless the environment says otherwise', () => {
    expect(orcFreshContextTokens({})).toBe(300_000);
    expect(orcFreshContextTokens({ CREWLY_ORC_FRESH_CONTEXT_TOKENS: '500000' })).toBe(500_000);
    expect(orcFreshContextTokens({ CREWLY_ORC_FRESH_CONTEXT_TOKENS: 'nope' })).toBe(300_000);
  });
});
