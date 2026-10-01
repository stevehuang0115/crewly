/**
 * Tests for the stopped-assignee waker: it goes through the member-start
 * endpoint with the ticket's WorkItem, as the caller, and turns a start
 * gate's refusal into a reported outcome instead of an error.
 */
import { createHttpAssigneeWaker } from './ticket-assignee-waker.js';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

function fakeFetch(status: number, text = ''): { calls: Call[]; fn: Parameters<typeof createHttpAssigneeWaker>[0] } {
  const calls: Call[] = [];
  return {
    calls,
    fn: async (url, init) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    },
  };
}

const req = { teamId: 't-ce', memberId: 'm-nova', session: 'ce-nova-a2b1f759', workItemId: 'wi-1', callerSession: 'ce-owen' };

describe('createHttpAssigneeWaker', () => {
  it('POSTs the member-start endpoint with the WorkItem, as the lead who assigned it', async () => {
    const f = fakeFetch(200, '{"success":true}');
    const wake = createHttpAssigneeWaker(f.fn, () => 'http://localhost:9999');
    await expect(wake(req)).resolves.toEqual({ outcome: 'started' });
    expect(f.calls[0].url).toBe('http://localhost:9999/api/teams/t-ce/members/m-nova/start');
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].init.headers['X-Agent-Session']).toBe('ce-owen');
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ sessionName: 'ce-nova-a2b1f759', workItemId: 'wi-1' });
  });

  it('sends no agent header for the owner and never forges the dashboard marker', async () => {
    const f = fakeFetch(200);
    await createHttpAssigneeWaker(f.fn, () => 'http://x')({ ...req, callerSession: undefined });
    expect(f.calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('reports which start gate refused', async () => {
    const f = fakeFetch(403, '{"success":false,"code":"commitment_requires_owner_approval"}');
    await expect(createHttpAssigneeWaker(f.fn, () => 'http://x')(req)).resolves.toMatchObject({
      outcome: 'blocked',
      code: 'commitment_requires_owner_approval',
    });
    const g = fakeFetch(400, '{"code":"wake_gate_no_pool_work"}');
    await expect(createHttpAssigneeWaker(g.fn, () => 'http://x')(req)).resolves.toMatchObject({ outcome: 'blocked', code: 'wake_gate_no_pool_work' });
  });

  it('reports other failures without throwing', async () => {
    const f = fakeFetch(500, 'boom');
    await expect(createHttpAssigneeWaker(f.fn, () => 'http://x')(req)).resolves.toMatchObject({ outcome: 'failed', detail: 'HTTP 500: boom' });
    const broken = createHttpAssigneeWaker(async () => {
      throw new Error('ECONNREFUSED');
    }, () => 'http://x');
    await expect(broken(req)).resolves.toEqual({ outcome: 'failed', detail: 'ECONNREFUSED' });
  });
});
