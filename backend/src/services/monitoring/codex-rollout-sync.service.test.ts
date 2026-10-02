/**
 * Tests for the Codex rollout usage sync. Lines are shaped like a real
 * Codex 0.160 rollout (session_meta, turn_context, token_usage_record,
 * token_count with repeats and info: null).
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CodexRolloutSyncService,
  findCodexRollout,
  parseCodexRolloutLines,
  type CodexParseState,
  type CodexUsageEvent,
} from './codex-rollout-sync.service.js';

const ID = '01a0fa7d-0bfa-75d2-bda1-3f766fe7d38b';

function usage(input: number, cached: number, output: number) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 20, total_tokens: input + output };
}

function tokenCount(ts: string, total: [number, number, number], last: [number, number, number]): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: usage(...total), last_token_usage: usage(...last), model_context_window: 258400 },
      rate_limits: { limit_id: 'codex', primary: { used_percent: 27.0, window_minutes: 300 } },
    },
  });
}

const META = JSON.stringify({ timestamp: '2026-10-02T02:41:35.608Z', type: 'session_meta', payload: { session_id: ID, id: ID, cwd: '/work/ce-core', originator: 'codex-tui', cli_version: '0.160.0' } });
const TURN = JSON.stringify({ timestamp: '2026-10-02T02:41:36.396Z', type: 'turn_context', payload: { turn_id: 't1', cwd: '/work/ce-core', model: 'gpt-6-sol' } });
const RECORD = JSON.stringify({ timestamp: '2026-10-02T02:41:41.801Z', type: 'token_usage_record', payload: { thread_id: ID, usage: usage(13985, 11648, 209) } });
const NO_INFO = JSON.stringify({ timestamp: '2026-10-02T02:41:42.100Z', type: 'event_msg', payload: { type: 'token_count', info: null } });
const C1 = tokenCount('2026-10-02T02:41:42.032Z', [13985, 11648, 209], [13985, 11648, 209]);
const C2 = tokenCount('2026-10-02T02:41:46.524Z', [28213, 23296, 393], [14228, 11648, 184]);
const C2_REPEAT = tokenCount('2026-10-02T02:41:46.600Z', [28213, 23296, 393], [14228, 11648, 184]);

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

describe('parseCodexRolloutLines', () => {
  it('records the running-total delta per call, cached on top of fresh input', () => {
    const state: CodexParseState = { model: '', lastTotal: null };
    const events = parseCodexRolloutLines(lines(META, TURN, RECORD, C1, NO_INFO, C2, C2_REPEAT), state);
    expect(events).toEqual([
      { timestamp: '2026-10-02T02:41:42.032Z', model: 'gpt-6-sol', input: 13985 - 11648, cachedInput: 11648, output: 209 },
      { timestamp: '2026-10-02T02:41:46.524Z', model: 'gpt-6-sol', input: 14228 - 11648, cachedInput: 11648, output: 184 },
    ]);
    // Token unit: input (fresh + cached) + output equals Codex's own total.
    const sum = events.reduce((n, e) => n + e.input + e.cachedInput + e.output, 0);
    expect(sum).toBe(28213 + 393);
    expect(state.lastTotal?.total).toBe(28213 + 393);
  });

  it('counts only the last call when the first total of a file already holds history', () => {
    const state: CodexParseState = { model: 'gpt-6-sol', lastTotal: null };
    const events = parseCodexRolloutLines(lines(tokenCount('2026-10-02T03:00:00Z', [900000, 800000, 9000], [50000, 40000, 300])), state);
    expect(events).toEqual([{ timestamp: '2026-10-02T03:00:00Z', model: 'gpt-6-sol', input: 10000, cachedInput: 40000, output: 300 }]);
  });

  it('falls back to the last call when the running total goes down', () => {
    const state: CodexParseState = { model: 'm', lastTotal: { input: 5000, cached: 0, output: 100, total: 5100 } };
    const events = parseCodexRolloutLines(lines(tokenCount('2026-10-02T03:00:00Z', [1000, 0, 10], [1000, 0, 10])), state);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ input: 1000, output: 10 });
  });

  it('ignores junk and partial JSON', () => {
    expect(parseCodexRolloutLines('not json\n{"type":"event_msg"}\n', { model: '', lastTotal: null })).toEqual([]);
  });
});

describe('CodexRolloutSyncService', () => {
  let home: string;
  let codexHome: string;
  let file: string;
  let recorded: Array<{ session: string; event: CodexUsageEvent }>;

  const make = () =>
    new CodexRolloutSyncService({
      codexHome,
      cursorFile: path.join(home, 'codex-rollout-cursors.json'),
      sessions: () =>
        new Map([
          ['ce-nova-a2b1f759', { runtimeType: 'codex-cli', claudeSessionId: ID }],
          ['ce-owen-ad0320ab', { runtimeType: 'claude-code', claudeSessionId: 'x' }],
        ]),
      record: (session, event) => recorded.push({ session, event }),
    });

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sync-'));
    codexHome = path.join(home, '.codex');
    const dir = path.join(codexHome, 'sessions', '2026', '10', '01');
    await fs.mkdir(dir, { recursive: true });
    file = path.join(dir, `rollout-2026-10-01T22-41-34-${ID}.jsonl`);
    // A rollout nobody in Crewly owns — never read.
    await fs.writeFile(path.join(dir, 'rollout-2026-10-01T20-00-00-ffffffff-0000-0000-0000-000000000000.jsonl'), lines(META, TURN, C1));
    recorded = [];
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('finds a rollout by conversation id', async () => {
    await fs.writeFile(file, lines(META));
    expect(await findCodexRollout(codexHome, ID)).toBe(file);
    expect(await findCodexRollout(codexHome, 'nope')).toBeNull();
  });

  it('attributes usage to the Crewly session and is idempotent across passes and restarts', async () => {
    await fs.writeFile(file, lines(META, TURN, RECORD, C1));
    const sync = make();
    expect((await sync.sync()).eventsRecorded).toBe(1);
    expect(recorded[0].session).toBe('ce-nova-a2b1f759');

    // Nothing new: nothing recorded.
    expect((await sync.sync()).eventsRecorded).toBe(0);

    // Appended lines, one repeated, and a partial trailing line.
    await fs.appendFile(file, `${C2}\n${C2_REPEAT}\n{"timestamp":"2026-10-02T02:42:00Z","type":"event_ms`);
    expect((await sync.sync()).eventsRecorded).toBe(1);

    // A fresh instance (backend restart) resumes from the persisted cursor.
    const again = make();
    expect((await again.sync()).eventsRecorded).toBe(0);
    expect(recorded).toHaveLength(2);
    const total = recorded.reduce((n, r) => n + r.event.input + r.event.cachedInput + r.event.output, 0);
    expect(total).toBe(28213 + 393);
  });
});
