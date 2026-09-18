/**
 * Google Workspace Routes
 *
 * Router for Gmail + Calendar on the owner's account via Crewly Cloud.
 * Mounted at `/api/google` in the main API router.
 *
 * @module controllers/google/google.routes
 */

import { Router } from 'express';
import {
  getStatus,
  getConnectUrl,
  disconnect,
  gmailSearch,
  gmailRead,
  gmailSend,
  calendarList,
  calendarCreate,
} from './google.controller.js';

/**
 * Creates the Google Workspace router.
 *
 * Routes:
 * - GET    /status                — grant status (connected, email, scopes)
 * - GET    /connect-url           — Cloud consent-start URL for the browser
 * - DELETE /disconnect            — revoke + forget the grant
 * - GET    /gmail/search          — ?q=&max=
 * - GET    /gmail/messages/:id    — read one message
 * - POST   /gmail/send            — { to, cc?, subject, text, threadId?, inReplyTo?, dryRun? }
 * - GET    /calendar/events       — ?from=&to=&calendarId=&max=
 * - POST   /calendar/events       — { calendarId?, summary, start, end, description?, attendees?, timezone? }
 *
 * @returns Express router for /api/google routes
 */
export function createGoogleRouter(): Router {
  const router = Router();

  router.get('/status', getStatus);
  router.get('/connect-url', getConnectUrl);
  router.delete('/disconnect', disconnect);
  router.get('/gmail/search', gmailSearch);
  router.get('/gmail/messages/:id', gmailRead);
  router.post('/gmail/send', gmailSend);
  router.get('/calendar/events', calendarList);
  router.post('/calendar/events', calendarCreate);

  return router;
}
