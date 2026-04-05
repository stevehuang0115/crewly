/**
 * Tests for DataObjectStore — file-based CRUD for DataObjects.
 *
 * Uses temporary directories to isolate each test run.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DataObjectStore } from './data-object-store.service.js';
import { DataObject, CreateDataObjectInput, isDataObject } from './data-object.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: DataObjectStore;

/** Creates a temp project directory and a fresh store instance. */
async function setup(): Promise<void> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dos-test-'));
  DataObjectStore.clearInstance();
  store = DataObjectStore.getInstance(tmpDir);
}

/** Removes temp directory tree. */
async function teardown(): Promise<void> {
  DataObjectStore.clearInstance();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

/** Default valid input for creating a DataObject. */
function defaultInput(overrides: Partial<CreateDataObjectInput> = {}): CreateDataObjectInput {
  return {
    type: 'memory',
    scope: 'project',
    schema_id: 'schema-test-v1',
    owner_id: 'agent-leo',
    namespace: 'test/ns',
    payload: { content: 'hello world' },
    tags: ['tag1'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DataObjectStore', () => {
  beforeEach(setup);
  afterEach(teardown);

  // ---- Singleton --------------------------------------------------------

  describe('getInstance', () => {
    it('returns the same instance for the same projectPath', () => {
      const a = DataObjectStore.getInstance(tmpDir);
      const b = DataObjectStore.getInstance(tmpDir);
      expect(a).toBe(b);
    });

    it('returns a new instance when projectPath changes', () => {
      const a = DataObjectStore.getInstance(tmpDir);
      const b = DataObjectStore.getInstance('/tmp/other');
      expect(a).not.toBe(b);
      // Reset back
      DataObjectStore.clearInstance();
      store = DataObjectStore.getInstance(tmpDir);
    });
  });

  // ---- create -----------------------------------------------------------

  describe('create', () => {
    it('returns a DataObject with a generated id', async () => {
      const obj = await store.create(defaultInput());
      expect(obj.id).toBeDefined();
      expect(typeof obj.id).toBe('string');
      expect(obj.id.length).toBeGreaterThan(0);
    });

    it('sets timestamps on creation', async () => {
      const before = new Date().toISOString();
      const obj = await store.create(defaultInput());
      const after = new Date().toISOString();

      expect(obj.metadata.created_at >= before).toBe(true);
      expect(obj.metadata.created_at <= after).toBe(true);
      expect(obj.metadata.updated_at).toBe(obj.metadata.created_at);
    });

    it('defaults status to "new"', async () => {
      const obj = await store.create(defaultInput());
      expect(obj.status).toBe('new');
    });

    it('defaults sync_state to "local"', async () => {
      const obj = await store.create(defaultInput());
      expect(obj.sync_state).toBe('local');
    });

    it('respects explicit status override', async () => {
      const obj = await store.create(defaultInput({ status: 'processed' }));
      expect(obj.status).toBe('processed');
    });

    it('persists the DataObject as a JSON file (project scope)', async () => {
      const obj = await store.create(defaultInput());
      const fp = path.join(tmpDir, '.crewly', 'data', 'test/ns', `${obj.id}.json`);
      const raw = await fs.readFile(fp, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(isDataObject(parsed)).toBe(true);
      expect(parsed.id).toBe(obj.id);
    });

    it('persists agent-scoped objects in agents/{owner}/data/', async () => {
      const obj = await store.create(defaultInput({ scope: 'agent' }));
      const fp = path.join(tmpDir, '.crewly', 'agents', 'agent-leo', 'data', `${obj.id}.json`);
      const raw = await fs.readFile(fp, 'utf-8');
      expect(JSON.parse(raw).id).toBe(obj.id);
    });

    it('stores tags from input in metadata', async () => {
      const obj = await store.create(defaultInput({ tags: ['a', 'b'] }));
      expect(obj.metadata.tags).toEqual(['a', 'b']);
    });

    it('defaults tags to empty array when not provided', async () => {
      const { tags, ...noTags } = defaultInput();
      const obj = await store.create(noTags as CreateDataObjectInput);
      expect(obj.metadata.tags).toEqual([]);
    });

    it('stores optional source_thread_id', async () => {
      const obj = await store.create(defaultInput({ source_thread_id: 'thread-1' }));
      expect(obj.metadata.source_thread_id).toBe('thread-1');
    });

    it('stores optional confidence_score', async () => {
      const obj = await store.create(defaultInput({ confidence_score: 0.85 }));
      expect(obj.metadata.confidence_score).toBe(0.85);
    });
  });

  // ---- getById ----------------------------------------------------------

  describe('getById', () => {
    it('retrieves a previously created object', async () => {
      const created = await store.create(defaultInput());
      const found = await store.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.payload).toEqual({ content: 'hello world' });
    });

    it('returns null for a non-existent id', async () => {
      const found = await store.getById('non-existent-uuid');
      expect(found).toBeNull();
    });

    it('finds agent-scoped objects', async () => {
      const created = await store.create(defaultInput({ scope: 'agent' }));
      const found = await store.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.scope).toBe('agent');
    });
  });

  // ---- list -------------------------------------------------------------

  describe('list', () => {
    it('returns all objects when no filters given', async () => {
      await store.create(defaultInput());
      await store.create(defaultInput({ namespace: 'other/ns' }));
      const all = await store.list();
      expect(all.length).toBe(2);
    });

    it('filters by type', async () => {
      await store.create(defaultInput({ type: 'memory' }));
      await store.create(defaultInput({ type: 'knowledge', namespace: 'other' }));
      const memories = await store.list({ type: 'memory' });
      expect(memories.length).toBe(1);
      expect(memories[0].type).toBe('memory');
    });

    it('filters by scope', async () => {
      await store.create(defaultInput({ scope: 'project' }));
      await store.create(defaultInput({ scope: 'agent' }));
      const projectOnly = await store.list({ scope: 'project' });
      expect(projectOnly.length).toBe(1);
      expect(projectOnly[0].scope).toBe('project');
    });

    it('filters by status', async () => {
      await store.create(defaultInput({ status: 'new' }));
      await store.create(defaultInput({ status: 'archived', namespace: 'other' }));
      const archived = await store.list({ status: 'archived' });
      expect(archived.length).toBe(1);
    });

    it('filters by owner_id', async () => {
      await store.create(defaultInput({ owner_id: 'agent-leo' }));
      await store.create(defaultInput({ owner_id: 'agent-sam', namespace: 'other' }));
      const leoOnly = await store.list({ owner_id: 'agent-leo' });
      expect(leoOnly.length).toBe(1);
      expect(leoOnly[0].owner_id).toBe('agent-leo');
    });

    it('filters by namespace', async () => {
      await store.create(defaultInput({ namespace: 'ns/a' }));
      await store.create(defaultInput({ namespace: 'ns/b' }));
      const nsA = await store.list({ namespace: 'ns/a' });
      expect(nsA.length).toBe(1);
    });

    it('filters by tags (must have all)', async () => {
      await store.create(defaultInput({ tags: ['a', 'b'] }));
      await store.create(defaultInput({ tags: ['a'], namespace: 'other' }));
      const both = await store.list({ tags: ['a', 'b'] });
      expect(both.length).toBe(1);
    });

    it('returns empty array for no matches', async () => {
      await store.create(defaultInput());
      const none = await store.list({ type: 'knowledge' });
      expect(none).toEqual([]);
    });

    it('returns empty array when store is empty', async () => {
      const all = await store.list();
      expect(all).toEqual([]);
    });
  });

  // ---- update -----------------------------------------------------------

  describe('update', () => {
    it('updates payload fields', async () => {
      const created = await store.create(defaultInput());
      const updated = await store.update(created.id, { payload: { content: 'updated' } });
      expect(updated.payload).toEqual({ content: 'updated' });
    });

    it('refreshes updated_at timestamp', async () => {
      const created = await store.create(defaultInput());
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));
      const updated = await store.update(created.id, { status: 'processed' });
      expect(updated.metadata.updated_at > created.metadata.updated_at).toBe(true);
    });

    it('does not change the id', async () => {
      const created = await store.create(defaultInput());
      const updated = await store.update(created.id, { id: 'should-be-ignored' } as Partial<DataObject>);
      expect(updated.id).toBe(created.id);
    });

    it('throws when object does not exist', async () => {
      await expect(store.update('non-existent', { status: 'archived' })).rejects.toThrow(
        'DataObject not found: non-existent',
      );
    });

    it('moves file when namespace changes', async () => {
      const created = await store.create(defaultInput({ namespace: 'old/ns' }));
      const oldPath = path.join(tmpDir, '.crewly', 'data', 'old/ns', `${created.id}.json`);
      expect(await fileExists(oldPath)).toBe(true);

      await store.update(created.id, { namespace: 'new/ns' });
      const newPath = path.join(tmpDir, '.crewly', 'data', 'new/ns', `${created.id}.json`);
      expect(await fileExists(newPath)).toBe(true);
      expect(await fileExists(oldPath)).toBe(false);
    });

    it('preserves unpatched fields', async () => {
      const created = await store.create(defaultInput({ tags: ['keep'] }));
      const updated = await store.update(created.id, { status: 'processed' });
      expect(updated.metadata.tags).toEqual(['keep']);
      expect(updated.type).toBe('memory');
      expect(updated.owner_id).toBe('agent-leo');
    });
  });

  // ---- delete -----------------------------------------------------------

  describe('delete', () => {
    it('removes a DataObject and returns true', async () => {
      const created = await store.create(defaultInput());
      const result = await store.delete(created.id);
      expect(result).toBe(true);
      const found = await store.getById(created.id);
      expect(found).toBeNull();
    });

    it('returns false for a non-existent id', async () => {
      const result = await store.delete('non-existent');
      expect(result).toBe(false);
    });

    it('actually removes the file from disk', async () => {
      const created = await store.create(defaultInput());
      const fp = path.join(tmpDir, '.crewly', 'data', 'test/ns', `${created.id}.json`);
      expect(await fileExists(fp)).toBe(true);
      await store.delete(created.id);
      expect(await fileExists(fp)).toBe(false);
    });
  });

  // ---- listByNamespace --------------------------------------------------

  describe('listByNamespace', () => {
    it('returns objects in the specified namespace', async () => {
      await store.create(defaultInput({ namespace: 'marketing/inputs' }));
      await store.create(defaultInput({ namespace: 'marketing/inputs' }));
      await store.create(defaultInput({ namespace: 'engineering/logs' }));

      const marketing = await store.listByNamespace('marketing/inputs');
      expect(marketing.length).toBe(2);
      marketing.forEach((obj) => expect(obj.namespace).toBe('marketing/inputs'));
    });

    it('returns empty array when namespace has no objects', async () => {
      const result = await store.listByNamespace('empty/ns');
      expect(result).toEqual([]);
    });
  });

  // ---- Integration: mixed scopes ----------------------------------------

  describe('mixed scope operations', () => {
    it('handles project and agent scoped objects together', async () => {
      const proj = await store.create(defaultInput({ scope: 'project', namespace: 'ns1' }));
      const agent = await store.create(defaultInput({ scope: 'agent', namespace: 'ns2' }));

      const all = await store.list();
      expect(all.length).toBe(2);

      const projFound = await store.getById(proj.id);
      const agentFound = await store.getById(agent.id);
      expect(projFound).not.toBeNull();
      expect(agentFound).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

async function fileExists(fp: string): Promise<boolean> {
  try {
    await fs.access(fp);
    return true;
  } catch {
    return false;
  }
}
