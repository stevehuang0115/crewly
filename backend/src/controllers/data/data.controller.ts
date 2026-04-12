/**
 * Data Controller — V2 Data Architecture
 *
 * REST API handlers for the Unified Data Model.
 * Delegates to DataObjectStore, SchemaRegistry, and SinkRegistry services.
 *
 * @see specs/crewly-data-architecture-v2.md
 * @module controllers/data/data.controller
 */

import type { Request, Response } from 'express';
import type { DataObjectType, DataObjectScope, DataObjectStatus } from '../../services/data/data-object.types.js';

/**
 * Resolve the active project path from the request or environment.
 *
 * @returns Absolute project path
 */
function resolveProjectPath(): string {
  return process.env.CREWLY_PROJECT_PATH || process.cwd();
}

/**
 * GET /api/v2/data/objects — List DataObjects with optional filters.
 */
export async function listDataObjects(req: Request, res: Response): Promise<void> {
  try {
    const { DataObjectStore } = await import('../../services/data/data-object-store.service.js');
    const store = DataObjectStore.getInstance(resolveProjectPath());
    const filters = {
      type: req.query.type as DataObjectType | undefined,
      scope: req.query.scope as DataObjectScope | undefined,
      status: req.query.status as DataObjectStatus | undefined,
      namespace: req.query.namespace as string | undefined,
      owner_id: req.query.owner_id as string | undefined,
      tags: req.query.tags ? (req.query.tags as string).split(',') : undefined,
    };
    const objects = await store.list(filters);
    res.json({ success: true, data: objects, count: objects.length });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

/**
 * GET /api/v2/data/objects/:id — Fetch a single DataObject by ID.
 */
export async function getDataObject(req: Request, res: Response): Promise<void> {
  try {
    const { DataObjectStore } = await import('../../services/data/data-object-store.service.js');
    const store = DataObjectStore.getInstance(resolveProjectPath());
    const obj = await store.getById(req.params.id);
    if (!obj) { res.status(404).json({ success: false, error: 'DataObject not found' }); return; }
    res.json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

/**
 * POST /api/v2/data/objects — Create a new DataObject.
 */
export async function createDataObject(req: Request, res: Response): Promise<void> {
  try {
    const { DataObjectStore } = await import('../../services/data/data-object-store.service.js');
    const store = DataObjectStore.getInstance(resolveProjectPath());
    const { type, scope, schema_id, owner_id, namespace, payload, tags, source_thread_id, confidence_score } = req.body;
    if (!type || !scope || !owner_id || !namespace) {
      res.status(400).json({ success: false, error: 'Missing required fields: type, scope, owner_id, namespace' });
      return;
    }
    if (schema_id) {
      try {
        const { SchemaRegistryService } = await import('../../services/data/schema-registry.service.js');
        const result = SchemaRegistryService.getInstance().validate(schema_id, payload || {});
        if (!result.valid) { res.status(422).json({ success: false, error: 'Schema validation failed', validationErrors: result.errors }); return; }
      } catch { /* schema service not loaded */ }
    }
    const obj = await store.create({ type, scope, schema_id: schema_id || '', owner_id, namespace, payload: payload || {}, tags: tags || [], source_thread_id, confidence_score });
    res.status(201).json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

/**
 * PATCH /api/v2/data/objects/:id — Update a DataObject.
 */
export async function updateDataObject(req: Request, res: Response): Promise<void> {
  try {
    const { DataObjectStore } = await import('../../services/data/data-object-store.service.js');
    const store = DataObjectStore.getInstance(resolveProjectPath());
    const obj = await store.update(req.params.id, req.body);
    if (!obj) { res.status(404).json({ success: false, error: 'DataObject not found' }); return; }
    res.json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

/**
 * DELETE /api/v2/data/objects/:id — Delete or archive a DataObject.
 */
export async function deleteDataObject(req: Request, res: Response): Promise<void> {
  try {
    const { DataObjectStore } = await import('../../services/data/data-object-store.service.js');
    const store = DataObjectStore.getInstance(resolveProjectPath());
    if (req.query.hard === 'true') {
      const deleted = await store.delete(req.params.id);
      if (!deleted) { res.status(404).json({ success: false, error: 'DataObject not found' }); return; }
      res.json({ success: true, message: 'DataObject permanently deleted' });
    } else {
      const obj = await store.update(req.params.id, { status: 'archived' });
      if (!obj) { res.status(404).json({ success: false, error: 'DataObject not found' }); return; }
      res.json({ success: true, data: obj, message: 'DataObject archived' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

/**
 * GET /api/v2/data/schemas — List all available schemas.
 */
export async function listSchemas(_req: Request, res: Response): Promise<void> {
  try {
    const { SchemaRegistryService } = await import('../../services/data/schema-registry.service.js');
    res.json({ success: true, data: SchemaRegistryService.getInstance().listSchemas() });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

/**
 * GET /api/v2/data/sinks — List all registered sinks.
 */
export async function listSinks(_req: Request, res: Response): Promise<void> {
  try {
    const { SinkRegistryService } = await import('../../services/data/sink-registry.service.js');
    res.json({ success: true, data: SinkRegistryService.getInstance().listSinks() });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

/**
 * POST /api/v2/data/sinks/:sinkId — Ingest data into a specific sink.
 */
export async function ingestToSink(req: Request, res: Response): Promise<void> {
  try {
    const { SinkRegistryService } = await import('../../services/data/sink-registry.service.js');
    const { DataObjectStore } = await import('../../services/data/data-object-store.service.js');
    const sinkRegistry = SinkRegistryService.getInstance();
    const store = DataObjectStore.getInstance(resolveProjectPath());
    const sink = sinkRegistry.getSink(req.params.sinkId);
    if (!sink) { res.status(404).json({ success: false, error: `Sink "${req.params.sinkId}" not found` }); return; }
    const { data, owner_id } = req.body;
    if (!data || typeof data !== 'object') { res.status(400).json({ success: false, error: 'Missing required field: data (object)' }); return; }
    if (sink.schema_id) {
      try {
        const { SchemaRegistryService: SR } = await import('../../services/data/schema-registry.service.js');
        const result = SR.getInstance().validate(sink.schema_id, data);
        if (!result.valid) { res.status(422).json({ success: false, error: 'Schema validation failed', validationErrors: result.errors, sink: sink.id }); return; }
      } catch { /* schema service not loaded */ }
    }
    const obj = await store.create({ type: 'sink_entry', scope: 'project', schema_id: sink.schema_id || '', owner_id: owner_id || 'system', namespace: sink.id, payload: data, tags: [], source_thread_id: req.body.source_thread_id });
    res.status(201).json({ success: true, data: obj, sink: sink.id, message: `Data ingested into sink "${sink.name}"` });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

/**
 * GET /api/v2/data/sync/status — Check dual-machine sync health.
 */
export async function getSyncStatus(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: { syncEnabled: false, localObjects: 0, syncedObjects: 0, conflictObjects: 0, lastSyncAt: null, message: 'Sync not yet enabled (Phase 3)' } });
}
