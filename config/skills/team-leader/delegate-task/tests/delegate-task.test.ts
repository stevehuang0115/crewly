import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';

/**
 * Behavioural tests for the team-leader `delegate-task` skill's
 * record-before-delivery ordering (WI 65578471).
 *
 * The skill previously created its WorkItem only AFTER delivery succeeded,
 * so a delivery failure exited with no record anywhere — not in the pool,
 * not targeted, nothing for a reconciler or a human to find. Every other
 * orphan class in this system left a WorkItem behind; this one left the
 * intent with no system of record at all.
 *
 * These run the real `execute.sh` against a stub API captured on a random
 * port (the skill honours `CREWLY_API_URL`), so they assert observable call
 * ordering rather than mirroring the implementation.
 */

const SKILL = join(__dirname, '..', 'execute.sh');

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];
/** When true the stub fails every delivery attempt. */
let failDelivery = false;

/**
 * Runs the skill with the stub API wired in.
 *
 * @param args - CLI arguments for execute.sh
 * @returns exit code and stdout/stderr
 */
function runSkill(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [SKILL, ...args],
      { env: { ...process.env, CREWLY_API_URL: baseUrl }, timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

beforeAll((done) => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep raw */ }
      const path = req.url ?? '';
      captured.push({ method: req.method ?? '', path, body });

      if (path.includes('/terminal/') && path.includes('/deliver')) {
        if (failDelivery) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'worker offline' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (path.includes('/task-pool/add')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { id: 'wi-created-1' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: {} }));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    done();
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => { captured = []; failDelivery = false; });

/** Index of the first captured call whose path matches, or -1. */
const indexOf = (needle: string): number =>
  captured.findIndex((c) => c.path.includes(needle));

describe('delegate-task record-before-delivery (WI 65578471)', () => {
  const args = ['--to', 'worker-1', '--task', 'do the thing', '--project', '/tmp/proj'];

  it('creates the WorkItem BEFORE attempting delivery', async () => {
    await runSkill(args);

    const add = indexOf('/task-pool/add');
    const deliver = indexOf('/deliver');
    expect(add).toBeGreaterThanOrEqual(0);
    expect(deliver).toBeGreaterThanOrEqual(0);
    expect(add).toBeLessThan(deliver);
  });

  it('still creates the WorkItem when delivery fails', async () => {
    failDelivery = true;
    await runSkill(args);

    // The regression: previously the pool-add never ran on this path, so
    // the intended work had no record anywhere.
    expect(indexOf('/task-pool/add')).toBeGreaterThanOrEqual(0);
  });

  it('marks the undelivered WorkItem explicitly rather than leaving it to look normal', async () => {
    failDelivery = true;
    await runSkill(args);

    const note = captured.find((c) => c.path.includes('/notes'));
    expect(note).toBeDefined();
    expect(JSON.stringify(note?.body)).toContain('[UNDELIVERED]');
  });

  it('still fails loudly on a delivery failure, and names the WorkItem it left behind', async () => {
    failDelivery = true;
    const { code, stdout } = await runSkill(args);

    // Creating the record must not soften the failure into a success.
    expect(code).not.toBe(0);
    expect(stdout).toContain('Failed to deliver');
    expect(stdout).toContain('wi-created-1');
  });

  it('targets the WorkItem at the intended worker so it stays recoverable', async () => {
    failDelivery = true;
    await runSkill(args);

    const add = captured.find((c) => c.path.includes('/task-pool/add'));
    expect((add?.body as { target?: string })?.target).toBe('worker-1');
  });

  it('does not annotate anything on the happy path', async () => {
    await runSkill(args);
    expect(captured.find((c) => c.path.includes('/notes'))).toBeUndefined();
  });
});
