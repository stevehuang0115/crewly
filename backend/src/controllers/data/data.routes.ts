/**
 * Data API Routes — V2 Data Architecture
 *
 * REST endpoints for the Unified Data Model (UDM).
 * Provides CRUD for DataObjects, schema listing, sink ingestion,
 * and sync status.
 *
 * @see specs/crewly-data-architecture-v2.md — Section 7
 * @module controllers/data/data.routes
 */

import { Router } from 'express';
import {
  listDataObjects,
  getDataObject,
  createDataObject,
  updateDataObject,
  deleteDataObject,
  listSchemas,
  ingestToSink,
  listSinks,
  getSyncStatus,
} from './data.controller.js';

/**
 * Create the Data API router for /api/v2/data routes.
 *
 * @returns Express router with all data endpoints
 */
export function createDataRouter(): Router {
  const router = Router();

  // ── DataObjects ────────────────────────────────────────────────
  // GET  /api/v2/data/objects        — List with filters (type, scope, status, namespace)
  router.get('/objects', listDataObjects);

  // GET  /api/v2/data/objects/:id    — Fetch by ID
  router.get('/objects/:id', getDataObject);

  // POST /api/v2/data/objects        — Create a new DataObject
  router.post('/objects', createDataObject);

  // PATCH /api/v2/data/objects/:id   — Update (status, metadata, payload)
  router.patch('/objects/:id', updateDataObject);

  // DELETE /api/v2/data/objects/:id  — Delete (soft-archive or hard-delete)
  router.delete('/objects/:id', deleteDataObject);

  // ── Schemas ────────────────────────────────────────────────────
  // GET  /api/v2/data/schemas        — List available schemas
  router.get('/schemas', listSchemas);

  // ── Sinks ──────────────────────────────────────────────────────
  // GET  /api/v2/data/sinks          — List registered sinks
  router.get('/sinks', listSinks);

  // POST /api/v2/data/sinks/:sinkId  — Ingest data into a sink
  router.post('/sinks/:sinkId', ingestToSink);

  // ── Sync ───────────────────────────────────────────────────────
  // GET  /api/v2/data/sync/status    — Check sync health
  router.get('/sync/status', getSyncStatus);

  return router;
}
