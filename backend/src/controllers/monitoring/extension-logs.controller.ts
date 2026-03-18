/**
 * Extension Logs Controller
 *
 * Receives log batches from the Crewly Chrome Extension and writes them
 * to the InProcessLogBuffer under the session name 'chrome-extension'.
 * This allows extension activity to appear in the Side Terminal panel
 * alongside agent logs.
 *
 * @module controllers/monitoring/extension-logs.controller
 */

import type { Request, Response } from 'express';
import { InProcessLogBuffer } from '../../services/agent/crewly-agent/in-process-log-buffer.js';

/** Shape of a single log entry from the Chrome Extension */
interface ExtensionLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: Record<string, unknown> | null;
}

/** Shape of the POST body */
interface ExtensionLogPayload {
  source: string;
  logs: ExtensionLogEntry[];
}

/** Session name used for Chrome Extension logs in the log buffer */
const EXTENSION_SESSION = 'chrome-extension';

/**
 * POST /api/monitoring/extension-logs
 *
 * Accepts a batch of log entries from the Chrome Extension and
 * writes each one into the InProcessLogBuffer for real-time
 * display and disk persistence.
 *
 * @param req - Express request with ExtensionLogPayload body
 * @param res - Express response
 */
export function receiveExtensionLogs(req: Request, res: Response): void {
  const payload = req.body as ExtensionLogPayload;

  if (!payload?.logs || !Array.isArray(payload.logs)) {
    res.status(400).json({ error: 'Missing or invalid logs array' });
    return;
  }

  const buffer = InProcessLogBuffer.getInstance();

  // Ensure the session exists so logs appear in the terminal
  if (!buffer.hasSession(EXTENSION_SESSION)) {
    buffer.registerSession(EXTENSION_SESSION);
  }

  let written = 0;
  for (const entry of payload.logs) {
    if (!entry.message) continue;
    const level = (['info', 'warn', 'error', 'debug'].includes(entry.level))
      ? entry.level
      : 'info';
    const dataSuffix = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    buffer.append(EXTENSION_SESSION, level as 'info' | 'warn' | 'error' | 'debug', `${entry.message}${dataSuffix}`);
    written++;
  }

  res.json({ received: written });
}
