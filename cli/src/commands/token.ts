/**
 * CLI Token Command
 *
 * Prints the API token non-loopback callers must present to reach this
 * Crewly server, or a ready-to-open dashboard link carrying it.
 *
 * Usage:
 *   crewly token                 # print the token
 *   crewly token --url           # print http://<host>:<port>/?token=<token>
 *   crewly token --url --host x  # override the host in the link
 *
 * The token resolves exactly like the running server does
 * (`CREWLY_API_TOKEN` → `<CREWLY_HOME>/api-token` → generate + persist),
 * so running this before the first boot is fine: the server will pick up
 * the same file. The file may be sealed by the credential vault; it is
 * opened with the vault key from the login keychain (macOS) or the secrets
 * directory (Linux) — owner-only use, agents are refused by the guard.
 *
 * @module cli/commands/token
 */

import chalk from 'chalk';
import * as os from 'os';
import { resolveApiToken } from '../../../backend/src/services/core/api-token.service.js';
import { getVaultKeyUnavailableReason } from '../../../backend/src/services/core/credential-vault.js';
import { DEFAULT_WEB_PORT } from '../constants.js';

/** Options accepted by `crewly token`. */
export interface TokenOptions {
  /** Print a dashboard URL carrying the token instead of the bare token. */
  url?: boolean;
  /** Host to use in the URL (defaults to the first non-internal IPv4, else localhost). */
  host?: string;
  /** Port to use in the URL (defaults to WEB_PORT / 8787). */
  port?: string;
}

/**
 * Pick a host for the dashboard link: the first non-internal IPv4 address
 * (what a LAN/VPN user would type), falling back to `localhost`.
 *
 * @param interfaces - Output of `os.networkInterfaces()` (injectable for tests)
 * @returns Host string
 */
export function pickAdvertisedHost(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return 'localhost';
}

/**
 * Build the dashboard deep link. The frontend consumes `?token=` once,
 * stores it in localStorage and strips it from the address bar.
 *
 * @param token - API token
 * @param host - Host part of the URL
 * @param port - Port part of the URL
 * @returns Absolute dashboard URL
 */
export function buildDashboardUrl(token: string, host: string, port: number): string {
  return `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
}

/**
 * Entry point for `crewly token`.
 *
 * @param options - Command options from Commander.js
 */
export async function tokenCommand(options: TokenOptions = {}): Promise<void> {
  const resolved = resolveApiToken();
  if (resolved.source === 'ephemeral') {
    // The token file is sealed (specs/2026-10-04-agent-credential-isolation.md)
    // and the vault key could not be read — usually a locked login keychain
    // (an SSH session). Never print a made-up token.
    console.error(chalk.red(`The API token at ${resolved.filePath} is sealed and its key could not be read (${getVaultKeyUnavailableReason() ?? 'vault key unavailable'}).`));
    console.error(chalk.gray('Run this from a logged-in macOS session (the login keychain must be unlocked), or set CREWLY_API_TOKEN.'));
    process.exitCode = 1;
    return;
  }

  if (options.url) {
    const port = Number.parseInt(options.port ?? process.env.WEB_PORT ?? String(DEFAULT_WEB_PORT), 10) || DEFAULT_WEB_PORT;
    const host = options.host || pickAdvertisedHost();
    console.log(buildDashboardUrl(resolved.token, host, port));
    return;
  }

  console.log(resolved.token);
  if (resolved.source === 'generated') {
    console.error(chalk.gray(`Generated a new API token and stored it at ${resolved.filePath} (mode 0600).`));
  }
}
