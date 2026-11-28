/**
 * Test fixture of the team move: builds a throwaway Crewly home with one team
 * (plus a decoy team that must not travel), its agents' memory, handover notes,
 * a project with `.crewly` data and a git repository, task-pool items,
 * decisions, chat channels and a Slack channel mapping.
 *
 * @module services/team-move/team-move.fixture
 */

import type { TeamMoveTriggerStore } from './team-move-triggers.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openChatDatabase } from '../chat-v2/sqlite/chat-db.js';

/** Ids of the fixture. */
export const FIXTURE = {
  teamId: '11111111-1111-4111-8111-111111111111',
  decoyTeamId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  leadId: 'aaaaaaaa-0000-4000-8000-000000000001',
  devId: 'aaaaaaaa-0000-4000-8000-000000000002',
  leadSession: 'movers-lena-aaaaaaaa',
  devSession: 'movers-dev-bbbbbbbb',
  decoySession: 'decoy-dan-cccccccc',
  channelId: 'chan-0001-team-channel',
  dmId: 'chan-0002-lena-dm',
} as const;

/** A built fixture. */
export interface Fixture {
  root: string;
  home: string;
  projectDir: string;
  remoteDir: string;
  cleanup(): Promise<void>;
}

/**
 * Write a JSON file, creating folders.
 *
 * @param file - Destination
 * @param value - Content
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

/**
 * Write a text file, creating folders.
 *
 * @param file - Destination
 * @param text - Content
 */
async function writeText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/**
 * Build the source machine.
 *
 * @returns Paths and a cleanup function
 */
export async function buildSourceFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-move-fixture-'));
  const home = path.join(root, 'source-home', '.crewly');
  const projectDir = path.join(root, 'source-projects', 'movers-app');
  const remoteDir = path.join(root, 'remote.git');
  const F = FIXTURE;
  const now = '2026-10-10T10:00:00.000Z';

  // Git: a bare remote with one pushed commit; the project is a clone of it.
  await fs.mkdir(remoteDir, { recursive: true });
  git(remoteDir, 'init', '--bare', '-q', '-b', 'main');
  await fs.mkdir(projectDir, { recursive: true });
  git(projectDir, 'init', '-q', '-b', 'main');
  await writeText(path.join(projectDir, 'README.md'), '# movers app\n');
  await writeText(path.join(projectDir, '.gitignore'), '.crewly/\n');
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-q', '-m', 'first');
  git(projectDir, 'remote', 'add', 'origin', remoteDir);
  git(projectDir, 'push', '-q', '-u', 'origin', 'main');

  // Project-local Crewly data.
  await writeText(path.join(projectDir, '.crewly', 'tickets', 'MOV-1-ship-it.md'), `---\nid: MOV-1\nstatus: ready\n---\nShip it from ${projectDir}/src\n`);
  await writeText(path.join(projectDir, '.crewly', 'tickets', 'MOV-2-second.md'), '---\nid: MOV-2\nstatus: backlog\n---\nSecond ticket\n');
  await writeJson(path.join(projectDir, '.crewly', 'missions', 'm1.json'), { id: 'm1', title: 'Launch', objective: 'ship' });
  await writeText(path.join(projectDir, '.crewly', 'findings', 'notes.md'), 'findings\n');
  await writeText(path.join(projectDir, '.crewly', 'logs', 'noise.log'), 'log noise\n');
  await writeText(path.join(projectDir, '.crewly', 'tickets', 'old.md.bak-1'), 'backup\n');

  // Teams.
  const member = (id: string, name: string, role: string, session: string): Record<string, unknown> => ({
    id,
    name,
    sessionName: session,
    role,
    systemPrompt: `You are ${name}. Work in ${projectDir}. Use ffmpeg for video.`,
    agentStatus: 'active',
    workingStatus: 'in_progress',
    runtimeType: 'claude-code',
    readyAt: now,
    dropoutReason: 'idle_exit',
    createdAt: now,
    updatedAt: now,
    agentId: session,
  });
  const teamDir = path.join(home, 'teams', F.teamId);
  await writeJson(path.join(teamDir, 'config.json'), {
    id: F.teamId,
    name: 'Movers',
    description: 'Team that moves',
    members: [member(F.leadId, 'Lena', 'tech-lead', F.leadSession), member(F.devId, 'Dev', 'developer', F.devSession)],
    projectIds: [F.projectId],
    leaderId: F.leadId,
    leaderIds: [F.leadId],
    createdAt: now,
    updatedAt: now,
  });
  await writeText(path.join(teamDir, 'prompts', `${F.leadId}.md`), 'lead prompt');
  await writeText(path.join(teamDir, 'norms', 'review.md'), '# Review norm\nAlways review with Google Drive docs.\n');
  await writeText(path.join(teamDir, 'sops', 'release.md'), '# Release SOP\n');
  await writeText(path.join(teamDir, 'wiki', 'llm-curated', 'index.md'), '# Wiki index\n');
  await writeText(path.join(teamDir, 'wiki', 'llm-curated', 'usage.jsonl'), '{"x":1}\n');
  await writeJson(path.join(teamDir, 'cron-tasks.json'), { tasks: [{ id: 'cron-1', cron: '0 9 * * *', message: 'daily' }] });
  await writeJson(path.join(teamDir, 'config.json.bak-1'), { stale: true });

  const decoyDir = path.join(home, 'teams', F.decoyTeamId);
  await writeJson(path.join(decoyDir, 'config.json'), {
    id: F.decoyTeamId,
    name: 'Decoy',
    members: [member('dddddddd-0000-4000-8000-000000000001', 'Dan', 'developer', F.decoySession)],
    projectIds: [],
    createdAt: now,
    updatedAt: now,
  });

  await writeJson(path.join(home, 'projects.json'), [
    { id: F.projectId, name: 'Movers App', path: projectDir, teams: {}, status: 'stopped', createdAt: now, updatedAt: now },
  ]);

  // Agent memory and handover notes.
  for (const s of [F.leadSession, F.devSession, F.decoySession]) {
    await writeJson(path.join(home, 'agents', s, 'memory.json'), { session: s, notes: [`remember ${s}`] });
    await writeText(path.join(home, 'agents', s, 'standing.md'), `standing answers of ${s}\n`);
    await writeText(path.join(home, 'agents', s, 'sessions', '2026-10-01-10-00.md'), `summary of ${s}\n`);
  }
  for (let i = 0; i < 12; i++) {
    const stamp = `2026-10-${String(i + 1).padStart(2, '0')}T10-00-00-000Z`;
    await writeText(path.join(home, 'handover', `${F.leadSession}-${stamp}.md`), `handover ${i}`);
  }
  await writeText(path.join(home, 'handover', `${F.decoySession}-2026-10-01T10-00-00-000Z.md`), 'decoy handover');

  // Task pool.
  const item = (id: string, target: string, status: string): Record<string, unknown> => ({
    id,
    type: 'delegate',
    owner: 'team_lead',
    target,
    title: `item ${id}`,
    description: `see ${projectDir}`,
    status,
    createdAt: now,
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    startedAt: status === 'running' ? now : undefined,
  });
  await writeJson(path.join(home, 'task-pool', 'pool.json'), {
    workItems: [item('wi-queued', F.devSession, 'queued'), item('wi-running', F.leadSession, 'running'), item('wi-done', F.devSession, 'done'), item('wi-decoy', F.decoySession, 'queued')],
    claims: [],
    lastUpdatedAt: now,
  });

  // Decisions.
  await writeJson(path.join(home, 'owner-decisions.json'), {
    nextId: 3,
    decisions: [
      { id: 'D-1', question: 'Ship?', options: [], defaultKey: 'wait', deadline: now, requestedBy: F.leadSession, asker: F.leadSession, teamId: F.teamId, status: 'open', card: { slackChannelId: 'C1', messageTs: '1.1', postedBy: 'crewly' }, createdAt: now, updatedAt: now },
      { id: 'D-2', question: 'Old?', options: [], defaultKey: 'wait', deadline: now, requestedBy: F.leadSession, asker: F.leadSession, teamId: F.teamId, status: 'resolved', createdAt: now, updatedAt: now },
    ],
  });

  // Slack channel mapping.
  await writeJson(path.join(home, 'slack-team-channels.json'), {
    version: 1,
    autoCreate: true,
    channelPrefix: '',
    mappings: [{ teamId: F.teamId, slackChannelId: 'C0MOVERS', slackChannelName: 'movers', chatChannelId: F.channelId, createdAt: now, autoCreated: true }],
  });

  // Chat channels.
  const db = openChatDatabase({ dbPath: path.join(home, 'chat.db'), skipIntegrityCheck: true });
  try {
    const insert = db.prepare('INSERT INTO chat_channels (id, agent_session, owner_user_id, name, purpose, created_at, type, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(F.channelId, '', 'owner', 'movers', null, Date.parse(now), 'huddle', F.teamId);
    insert.run(F.dmId, F.leadSession, 'owner', 'Lena', null, Date.parse(now), 'dm', null);
    insert.run('chan-0003-decoy-dm', F.decoySession, 'owner', 'Dan', null, Date.parse(now), 'dm', null);
    const member = db.prepare('INSERT INTO chat_channel_members (channel_id, member_session, joined_at) VALUES (?, ?, ?)');
    member.run(F.channelId, F.leadSession, Date.parse(now));
    member.run(F.channelId, F.devSession, Date.parse(now));
  } finally {
    db.close();
  }

  return { root, home, projectDir, remoteDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/**
 * An empty target machine.
 *
 * @param root - Fixture root
 * @returns Target home and projects root
 */
export async function buildTargetPaths(root: string): Promise<{ home: string; projectsRoot: string }> {
  const home = path.join(root, 'target-home', '.crewly');
  const projectsRoot = path.join(root, 'target-projects');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });
  return { home, projectsRoot };
}

/**
 * A trigger store holding nothing, for tests that are not about triggers
 * (those run real engines: team-move-triggers.integration.test.ts).
 *
 * @returns The store
 */
export function emptyTriggerStore(): TeamMoveTriggerStore {
  return {
    list: async () => [],
    restore: async () => ({ imported: [], skipped: [], failed: [] }),
    arm: async () => undefined,
    remove: async () => 0,
  };
}
