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
/** When true the stub answers a delivery as the backend does for a worker that is not running. */
let workerDown = false;
/** When true the stub knows a team that owns worker-1. */
let teamsKnown = false;
/** Extra fields of the stub's /task-pool/add `data`. */
let addExtra: Record<string, unknown> = {};
/** Status the stub reports for GET /task-pool/items/<id> (absent id → 404). */
let upstreamStatus: Record<string, string> = {};

/**
 * Runs the skill with the stub API wired in.
 *
 * @param args - CLI arguments for execute.sh
 * @returns exit code and stdout/stderr
 */
function runSkill(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // stdin is closed right away: with no --task the skill reads the brief
    // from stdin, and an open pipe would wait forever.
    const child = execFile(
      'bash',
      [SKILL, ...args],
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
        if (workerDown) {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, queued: true, waking: true, message: 'The agent is not running. The message is queued and the agent is being started; it is delivered when the agent is ready.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (teamsKnown && /\/api\/teams(\/team-1)?$/.test(path) && req.method === 'GET') {
        const team = { id: 'team-1', members: [{ id: 'm-worker', sessionName: 'worker-1' }] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: path.endsWith('team-1') ? team : [team] }));
        return;
      }
      const itemMatch = /\/task-pool\/items\/([^/?]+)$/.exec(path);
      if (itemMatch && req.method === 'GET') {
        const status = upstreamStatus[itemMatch[1]];
        if (!status) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { id: itemMatch[1], status } }));
        return;
      }
      if (path.includes('/task-pool/add')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { id: 'wi-created-1', ...addExtra } }));
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

beforeEach(() => { captured = []; failDelivery = false; workerDown = false; teamsKnown = false; addExtra = {}; upstreamStatus = {}; });

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

describe('delegate-task hands the WorkItem over with its id (fresh conversation, single delivery)', () => {
  const args = ['--to', 'worker-1', '--task', 'do the thing', '--project', '/tmp/proj'];

  it('flags the WorkItem as delivered directly so the queued push holds off', async () => {
    await runSkill(args);
    const add = captured.find((c) => c.path.includes('/task-pool/add'));
    expect((add?.body as { metadata?: Record<string, unknown> })?.metadata?.directDelivery).toBe(true);
  });

  it('sends the workItemId with the delivery and names it in the text', async () => {
    await runSkill(args);
    const deliver = captured.find((c) => c.path.includes('/deliver'));
    const body = deliver?.body as { workItemId?: string; message?: string };
    expect(body.workItemId).toBe('wi-created-1');
    expect(body.message).toContain('WorkItem wi-created-1');
    expect(body.message).not.toContain('<your WorkItem id>');
  });

  it('carries the workItemId on the force fallback too', async () => {
    failDelivery = true;
    await runSkill(args);
    const delivers = captured.filter((c) => c.path.includes('/deliver'));
    expect(delivers.length).toBeGreaterThanOrEqual(2);
    for (const d of delivers) expect((d.body as { workItemId?: string }).workItemId).toBe('wi-created-1');
  });
});

describe('delegate-task owner thread + no member fits (crewly#1083)', () => {
  const base = ['--to', 'worker-1', '--task', 'Goal: x. Outcome: y. Eval: z.', '--project', '/tmp/proj'];

  it('--thread sends the owner thread key on the WorkItem metadata', async () => {
    await runSkill([...base, '--thread', 'C0THINK:1790000000.000100']);
    const add = captured.find((c) => c.path.includes('/task-pool/add'));
    expect((add?.body as { metadata?: { ownerThread?: string } }).metadata?.ownerThread).toBe('C0THINK:1790000000.000100');
  });

  it('omits ownerThread when --thread is not given', async () => {
    await runSkill(base);
    const add = captured.find((c) => c.path.includes('/task-pool/add'));
    expect((add?.body as { metadata?: Record<string, unknown> }).metadata).not.toHaveProperty('ownerThread');
  });

  it('--force-after-answer sets forceAfterAnswer on the WorkItem metadata, and is absent without it (CREW-878)', async () => {
    await runSkill([...base, '--thread', 'C0THINK:1790000000.000100', '--force-after-answer']);
    await runSkill([...base, '--thread', 'C0THINK:1790000000.000100']);
    const adds = captured.filter((c) => c.path.includes('/task-pool/add')).map((c) => (c.body as { metadata: Record<string, unknown> }).metadata);
    expect(adds).toHaveLength(2);
    expect(adds[0].forceAfterAnswer).toBe(true);
    expect(adds[1]).not.toHaveProperty('forceAfterAnswer');
  });

  it('--conversation sends the owner conversation id on the WorkItem metadata (crewly#1357)', async () => {
    await runSkill([...base, '--conversation', 'room-video']);
    const add = captured.find((c) => c.path.includes('/task-pool/add'));
    expect((add?.body as { metadata?: { ownerConversation?: string } }).metadata?.ownerConversation).toBe('room-video');
    await runSkill(base);
    const plain = captured.filter((c) => c.path.includes('/task-pool/add')).pop();
    expect((plain?.body as { metadata?: Record<string, unknown> }).metadata).not.toHaveProperty('ownerConversation');
  });

  it('appends the backend\'s result-route note (the result goes to the delegator) to the delivered brief (crewly#1357)', async () => {
    addExtra = { resultRoute: { to: 'tl-1', note: 'Ella delegated this on their own initiative; the owner did not ask for it in any thread. Do not post it to the owner.' } };
    await runSkill(base);
    const deliver = captured.find((c) => c.path.includes('/deliver'));
    expect(String((deliver?.body as { message?: string }).message)).toContain('Do not post it to the owner.');
  });

  it('appends the backend\'s owner-thread note to the delivered brief', async () => {
    addExtra = { ownerThread: { key: 'C0THINK:1790000000.000100', note: 'The owner asked for this in Slack thread [SLACK-THREAD:C0THINK:1790000000.000100]. Post your progress and your result there yourself.' } };
    await runSkill(base);
    const deliver = captured.find((c) => c.path.includes('/deliver'));
    expect(String((deliver?.body as { message?: string }).message)).toContain('[SLACK-THREAD:C0THINK:1790000000.000100]');
  });

  it('--no-member-fits records the kept work and delivers nothing', async () => {
    const r = await runSkill(['--no-member-fits', 'needs the owner\'s Stripe login', '--task', 'Update billing settings', '--work-item', 'wi-9']);
    expect(r.code).toBe(0);
    const rec = captured.find((c) => c.path.includes('/teams/lead-self-work'));
    expect(rec?.body).toEqual({ reason: "needs the owner's Stripe login", work: 'Update billing settings', workItemId: 'wi-9' });
    const note = captured.find((c) => c.path.includes('/task-pool/items/wi-9/notes'));
    expect(String((note?.body as { note?: string }).note)).toContain('[NO-MEMBER-FITS]');
    expect(indexOf('/deliver')).toBe(-1);
    expect(indexOf('/task-pool/add')).toBe(-1);
  });

  it('--no-member-fits without --task fails', async () => {
    const r = await runSkill(['--no-member-fits', 'no access']);
    expect(r.code).not.toBe(0);
    expect(indexOf('/teams/lead-self-work')).toBe(-1);
  });
});

describe('delegate-task auto-start of an offline worker', () => {
  const args = ['--to', 'worker-1', '--task', 'do the thing', '--project', '/tmp/proj'];

  it('starts the worker via its team, passing the workItemId, even without --team', async () => {
    failDelivery = true;
    teamsKnown = true;
    await runSkill(args);

    const start = captured.find((c) => /\/teams\/team-1\/members\/m-worker\/start/.test(c.path));
    expect(start).toBeDefined();
    expect((start?.body as { workItemId?: string })?.workItemId).toBe('wi-created-1');
  }, 60_000);
});

describe('delegate-task says whether the brief was delivered or only queued (2026-11-14)', () => {
  const args = ['--to', 'worker-1', '--task', 'Goal: x. Outcome: y. Eval: z.', '--from', 'lead-1'];
  /** The last JSON line the skill printed. */
  const lastLine = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').pop() ?? '{}');

  it('a brief written into the running session ends with delivery: delivered', async () => {
    const { code, stdout } = await runSkill(args);
    expect(code).toBe(0);
    expect(lastLine(stdout)).toMatchObject({ success: true, delivery: 'delivered', to: 'worker-1', workItemId: 'wi-created-1' });
  });

  it('a worker that is not running ends with delivery: queued and tells the lead what to say', async () => {
    workerDown = true;
    const { code, stdout } = await runSkill(args);
    expect(code).toBe(0);
    const last = lastLine(stdout);
    expect(last).toMatchObject({ success: true, delivery: 'queued', to: 'worker-1', workItemId: 'wi-created-1' });
    expect(last.info).toContain('NOT DELIVERED YET');
    expect(last.info).toContain('queued for worker-1, not yet picked up');
    expect(last.info).toContain('Do not tell anyone the task was handed over');
    // The queued answer is not a failure: no force write, no [UNDELIVERED] note.
    expect(captured.filter((c) => c.path.includes('/deliver'))).toHaveLength(1);
    expect(captured.some((c) => c.path.includes('/notes'))).toBe(false);
  });
});


describe('delegate-task --after (CREW-733: "start after another job")', () => {
  const args = ['--to', 'worker-1', '--task', 'start after the deploy', '--project', '/tmp/proj'];

  it('creates the item blocked on the upstream item and delivers nothing', async () => {
    upstreamStatus = { 'wi-up': 'running' };
    addExtra = { status: 'blocked' };
    const r = await runSkill([...args, '--after', 'wi-up']);

    expect(r.code).toBe(0);
    const add = captured.find((c) => c.path.includes('/task-pool/add'));
    expect(add).toBeDefined();
    const body = add!.body as { dependsOn?: string[]; metadata?: Record<string, unknown> };
    expect(body.dependsOn).toEqual(['wi-up']);
    // Not marked for direct delivery: the backend delivers it when it is promoted to queued.
    expect(body.metadata?.directDelivery).toBeUndefined();
    // Nothing is delivered, subscribed or scheduled while it waits.
    expect(captured.some((c) => c.path.includes('/deliver'))).toBe(false);
    expect(captured.some((c) => c.path.includes('/events/subscribe') || c.path.includes('/schedule'))).toBe(false);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: true, workItemId: 'wi-created-1', after: 'wi-up' });
  });

  it('without --after the item has no dependsOn and is delivered as before', async () => {
    await runSkill(args);
    const body = captured.find((c) => c.path.includes('/task-pool/add'))!.body as { dependsOn?: string[]; metadata?: Record<string, unknown> };
    expect(body.dependsOn).toBeUndefined();
    expect(body.metadata?.directDelivery).toBe(true);
    expect(captured.some((c) => c.path.includes('/deliver'))).toBe(true);
  });

  it.each([
    ['an unknown upstream item', {} as Record<string, string>, /no such WorkItem/],
    ['an upstream item that is already done', { 'wi-up': 'done' }, /nothing to wait for/],
    ['an upstream item that was cancelled', { 'wi-up': 'cancelled' }, /will never succeed/],
  ])('refuses %s before creating anything', async (_label, statuses, message) => {
    upstreamStatus = statuses;
    const r = await runSkill([...args, '--after', 'wi-up']);

    expect(r.code).not.toBe(0);
    expect(r.stdout).toMatch(message);
    expect(captured.some((c) => c.path.includes('/task-pool/add'))).toBe(false);
    expect(captured.some((c) => c.path.includes('/deliver'))).toBe(false);
  });
});
