/**
 * WeChat REST Controller
 *
 * HTTP endpoints for managing the WeChat iLink Bot integration.
 *
 * Routes:
 * - POST /api/wechat/qrcode     — Generate login QR code
 * - GET  /api/wechat/status      — Get connection status
 * - POST /api/wechat/disconnect  — Disconnect WeChat
 *
 * @module services/wechat/wechat.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { getWeChatService } from './wechat.service.js';
import { LoggerService } from '../core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('WeChatController');

/**
 * POST /api/wechat/qrcode
 *
 * Generate a WeChat login QR code. The frontend displays this QR code
 * for the user to scan with their WeChat app.
 *
 * @param _req - Express request (no body required)
 * @param res - Response with { success, data: { qrcodeUrl, ticket } }
 * @param next - Next function
 */
export async function getQRCode(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = getWeChatService();
    const qrData = await service.getQRCode();

    res.json({
      success: true,
      data: {
        qrcodeUrl: qrData.qrcode_url,
        ticket: qrData.qrcode_ticket,
      },
    });

    // Start polling for QR code status in the background
    service.pollQRCodeStatus(qrData.qrcode_ticket).catch((err) => {
      logger.warn('QR code status polling ended', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (error) {
    logger.error('Failed to generate WeChat QR code', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /api/wechat/status
 *
 * Get the current WeChat connection status.
 *
 * @param _req - Express request
 * @param res - Response with { success, data: { state, botName, connectedAt } }
 */
export function getStatus(_req: Request, res: Response): void {
  const service = getWeChatService();
  const status = service.getStatus();

  res.json({
    success: true,
    data: status,
  });
}

/**
 * POST /api/wechat/disconnect
 *
 * Disconnect the WeChat bot and clear credentials.
 *
 * @param _req - Express request
 * @param res - Response with { success }
 * @param next - Next function
 */
export async function disconnectWeChat(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = getWeChatService();
    service.disconnect();
    await service.removeConfig();

    logger.info('WeChat disconnected');
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to disconnect WeChat', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * Create the WeChat router with all endpoints.
 *
 * @returns Express router for /api/wechat/*
 */
export function createWeChatRouter(): Router {
  const router = Router();

  router.post('/qrcode', getQRCode);
  router.get('/status', getStatus);
  router.post('/disconnect', disconnectWeChat);

  return router;
}
