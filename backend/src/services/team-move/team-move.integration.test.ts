/**
 * Team move, end to end between two temporary Crewly homes: export, encrypt,
 * decrypt, import, archive and rollback, with the secret scan and the
 * unpushed-work guard in the way.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StorageService } from '../core/storage.service.js';
import { openChatDatabase } from '../chat-v2/sqlite/chat-db.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import type { Team } from '../../types/index.js';
import { TeamMoveArchiver } from './team-move-archive.js';
import { generateTargetKeyPair } from './team-move-crypto.js';
import { TeamMoveBlockedError, TeamMoveExporter, buildEncryptedPackage } from './team-move-exporter.js';
import { walkFiles } from './team-move-fs.js';
import { TeamMoveImporter, TeamMoveImportError } from './team-move-importer.js';
import { MoveJournal } from './team-move-journal.js';
import { TeamMoveSecretScanError } from './team-move-secret-scan.js';
import { FIXTURE, buildSourceFixture, buildTargetPaths, type Fixture } from './team-move.fixture.js';

// Fake credentials are assembled at run time so secret scanners do not flag this file.
const FAKE_SLACK = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnop'].join('-');
const FAKE_ANTHROPIC = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');

const MOVE_ID = 'move-integration-0001';
const F = FIXTURE;

describe('team move between two homes', () => {
  let fx: Fixture;
  let sourceStorage: StorageService;
  let targetHome: string;
  let targetStorage: StorageService;
  let started: string[];
  let adopted: Array<Record<string, unknown>>;

  beforeEach(async () => {
    fx = await buildSourceFixture();
    const target = await buildTargetPaths(fx.root);
    targetHome = target.home;
    process.env['CREWLY_PROJECTS_ROOT'] = target.projectsRoot;
    sourceStorage = new StorageService(fx.home);
    targetStorage = new StorageService(targetHome);
    started = [];
    adopted = [];
  });

  afterEach(async () => {
    delete process.env['CREWLY_PROJECTS_ROOT'];
    await fx.cleanup();
  });

  const exporter = (overrides: Partial<ConstructorParameters<typeof TeamMoveExporter>[0]> = {}): TeamMoveExporter =>
    new TeamMoveExporter({
      home: fx.home,
      getTeams: () => sourceStorage.getTeams(),
      getProjects: () => sourceStorage.getProjects(),
      crewlyVersion: '9.9.9',
      source: { instanceId: 'src-instance', deviceName: 'Mac' },
      knownSecrets: async () => [],
      ...overrides,
    });

  const importer = (extra: Partial<ConstructorParameters<typeof TeamMoveImporter>[0]> = {}): TeamMoveImporter =>
    new TeamMoveImporter({
      home: targetHome,
      crewlyVersion: '9.9.9',
      storage: targetStorage,
      addWorkItems: async (items) => {
        const file = path.join(targetHome, 'task-pool', 'pool.json');
        await fs.mkdir(path.dirname(file), { recursive: true });
        const pool = await safeReadJson<{ workItems: Array<{ id: string }>; claims: unknown[] }>(file, { workItems: [], claims: [] });
        let added = 0;
        for (const it of items) {
          if (pool.workItems.some((w) => w.id === it.id)) continue;
          pool.workItems.push(it as never);
          added += 1;
        }
        await atomicWriteJson(file, pool);
        return added;
      },
      addDecisions: async (decisions) => {
        const file = path.join(targetHome, 'owner-decisions.json');
        const data = await safeReadJson<{ nextId: number; decisions: Array<Record<string, unknown>> }>(file, { nextId: 1, decisions: [] });
        for (const d of decisions) data.decisions.push({ ...d, id: `D-${data.nextId++}` });
        await atomicWriteJson(file, data);
        return decisions.length;
      },
      adoptSlackMapping: async (mapping) => {
        adopted.push(mapping);
        return true;
      },
      startTeam: async (teamId) => {
        started.push(teamId);
        return { ok: true };
      },
      hasCommand: (bin) => bin !== 'ffmpeg',
      runtimeLogins: async () => ({ 'claude-code': false }),
      ...extra,
    });

  /** Export from the source, encrypt for a fresh target key, return the pieces. */
  async function exportAndEncrypt(options: { allowDirty?: boolean; skipFlagged?: boolean } = {}) {
    const staging = path.join(fx.root, 'staging-out');
    const result = await exporter().export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: staging, ...options });
    const key = generateTargetKeyPair();
    const file = path.join(fx.root, 'package.enc');
    const enc = await buildEncryptedPackage(staging, file, key.publicKey, MOVE_ID);
    return { result, key, enc, file };
  }

  it('exports only the team, with a manifest and no secrets', async () => {
    const { result, enc } = await exportAndEncrypt();
    const m = result.manifest;
    const paths = m.files.map((f) => f.path);

    expect(m.noSecrets).toBe(true);
    expect(m.team.members.map((x) => x.sessionName).sort()).toEqual([F.devSession, F.leadSession].sort());
    expect(paths).toContain('team/config.json');
    expect(paths).toContain('team/norms/review.md');
    expect(paths).toContain('team/wiki/llm-curated/index.md');
    expect(paths).toContain('team/cron-tasks.json');
    expect(paths).toContain(`agents/${F.leadSession}/memory.json`);
    expect(paths).toContain(`agents/${F.leadSession}/sessions/2026-10-01-10-00.md`);
    expect(paths).toContain(`projects/${F.projectId}/data/tickets/MOV-1-ship-it.md`);
    expect(paths).toContain(`projects/${F.projectId}/data/missions/m1.json`);
    // Left out: other teams, backups, logs, transcripts.
    expect(paths.some((p) => p.includes(F.decoySession))).toBe(false);
    expect(paths.some((p) => p.includes('.bak'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.log') || p.endsWith('.jsonl'))).toBe(false);
    // Newest 10 handover notes of the lead only.
    expect(paths.filter((p) => p.startsWith('handover/'))).toHaveLength(10);
    // Task pool: queued + running items of the team, not the done or foreign one.
    const pool = JSON.parse(await fs.readFile(path.join(result.staging.root, 'records/task-pool.json'), 'utf8')) as { workItems: Array<{ id: string; status: string }> };
    expect(pool.workItems.map((w) => w.id).sort()).toEqual(['wi-queued', 'wi-running']);
    expect(pool.workItems.find((w) => w.id === 'wi-running')!.status).toBe('queued');
    expect(m.counts['openDecisions']).toBe(1);
    expect(m.counts['chatChannels']).toBe(2);
    expect(m.requiredTools).toContain('ffmpeg');
    expect(m.requiredConnectors).toContain('Google');
    expect(m.repos).toHaveLength(1);
    expect(m.repos[0]).toMatchObject({ remoteUrl: fx.remoteDir, branch: 'main', dirty: false, unpushed: 0 });
    expect(result.summary.noSecrets).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.summary))).toBeLessThan(64 * 1024);
    // The package is ciphertext.
    const raw = await fs.readFile(enc.file);
    expect(raw.includes(Buffer.from('Movers'))).toBe(false);
    expect(enc.size).toBe(raw.length);
  });

  it('sanitizes runtime state in the exported team config', async () => {
    const { result } = await exportAndEncrypt();
    const config = JSON.parse(await fs.readFile(path.join(result.staging.root, 'team/config.json'), 'utf8')) as Team;
    for (const member of config.members) {
      expect(member.agentStatus).toBe('inactive');
      expect(member.workingStatus).toBe('idle');
      expect(member.readyAt).toBeUndefined();
      expect(member.dropoutReason).toBeUndefined();
    }
  });

  it('moves a team: same members, tickets, wiki, memory, records; nothing starts before the end', async () => {
    const { key, enc, file } = await exportAndEncrypt();
    const report = await importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });

    // Team and members arrive under the same ids and sessions.
    const teams = await targetStorage.getTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]!.id).toBe(F.teamId);
    expect(teams[0]!.members.map((m) => m.sessionName).sort()).toEqual([F.devSession, F.leadSession].sort());
    expect(teams[0]!.members.every((m) => m.agentStatus === 'inactive')).toBe(true);
    expect(started).toEqual([F.teamId]);

    // Project relocated under the target projects root, repo cloned at the same commit.
    const projects = await targetStorage.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(F.projectId);
    const newPath = projects[0]!.path;
    expect(newPath).toBe(path.join(process.env['CREWLY_PROJECTS_ROOT']!, 'movers-app'));
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: newPath, encoding: 'utf8' }).trim()).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.projectDir, encoding: 'utf8' }).trim());
    expect(report.paths).toEqual([{ projectId: F.projectId, name: 'Movers App', from: fx.projectDir, to: newPath }]);
    expect(report.repos.cloned).toHaveLength(1);
    expect(report.repos.failed).toHaveLength(0);

    // Tickets and wiki and memory equal; paths inside text were rewritten.
    const ticket = await fs.readFile(path.join(newPath, '.crewly', 'tickets', 'MOV-1-ship-it.md'), 'utf8');
    expect(ticket).toContain(`${newPath}/src`);
    expect(ticket).not.toContain(fx.projectDir);
    expect(await fs.readFile(path.join(newPath, '.crewly', 'tickets', 'MOV-2-second.md'), 'utf8')).toBe(await fs.readFile(path.join(fx.projectDir, '.crewly', 'tickets', 'MOV-2-second.md'), 'utf8'));
    expect(await fs.readFile(path.join(newPath, '.crewly', 'missions', 'm1.json'), 'utf8')).toBe(await fs.readFile(path.join(fx.projectDir, '.crewly', 'missions', 'm1.json'), 'utf8'));
    await expect(fs.stat(path.join(newPath, '.crewly', 'logs'))).rejects.toThrow();
    for (const rel of ['norms/review.md', 'sops/release.md', 'wiki/llm-curated/index.md', 'cron-tasks.json']) {
      expect(await fs.readFile(path.join(targetHome, 'teams', F.teamId, rel), 'utf8')).toBe(await fs.readFile(path.join(fx.home, 'teams', F.teamId, rel), 'utf8'));
    }
    // Prompts are saved from the member and carry this machine's paths.
    const prompt = await fs.readFile(path.join(targetHome, 'teams', F.teamId, 'prompts', `${F.leadId}.md`), 'utf8');
    expect(prompt).toContain(`Work in ${newPath}.`);
    for (const s of [F.leadSession, F.devSession]) {
      expect(await fs.readFile(path.join(targetHome, 'agents', s, 'memory.json'), 'utf8')).toBe(await fs.readFile(path.join(fx.home, 'agents', s, 'memory.json'), 'utf8'));
      expect(await fs.readFile(path.join(targetHome, 'agents', s, 'sessions', '2026-10-01-10-00.md'), 'utf8')).toContain(s);
    }
    expect((await fs.readdir(path.join(targetHome, 'handover'))).length).toBe(10);

    // Records.
    const pool = await safeReadJson<{ workItems: Array<{ id: string; description: string }> }>(path.join(targetHome, 'task-pool', 'pool.json'), { workItems: [] });
    expect(pool.workItems.map((w) => w.id).sort()).toEqual(['wi-queued', 'wi-running']);
    expect(pool.workItems[0]!.description).toContain(newPath);
    const decisions = await safeReadJson<{ decisions: Array<{ question: string }> }>(path.join(targetHome, 'owner-decisions.json'), { decisions: [] });
    expect(decisions.decisions.map((d) => d.question)).toEqual(['Ship?']);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ teamId: F.teamId, slackChannelId: 'C0MOVERS' });
    const db = openChatDatabase({ dbPath: path.join(targetHome, 'chat.db'), skipIntegrityCheck: true });
    try {
      const ids = (db.prepare('SELECT id FROM chat_channels ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual([F.channelId, F.dmId]);
      expect((db.prepare('SELECT COUNT(*) c FROM chat_channel_members WHERE channel_id = ?').get(F.channelId) as { c: number }).c).toBe(2);
    } finally {
      db.close();
    }

    // Report.
    expect(report.missingTools).toContain('ffmpeg');
    expect(report.runtimesNotLoggedIn).toEqual(['claude-code']);
    expect(report.reconnect.map((r) => r.kind).sort()).toEqual(['connector', 'runtime']);
    expect(report.reconnect.find((r) => r.kind === 'connector')!.url).toMatch(/^https:\/\//);
    expect(report.started).toEqual({ requested: true, ok: true });
    expect(report.moved['members']).toBe(2);

    // The package and the decrypted copy are gone; the report is kept.
    await expect(fs.stat(file)).rejects.toThrow();
    await expect(fs.stat(path.join(targetHome, 'team-moves', MOVE_ID, 'staging'))).rejects.toThrow();
    expect((await fs.stat(path.join(targetHome, 'team-moves', MOVE_ID, 'import-report.json'))).isFile()).toBe(true);
  });

  describe('a Crewly channel shared with another team (the Iris shape)', () => {
    const ROOM = 'chan-0004-shared-room';
    const OTHER = 'other-team-session';
    const adhocTeamId = 'adhoc:C0SHARED';

    /** Source: a Crewly channel with this team's two agents and one agent of another team, with history. */
    async function addSharedRoom(): Promise<void> {
      const now = Date.parse('2026-10-05T10:00:00.000Z');
      const db = openChatDatabase({ dbPath: path.join(fx.home, 'chat.db'), skipIntegrityCheck: true });
      try {
        db.prepare('INSERT INTO chat_channels (id, agent_session, owner_user_id, name, purpose, created_at, type, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ROOM, '', 'owner', 'shared-room', null, now, 'huddle', null);
        const member = db.prepare('INSERT INTO chat_channel_members (channel_id, member_session, joined_at) VALUES (?, ?, ?)');
        for (const s of [F.leadSession, F.devSession, OTHER, 'team:placeholder']) member.run(ROOM, s, now);
        const msg = db.prepare("INSERT INTO chat_messages (id, channel_id, seq, sender_type, sender_id, content, content_type, created_at) VALUES (?, ?, ?, 'user', 'owner', ?, 'text', ?)");
        for (let i = 1; i <= 3; i++) msg.run(`m-${i}`, ROOM, i, `shared history ${i}`, now + i);
      } finally {
        db.close();
      }
      const file = path.join(fx.home, 'slack-team-channels.json');
      const store = await safeReadJson<{ mappings: Array<Record<string, unknown>> }>(file, { mappings: [] });
      store.mappings.push({ teamId: adhocTeamId, slackChannelId: 'C0SHARED', slackChannelName: 'shared-room', chatChannelId: ROOM, createdAt: '2026-10-05T10:00:00.000Z', autoCreated: false, members: [F.leadSession, F.devSession, OTHER], excluded: [OTHER] });
      await atomicWriteJson(file, store);
    }

    it('carries the channel, its members of this team and its history to the target', async () => {
      await addSharedRoom();
      const adoptedAdhoc: Array<Record<string, unknown>> = [];
      const { key, enc, file } = await exportAndEncrypt();
      const report = await importer({
        adoptAdhocMapping: async (mapping) => {
          adoptedAdhoc.push(mapping);
          return { chatChannelId: String(mapping['chatChannelId']), added: true };
        },
      }).run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });

      // The Slack link comes along, with this team's agents only.
      expect(adoptedAdhoc).toHaveLength(1);
      expect(adoptedAdhoc[0]).toMatchObject({ teamId: adhocTeamId, slackChannelId: 'C0SHARED', chatChannelId: ROOM, members: [F.leadSession, F.devSession] });
      expect(adoptedAdhoc[0]!['excluded']).toBeUndefined();
      expect(report.moved['slackChannelMappings']).toBe(2);

      // The huddle, its roster (no other team's agent, no placeholder) and the history exist on the target.
      const db = openChatDatabase({ dbPath: path.join(targetHome, 'chat.db'), skipIntegrityCheck: true });
      try {
        expect((db.prepare('SELECT 1 FROM chat_channels WHERE id = ?').get(ROOM) as unknown) !== undefined).toBe(true);
        const roster = (db.prepare('SELECT member_session s FROM chat_channel_members WHERE channel_id = ? ORDER BY s').all(ROOM) as Array<{ s: string }>).map((r) => r.s);
        expect(roster).toEqual([F.devSession, F.leadSession].sort());
        const history = (db.prepare('SELECT content FROM chat_messages WHERE channel_id = ? ORDER BY seq').all(ROOM) as Array<{ content: string }>).map((r) => r.content);
        expect(history).toEqual(['shared history 1', 'shared history 2', 'shared history 3']);
      } finally {
        db.close();
      }
    });

    it('joins a channel the target already has for that Slack channel, under the target\'s own huddle id', async () => {
      await addSharedRoom();
      // Target: the same Slack channel is known here already, under another huddle, with a member and one message.
      const existing = 'target-huddle-7';
      const targetDb = openChatDatabase({ dbPath: path.join(targetHome, 'chat.db'), skipIntegrityCheck: true });
      try {
        targetDb.prepare('INSERT INTO chat_channels (id, agent_session, owner_user_id, name, purpose, created_at, type, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(existing, '', 'owner', 'shared-room', null, 1, 'huddle', null);
        targetDb.prepare('INSERT INTO chat_channel_members (channel_id, member_session, joined_at) VALUES (?, ?, ?)').run(existing, 'already-here', 1);
        targetDb.prepare("INSERT INTO chat_messages (id, channel_id, seq, sender_type, sender_id, content, content_type, created_at) VALUES ('t-1', ?, 1, 'user', 'owner', 'local history', 'text', 1)").run(existing);
      } finally {
        targetDb.close();
      }
      const { key, enc, file } = await exportAndEncrypt();
      await importer({ adoptAdhocMapping: async () => ({ chatChannelId: existing, added: false }) }).run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });

      const db = openChatDatabase({ dbPath: path.join(targetHome, 'chat.db'), skipIntegrityCheck: true });
      try {
        expect(db.prepare('SELECT 1 FROM chat_channels WHERE id = ?').get(ROOM)).toBeUndefined();
        const roster = (db.prepare('SELECT member_session s FROM chat_channel_members WHERE channel_id = ? ORDER BY s').all(existing) as Array<{ s: string }>).map((r) => r.s);
        expect(roster).toEqual(['already-here', F.devSession, F.leadSession].sort());
        const history = (db.prepare('SELECT seq, content FROM chat_messages WHERE channel_id = ? ORDER BY seq').all(existing) as Array<{ seq: number; content: string }>);
        expect(history.map((h) => h.content)).toEqual(['local history', 'shared history 1', 'shared history 2', 'shared history 3']);
        expect(history.map((h) => h.seq)).toEqual([1, 2, 3, 4]);
      } finally {
        db.close();
      }
    });
  });

  it('contains no secret in any packaged file', async () => {
    const { result } = await exportAndEncrypt();
    const all: string[] = [];
    for await (const f of walkFiles(result.staging.root)) all.push(await fs.readFile(f.abs, 'utf8').catch(() => ''));
    const text = all.join('\n');
    expect(text).not.toMatch(/xox[bpa]-\d/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{20}/);
  });

  it('is idempotent: running the same import again changes nothing and does not start twice', async () => {
    const { key, enc, file } = await exportAndEncrypt();
    const input = { moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 };
    const first = await importer().run(input);
    const second = await importer().run(input);
    expect(second).toEqual(first);
    expect(started).toHaveLength(1);
    expect(await targetStorage.getTeams()).toHaveLength(1);
  });

  it('resumes after a crash: a failed step is retried and finished steps are not repeated', async () => {
    const { key, enc, file } = await exportAndEncrypt();
    const input = { moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 };
    let failOnce = true;
    const flaky = new TeamMoveImporter({
      ...(importer() as unknown as { deps: ConstructorParameters<typeof TeamMoveImporter>[0] }).deps,
      addWorkItems: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('disk hiccup');
        }
        return 0;
      },
    });
    await expect(flaky.run(input)).rejects.toThrow('disk hiccup');
    const journal = new MoveJournal(MOVE_ID, targetHome);
    expect(await journal.isDone('projects')).toBe(true);
    expect(await journal.isDone('records')).toBe(false);
    expect(await targetStorage.getTeams()).toHaveLength(0); // not registered, so not started
    expect(started).toHaveLength(0);

    const report = await flaky.run(input);
    expect(report.started.ok).toBe(true);
    expect(await targetStorage.getTeams()).toHaveLength(1);
  });

  it('refuses a package that was altered or is for another move', async () => {
    const { key, enc, file } = await exportAndEncrypt();
    const bytes = await fs.readFile(file);
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 1;
    await fs.writeFile(file, bytes);
    await expect(importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 })).rejects.toThrow(/hash does not match/);
    await expect(importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey })).rejects.toThrow(/authentication/);
    expect(await targetStorage.getTeams()).toHaveLength(0);
  });

  it('refuses to import over a live team with the same id', async () => {
    const { key, enc, file } = await exportAndEncrypt();
    await targetStorage.saveTeam({ id: F.teamId, name: 'Already here', members: [], projectIds: [], createdAt: 'x', updatedAt: 'x' } as unknown as Team);
    await expect(importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 })).rejects.toBeInstanceOf(TeamMoveImportError);
  });

  it('aborts the export when a file holds a credential, and skips it only on request', async () => {
    const leak = path.join(fx.projectDir, '.crewly', 'findings', 'leak.md');
    await fs.writeFile(leak, `token: ${FAKE_SLACK}\n`);
    await expect(exportAndEncrypt()).rejects.toBeInstanceOf(TeamMoveSecretScanError);
    const ok = await exportAndEncrypt({ skipFlagged: true });
    expect(ok.result.manifest.files.some((f) => f.path.endsWith('leak.md'))).toBe(false);
    expect(ok.result.manifest.projects[0]!.skipped).toEqual([expect.objectContaining({ path: 'findings/leak.md', reason: 'secret_scan' })]);
    expect(ok.result.manifest.secretScan.excludedFiles).toBe(1);
  });

  it('moves memory files that hold a key, masked, and names them in the import report', async () => {
    const dir = path.join(fx.projectDir, '.crewly', 'knowledge');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'gotchas.json'), JSON.stringify([{ id: 'g1', content: `never reuse ${FAKE_SLACK}` }]));
    await fs.writeFile(path.join(dir, 'learnings.md'), `# Learnings\n- the key ${FAKE_ANTHROPIC} expired\n`);
    const { key, enc, file, result } = await exportAndEncrypt();
    expect(result.manifest.projects[0]!.skipped).toEqual([]);
    expect(result.manifest.secretScan.excludedFiles).toBe(0);
    expect(result.manifest.secretScan.masked!.map((m) => [m.path.replace(/^.*\/\.crewly\//, ''), m.redactions]).sort()).toEqual([
      ['knowledge/gotchas.json', 1],
      ['knowledge/learnings.md', 1],
    ]);
    for (const name of ['gotchas.json', 'learnings.md']) {
      const entry = result.manifest.files.find((f) => f.path.endsWith(`/data/knowledge/${name}`))!;
      const packed = await fs.readFile(path.join(result.staging.root, entry.path), 'utf8');
      for (const secret of [FAKE_SLACK, FAKE_ANTHROPIC]) expect(packed).not.toContain(secret);
      expect(await fs.readFile(path.join(dir, name), 'utf8')).toContain(name === 'gotchas.json' ? FAKE_SLACK : FAKE_ANTHROPIC);
    }
    const report = await importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });
    const warning = report.warnings.find((w) => w.startsWith('Credentials were masked in 2 moved file(s)'))!;
    expect(warning).toContain('knowledge/gotchas.json (1)');
    expect(warning).not.toContain(FAKE_SLACK);
  });

  it('masks a key pasted into a chat message in the package copy, so skipFlagged still passes and the channel moves', async () => {
    const db = openChatDatabase({ dbPath: path.join(fx.home, 'chat.db'), skipIntegrityCheck: true });
    try {
      db.prepare("INSERT INTO chat_messages (id, channel_id, seq, sender_type, sender_id, content, content_type, created_at) VALUES ('leak-1', ?, 99, 'user', 'owner', ?, 'text', 1)").run(F.channelId, `here is the key ${FAKE_SLACK} ok`);
    } finally {
      db.close();
    }
    await expect(exportAndEncrypt()).resolves.toBeDefined();
    const ok = await exportAndEncrypt({ skipFlagged: true });
    const text = await fs.readFile(path.join(ok.result.staging.root, 'records/chat-channels.json'), 'utf8');
    expect(text).not.toContain(FAKE_SLACK);
    const chat = JSON.parse(text) as { channels: Array<{ id: string }>; members: unknown[] };
    expect(chat.channels.some((c) => c.id === F.channelId)).toBe(true);
    expect(ok.result.manifest.secretScan.redactedFiles).toBe(1);
    expect(ok.result.manifest.secretScan.excludedFiles).toBe(0);
  });

  it('never skips a credential in a core record', async () => {
    const config = JSON.parse(await fs.readFile(path.join(fx.home, 'teams', F.teamId, 'config.json'), 'utf8')) as { members: Array<{ systemPrompt: string }> };
    config.members[0]!.systemPrompt = `use ${FAKE_ANTHROPIC}`;
    await fs.writeFile(path.join(fx.home, 'teams', F.teamId, 'config.json'), JSON.stringify(config));
    await expect(exportAndEncrypt({ skipFlagged: true })).rejects.toBeInstanceOf(TeamMoveSecretScanError);
  });

  it('catches the exact value of a known secret even when it has no recognisable shape', async () => {
    await fs.writeFile(path.join(fx.projectDir, '.crewly', 'findings', 'plain.md'), 'the value is d41d8cd98f00b204e9800998ecf8427e here\n');
    await expect(
      exporter({ knownSecrets: async () => [{ name: 'SLACK_SIGNING_SECRET', value: 'd41d8cd98f00b204e9800998ecf8427e' }] }).export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: path.join(fx.root, 's2') }),
    ).rejects.toBeInstanceOf(TeamMoveSecretScanError);
  });

  it('refuses to move while a repository has unpushed or uncommitted work', async () => {
    await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'not committed');
    await expect(exportAndEncrypt()).rejects.toBeInstanceOf(TeamMoveBlockedError);
    execFileSync('git', ['add', '-A'], { cwd: fx.projectDir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'local only'], { cwd: fx.projectDir });
    const check = await exporter().checkRepos(F.teamId);
    expect(check.blocking[0]).toMatch(/1 commit not pushed on main/);
    await expect(exportAndEncrypt()).rejects.toThrow(/Push this work before moving/);
    const allowed = await exportAndEncrypt({ allowDirty: true });
    expect(allowed.result.dirtyRepos).toHaveLength(1);
  });

  it('caps project files: oversized files are skipped and listed', async () => {
    await fs.writeFile(path.join(fx.projectDir, '.crewly', 'findings', 'huge.bin'), Buffer.alloc(11 * 1024 * 1024, 1));
    const { result } = await exportAndEncrypt();
    expect(result.manifest.projects[0]!.skipped).toEqual([expect.objectContaining({ path: 'findings/huge.bin', reason: 'too_large' })]);
    expect(result.manifest.files.some((f) => f.path.endsWith('huge.bin'))).toBe(false);
  });

  /** Add a second project that is a plain folder (not a git repository) to the team. */
  async function addPlainProject(files: Record<string, string | Buffer>): Promise<{ id: string; dir: string }> {
    const id = '44444444-4444-4444-8444-444444444444';
    const dir = path.join(fx.root, 'source-projects', 'biblestudy');
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    }
    const projectsFile = path.join(fx.home, 'projects.json');
    const projects = JSON.parse(await fs.readFile(projectsFile, 'utf8')) as Array<Record<string, unknown>>;
    projects.push({ id, name: 'Bible Study', path: dir, teams: {}, status: 'stopped', createdAt: 'x', updatedAt: 'x' });
    await fs.writeFile(projectsFile, JSON.stringify(projects));
    const configFile = path.join(fx.home, 'teams', F.teamId, 'config.json');
    const config = JSON.parse(await fs.readFile(configFile, 'utf8')) as { projectIds: string[] };
    config.projectIds.push(id);
    await fs.writeFile(configFile, JSON.stringify(config));
    return { id, dir };
  }

  it('moves the working files of a project that is not a git repository, leaving out dependencies and build output', async () => {
    const plain = await addPlainProject({
      'AGENTS.md': `# Agents\nsee ${fx.projectDir}\n`,
      'reviews/ch1.md': 'review one',
      'node_modules/dep/index.js': 'x',
      '.next/cache/a.js': 'x',
      'dist/out.js': 'x',
      'build/out.js': 'x',
      '.cache/c': 'x',
      'debug.log': 'noise',
      '.DS_Store': 'x',
      '.crewly/tickets/BS-1-a.md': '---\nid: BS-1\n---\n',
    });
    const { key, enc, file, result } = await exportAndEncrypt();
    const entry = result.manifest.projects.find((p) => p.id === plain.id)!;
    const packaged = result.manifest.files.map((f) => f.path).filter((p) => p.startsWith(`projects/${plain.id}/files/`));
    expect(packaged.sort()).toEqual([`projects/${plain.id}/files/AGENTS.md`, `projects/${plain.id}/files/reviews/ch1.md`]);
    expect(entry.work).toMatchObject({ files: 2, skipped: [] });
    expect(result.manifest.counts['workFiles']).toBe(2);
    // The git project is unaffected: nothing of its working tree travels.
    expect(result.manifest.files.some((f) => f.path.startsWith(`projects/${F.projectId}/files/`))).toBe(false);

    const report = await importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });
    const moved = (await targetStorage.getProjects()).find((p) => p.id === plain.id)!;
    expect(await fs.readFile(path.join(moved.path, 'reviews', 'ch1.md'), 'utf8')).toBe('review one');
    expect(await fs.readFile(path.join(moved.path, 'AGENTS.md'), 'utf8')).toContain(fx.projectDir);
    await expect(fs.stat(path.join(moved.path, 'node_modules'))).rejects.toThrow();
    expect((await fs.stat(path.join(moved.path, '.crewly', 'tickets', 'BS-1-a.md'))).isFile()).toBe(true);
    expect(report.warnings.join('\n')).not.toMatch(/not a git repository/);
    expect(report.paths.some((p) => p.projectId === plain.id)).toBe(true);
  });

  it('lists non-git files over the caps in the manifest and the report', async () => {
    const plain = await addPlainProject({ 'small.md': 'ok', 'big.bin': Buffer.alloc(2048, 1), 'mid.bin': Buffer.alloc(300, 1) });
    const limited = exporter({ workLimits: { totalBytes: 1000, fileBytes: 1024 } });
    const staging = path.join(fx.root, 'staging-caps');
    const result = await limited.export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: staging });
    const entry = result.manifest.projects.find((p) => p.id === plain.id)!;
    expect(entry.work!.skipped).toEqual([expect.objectContaining({ path: 'big.bin', reason: 'too_large' })]);
    expect(entry.work!.files).toBe(2);
    const tight = await exporter({ workLimits: { totalBytes: 100, fileBytes: 1024 } }).export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: path.join(fx.root, 'staging-caps2') });
    expect(tight.manifest.projects.find((p) => p.id === plain.id)!.work!.skipped.map((s) => [s.path, s.reason])).toEqual([['big.bin', 'too_large'], ['mid.bin', 'size_cap']]);
  });

  it('runs the secret scan over non-git files: blocks, or leaves the file out with skipFlagged', async () => {
    const plain = await addPlainProject({ 'notes.md': 'fine', 'keys.txt': `token: ${FAKE_SLACK}\n` });
    await expect(exportAndEncrypt()).rejects.toBeInstanceOf(TeamMoveSecretScanError);
    const ok = await exportAndEncrypt({ skipFlagged: true });
    const entry = ok.result.manifest.projects.find((p) => p.id === plain.id)!;
    expect(entry.work!.skipped).toEqual([expect.objectContaining({ path: 'keys.txt', reason: 'secret_scan' })]);
    expect(entry.work!.files).toBe(1);
    expect(ok.result.manifest.files.some((f) => f.path.endsWith('keys.txt'))).toBe(false);
  });

  it('archives the team on the source and restores it on rollback', async () => {
    const poolFile = path.join(fx.home, 'task-pool', 'pool.json');
    const decisionStatus: Record<string, string> = { 'D-1': 'open' };
    const stopped: string[] = [];
    const unlinked: string[] = [];
    let adoptedBack: Record<string, unknown> | null = null;
    const archiver = new TeamMoveArchiver({
      home: fx.home,
      storage: {
        getTeams: () => sourceStorage.getTeams(),
        saveTeam: (t) => sourceStorage.saveTeam(t),
        detachTeamForMove: (id) => sourceStorage.detachTeamForMove(id),
        getScheduledMessages: () => sourceStorage.getScheduledMessages(),
        saveScheduledMessage: (m) => sourceStorage.saveScheduledMessage(m),
        deleteScheduledMessage: (id) => sourceStorage.deleteScheduledMessage(id),
      },
      runtime: {
        stopTeam: async (id) => void stopped.push(id),
        startTeam: async (id) => {
          started.push(id);
          return { ok: true };
        },
      },
      pool: {
        read: () => safeReadJson(poolFile, { workItems: [] }) as never,
        removeWorkItems: async (ids) => {
          const pool = await safeReadJson<{ workItems: Array<{ id: string }> }>(poolFile, { workItems: [] });
          pool.workItems = pool.workItems.filter((w) => !ids.includes(w.id));
          await atomicWriteJson(poolFile, pool);
          return ids.length;
        },
        addWorkItems: async (items) => {
          const pool = await safeReadJson<{ workItems: Array<{ id: string }> }>(poolFile, { workItems: [] });
          for (const it of items) if (!pool.workItems.some((w) => w.id === it.id)) pool.workItems.push(it as never);
          await atomicWriteJson(poolFile, pool);
          return items.length;
        },
      },
      decisions: {
        list: async () => [{ id: 'D-1', status: decisionStatus['D-1']!, teamId: F.teamId }],
        setStatus: async (id, status) => void (decisionStatus[id] = status),
      },
      slack: {
        unlink: async (teamId) => {
          unlinked.push(teamId);
          return { teamId, slackChannelId: 'C0MOVERS', slackChannelName: 'movers', chatChannelId: F.channelId, createdAt: 'x', autoCreated: true };
        },
        adopt: async (m) => {
          adoptedBack = m;
          return true;
        },
      },
    });

    const events: string[] = [];
    sourceStorage.onStorageEvent((e) => void events.push(e.kind));
    const meta = await archiver.archive('move-archive-0001', F.teamId);
    // Schedulers let go of the team, but Slack and Cloud see no delete (it would remove the agents' Slack apps).
    expect(events).toEqual(['team-moved-away']);
    expect(meta!.state).toBe('archived');
    expect(Date.parse(meta!.expiresAt) - Date.parse(meta!.archivedAt)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(stopped).toEqual([F.teamId]);
    // Hidden: the team is gone from live storage, the decoy stays, work is released.
    expect((await sourceStorage.getTeams()).map((t) => t.id)).toEqual([F.decoyTeamId]);
    expect((await safeReadJson<{ workItems: Array<{ id: string }> }>(poolFile, { workItems: [] })).workItems.map((w) => w.id).sort()).toEqual(['wi-decoy', 'wi-done']);
    expect(decisionStatus['D-1']).toBe('cancelled');
    expect(unlinked).toEqual([F.teamId]);
    const db = openChatDatabase({ dbPath: path.join(fx.home, 'chat.db'), skipIntegrityCheck: true });
    try {
      expect((db.prepare('SELECT COUNT(*) c FROM chat_channels WHERE archived_at IS NOT NULL').get() as { c: number }).c).toBe(2);
    } finally {
      db.close();
    }
    // Archiving again is a no-op.
    expect((await archiver.archive('move-archive-0001', F.teamId))!.archivedAt).toBe(meta!.archivedAt);

    const restored = await archiver.restore('move-archive-0001');
    expect(restored).toMatchObject({ restored: true, started: true });
    expect((await sourceStorage.getTeams()).map((t) => t.id).sort()).toEqual([F.decoyTeamId, F.teamId].sort());
    expect(await fs.readFile(path.join(fx.home, 'teams', F.teamId, 'norms', 'review.md'), 'utf8')).toContain('Review norm');
    expect((await safeReadJson<{ workItems: Array<{ id: string }> }>(poolFile, { workItems: [] })).workItems.map((w) => w.id)).toContain('wi-queued');
    expect(decisionStatus['D-1']).toBe('open');
    expect(adoptedBack).toMatchObject({ slackChannelId: 'C0MOVERS' });
    expect(started).toEqual([F.teamId]);
    const db2 = openChatDatabase({ dbPath: path.join(fx.home, 'chat.db'), skipIntegrityCheck: true });
    try {
      expect((db2.prepare('SELECT COUNT(*) c FROM chat_channels WHERE archived_at IS NOT NULL').get() as { c: number }).c).toBe(0);
    } finally {
      db2.close();
    }
    expect(await archiver.restore('move-archive-0001')).toMatchObject({ restored: false });
  });

  it('purges archives after their 7 days', async () => {
    const clock = { now: '2026-10-10T00:00:00.000Z' };
    const archiver = new TeamMoveArchiver({
      home: fx.home,
      now: () => clock.now,
      storage: {
        getTeams: () => sourceStorage.getTeams(),
        saveTeam: (t) => sourceStorage.saveTeam(t),
        detachTeamForMove: (id) => sourceStorage.detachTeamForMove(id),
        getScheduledMessages: async () => [],
        saveScheduledMessage: async () => undefined,
        deleteScheduledMessage: async () => true,
      },
      runtime: { stopTeam: async () => undefined, startTeam: async () => ({ ok: true }) },
      pool: { read: async () => ({ workItems: [] }), removeWorkItems: async () => 0, addWorkItems: async () => 0 },
      decisions: { list: async () => [], setStatus: async () => undefined },
      slack: { unlink: async () => null, adopt: async () => false },
    });
    await archiver.archive('move-purge-000001', F.teamId);
    clock.now = '2026-10-16T00:00:00.000Z';
    expect(await archiver.purgeExpired()).toEqual([]);
    clock.now = '2026-10-18T00:00:00.000Z';
    expect(await archiver.restore('move-purge-000001')).toMatchObject({ restored: false, error: 'the archive has expired' });
    expect(await archiver.purgeExpired()).toEqual(['move-purge-000001']);
    expect((await archiver.readMeta('move-purge-000001'))!.state).toBe('purged');
  });
});
