/**
 * Google Workspace Routes
 *
 * Router for Gmail + Calendar on the owner's account via Crewly Cloud.
 * Mounted at `/api/google` in the main API router.
 *
 * @module controllers/google/google.routes
 */

import { Router } from 'express';
import { requireConnectorAccess } from '../connector/connector.controller.js';
import {
  getStatus,
  getConnectUrl,
  disconnect,
  setDefaultAccount,
  gmailSearch,
  gmailRead,
  gmailSend,
  calendarList,
  calendarCreate,
  driveSearch,
  driveGet,
  driveContent,
  driveUpload,
  docsRead,
  docsCreate,
  docsAppend,
  sheetsInfo,
  sheetsRead,
  sheetsCreate,
  sheetsWrite,
  slidesRead,
  slidesCreate,
} from './google.controller.js';

/**
 * Creates the Google Workspace router.
 *
 * Routes (everything after /disconnect is behind the connector's role allowlist):
 * - GET    /status                — grant status (connected, email, scopes)
 * - GET    /connect-url           — Cloud consent-start URL for the browser
 * - POST   /default                — choose the account used when none is named
 * - DELETE /disconnect            — revoke + forget the grant (optional ?account=)
 * - GET    /gmail/search          — ?q=&max=
 * - GET    /gmail/messages/:id    — read one message
 * - POST   /gmail/send            — { to, cc?, subject, text, threadId?, inReplyTo?, dryRun? }
 * - GET    /calendar/events       — ?from=&to=&calendarId=&max=
 * - POST   /calendar/events       — { calendarId?, summary, start, end, description?, attendees?, timezone? }
 * - GET    /drive/files           — ?q=&mimeType=&folderId=&max=
 * - GET    /drive/files/:id       — metadata
 * - GET    /drive/files/:id/content — exported text / downloaded body
 * - POST   /drive/files           — { name, content, encoding?, mimeType?, folderId?, convertTo? }
 * - GET    /docs/:id              — document as text
 * - POST   /docs                  — { title, text? }
 * - POST   /docs/:id/append       — { text }
 * - GET    /sheets/:id            — title + tabs
 * - GET    /sheets/:id/values     — ?range=
 * - POST   /sheets                — { title, sheetTitle?, rows? }
 * - POST   /sheets/:id/values     — { range?, rows, mode?: append|update }
 * - GET    /slides/:id            — deck as text
 * - POST   /slides                — { title, slides: [{ title, bullets? }] }
 *
 * @returns Express router for /api/google routes
 */
export function createGoogleRouter(): Router {
  const router = Router();

  router.get('/status', getStatus);
  router.get('/connect-url', getConnectUrl);
  router.post('/default', setDefaultAccount);
  router.delete('/disconnect', disconnect);

  // Everything below touches the owner's Google data, so it goes through the
  // per-connector role allowlist. Registered here on purpose: Express matches
  // in order, so the three grant-management routes above (the dashboard's)
  // stay ungated.
  router.use(requireConnectorAccess('google-workspace'));
  router.get('/gmail/search', gmailSearch);
  router.get('/gmail/messages/:id', gmailRead);
  router.post('/gmail/send', gmailSend);
  router.get('/calendar/events', calendarList);
  router.post('/calendar/events', calendarCreate);
  router.get('/drive/files', driveSearch);
  router.get('/drive/files/:id', driveGet);
  router.get('/drive/files/:id/content', driveContent);
  router.post('/drive/files', driveUpload);
  router.get('/docs/:id', docsRead);
  router.post('/docs', docsCreate);
  router.post('/docs/:id/append', docsAppend);
  router.get('/sheets/:id', sheetsInfo);
  router.get('/sheets/:id/values', sheetsRead);
  router.post('/sheets', sheetsCreate);
  router.post('/sheets/:id/values', sheetsWrite);
  router.get('/slides/:id', slidesRead);
  router.post('/slides', slidesCreate);

  return router;
}
