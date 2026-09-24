/**
 * Microsoft To Do routes — mounted at `/api/microsoft-todo`.
 *
 * Everything after /disconnect is behind the connector's role allowlist.
 *
 * - GET    /status            — grant status
 * - GET    /connect-url       — Cloud consent-start URL
 * - DELETE /disconnect        — forget the grant
 * - GET    /lists             — every task list
 * - POST   /lists             — { name }
 * - GET    /tasks             — ?list=<name|id>&all=1&limit=
 * - POST   /tasks             — { list?, title, note?, due?, importance? }
 * - PATCH  /tasks/:taskId     — { list?, complete?, title?, note?, due? (null clears), importance? }
 * - DELETE /tasks/:taskId     — ?list=<name|id>
 *
 * @module controllers/microsoft/microsoft-todo.routes
 */

import { Router } from 'express';
import { MICROSOFT_TODO_CONSTANTS } from '../../constants.js';
import { requireConnectorAccess } from '../connector/connector.controller.js';
import { getStatus, getConnectUrl, disconnect, listLists, createList, listTasks, addTask, updateTask, deleteTask } from './microsoft-todo.controller.js';

/**
 * Creates the Microsoft To Do router.
 *
 * @returns Express router
 */
export function createMicrosoftTodoRouter(): Router {
  const router = Router();
  router.get('/status', getStatus);
  router.get('/connect-url', getConnectUrl);
  router.delete('/disconnect', disconnect);
  // Data routes only — see the note in google.routes.ts.
  router.use(requireConnectorAccess(MICROSOFT_TODO_CONSTANTS.CONNECTOR_ID));
  router.get('/lists', listLists);
  router.post('/lists', createList);
  router.get('/tasks', listTasks);
  router.post('/tasks', addTask);
  router.patch('/tasks/:taskId', updateTask);
  router.delete('/tasks/:taskId', deleteTask);
  return router;
}
