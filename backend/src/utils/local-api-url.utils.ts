/**
 * The one place the backend's own API address comes from.
 *
 * Agents (`CREWLY_API_URL` in their PTY env), the in-process crewly-agent
 * runtime, skills spawned by the server, and the server's own
 * server-to-server calls (reconciler wake, auto-claim, dispatch writes) all
 * need to reach THIS instance. They used to hard-code
 * `WEB_CONSTANTS.PORTS.BACKEND` (8787), so an instance started with
 * `crewly start -p 8797` handed its agents the default port and every skill
 * call went to the wrong server — or to another Crewly on 8787 (#777).
 *
 * The server records its resolved listen port at construction
 * ({@link setLocalApiPort}); everything else asks {@link getLocalApiPort} /
 * {@link getLocalApiBaseUrl}. Before that (tests, scripts) the accessor
 * falls back to `WEB_PORT`, then the default.
 *
 * `CREWLY_API_URL` in the backend's OWN environment is deliberately NOT
 * consulted: a backend launched from inside an agent shell inherits that
 * agent's URL, which points at a different instance.
 *
 * @module utils/local-api-url
 */

import { WEB_CONSTANTS } from '../constants.js';

/** Host agents use to reach the backend on the same machine. */
const LOCAL_API_HOST = 'localhost';

/** Largest valid TCP port. */
const MAX_TCP_PORT = 65535;

/** Port recorded by the running server, or null before it is known. */
let runningPort: number | null = null;

/**
 * Parse a port value, rejecting anything that is not an integer in 1..65535.
 *
 * @param value - Candidate port (number or numeric string)
 * @returns The port, or null when invalid
 */
export function parsePort(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_TCP_PORT ? n : null;
}

/**
 * Record the port this server listens on. Called once by the server with its
 * resolved `webPort` (from `-p` / `WEB_PORT` / default).
 *
 * @param port - The listen port
 * @throws {Error} When the port is not a valid TCP port
 */
export function setLocalApiPort(port: number): void {
  const parsed = parsePort(port);
  if (parsed === null) {
    throw new Error(`Invalid Crewly API port: ${String(port)}`);
  }
  runningPort = parsed;
}

/**
 * The port this Crewly instance's API is served on.
 *
 * @returns The recorded running port, else a valid `WEB_PORT`, else the default
 */
export function getLocalApiPort(): number {
  if (runningPort !== null) return runningPort;
  return parsePort(process.env.WEB_PORT) ?? WEB_CONSTANTS.PORTS.BACKEND;
}

/**
 * Base URL of this instance's API, e.g. `http://localhost:8797` — the value
 * agents receive as `CREWLY_API_URL`. Paths are appended by the caller
 * (`${getLocalApiBaseUrl()}/api/teams`).
 *
 * @returns The base URL without a trailing slash
 */
export function getLocalApiBaseUrl(): string {
  return `http://${LOCAL_API_HOST}:${getLocalApiPort()}`;
}

/**
 * Forget the recorded port (tests only).
 */
export function resetLocalApiPortForTesting(): void {
  runningPort = null;
}
