import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';

/**
 * Behavioural tests for the `block-task` skill's `afterWorkItemId` option
 * (CREW-733: a brief that says "start after X" must wait for X instead of
 * being bounced by the stall detector).
 *
 * Runs the real `execute.sh` against a stub API (the skill honours
 * `CREWLY_API_URL`) and asserts the request it sends to /task-pool/block.
 */

const SKILL = join(__dirname, '..', 'execute.sh');

interface Captured {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];

/**
 * Runs the skill with the stub API wired in.
 *
 * @param input - JSON input for execute.sh
 * @returns exit code and output
 */
function runSkill(input: Record<string, unknown>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'bash',
      [SKILL, JSON.stringify(input)],
      { env: { ...process.env, CREWLY_API_URL: baseUrl }, timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

beforeAll((done) => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep empty */ }
      const path = req.url ?? '';
      captured.push({ method: req.method ?? '', path, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && path.includes('/task-pool/items/')) {
        res.end(JSON.stringify({ success: true, data: { id: 'wi-1', status: 'running' } }));
        return;
      }
      res.end(JSON.stringify({ success: true, message: 'WorkItem wi-1 blocked' }));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => { captured = []; });

const blockCall = (): Captured | undefined => captured.find((c) => c.path.includes('/task-pool/block/'));

describe('block-task afterWorkItemId', () => {
  const base = { workItemId: 'wi-1', sessionName: 'dev-1', reason: 'brief says start after the deploy' };

  it('sends afterWorkItemId to the block endpoint', async () => {
    const r = await runSkill({ ...base, afterWorkItemId: 'wi-up' });

    expect(r.code).toBe(0);
    expect(captured.some((c) => c.path.includes('/task-pool/block/'))).toBe(true);
    expect(blockCall()!.body).toMatchObject({ agentId: 'dev-1', afterWorkItemId: 'wi-up' });
    expect(blockCall()!.body.until).toBeUndefined();
  });

  it('sends no afterWorkItemId when none is given', async () => {
    await runSkill(base);
    expect(blockCall()!.body.afterWorkItemId).toBeUndefined();
  });

  it('refuses afterWorkItemId together with until, sending nothing', async () => {
    const r = await runSkill({ ...base, afterWorkItemId: 'wi-up', until: '2099-01-01T00:00:00Z' });

    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/not both/);
    expect(blockCall()).toBeUndefined();
  });
});
