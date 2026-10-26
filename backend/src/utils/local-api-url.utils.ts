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
 * The host is an IP literal, never `localhost`. Node resolves every hostname
 * (`localhost` included) with `getaddrinfo` on the libuv threadpool; during
 * the 2026-10-26 Wi-Fi drop the pool was full of hanging Cloud lookups, so
 * the reconciler's own `…/members/start` and the dispatcher's
 * `/api/terminal/:name/write` calls to this very process timed out for
 * twenty minutes ("fetch failed" after 10 s, axios 45 s). An IP literal
 * skips the lookup, so a self-call never waits on DNS.
 *
 * @module utils/local-api-url
 */

import { isIP } from 'net';
import { WEB_CONSTANTS } from '../constants.js';

/** Loopback IPv4 literal: reaches a server bound to `0.0.0.0`, `::` (dual-stack) or `localhost` */
const LOOPBACK_HOST = '127.0.0.1';
/** Bind addresses that mean "every interface" — loopback reaches them */
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::']);

/** Largest valid TCP port. */
const MAX_TCP_PORT = 65535;

/** Port recorded by the running server, or null before it is known. */
let runningPort: number | null = null;
/** The host self-calls use, derived from the bind host at construction */
let runningHost: string | null = null;

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
 * Record the port (and bind host) this server listens on, at construction.
 *
 * @param port - The resolved listen port
 * @param bindHost - The address the server binds to; a specific IP literal
 *   becomes the self-call host, anything else (wildcard, hostname, absent)
 *   means loopback
 * @throws Error when the port is not a valid TCP port
 */
export function setLocalApiPort(port: number, bindHost?: string): void {
  const parsed = parsePort(port);
  if (parsed === null) {
    throw new Error(`Invalid Crewly API port: ${String(port)}`);
  }
  runningPort = parsed;
  runningHost = selfCallHost(bindHost);
}

/**
 * The host self-calls and agents use for a server bound to `bindHost`: an IP
 * literal always (no DNS lookup, see the module note), so a specific bind
 * address is used as is (IPv6 bracketed) and a wildcard or hostname bind
 * (`0.0.0.0`, `::`, `localhost`) is reached over `127.0.0.1`.
 *
 * @param bindHost - The server's bind address, if any
 * @returns Host part of the base URL
 */
export function selfCallHost(bindHost: string | undefined): string {
  const host = (bindHost ?? '').trim();
  if (host === '' || WILDCARD_BIND_HOSTS.has(host)) return LOOPBACK_HOST;
  const family = isIP(host);
  if (family === 4) return host;
  if (family === 6) return `[${host}]`;
  return LOOPBACK_HOST;
}

/**
 * Host part of this instance's API URL.
 *
 * @returns An IP literal (IPv6 bracketed)
 */
export function getLocalApiHost(): string {
  return runningHost ?? LOOPBACK_HOST;
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
 * Base URL of this instance's API, e.g. `http://127.0.0.1:8797` — the value
 * agents receive as `CREWLY_API_URL`. Paths are appended by the caller
 * (`${getLocalApiBaseUrl()}/api/teams`).
 *
 * @returns The base URL without a trailing slash
 */
export function getLocalApiBaseUrl(): string {
  return `http://${getLocalApiHost()}:${getLocalApiPort()}`;
}

/**
 * Forget the recorded port (tests only).
 */
export function resetLocalApiPortForTesting(): void {
  runningPort = null;
  runningHost = null;
}
