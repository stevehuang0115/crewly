/**
 * Workspace backup routes — start a cloud backup of this machine remotely.
 *
 *   POST /api/backup/push   start one (202; 409 while one is running)
 *   GET  /api/backup/push   state of the running or last one
 *
 * Reachable from the portal and the phone over the relay (see the
 * MobileApiRelayService allowlist), which is how "Back up now" works without
 * a terminal on the machine.
 *
 * @module controllers/backup/backup.routes
 */

import { Router, type Request, type Response } from 'express';
import { BackupPushService } from '../../services/backup/backup-push.service.js';

/**
 * Create the backup router.
 *
 * @param service - Injectable for tests
 * @returns Router mounted at /api/backup
 */
export function createBackupRouter(service: () => BackupPushService = () => BackupPushService.getInstance()): Router {
  const router = Router();

  router.get('/push', (_req: Request, res: Response) => {
    res.json({ success: true, data: service().status() });
  });

  router.post('/push', (req: Request, res: Response) => {
    const chatDb = (req.body ?? {}).chatDb !== false;
    const started = service().start({ chatDb });
    if (!started) {
      res.status(409).json({ success: false, error: 'A backup is already running', data: service().status() });
      return;
    }
    res.status(202).json({ success: true, data: started });
  });

  return router;
}
