/**
 * Tests for ticket autopilot tracing (specs/2026-10-03-autopilot-experiments.md §1):
 * the run trace per project and day, ticket traces tagged with the project,
 * day and labels, status events, picks / cancels, and the listener.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore, setTraceStoreForTesting } from '../trace/trace-store.js';
import { getTraceContext, setTraceContextForTesting } from '../trace/trace-context.service.js';
import {
  autopilotRunTrace,
  autopilotTicketTraceForStart,
  createAutopilotTicketListener,
  ticketActor,
  traceAutopilotAction,
  traceAutopilotTicketChange,
  traceAutopilotTicketStarted,
  type AutopilotTicketChange,
} from './ticket-autopilot-trace.js';

const ON = { id: 'p-ce', name: 'CE', ticketAutopilot: { enabled: true } };
const OFF = { id: 'p-off', name: 'Off', ticketAutopilot: { enabled: false } };
const DAY1 = new Date(2026, 9, 3, 10, 0, 0);
const DAY2 = new Date(2026, 9, 4, 10, 0, 0);

describe('ticket-autopilot-trace', () => {
  let dir: string;
  let store: TraceStore;
  const events = async (traceId: string) => (await store.read(traceId, 0, 1000))!.events;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-trace-'));
    store = new TraceStore({ dir, indexFlushDelayMs: 5 });
    setTraceStoreForTesting(store);
    setTraceContextForTesting(null);
  });

  afterEach(async () => {
    await store.idle();
    setTraceStoreForTesting(null);
    setTraceContextForTesting(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps one run trace per project and local day, tagged autopilot', () => {
    const a = autopilotRunTrace(ON, DAY1)!;
    expect(autopilotRunTrace(ON, new Date(2026, 9, 3, 23, 0, 0))).toBe(a);
    const b = autopilotRunTrace(ON, DAY2)!;
    expect(b).not.toBe(a);
    expect(autopilotRunTrace({ id: 'other', name: 'X' }, DAY1)).not.toBe(a);
    expect(store.getEntry(a)).toMatchObject({ root: { kind: 'autopilot', summary: 'Autopilot run: CE 2026-10-03' }, tags: { autopilot: { projectId: 'p-ce', day: '2026-10-03' } } });
    expect(autopilotRunTrace(ON, new Date(2026, 9, 9), false)).toBeNull();
    expect(store.listTagged({ autopilotProjectId: 'p-ce', day: '2026-10-04' }).map((e) => e.traceId)).toEqual([b]);
  });

  it('records actions in the run trace (and a ticket trace when given)', async () => {
    const run = traceAutopilotAction(ON, 'skip', { summary: 'CE: no triage — nobody idle', outcome: 'skipped', data: { reason: 'nobody_idle' }, now: DAY1 })!;
    const evs = await events(run);
    expect(evs.map((e) => e.type)).toEqual(['trace.root', 'autopilot.action']);
    expect(evs[1]).toMatchObject({ outcome: 'skipped', data: { action: 'skip', reason: 'nobody_idle', projectId: 'p-ce' } });
  });

  it('starts a tagged ticket trace with the labels, and records the claim in both traces', async () => {
    const t = { id: 'CE-7', title: 'Feed filter chips', labels: ['visa', 'feed'] };
    const traceId = autopilotTicketTraceForStart(ON, t, { assignee: 'ce-dev', self: true, now: DAY1 })!;
    expect(store.getEntry(traceId)).toMatchObject({
      root: { kind: 'ticket', summary: 'CE-7: Feed filter chips', refs: { ticketId: 'CE-7' } },
      tags: { autopilot: { projectId: 'p-ce', day: '2026-10-03' }, labels: ['visa', 'feed'] },
    });
    expect(store.traceByRef('ticket', 'CE-7')).toBe(traceId);
    traceAutopilotTicketStarted(ON, t, { assignee: 'ce-dev', self: true, workItemId: 'wi-1', traceId, now: DAY1 });
    const claim = (await events(traceId)).find((e) => e.type === 'autopilot.action');
    expect(claim).toMatchObject({ actor: { kind: 'agent', session: 'ce-dev' }, refs: { ticketId: 'CE-7', workItemId: 'wi-1' }, data: { action: 'claim', labels: 'visa,feed' } });
    const run = autopilotRunTrace(ON, DAY1, false)!;
    expect((await events(run)).filter((e) => e.type === 'autopilot.action').map((e) => e.data?.action)).toEqual(['claim']);
    // Restarted later: same trace, the start day is kept.
    expect(autopilotTicketTraceForStart(ON, { ...t, labels: ['feed', 'p1'] }, { assignee: 'ce-dev', self: false, actor: 'ce-owen', now: DAY2 })).toBe(traceId);
    expect(store.getEntry(traceId)?.tags).toEqual({ autopilot: { projectId: 'p-ce', day: '2026-10-03' }, labels: ['visa', 'feed', 'p1'] });
  });

  it('reuses a Request trace but not a broad owner conversation', () => {
    const req = getTraceContext().startTrace({ kind: 'request', summary: 'TKT-1', actor: { kind: 'owner' } })!;
    store.linkRef('ticket', 'CE-1', req);
    expect(autopilotTicketTraceForStart(ON, { id: 'CE-1', title: 'a' }, { assignee: 'x', self: true, now: DAY1 })).toBe(req);
    const chat = getTraceContext().startTrace({ kind: 'owner_message', summary: 'hi', actor: { kind: 'owner' } })!;
    store.linkRef('ticket', 'CE-2', chat);
    const own = autopilotTicketTraceForStart(ON, { id: 'CE-2', title: 'b' }, { assignee: 'x', self: true, now: DAY1 })!;
    expect(own).not.toBe(chat);
    expect(store.getEntry(own)?.root.kind).toBe('ticket');
    expect(store.getEntry(chat)?.tags).toBeUndefined();
  });

  it('does nothing when the project autopilot is off', () => {
    expect(autopilotTicketTraceForStart(OFF, { id: 'X-1', title: 'a' }, { assignee: 'x', self: true, now: DAY1 })).toBeNull();
    expect(store.list({}).length).toBe(0);
  });

  it('records ticket status changes and new labels in the ticket trace; picks and cancels in the run trace', async () => {
    const traceId = autopilotTicketTraceForStart(ON, { id: 'CE-7', title: 'Feed', labels: ['visa'] }, { assignee: 'ce-dev', self: true, now: DAY1 })!;
    const change = (from: string, to: string, actor: string, labels = ['visa']): AutopilotTicketChange => ({
      projectPath: '/p',
      ticket: { id: 'CE-7', title: 'Feed', status: to as never, labels, assignee: 'ce-dev', workItemId: 'wi-1' },
      before: { status: from as never, labels: ['visa'] },
      actor,
    });
    traceAutopilotTicketChange(ON, change('ready', 'in_progress', 'ce-dev'), DAY1);
    traceAutopilotTicketChange(ON, change('in_progress', 'done', 'crewly', ['visa', 'feed']), DAY1);
    const evs = (await events(traceId)).filter((e) => e.type === 'ticket.status');
    expect(evs.map((e) => [e.data?.from, e.data?.to, e.actor.kind, e.outcome])).toEqual([
      ['ready', 'in_progress', 'agent', 'info'],
      ['in_progress', 'done', 'system', 'ok'],
    ]);
    expect(store.getEntry(traceId)?.tags?.labels).toEqual(['visa', 'feed']);

    // A lead readies / cancels other tickets: picks and cancels in the run trace.
    const other = (to: string, actor: string): AutopilotTicketChange => ({
      projectPath: '/p',
      ticket: { id: 'CE-9', title: 'Other', status: to as never, labels: ['feed'], assignee: null, workItemId: null },
      before: { status: 'backlog', labels: ['feed'] },
      actor,
    });
    traceAutopilotTicketChange(ON, other('ready', 'ce-owen'), DAY1);
    traceAutopilotTicketChange(ON, other('cancelled', 'ce-owen'), DAY1);
    traceAutopilotTicketChange(ON, other('ready', 'owner'), DAY1); // the owner's own move is not an autopilot pick
    traceAutopilotTicketChange(OFF, other('ready', 'lead'), DAY1);
    const run = autopilotRunTrace(ON, DAY1, false)!;
    const actions = (await events(run)).filter((e) => e.type === 'autopilot.action').map((e) => [e.data?.action, e.refs.ticketId]);
    expect(actions).toEqual([
      ['pick', 'CE-9'],
      ['cancel', 'CE-9'],
    ]);
    expect(autopilotRunTrace(OFF, DAY1, false)).toBeNull();
  });

  it('the listener finds the project by path and never throws', async () => {
    const traceId = autopilotTicketTraceForStart(ON, { id: 'CE-7', title: 'Feed' }, { assignee: 'ce-dev', self: true, now: DAY1 })!;
    const listener = createAutopilotTicketListener(async () => [{ ...ON, path: '/work/ce' }], () => DAY1);
    listener({
      projectPath: '/work/ce/',
      ticket: { id: 'CE-7', title: 'Feed', status: 'review', labels: [], assignee: 'ce-dev', workItemId: null },
      before: { status: 'in_progress', labels: [] },
      actor: 'crewly',
    });
    const broken = createAutopilotTicketListener(async () => {
      throw new Error('storage down');
    });
    expect(() => broken({ projectPath: '/x', ticket: { id: 'a', title: 'a', status: 'ready', labels: [], assignee: null, workItemId: null }, before: { status: 'backlog', labels: [] }, actor: 'x' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect((await events(traceId)).some((e) => e.type === 'ticket.status' && e.data?.to === 'review')).toBe(true);
  });

  it('maps ticket Log actors', () => {
    expect(ticketActor('owner')).toEqual({ kind: 'owner' });
    expect(ticketActor('crewly')).toEqual({ kind: 'system' });
    expect(ticketActor(undefined)).toEqual({ kind: 'system' });
    expect(ticketActor('ce-owen')).toEqual({ kind: 'agent', session: 'ce-owen' });
  });
});
