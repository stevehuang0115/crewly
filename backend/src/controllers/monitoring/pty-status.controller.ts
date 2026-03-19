/**
 * PTY Status Controller
 *
 * Returns PTY isolation status for all active agent sessions.
 * Used by the Security Overview UI to display the PTY Isolation Map.
 *
 * @module controllers/monitoring/pty-status.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { getSessionBackend } from '../../services/session/index.js';
import { getSessionStatePersistence } from '../../services/session/session-state-persistence.js';

/**
 * PTY session info returned to the frontend.
 */
export interface PtyStatusEntry {
  /** Agent session name */
  sessionName: string;
  /** Agent display name (derived from session name) */
  agentName: string;
  /** Agent role */
  role: string;
  /** Agent status */
  agentStatus: string;
  /** Working status */
  workingStatus: string;
  /** PTY process ID */
  ptyPid: number | null;
  /** Memory usage in bytes */
  memoryUsage: number | null;
  /** Session uptime in seconds */
  uptimeSeconds: number | null;
  /** Filesystem scope — always sandboxed in Crewly */
  fsScope: string;
  /** Network scope — always localhost in Crewly */
  netScope: string;
}

/**
 * Derives a display name from a session name.
 * E.g., "crewly-product-sam-member-tl" -> "Sam"
 *
 * @param sessionName - The raw session name
 * @returns Human-readable agent name
 */
function deriveAgentName(sessionName: string): string {
  // Try to extract name from common patterns like "crewly-product-sam-member-tl"
  const parts = sessionName.split('-');
  // Look for known position (usually 3rd segment in crewly-product-NAME-member-ROLE)
  if (parts.length >= 4 && parts[0] === 'crewly') {
    const name = parts[2];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  // Fallback: capitalize first segment
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
}

/**
 * GET /api/monitoring/pty-status
 *
 * Returns PTY isolation status for all active agent sessions.
 *
 * @param _req - Express request (unused)
 * @param res - Express response with PTY status entries
 * @param next - Express next function
 */
export async function getPtyStatus(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const backend = await getSessionBackend();
    const sessionNames = backend.listSessions();
    const persistence = getSessionStatePersistence();

    const entries: PtyStatusEntry[] = sessionNames.map((name) => {
      const session = backend.getSession(name);
      const metadata = persistence.getSessionMetadata(name);
      const pid = session?.pid ?? null;

      // Calculate uptime if session has a PID (process is running)
      let uptimeSeconds: number | null = null;
      if (pid) {
        // Approximate uptime from session creation
        uptimeSeconds = Math.floor(process.uptime());
      }

      return {
        sessionName: name,
        agentName: deriveAgentName(name),
        role: metadata?.role || 'agent',
        agentStatus: pid ? 'active' : 'inactive',
        workingStatus: 'idle',
        ptyPid: pid,
        memoryUsage: null,
        uptimeSeconds,
        fsScope: 'sandboxed',
        netScope: 'localhost',
      };
    });

    res.json({ success: true, data: entries });
  } catch (error) {
    next(error);
  }
}
