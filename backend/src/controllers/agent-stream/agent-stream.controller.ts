/**
 * Agent Stream Controller
 *
 * SSE endpoint that streams real-time agent execution events to the frontend.
 * Clients connect via GET /api/agents/:sessionName/stream and receive
 * text_chunk, tool_call_start, tool_call_finish, and step_finish events.
 *
 * @module controllers/agent-stream/agent-stream.controller
 */

import type { Request, Response } from 'express';
import { AgentStreamService, type AgentStreamEvent } from '../../services/agent/crewly-agent/agent-stream.service.js';

// NOTE: The lazy load of `InProcessLogBuffer` inside
// `getStreamableSessions` (below) avoids a top-level circular import.
// The relative-path resolution requires the calling file's URL as
// anchor, so we use ESM dynamic `import()` rather than CJS `require`.
// See `backend/src/utils/node-require.utils.ts` JSDoc for why the
// previous `createRequire(...)` paths (PR #323 `new Function`,
// PR #494 `process.argv[1]`, eval-trick) all fail.

/** SSE heartbeat interval in milliseconds to keep the connection alive */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * SSE endpoint handler for streaming agent execution events.
 *
 * Sets up an SSE connection that:
 * 1. Sends a 'connected' event on initial connection
 * 2. Forwards all AgentStreamService events for the requested sessionName
 * 3. Sends heartbeat events every 15s to prevent connection timeout
 * 4. Cleans up listeners on client disconnect
 *
 * @param req - Express request with sessionName param
 * @param res - Express response configured for SSE
 */
export function streamAgentEvents(req: Request, res: Response): void {
  const { sessionName } = req.params;

  if (!sessionName) {
    res.status(400).json({ success: false, error: 'sessionName parameter is required' });
    return;
  }

  // Configure SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial connected event
  const connectedEvent = JSON.stringify({
    type: 'connected',
    sessionName,
    timestamp: new Date().toISOString(),
  });
  res.write(`data: ${connectedEvent}\n\n`);

  // Subscribe to streaming events
  const streamService = AgentStreamService.getInstance();

  const handleStreamEvent = (event: AgentStreamEvent) => {
    // Only forward events for the requested session
    if (event.sessionName !== sessionName) return;

    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Client disconnected — cleanup will happen via 'close' event
    }
  };

  streamService.on('stream', handleStreamEvent);

  // Heartbeat to prevent connection timeout
  const heartbeatTimer = setInterval(() => {
    try {
      const heartbeat = JSON.stringify({
        type: 'heartbeat',
        sessionName,
        timestamp: new Date().toISOString(),
      });
      res.write(`data: ${heartbeat}\n\n`);
    } catch {
      clearInterval(heartbeatTimer);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup on client disconnect
  req.on('close', () => {
    streamService.off('stream', handleStreamEvent);
    clearInterval(heartbeatTimer);
  });
}

/**
 * Get a list of session names that currently have active streams.
 *
 * **Async** — the `InProcessLogBuffer` module is loaded LAZILY via ESM
 * dynamic `import()` to avoid a top-level circular import. The
 * dynamic-import migration replaced the previous `nodeRequire(...)`
 * (entry-script-anchored CJS `createRequire`) which broke relative-path
 * resolution at runtime. See `backend/src/utils/node-require.utils.ts`
 * JSDoc for the full lessons-banked context.
 *
 * @param _req - Express request
 * @param res - Express response
 */
export async function getStreamableSessions(_req: Request, res: Response): Promise<void> {
  try {
    // Lazy-load relative-path module via ESM dynamic import — see file
    // header NOTE for why this is async.
    const { InProcessLogBuffer } = await import(
      '../../services/agent/crewly-agent/in-process-log-buffer.js'
    );
    const buffer = InProcessLogBuffer.getInstance();
    const sessions = buffer.getSessionNames();

    res.json({
      success: true,
      data: sessions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: message });
  }
}
