import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StagingArea } from './team-move-fs.js';
import { TeamMoveSecretScanError, isRedactableFinding, isRedactableRecord, isSkippableFinding, redactRecordInStaging, redactTranscriptInStaging, scanStaging, memoryStoreOf } from './team-move-secret-scan.js';

// Fake credentials are assembled at run time so secret scanners do not flag this file.
const FAKE_SLACK = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnop'].join('-');
const FAKE_ANTHROPIC = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
const FAKE_OPENAI = ['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
const FAKE_BEARER = ['Bearer', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(' ');
const FAKE_PEM = ['-----BEGIN PRIVATE KEY-----', 'abc', '-----END PRIVATE KEY-----'].join('\n');

describe('team-move-secret-scan', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'move-scan-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function stage(files: Record<string, string | Buffer>): Promise<StagingArea> {
    const s = new StagingArea(dir);
    await s.init();
    for (const [rel, content] of Object.entries(files)) await s.writeText(rel, content.toString('latin1'));
    return s;
  }

  it('redacts a conversation transcript in the package: valid JSON Lines, no secret left, the rest intact', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'deploy with the key below' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_result', content: `export ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\nok "quoted" \\ done` }] } }),
      JSON.stringify({ type: 'assistant', nested: { deep: [FAKE_SLACK, 'plain text', 42, null, true] } }),
      'not json at all, token ' + FAKE_OPENAI,
      '',
    ];
    const s = await stage({ 'transcripts/ryan/abc.jsonl': lines.join('\n') });
    const before = s.files().find((f) => f.path === 'transcripts/ryan/abc.jsonl');

    const { entry, redactions } = await redactTranscriptInStaging(s, 'transcripts/ryan/abc.jsonl');
    expect(redactions).toBeGreaterThanOrEqual(3);
    expect(entry.sha256).not.toBe(before?.sha256);
    expect(s.files().find((f) => f.path === entry.path)).toEqual(entry);

    const text = await fs.readFile(s.abs('transcripts/ryan/abc.jsonl'), 'utf8');
    for (const secret of [FAKE_ANTHROPIC, FAKE_SLACK, FAKE_OPENAI]) expect(text).not.toContain(secret);
    const out = text.split('\n').filter((l) => l.length > 0);
    expect(JSON.parse(out[0])).toEqual({ type: 'user', message: { content: 'deploy with the key below' } });
    const second = JSON.parse(out[1]);
    expect(second.message.content[0].content).toContain('ok "quoted" \\ done');
    expect(JSON.parse(out[2]).nested.deep.slice(1)).toEqual(['plain text', 42, null, true]);
    expect(out[3].startsWith('not json at all, token ')).toBe(true);
    expect((await scanStaging(s, s.files())).findings).toEqual([]);
  });

  it('a transcript with a quoted secret assignment is clean once redacted (the escaped quote is not a new secret)', async () => {
    const quoted = JSON.stringify({ type: 'assistant', text: 'export ANTHROPIC_API_KEY="abc123def456ghi789" && run' });
    const s = await stage({ 'transcripts/ryan/q.jsonl': quoted + '\n' + JSON.stringify({ text: `DB_PASSWORD='hunter2hunter2hunter2'` }) });
    expect((await scanStaging(s, s.files())).findings).toHaveLength(1);
    const { residual, redactions } = await redactTranscriptInStaging(s, 'transcripts/ryan/q.jsonl');
    expect(redactions).toBe(2);
    expect(residual).toBe(0);
    const text = await fs.readFile(s.abs('transcripts/ryan/q.jsonl'), 'utf8');
    expect(text).not.toContain('abc123def456ghi789');
    expect(text).not.toContain('hunter2hunter2hunter2');
    expect(JSON.parse(text.split('\n')[0]).text).toBe('export ANTHROPIC_API_KEY="[REDACTED]" && run');
  });

  it('only conversation transcripts are redacted in place', () => {
    expect(isRedactableFinding('transcripts/ryan/abc.jsonl')).toBe(true);
    for (const p of ['team/config.json', 'transcripts/ryan/notes.md', 'agents/s/memory.json', 'records/nested/x.json', 'records/notes.md']) expect(isRedactableFinding(p)).toBe(false);
  });

  it('JSON records (chat channels, tasks, decisions) are redacted too, never team/config.json', () => {
    for (const p of ['records/chat-channels.json', 'records/task-pool.json', 'records/decisions.json']) {
      expect(isRedactableRecord(p)).toBe(true);
      expect(isRedactableFinding(p)).toBe(true);
    }
    expect(isRedactableRecord('team/config.json')).toBe(false);
  });

  it('redacts a chat message in records/chat-channels.json: same JSON, channels and members intact, nothing left', async () => {
    const chat = { channels: [{ id: 'c1', name: 'movers' }], members: [{ channelId: 'c1', session: 'lead' }], messages: [{ id: 'm1', content: `use ${FAKE_ANTHROPIC} now` }, { id: 'm2', content: 'plain "quoted" text' }] };
    const s = await stage({ 'records/chat-channels.json': JSON.stringify(chat, null, 2) });
    expect((await scanStaging(s, s.files())).findings).toHaveLength(1);
    const { entry, redactions, residual } = await redactRecordInStaging(s, 'records/chat-channels.json');
    expect(redactions).toBe(1);
    expect(residual).toBe(0);
    expect(s.files().find((f) => f.path === entry.path)).toEqual(entry);
    const text = await fs.readFile(s.abs('records/chat-channels.json'), 'utf8');
    expect(text).not.toContain(FAKE_ANTHROPIC);
    const out = JSON.parse(text) as typeof chat;
    expect(out.channels).toEqual(chat.channels);
    expect(out.members).toEqual(chat.members);
    expect(out.messages[1]).toEqual(chat.messages[1]);
    expect(out.messages[0]!.content).toMatch(/^use .* now$/);
    expect((await scanStaging(s, s.files())).findings).toEqual([]);
  });

  it('a record that still matches after redaction reports a residual (so the exporter keeps blocking)', async () => {
    // A known value that the mask text itself contains can never be masked away: the second pass finds it again.
    const s = await stage({ 'records/x.json': JSON.stringify({ text: 'note REDACTED_x here' }) });
    const { residual } = await redactRecordInStaging(s, 'records/x.json', [{ name: 'MASK', value: 'REDACTED' }]);
    expect(residual).toBeGreaterThan(0);
  });

  it('finds token shapes, secret assignments and known values, and reports paths only', async () => {
    const s = await stage({
      'clean.md': 'nothing here, TOKEN_COUNT=5',
      'slack.md': FAKE_SLACK,
      'env.md': 'export ANTHROPIC_API_KEY=abc123def456ghi789',
      'known.md': 'the secret is 0123456789abcdef0123456789abcdef today',
      'bearer.md': `Authorization: ${FAKE_BEARER}`,
      'pem.md': FAKE_PEM,
    });
    const result = await scanStaging(s, s.files(), [{ name: 'SIGNING', value: '0123456789abcdef0123456789abcdef' }]);
    expect(result.filesScanned).toBe(6);
    expect(result.findings.map((f) => f.path).sort()).toEqual(['bearer.md', 'env.md', 'known.md', 'pem.md', 'slack.md']);
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop');
  });

  it('does not scan binary files and sees a secret across a window boundary', async () => {
    const s = new StagingArea(dir);
    await s.init();
    await fs.writeFile(path.join(dir, 'bin.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(FAKE_SLACK)]));
    const filler = 'a '.repeat(512 * 1024 - 10);
    await s.writeText('big.md', `${filler}${FAKE_SLACK} tail`);
    const entries = [{ path: 'bin.dat', sha256: '', bytes: 0 }, ...s.files()];
    const result = await scanStaging(s, entries);
    expect(result.findings.map((f) => f.path)).toEqual(['big.md']);
    expect(result.filesScanned).toBe(1);
  });

  it('builds an error that names files, not values', () => {
    const e = new TeamMoveSecretScanError(Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.md`, matches: 1 })));
    expect(e.message).toMatch(/12 files/);
    expect(e.message).toMatch(/f0\.md/);
    expect(e.message).toMatch(/\.\.\.$/);
  });

  it('allows skipping notes and project files but never core records', () => {
    for (const p of ['projects/p/data/x.md', 'handover/a.md', 'agents/s/sessions/1.md', 'team/wiki/a.md', 'team/norms/n.md']) expect(isSkippableFinding(p)).toBe(true);
    for (const p of ['team/config.json', 'records/task-pool.json', 'agents/s/memory.json', 'manifest.json', 'team/prompts/a.md']) expect(isSkippableFinding(p)).toBe(false);
  });
});

describe('memoryStoreOf', () => {
  it('knows a project memory store, which is masked rather than dropped', () => {
    for (const store of ['knowledge/gotchas.json', 'knowledge/learnings.md', 'knowledge/decisions.json', 'knowledge/patterns.json', 'knowledge/archive/old.jsonl']) {
      expect(memoryStoreOf(`projects/p1/data/${store}`)).toEqual({ projectId: 'p1', path: store });
      expect(isRedactableFinding(`projects/p1/data/${store}`)).toBe(true);
    }
  });

  it('leaves every other file to the old rules', () => {
    for (const other of ['projects/p1/data/findings/leak.md', 'projects/p1/files/knowledge/gotchas.json', 'projects/p1/data/knowledge/index.db', 'projects/p1/data/specs/knowledge/a.md', 'team/wiki/knowledge/a.md']) {
      expect(memoryStoreOf(other)).toBeNull();
      expect(isRedactableFinding(other)).toBe(false);
    }
  });
});
