import { Router, Request, Response, NextFunction } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CREWLY_CONSTANTS } from '../../constants.js';
import { MessengerRegistryService } from '../../services/messaging/messenger-registry.service.js';
import { SlackMessengerAdapter } from '../../services/messaging/adapters/slack-messenger.adapter.js';
import { TelegramMessengerAdapter } from '../../services/messaging/adapters/telegram-messenger.adapter.js';
import { DiscordMessengerAdapter } from '../../services/messaging/adapters/discord-messenger.adapter.js';
import { GoogleChatMessengerAdapter } from '../../services/messaging/adapters/google-chat-messenger.adapter.js';
import type { MessengerPlatform } from '../../services/messaging/messenger-adapter.interface.js';

/** Known messenger platforms for input validation. */
const VALID_PLATFORMS: ReadonlySet<string> = new Set<MessengerPlatform>(['slack', 'telegram', 'discord', 'google-chat']);

/**
 * Validate that a string is a known messenger platform.
 *
 * @param value - The platform string from request params
 * @returns The validated MessengerPlatform, or null if invalid
 */
function validatePlatform(value: string): MessengerPlatform | null {
  return VALID_PLATFORMS.has(value) ? (value as MessengerPlatform) : null;
}

/**
 * Get the credential file path for a messenger platform.
 *
 * @param platform - The messenger platform identifier
 * @returns Absolute path to the platform's credential JSON file
 */
function getCredentialPath(platform: MessengerPlatform): string {
  return path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME, `${platform}-credentials.json`);
}

/**
 * Register default messenger adapters if they are not already registered.
 *
 * @param registry - The messenger registry to populate
 */
function registerDefaultAdapters(registry: MessengerRegistryService): void {
  if (!registry.get('slack')) registry.register(new SlackMessengerAdapter());
  if (!registry.get('telegram')) registry.register(new TelegramMessengerAdapter());
  if (!registry.get('discord')) registry.register(new DiscordMessengerAdapter());
  if (!registry.get('google-chat')) registry.register(new GoogleChatMessengerAdapter());
}

/**
 * Create the messenger API router.
 *
 * Registers default adapters and exposes status, connect, disconnect,
 * and send endpoints for each platform.
 *
 * @returns Express Router with messenger routes
 */
export function createMessengerRouter(): Router {
  const router = Router();
  const registry = MessengerRegistryService.getInstance();
  registerDefaultAdapters(registry);

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ success: true, data: registry.list() });
  });

  router.post('/:platform/connect', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const platform = validatePlatform(req.params.platform);
      if (!platform) {
        res.status(400).json({ success: false, error: `Invalid platform: ${req.params.platform}` });
        return;
      }
      const adapter = registry.get(platform);
      if (!adapter) {
        res.status(404).json({ success: false, error: `Unsupported platform: ${platform}` });
        return;
      }

      await adapter.initialize(req.body || {});
      const crewlyDir = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
      await fs.mkdir(crewlyDir, { recursive: true });
      await fs.writeFile(getCredentialPath(platform), JSON.stringify(req.body || {}, null, 2) + '\n', 'utf8');
      res.json({ success: true, data: adapter.getStatus(), message: `${platform} connected` });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:platform/disconnect', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const platform = validatePlatform(req.params.platform);
      if (!platform) {
        res.status(400).json({ success: false, error: `Invalid platform: ${req.params.platform}` });
        return;
      }
      const adapter = registry.get(platform);
      if (!adapter) {
        res.status(404).json({ success: false, error: `Unsupported platform: ${platform}` });
        return;
      }

      await adapter.disconnect();
      await fs.rm(getCredentialPath(platform), { force: true });
      res.json({ success: true, message: `${platform} disconnected` });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:platform/send', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const platform = validatePlatform(req.params.platform);
      if (!platform) {
        res.status(400).json({ success: false, error: `Invalid platform: ${req.params.platform}` });
        return;
      }
      const adapter = registry.get(platform);
      if (!adapter) {
        res.status(404).json({ success: false, error: `Unsupported platform: ${platform}` });
        return;
      }

      const channel = String(req.body?.channel || req.body?.space || '');
      const text = String(req.body?.text || '');
      if (!channel || !text) {
        res.status(400).json({ success: false, error: 'channel (or space) and text are required' });
        return;
      }

      const threadId = req.body?.threadId || req.body?.threadName || undefined;
      await adapter.sendMessage(channel, text, { threadId });
      res.json({ success: true, message: 'Message sent' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
