/**
 * Tests for the v1 `.crewly/tasks` → project tickets migration: dry-run,
 * apply, idempotency, originals untouched, done/ not imported.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { demoteHeadings, migrateV1Tasks, parseV1Task } from './v1-task-migration.js';
import { ProjectTicketService } from './project-ticket.service.js';
import type { ComponentLogger } from '../core/logger.service.js';

const quiet = (): ComponentLogger =>
  ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

const V1_INLINE = [
  '# Set up TPM',
  '',
  '**Status:** open',
  '**Priority:** high',
  '',
  '## Description',
  'Install the TPM tooling.',
  '',
  '## Acceptance Criteria',
  '- tpm installed',
  '- [x] docs updated',
  '',
  '## Notes',
  'none',
  '',
].join('\n');

const V1_FRONTMATTER = [
  '---',
  'id: m1_auth_web.01',
  'priority: P0',
  'labels: [auth, web]',
  '---',
  '',
  '# m1.01: Login form',
  '',
  '```bash',
  '# not a heading',
  '```',
  '',
].join('\n');

describe('v1 migration', () => {
  let project: string;
  let tickets: ProjectTicketService;
  const tasks = (...p: string[]) => path.join(project, '.crewly', 'tasks', ...p);

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-v1-'));
    tickets = new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' });
    await fs.mkdir(tasks('m1_foundation', 'open'), { recursive: true });
    await fs.mkdir(tasks('m1_foundation', 'done'), { recursive: true });
    await fs.mkdir(tasks('delegated', 'in_progress'), { recursive: true });
    await fs.mkdir(tasks('delegated', 'blocked'), { recursive: true });
    await fs.writeFile(tasks('m1_foundation', 'open', '01_setup_tpm.md'), V1_INLINE);
    await fs.writeFile(tasks('delegated', 'in_progress', 'login_form.md'), V1_FRONTMATTER);
    await fs.writeFile(tasks('m1_foundation', 'done', 'old.md'), '# Finished long ago\n');
    await fs.writeFile(tasks('delegated', 'blocked', 'stuck.md'), '# Stuck\n');
    await fs.writeFile(tasks('checklist-x.json'), '{}');
  });

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  it('dry-run reports without writing anything', async () => {
    const report = await migrateV1Tasks(tickets, project, 'App');
    expect(report).toMatchObject({ apply: false, scanned: 2, toCreate: 2, created: 0, skipped: 0 });
    expect(report.byMilestone).toEqual({ delegated: { create: 1, skip: 0 }, m1_foundation: { create: 1, skip: 0 } });
    expect(report.items.map((i) => [i.source, i.v1Status, i.title, i.priority])).toEqual([
      ['.crewly/tasks/delegated/in_progress/login_form.md', 'in_progress', 'm1.01: Login form', 'P0'],
      ['.crewly/tasks/m1_foundation/open/01_setup_tpm.md', 'open', 'Set up TPM', 'P1'],
    ]);
    await expect(fs.access(path.join(project, '.crewly', 'tickets'))).rejects.toThrow();
  });

  it('apply creates backlog tickets, keeps originals, and is idempotent', async () => {
    const before = await fs.readFile(tasks('m1_foundation', 'open', '01_setup_tpm.md'), 'utf8');
    const run = await migrateV1Tasks(tickets, project, 'App', { apply: true });
    expect(run.created).toBe(2);
    const { tickets: all } = await tickets.list(project);
    expect(all).toHaveLength(2);
    for (const t of all) expect(t).toMatchObject({ status: 'backlog', source: 'v1-migration' });
    const tpm = all.find((t) => t.title === 'Set up TPM')!;
    expect(tpm.migratedFrom).toBe('.crewly/tasks/m1_foundation/open/01_setup_tpm.md');
    expect(tpm.labels).toEqual(['milestone:m1_foundation']);
    expect(tpm.acceptance).toEqual([
      { text: 'tpm installed', done: false },
      { text: 'docs updated', done: true },
    ]);
    // the whole original body lives in the Description, headings demoted
    expect(tpm.description).toContain('### Set up TPM');
    expect(tpm.description).toContain('#### Notes');
    expect(await fs.readFile(tasks('m1_foundation', 'open', '01_setup_tpm.md'), 'utf8')).toBe(before);

    const again = await migrateV1Tasks(tickets, project, 'App', { apply: true });
    expect(again).toMatchObject({ created: 0, toCreate: 0, skipped: 2 });
    expect(again.items.every((i) => i.action === 'skip-existing' && i.ticketId)).toBe(true);
    expect((await tickets.list(project)).tickets).toHaveLength(2);
  });

  it('can limit the run to some milestones', async () => {
    const run = await migrateV1Tasks(tickets, project, 'App', { apply: true, milestones: ['m1_foundation'] });
    expect(run.created).toBe(1);
    expect(run.items.find((i) => i.milestone === 'delegated')?.action).toBe('skip-milestone');
  });

  it('handles a project with no v1 folder', async () => {
    await fs.rm(path.join(project, '.crewly'), { recursive: true, force: true });
    expect(await migrateV1Tasks(tickets, project, 'App')).toMatchObject({ scanned: 0, toCreate: 0 });
  });

  it('parses the frontmatter variant and keeps code fences intact', () => {
    const p = parseV1Task(V1_FRONTMATTER, 'login_form', 'delegated');
    expect(p).toMatchObject({ title: 'm1.01: Login form', priority: 'P0', labels: ['auth', 'web', 'milestone:delegated'] });
    expect(p.description).toContain('```bash\n# not a heading\n```');
  });

  it('falls back to the file name for the title and P2 for the priority', () => {
    expect(parseV1Task('just text', 'fix_the_thing', 'm')).toMatchObject({ title: 'fix the thing', priority: 'P2' });
  });

  it('demotes headings two levels outside fences', () => {
    expect(demoteHeadings('# A\n## B\n```\n# c\n```\ntext #not')).toBe('### A\n#### B\n```\n# c\n```\ntext #not');
  });
});
