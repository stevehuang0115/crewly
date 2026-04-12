/**
 * Task Projection Routes (V3.1)
 *
 * Mounted at /api/task-projection
 *
 * @module controllers/task-projection/task-projection.routes
 */

import { Router } from 'express';
import {
  listRecords,
  getSummary,
  getRecord,
  createRecord,
  updateRecord,
  startRecord,
  completeRecord,
  failRecord,
  blockRecord,
  recordSkill,
  listEvents,
  aggregateByRequest,
  aggregateByAgent,
} from './task-projection.controller.js';

const router = Router();

// Records
router.get('/records', listRecords);
router.get('/records/summary', getSummary);
router.get('/records/:id', getRecord);
router.post('/records', createRecord);
router.patch('/records/:id', updateRecord);
router.post('/records/:id/start', startRecord);
router.post('/records/:id/done', completeRecord);
router.post('/records/:id/fail', failRecord);
router.post('/records/:id/block', blockRecord);

// Skills
router.post('/skills', recordSkill);

// Events
router.get('/events', listEvents);

// Aggregation
router.get('/aggregate/request', aggregateByRequest);
router.get('/aggregate/agent', aggregateByAgent);

export default router;
