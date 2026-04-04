import { Router, Request, Response, NextFunction } from 'express';
import { UserIdentityService } from '../../services/user/user-identity.service.js';
import { validateCreateUserInput } from './user-validation.js';

/**
 * Create the user API router.
 *
 * Provides endpoints to list users, get a user by ID, and create/update users.
 *
 * @returns Express Router with user routes
 */
export function createUserRouter(): Router {
  const router = Router();
  const users = UserIdentityService.getInstance();

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await users.listUsers();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await users.getUserById(req.params.id);
      if (!user) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Run field-level validation (username, email, password)
      const validation = validateCreateUserInput(req.body);
      if (!validation.valid) {
        res.status(400).json({ success: false, ...validation.error });
        return;
      }

      const { email } = validation.data;
      const slackUserId = req.body?.slackUserId ? String(req.body.slackUserId) : undefined;

      const user = await users.createOrUpdateUser({ email, slackUserId });
      res.status(201).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
