/**
 * Tests for `crewly tickets list|migrate` — temp project folders only.
 */
jest.mock('chalk', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: () => {
      const fn = (s: string) => s;
      return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
    },
  }),
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { formatMigrationReport, resolveProjectName, ticketsCommand } from './tickets.js';
import { ProjectTicketService } from '../../../backend/src/services/project-tickets/project-ticket.service.js';
import type { ComponentLogger } from '../../../backend/src/services/core/logger.service.js';

const quiet = (): ComponentLogger =>
  ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

describe('crewly tickets', () => {
  let project: string;
  let svc: ProjectTicketService;
  let out: string[];
  const print = (l: string) => void out.push(l);

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-cli-tickets-'));
    svc = new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' });
    out = [];
    await fs.mkdir(path.join(project, '.crewly', 'tasks', 'm1', 'open'), { recursive: true });
    await fs.writeFile(path.join(project, '.crewly', 'tasks', 'm1', 'open', 'a.md'), '# Old task\n**Priority:** high\n');
  });

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  it('migrate is a dry run by default, then imports with --apply, idempotently', async () => {
    expect(await ticketsCommand('migrate', project, { name: 'App' }, print, svc)).toBe(0);
    expect(out.join('\n')).toContain('Dry run');
    expect(out.join('\n')).toContain('Re-run with --apply');
    expect((await svc.list(project)).tickets).toHaveLength(0);

    out = [];
    expect(await ticketsCommand('migrate', project, { name: 'App', apply: true }, print, svc)).toBe(0);
    expect(out.join('\n')).toContain('+ APP-1  [P1] Old task');
    expect(await ticketsCommand('migrate', project, { name: 'App', apply: true, json: true }, print, svc)).toBe(0);
    expect(JSON.parse(out[out.length - 1])).toMatchObject({ created: 0, skipped: 1 });
  });

  it('lists tickets, with a status filter and JSON', async () => {
    await svc.create(project, 'App', { title: 'Ready one', status: 'ready' }, 'owner');
    await svc.create(project, 'App', { title: 'Later' }, 'owner');
    expect(await ticketsCommand('list', project, { status: 'ready' }, print, svc)).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Ready one');
    out = [];
    await ticketsCommand('list', project, { json: true }, print, svc);
    expect(JSON.parse(out[0]).tickets).toHaveLength(2);
  });

  it('rejects unknown actions', async () => {
    expect(await ticketsCommand('explode', project, {}, print, svc)).toBe(1);
  });

  it('uses --name, else the folder name when the project is not registered', async () => {
    expect(await resolveProjectName(project, ' Named ')).toBe('Named');
  });

  it('formats a report with per-milestone counts', () => {
    const lines = formatMigrationReport({
      projectPath: '/p',
      apply: true,
      scanned: 1,
      toCreate: 1,
      created: 1,
      skipped: 0,
      byMilestone: { m1: { create: 1, skip: 0 } },
      items: [{ source: '.crewly/tasks/m1/open/a.md', milestone: 'm1', v1Status: 'open', title: 'A', priority: 'P2', action: 'create', ticketId: 'P-1' }],
    });
    expect(lines).toContain('    m1: 1 to import, 0 skipped');
    expect(lines.at(-1)).toContain('+ P-1  [P2] A');
  });
});
