/**
 * Memory REST Routes
 *
 * Router configuration for memory-related endpoints. Provides REST access
 * to the unified MemoryService for orchestrator bash skills.
 *
 * @module controllers/memory/memory.routes
 */

import { Router } from 'express';
import {
  remember,
  recall,
  recordLearning,
  setGoal,
  getGoals,
  updateFocus,
  getFocus,
  appendDailyLog,
  getDailyLog,
  recordSuccess,
  recordFailure,
  getMyContext,
  getUserProfile,
  updateUserProfile,
} from './memory.controller.js';

/**
 * Creates the memory router with all memory endpoints.
 *
 * Endpoints:
 * - POST /remember        - Store knowledge in agent or project memory
 * - POST /recall          - Retrieve relevant knowledge from memory
 * - POST /record-learning - Record a learning or discovery
 * - POST /goals           - Set or append a project goal
 * - GET  /goals           - Get active project goals
 * - POST /focus           - Update the team's current focus
 * - GET  /focus           - Get the team's current focus
 * - POST /daily-log       - Append an entry to today's daily log
 * - GET  /daily-log       - Get today's daily log
 * - POST /record-success  - Record a successful pattern or approach
 * - POST /record-failure  - Record a failed approach or pitfall
 * - POST /my-context      - Get combined agent context (memories, goals, focus, logs, learnings)
 * - GET  /user-profile    - Get the shared user profile
 * - POST /user-profile    - Update the shared user profile (partial merge)
 *
 * @returns Express router configured with memory routes
 */
export function createMemoryRouter(): Router {
  const router = Router();

  router.post('/remember', remember);
  router.post('/recall', recall);
  router.post('/record-learning', recordLearning);
  router.post('/goals', setGoal);
  router.get('/goals', getGoals);
  router.post('/focus', updateFocus);
  router.get('/focus', getFocus);
  router.post('/daily-log', appendDailyLog);
  router.get('/daily-log', getDailyLog);
  router.post('/record-success', recordSuccess);
  router.post('/record-failure', recordFailure);
  router.post('/my-context', getMyContext);
  router.get('/user-profile', getUserProfile);
  router.post('/user-profile', updateUserProfile);

  return router;
}
