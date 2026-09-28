/**
 * Tests for the project ticket store: CRUD, state machine, tolerance of
 * hand-edited / invalid files, pickup of outside edits, concurrency.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectTicketError, ProjectTicketService } from './project-ticket.service.js';
import type { ComponentLogger } from '../core/logger.service.js';

function silentLogger(): ComponentLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as ComponentLogger;
}

describe('ProjectTicketService', () => {
  let project: string;
  let svc: ProjectTicketService;
  let logger: ComponentLogger;
  let ensureTracked: jest.Mock;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-project-'));
    logger = silentLogger();
    ensureTracked = jest.fn().mockResolvedValue('tracked');
    svc = new ProjectTicketService({ logger, ensureTracked });
  });

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  it('lists nothing for a project without a tickets folder', async () => {
    expect(await svc.list(project)).toEqual({ tickets: [], invalid: [] });
  });

  it('creates a ticket file with defaults, a Log line and a project-scoped id', async () => {
    const t = await svc.create(project, 'crewly', { title: '  Export  as CSV ', description: 'why', acceptance: ['header row'] }, 'owner');
    expect(t).toMatchObject({ id: 'CREW-1', title: 'Export as CSV', status: 'backlog', priority: 'P2', assignee: null, fileName: 'CREW-1-export-as-csv.md' });
    expect(t.acceptance).toEqual([{ text: 'header row', done: false }]);
    expect(t.log[0]).toMatch(/ · owner · created \(backlog\)$/);
    const onDisk = await fs.readFile(path.join(project, '.crewly', 'tickets', 'CREW-1-export-as-csv.md'), 'utf8');
    expect(onDisk).toContain('## Acceptance criteria\n\n- [ ] header row');
    expect(ensureTracked).toHaveBeenCalledWith(project);
  });

  it('checks git tracking only once per project', async () => {
    await svc.create(project, 'p', { title: 'a' }, 'owner');
    await svc.create(project, 'p', { title: 'b' }, 'owner');
    expect(ensureTracked).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty title or an unreadable priority', async () => {
    await expect(svc.create(project, 'p', { title: ' ' }, 'owner')).rejects.toMatchObject({ status: 400 });
    await expect(svc.create(project, 'p', { title: 'x', priority: 'P7' }, 'owner')).rejects.toBeInstanceOf(ProjectTicketError);
  });

  it('gets a ticket by id (case-insensitive) with its body', async () => {
    await svc.create(project, 'p', { title: 'x' }, 'owner');
    const t = await svc.get(project, 'p-1');
    expect(t?.id).toBe('P-1');
    expect(t?.body).toContain('## Log');
    expect(await svc.get(project, 'P-99')).toBeNull();
  });

  it('updates owned fields and sections, logging what changed', async () => {
    await svc.create(project, 'p', { title: 'x' }, 'owner');
    const t = await svc.update(project, 'P-1', { priority: 'high', labels: ['ui', 'ui', ' bug '], description: 'new', acceptance: [{ text: 'a', done: true }] }, 'dev-1', 'context');
    expect(t).toMatchObject({ priority: 'P1', labels: ['ui', 'bug'], description: 'new', acceptance: [{ text: 'a', done: true }] });
    expect(t.log.at(-1)).toMatch(/dev-1 · updated priority P1, labels, description, acceptance criteria — context$/);
  });

  it('enforces the state machine', async () => {
    await svc.create(project, 'p', { title: 'x' }, 'owner');
    await expect(svc.transition(project, 'P-1', 'done', 'owner')).rejects.toMatchObject({ status: 400 });
    const ready = await svc.transition(project, 'P-1', 'ready', 'owner', 'groomed');
    expect(ready.status).toBe('ready');
    expect(ready.log.at(-1)).toMatch(/owner · backlog → ready — groomed$/);
    const started = await svc.transition(project, 'P-1', 'in_progress', 'dev-1', undefined, { assignee: 'dev-1', workItemId: 'wi-1' });
    expect(started).toMatchObject({ status: 'in_progress', assignee: 'dev-1', workItemId: 'wi-1' });
    // same status is a no-op, not an error
    const again = await svc.transition(project, 'P-1', 'in_progress', 'dev-1');
    expect(again.log).toHaveLength(started.log.length);
  });

  it('404s on a missing ticket', async () => {
    await expect(svc.appendLog(project, 'P-9', 'owner', 'hi')).rejects.toMatchObject({ status: 404 });
  });

  it('appends notes to the Log', async () => {
    await svc.create(project, 'p', { title: 'x' }, 'owner');
    const t = await svc.appendLog(project, 'P-1', 'dev-1', 'halfway there');
    expect(t.log.at(-1)).toMatch(/dev-1 · halfway there$/);
    await expect(svc.appendLog(project, 'P-1', 'dev-1', '  ')).rejects.toMatchObject({ status: 400 });
  });

  it('skips invalid and duplicate files with a warning, never crashing', async () => {
    await svc.create(project, 'p', { title: 'good' }, 'owner');
    const dir = svc.ticketsDir(project);
    await fs.writeFile(path.join(dir, 'broken.md'), 'no frontmatter here');
    await fs.writeFile(path.join(dir, 'P-1-zcopy.md'), '---\nid: P-1\ntitle: dup\nstatus: ready\n---\n');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignored');
    const { tickets, invalid } = await svc.list(project);
    expect(tickets.map((t) => t.id)).toEqual(['P-1']);
    expect(invalid.map((i) => i.fileName).sort()).toEqual(['P-1-zcopy.md', 'broken.md']);
    expect(logger.warn).toHaveBeenCalledWith('Skipping invalid project ticket file', expect.objectContaining({ error: 'missing YAML frontmatter' }));
    // warned once per file version
    await svc.list(project);
    expect((logger.warn as jest.Mock).mock.calls.filter((c) => c[0] === 'Skipping invalid project ticket file')).toHaveLength(1);
  });

  it('picks up edits made outside Crewly (human edit / git pull) on the next read', async () => {
    const t = await svc.create(project, 'p', { title: 'x' }, 'owner');
    await svc.list(project);
    const text = await fs.readFile(t.filePath, 'utf8');
    await fs.writeFile(t.filePath, text.replace('status: backlog', 'status: ready').replace('title: x', 'title: edited by hand'));
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(t.filePath, later, later);
    const { tickets } = await svc.list(project);
    expect(tickets[0]).toMatchObject({ status: 'ready', title: 'edited by hand' });
    // a new file dropped in by a pull appears too; a deleted one disappears
    await fs.writeFile(path.join(svc.ticketsDir(project), 'P-7-pulled.md'), '---\nid: P-7\ntitle: pulled\nstatus: ready\npriority: P0\n---\n');
    expect((await svc.list(project)).tickets.map((x) => x.id)).toEqual(['P-7', 'P-1']);
    await fs.unlink(t.filePath);
    expect((await svc.list(project)).tickets.map((x) => x.id)).toEqual(['P-7']);
  });

  it('keeps a human-edited body intact through service writes', async () => {
    const t = await svc.create(project, 'p', { title: 'x' }, 'owner');
    const text = await fs.readFile(t.filePath, 'utf8');
    const human = text.replace('## Log', '## Design notes\n\nKeep *this* exactly.  \n\n## Log');
    await fs.writeFile(t.filePath, human);
    await svc.transition(project, 'P-1', 'ready', 'owner');
    const after = await fs.readFile(t.filePath, 'utf8');
    expect(after).toContain('## Design notes\n\nKeep *this* exactly.  \n\n## Log');
  });

  it('gives unique ids to concurrent creates', async () => {
    const created = await Promise.all(Array.from({ length: 15 }, (_, i) => svc.create(project, 'p', { title: `t${i}` }, 'owner')));
    expect(new Set(created.map((c) => c.id)).size).toBe(15);
    expect((await svc.list(project)).tickets).toHaveLength(15);
  });

  it('sorts by status, then priority, then number', async () => {
    await svc.create(project, 'p', { title: 'a', priority: 'P3' }, 'owner');
    await svc.create(project, 'p', { title: 'b', priority: 'P0' }, 'owner');
    await svc.create(project, 'p', { title: 'c', status: 'ready' }, 'owner');
    expect((await svc.list(project)).tickets.map((t) => t.title)).toEqual(['b', 'a', 'c']);
  });
});
