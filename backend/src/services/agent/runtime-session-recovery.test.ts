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
  discoverCodexSessionId,
  planRuntimeSessionFlags,
  stripNestedClaudeSessionEnv,
  toCodexResumeCommand,
  waitForCodexSessionId,
} from './runtime-session-recovery.js';

describe('planRuntimeSessionFlags', () => {
  it('launches a fresh Claude Code agent with a preset --session-id that must be persisted', () => {
    const plan = planRuntimeSessionFlags({ runtimeType: 'claude-code', isRestored: false, storedSessionId: null, autoResume: true, newId: () => 'uuid-1' });
    expect(plan.flags).toEqual(['--session-id', 'uuid-1']);
    expect(plan.presetSessionId).toBe('uuid-1');
    expect(plan.resumeSessionId).toBeNull();
  });

  it('resumes a restored Claude Code agent with its stored id; a fresh id when auto-resume is off', () => {
    const on = planRuntimeSessionFlags({ runtimeType: 'claude-code', isRestored: true, storedSessionId: 'old', autoResume: true, newId: () => 'x' });
    expect(on.flags).toEqual(['--resume', 'old']);
    expect(on.resumeSessionId).toBe('old');
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
