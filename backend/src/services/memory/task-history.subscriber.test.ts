/**
 * Tests for TaskHistorySubscriber.
 *
 * Wires a stub EventBus + ProjectMemory + TaskPool and asserts that
 * a `task:done_by_worker` publish produces a TaskHistoryEntry with
 * the right shape, that failures map to `outcome: 'failure'`, that
 * memory-write exceptions are swallowed, and that double-start is
 * idempotent.
 *
 * @module services/memory/task-history.subscriber.test
 */

import { EventEmitter } from 'events';
import {
  TaskHistorySubscriber,
  extractToolsUsed,
} from './task-history.subscriber.js';
import {
  TaskHistoryEntry,
} from '../../types/memory.types.js';
import {
  AgentEvent,
  EventType,
} from '../../types/event-bus.types.js';
import type { InProcessEventHandler } from '../event-bus/event-bus.service.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Minimal EventBus that the subscriber can attach to. Mirrors the API
 * surface the subscriber uses: `onInProcess(types, handler)` returns
 * a detach function and routes published events to the handler.
 */
class StubEventBus {
  private handlers: Array<{
    types: EventType[];
    handler: InProcessEventHandler;
  }> = [];

  onInProcess(types: EventType | EventType[], handler: InProcessEventHandler) {
    const typeArr = Array.isArray(types) ? types : [types];
    const entry = { types: typeArr, handler };
    this.handlers.push(entry);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== entry);
    };
  }

  publish(event: AgentEvent): void {
    for (const h of this.handlers) {
      if (h.types.includes(event.type)) {
        void h.handler(event);
      }
    }
  }

  getHandlerCount(): number {
    return this.handlers.length;
  }
}

class StubProjectMemory {
  public writes: Array<{ projectPath: string; entry: TaskHistoryEntry }> = [];
  public throwOnNextWrite = false;

  async addTaskHistory(projectPath: string, entry: TaskHistoryEntry): Promise<string> {
    if (this.throwOnNextWrite) {
      this.throwOnNextWrite = false;
      throw new Error('disk full (simulated)');
    }
    this.writes.push({ projectPath, entry });
    return entry.id;
  }

  async getTaskHistory(_projectPath: string): Promise<TaskHistoryEntry[]> {
    return this.writes.map((w) => w.entry);
  }
}

class StubTaskPool {
  private store: Map<string, Record<string, unknown>> = new Map();
  put(id: string, wi: Record<string, unknown>): void { this.store.set(id, wi); }
  async findWorkItem(id: string): Promise<Record<string, unknown> | null> {
    return this.store.get(id) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: 'evt-1',
    type: 'task:done_by_worker' as EventType,
    timestamp: '2026-05-18T14:00:00Z',
    teamId: 't1',
    teamName: 'Team',
    memberId: 'm1',
    memberName: 'Ella',
    sessionName: 'crewly-product-ella',
    previousValue: 'running',
    newValue: 'done_by_worker',
    changedField: 'taskStatus',
    workItemId: 'wi-1',
    ...overrides,
  } as AgentEvent;
}

function buildSubscriber(opts: {
  pool?: StubTaskPool;
  memory?: StubProjectMemory;
  bus?: StubEventBus;
  resolveProjectPath?: (event: AgentEvent) => string | null;
} = {}) {
  const bus = opts.bus ?? new StubEventBus();
  const memory = opts.memory ?? new StubProjectMemory();
  const pool = opts.pool ?? new StubTaskPool();
  const sub = new TaskHistorySubscriber({
    eventBus: bus as unknown as ConstructorParameters<typeof TaskHistorySubscriber>[0]['eventBus'],
    projectMemoryService: memory as unknown as ConstructorParameters<typeof TaskHistorySubscriber>[0]['projectMemoryService'],
    taskPoolService: pool as unknown as ConstructorParameters<typeof TaskHistorySubscriber>[0]['taskPoolService'],
    resolveProjectPath: opts.resolveProjectPath ?? (() => '/tmp/proj'),
  });
  return { bus, memory, pool, sub };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskHistorySubscriber', () => {
  it('attaches a single in-process handler on start()', () => {
    const { bus, sub } = buildSubscriber();
    expect(bus.getHandlerCount()).toBe(0);
    sub.start();
    expect(bus.getHandlerCount()).toBe(1);
    sub.stop();
    expect(bus.getHandlerCount()).toBe(0);
  });

  it('start() is idempotent — second call does not double-attach', () => {
    const { bus, sub } = buildSubscriber();
    sub.start();
    sub.start();
    expect(bus.getHandlerCount()).toBe(1);
    sub.stop();
  });

  it('records a success entry for task:done_by_worker', async () => {
    const pool = new StubTaskPool();
    pool.put('wi-1', {
      title: 'Read MIT Role email',
      metadata: { role: 'fullstack-dev', toolsUsed: ['read_email_oauth'] },
    });
    const { bus, memory, sub } = buildSubscriber({ pool });
    sub.start();

    bus.publish(makeEvent({ workItemId: 'wi-1' }));
    await flush();

    expect(memory.writes).toHaveLength(1);
    const entry = memory.writes[0]!.entry;
    expect(entry.task.outcome).toBe('success');
    expect(entry.agent.sessionName).toBe('crewly-product-ella');
    expect(entry.agent.role).toBe('fullstack-dev');
    expect(entry.task.description).toBe('Read MIT Role email');
    expect(entry.capabilities.sort()).toEqual(['gmail:read', 'oauth:gmail'].sort());
    expect(entry.toolsUsed).toEqual(['read_email_oauth']);
  });

  it('records a failure entry for task:rejected', async () => {
    const pool = new StubTaskPool();
    pool.put('wi-2', { title: 'Send memo', metadata: { toolsUsed: ['send_email_oauth'] } });
    const { bus, memory, sub } = buildSubscriber({ pool });
    sub.start();

    bus.publish(makeEvent({
      id: 'evt-2',
      type: 'task:rejected' as EventType,
      workItemId: 'wi-2',
    }));
    await flush();

    expect(memory.writes).toHaveLength(1);
    expect(memory.writes[0]!.entry.task.outcome).toBe('failure');
  });

  it('records a partial entry for task:cancelled', async () => {
    const pool = new StubTaskPool();
    pool.put('wi-3', { title: 'Pulled out', metadata: { toolsUsed: [] } });
    const { bus, memory, sub } = buildSubscriber({ pool });
    sub.start();

    bus.publish(makeEvent({
      id: 'evt-3',
      type: 'task:cancelled' as EventType,
      workItemId: 'wi-3',
    }));
    await flush();

    expect(memory.writes).toHaveLength(1);
    expect(memory.writes[0]!.entry.task.outcome).toBe('partial');
  });

  it('skips events with no workItemId', async () => {
    const { bus, memory, sub } = buildSubscriber();
    sub.start();
    const evt = makeEvent({ workItemId: undefined as unknown as string });
    bus.publish(evt);
    await flush();
    expect(memory.writes).toHaveLength(0);
  });

  it('skips events whose WorkItem is no longer in the pool (race window)', async () => {
    const { bus, memory, sub } = buildSubscriber();
    sub.start();
    bus.publish(makeEvent({ workItemId: 'wi-missing' }));
    await flush();
    expect(memory.writes).toHaveLength(0);
  });

  it('skips events whose projectPath cannot be resolved', async () => {
    const pool = new StubTaskPool();
    pool.put('wi-x', { title: 't', metadata: {} });
    const { bus, memory, sub } = buildSubscriber({
      pool,
      resolveProjectPath: () => null,
    });
    sub.start();
    bus.publish(makeEvent({ workItemId: 'wi-x' }));
    await flush();
    expect(memory.writes).toHaveLength(0);
  });

  it('swallows memory-write failures (does not throw to publisher)', async () => {
    const pool = new StubTaskPool();
    pool.put('wi-err', { title: 't', metadata: { toolsUsed: [] } });
    const memory = new StubProjectMemory();
    memory.throwOnNextWrite = true;
    const { bus, sub } = buildSubscriber({ pool, memory });
    sub.start();

    expect(() => bus.publish(makeEvent({ workItemId: 'wi-err' }))).not.toThrow();
    await flush();
    expect(memory.writes).toHaveLength(0);
  });

  it('uses stable workItemId-keyed entry id so redelivery dedups', async () => {
    const pool = new StubTaskPool();
    pool.put('wi-same', { title: 't', metadata: { toolsUsed: [] } });
    const { bus, memory, sub } = buildSubscriber({ pool });
    sub.start();

    bus.publish(makeEvent({ workItemId: 'wi-same' }));
    bus.publish(makeEvent({ workItemId: 'wi-same', id: 'evt-99' }));
    await flush();

    const ids = memory.writes.map((w) => w.entry.id);
    expect(ids.every((id) => id === 'th-wi-same')).toBe(true);
  });
});

describe('extractToolsUsed', () => {
  it('reads canonical metadata.toolsUsed when present', () => {
    expect(extractToolsUsed({ metadata: { toolsUsed: ['a', 'b'] } })).toEqual(['a', 'b']);
  });

  it('falls back to legacy metadata.tools', () => {
    expect(extractToolsUsed({ metadata: { tools: ['legacy'] } })).toEqual(['legacy']);
  });

  it('strips non-string entries', () => {
    expect(
      extractToolsUsed({ metadata: { toolsUsed: ['a', 1, null, 'b'] as unknown[] } }),
    ).toEqual(['a', 'b']);
  });

  it('returns [] when neither field is set', () => {
    expect(extractToolsUsed({ metadata: {} })).toEqual([]);
    expect(extractToolsUsed({})).toEqual([]);
  });
});

async function flush(): Promise<void> {
  // Subscribers may be async; let the microtask queue drain.
  await new Promise((r) => setImmediate(r));
}

// Suppress unused import warning if EventEmitter is not referenced
// in any test (kept here in case StubEventBus is ever refactored to
// extend it for hierarchical events).
void EventEmitter;
