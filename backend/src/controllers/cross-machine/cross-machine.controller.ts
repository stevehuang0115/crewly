/**
 * Cross-Machine Controller
 *
 * REST API endpoints for cross-machine communication via Slack.
 * Provides send, configure, and status endpoints.
 *
 * @module controllers/cross-machine
 */

import { Router, Request, Response } from 'express';
import {
  getCrossMachineMessageService,
} from '../../services/slack/cross-machine-message.service.js';
import type {
  CrossMachineMessageType,
  CrossMachineConfig,
} from '../../types/cross-machine.types.js';

/**
 * Create the cross-machine router.
 *
 * @returns Express router with cross-machine endpoints
 */
export function createCrossMachineRouter(): Router {
  const router = Router();

  /**
   * GET /api/cross-machine/status
   *
   * Get cross-machine messaging status including device identity and config.
   */
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const service = getCrossMachineMessageService();
      const config = service.getConfig();
      const identity = service.getIdentity();

      res.json({
        success: true,
        enabled: service.isEnabled(),
        config,
        identity: identity ? {
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
        } : null,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/cross-machine/configure
   *
   * Configure cross-machine messaging with a Slack channel ID.
   *
   * @body {string} channelId - Slack channel ID for cross-machine messages
   * @body {boolean} enabled - Whether to enable cross-machine messaging
   */
  router.post('/configure', async (req: Request, res: Response) => {
    try {
      const { channelId, enabled } = req.body as { channelId?: string; enabled?: boolean };

      if (!channelId) {
        res.status(400).json({ success: false, error: 'channelId is required' });
        return;
      }

      const service = getCrossMachineMessageService();
      await service.initialize();

      const config: CrossMachineConfig = {
        channelId,
        enabled: enabled !== false, // Default to true
      };

      await service.configure(config);

      res.json({ success: true, config });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/cross-machine/send
   *
   * Send a cross-machine message via Slack.
   *
   * @body {string} targetMachine - Target device ID (or "*" for broadcast)
   * @body {string} type - Message type (delegate-task, send-message, status-request, ping)
   * @body {object} payload - Message payload
   */
  router.post('/send', async (req: Request, res: Response) => {
    try {
      const { targetMachine, type, payload, message } = req.body as {
        targetMachine?: string;
        type?: string;
        payload?: Record<string, unknown>;
        message?: string;
      };

      if (!targetMachine) {
        res.status(400).json({ success: false, error: 'targetMachine is required' });
        return;
      }

      if (!type) {
        res.status(400).json({ success: false, error: 'type is required' });
        return;
      }

      const validTypes: CrossMachineMessageType[] = [
        'delegate-task', 'send-message', 'status-request', 'status-response', 'ping', 'pong',
      ];
      if (!validTypes.includes(type as CrossMachineMessageType)) {
        res.status(400).json({
          success: false,
          error: `Invalid type. Must be one of: ${validTypes.join(', ')}`,
        });
        return;
      }

      const service = getCrossMachineMessageService();
      if (!service.isEnabled()) {
        // Try to initialize — config may have been added since startup
        await service.initialize();
        if (!service.isEnabled()) {
          res.status(409).json({
            success: false,
            error: 'Cross-machine messaging is not configured. POST /api/cross-machine/configure first.',
          });
          return;
        }
      }

      // Build payload — include message text if provided
      const fullPayload = { ...payload };
      if (message) {
        fullPayload.message = message;
      }

      const result = await service.sendMessage(
        targetMachine,
        type as CrossMachineMessageType,
        fullPayload
      );

      if (result.success) {
        res.json({ success: true, slackTs: result.slackTs });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
