/**
 * Network exposure helpers for the startup banner.
 *
 * Decides whether the process looks headless (a server install rather than a
 * developer laptop) and renders the "how reachable is this API" summary the
 * server logs on boot, so an operator sees at once whether the box is bound
 * to every interface and where the API token lives.
 *
 * @module utils/network-exposure.utils
 */

import { API_SECURITY_CONSTANTS } from '../../../config/constants.js';
import type { ApiTokenSource } from '../services/core/api-token.service.js';

/** Inputs describing how the server is exposed. */
export interface NetworkExposureInput {
  /** Host passed to `httpServer.listen`. */
  bindHost: string;
  /** Listening port. */
  port: number;
  /** Whether `CREWLY_BIND_HOST` was explicitly set. */
  bindHostExplicit: boolean;
  /** Where the API token came from. */
  tokenSource: ApiTokenSource;
  /** Absolute path of the token file. */
  tokenFilePath: string;
  /** Whether the process looks headless. */
  headless: boolean;
}

/** Startup log entry describing exposure. */
export interface NetworkExposureSummary {
  /** Log level the server should use. */
  level: 'info' | 'warn';
  /** Human-readable message. */
  message: string;
  /** Structured details for the log line. */
  details: Record<string, string | number | boolean>;
}

/**
 * Whether the current process looks headless (no display attached).
 *
 * Rules: `CREWLY_HEADLESS=1|true` forces headless; darwin and win32 always
 * have a display; linux is headless without `DISPLAY`/`WAYLAND_DISPLAY`;
 * anything else is assumed headless.
 *
 * @param env - Environment to inspect (defaults to `process.env`)
 * @param platform - Platform to inspect (defaults to `process.platform`)
 * @returns True when the process appears to run without a display
 */
export function isHeadlessEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const forced = env[API_SECURITY_CONSTANTS.ENV.HEADLESS];
  if (forced === '1' || forced === 'true') return true;
  if (platform === 'darwin' || platform === 'win32') return false;
  if (platform === 'linux') return !env.DISPLAY && !env.WAYLAND_DISPLAY;
  return true;
}

/**
 * Whether a bind host only exposes the server to the local machine.
 *
 * @param bindHost - Host passed to `listen`
 * @returns True for loopback hosts
 */
export function isLoopbackBindHost(bindHost: string): boolean {
  return bindHost === 'localhost' || (API_SECURITY_CONSTANTS.LOOPBACK_ADDRESSES as readonly string[]).includes(bindHost);
}

/**
 * Render the startup exposure summary.
 *
 * A WARN is produced when the process is headless, `CREWLY_BIND_HOST` is
 * unset and `CREWLY_API_TOKEN` is unset — i.e. a server install that binds
 * every interface with only the auto-generated token standing between the
 * network and the orchestrator shell. Everything else is INFO.
 *
 * @param input - Exposure inputs
 * @returns Level, message and structured details
 */
export function describeNetworkExposure(input: NetworkExposureInput): NetworkExposureSummary {
  const { ENV, LOOPBACK_BIND_HOST } = API_SECURITY_CONSTANTS;
  const loopbackOnly = isLoopbackBindHost(input.bindHost);
  const tokenHint =
    input.tokenSource === 'env'
      ? `token from ${ENV.API_TOKEN}`
      : `token at ${input.tokenFilePath} (print with \`crewly token\`)`;

  const details: Record<string, string | number | boolean> = {
    bindHost: input.bindHost,
    port: input.port,
    loopbackOnly,
    tokenSource: input.tokenSource,
    tokenFile: input.tokenFilePath,
    rule: 'loopback callers need no token; every other address must send it (Bearer / X-Crewly-Token / crewly_token cookie)',
  };

  if (loopbackOnly) {
    return {
      level: 'info',
      message: `API bound to ${input.bindHost}:${input.port} (loopback only); ${tokenHint}`,
      details,
    };
  }

  const shouldWarn = input.headless && !input.bindHostExplicit && input.tokenSource !== 'env';
  if (shouldWarn) {
    return {
      level: 'warn',
      message:
        `API is reachable from the network on ${input.bindHost}:${input.port}. ` +
        `Only the auto-generated API token protects it (${tokenHint}). ` +
        `To restrict: set ${ENV.BIND_HOST}=${LOOPBACK_BIND_HOST} to bind loopback only, ` +
        `or set ${ENV.API_TOKEN} to pin the token and silence this warning.`,
      details,
    };
  }

  return {
    level: 'info',
    message: `API bound to ${input.bindHost}:${input.port}; non-loopback callers must present the API token (${tokenHint})`,
    details,
  };
}
