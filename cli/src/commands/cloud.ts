/**
 * CLI Cloud Command Group
 *
 * Provides subcommands for managing CrewlyAI Cloud connection:
 *   crewly cloud login [--token <token>]  — Authenticate with CrewlyAI Cloud
 *   crewly cloud status                   — Show current connection status
 *   crewly cloud logout                   — Disconnect from CrewlyAI Cloud
 *
 * The login flow supports two modes:
 * 1. Direct token login via --token flag
 * 2. Browser-based OAuth: starts a local HTTP callback server, opens the
 *    backend Google OAuth URL, receives the token via redirect, persists
 *    credentials to ~/.crewly/cloud/config.json, then calls POST /api/cloud/connect.
 *
 * @module cli/commands/cloud
 */

import chalk from 'chalk';
import axios from 'axios';
import http from 'http';
import { exec } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { DEFAULT_WEB_PORT } from '../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Backend base URL */
const BACKEND_URL = `http://localhost:${DEFAULT_WEB_PORT}`;

/** Cloud connect endpoint */
const CLOUD_CONNECT_ENDPOINT = '/api/cloud/connect';

/** Cloud disconnect endpoint */
const CLOUD_DISCONNECT_ENDPOINT = '/api/cloud/disconnect';

/** Cloud status endpoint */
const CLOUD_STATUS_ENDPOINT = '/api/cloud/status';

/** Google OAuth start endpoint */
const GOOGLE_OAUTH_START_ENDPOINT = '/api/cloud/google/start';

/** Timeout for backend API requests (ms) */
const API_TIMEOUT_MS = 15_000;

/** Directory for cloud credentials */
const CLOUD_CONFIG_DIR = join(homedir(), '.crewly', 'cloud');

/** Path to cloud config file */
const CLOUD_CONFIG_FILE = join(CLOUD_CONFIG_DIR, 'config.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the login subcommand */
interface LoginOptions {
  token?: string;
}

/** Shape of the credentials saved to config.json */
interface CloudCredentials {
  token: string;
  refreshToken?: string;
  savedAt: string;
}

/** Shape of the cloud status response data */
interface CloudStatusData {
  connectionStatus?: string;
  tier?: string;
  cloudUrl?: string;
  lastSyncAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Save cloud credentials to ~/.crewly/cloud/config.json.
 *
 * Creates the directory hierarchy if it does not exist.
 *
 * @param token - JWT access token
 * @param refreshToken - Optional refresh token
 */
export function saveCloudCredentials(token: string, refreshToken?: string): void {
  if (!existsSync(CLOUD_CONFIG_DIR)) {
    mkdirSync(CLOUD_CONFIG_DIR, { recursive: true });
  }
  const credentials: CloudCredentials = {
    token,
    refreshToken,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(CLOUD_CONFIG_FILE, JSON.stringify(credentials, null, 2), 'utf-8');
}

/**
 * Load cloud credentials from ~/.crewly/cloud/config.json.
 *
 * @returns The saved credentials, or null if the file does not exist or is invalid
 */
export function loadCloudCredentials(): CloudCredentials | null {
  if (!existsSync(CLOUD_CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = readFileSync(CLOUD_CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as CloudCredentials;
  } catch {
    return null;
  }
}

/**
 * Open a URL in the user's default browser.
 *
 * Uses `open` on macOS and `xdg-open` on Linux.
 *
 * @param url - The URL to open
 */
export function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

/**
 * Handle API errors with user-friendly output.
 *
 * Differentiates between network errors (backend not running) and
 * server errors (backend returned an error status).
 *
 * @param error - The caught error
 * @param action - Description of the failed action for the error message
 */
function handleApiError(error: unknown, action: string): never {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNREFUSED') {
      console.log(chalk.red(`  ✗ Cannot ${action}: Crewly backend is not running.`));
      console.log(chalk.gray('  Start with: crewly start'));
    } else if (error.response) {
      const msg = error.response.data?.error || error.response.statusText || 'Server error';
      console.log(chalk.red(`  ✗ Failed to ${action}: ${msg}`));
    } else {
      console.log(chalk.red(`  ✗ Failed to ${action}: ${error.message}`));
    }
  } else {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  ✗ Failed to ${action}: ${msg}`));
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Login subcommand
// ---------------------------------------------------------------------------

/**
 * Start a temporary HTTP server to receive the OAuth callback.
 *
 * The server listens on a random port and resolves with the token and
 * refreshToken query parameters from the callback URL. It automatically
 * shuts down after receiving the callback or after a 120-second timeout.
 *
 * @returns An object containing the server instance, the port, and a
 *          promise that resolves with the received credentials
 */
export function startCallbackServer(): {
  server: http.Server;
  port: Promise<number>;
  credentials: Promise<{ token: string; refreshToken?: string }>;
} {
  let resolvePort: (port: number) => void;
  let resolveCreds: (creds: { token: string; refreshToken?: string }) => void;
  let rejectCreds: (err: Error) => void;

  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  const credsPromise = new Promise<{ token: string; refreshToken?: string }>((resolve, reject) => {
    resolveCreds = resolve;
    rejectCreds = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    if (url.pathname === '/callback') {
      const token = url.searchParams.get('token');
      const refreshToken = url.searchParams.get('refreshToken') || undefined;

      if (token) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Login successful!</h2><p>You can close this tab.</p></body></html>');
        resolveCreds({ token, refreshToken });
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Login failed</h2><p>No token received.</p></body></html>');
        rejectCreds(new Error('No token received in callback'));
      }

      // Shut down server after response
      setTimeout(() => server.close(), 500);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(0, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    resolvePort!(port);
  });

  // Timeout after 120 seconds
  const timeout = setTimeout(() => {
    server.close();
    rejectCreds!(new Error('Login timed out — no callback received within 120 seconds'));
  }, 120_000);

  // Clean up timeout when credentials resolve
  credsPromise.then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));

  return { server, port: portPromise, credentials: credsPromise };
}

/**
 * Handle the `crewly cloud login` subcommand.
 *
 * With `--token`: saves the token and calls POST /api/cloud/connect directly.
 * Without `--token`: starts a local HTTP callback server, opens the browser
 * to the backend OAuth URL, waits for the callback, saves credentials, and
 * then calls POST /api/cloud/connect.
 *
 * @param options - Login command options (optional --token)
 */
export async function loginCommand(options: LoginOptions): Promise<void> {
  if (options.token) {
    // Direct token login
    console.log(chalk.blue('Logging in with provided token...'));
    await connectWithToken(options.token);
    return;
  }

  // Browser-based OAuth flow
  console.log('');
  console.log(chalk.blue('CrewlyAI Cloud Login'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log('');
  console.log(chalk.white('Opening browser for Google OAuth...'));

  const { server, port: portPromise, credentials } = startCallbackServer();

  try {
    const port = await portPromise;
    const redirectUrl = `http://localhost:${port}/callback`;
    const oauthUrl = `${BACKEND_URL}${GOOGLE_OAUTH_START_ENDPOINT}?redirect=${encodeURIComponent(redirectUrl)}`;

    openBrowser(oauthUrl);
    console.log(chalk.gray(`  Callback server listening on port ${port}`));
    console.log(chalk.gray('  Waiting for OAuth callback...'));
    console.log('');

    const creds = await credentials;
    saveCloudCredentials(creds.token, creds.refreshToken);
    console.log(chalk.green('  ✓ Credentials saved'));

    await connectWithToken(creds.token, creds.refreshToken);
  } catch (error) {
    server.close();
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  ✗ Login failed: ${msg}`));
    process.exit(1);
  }
}

/**
 * Connect to CrewlyAI Cloud by calling POST /api/cloud/connect.
 *
 * On success, displays the connection tier info.
 *
 * @param token - JWT access token
 * @param refreshToken - Optional refresh token
 */
async function connectWithToken(token: string, refreshToken?: string): Promise<void> {
  try {
    const response = await axios.post(
      `${BACKEND_URL}${CLOUD_CONNECT_ENDPOINT}`,
      { token, refreshToken },
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      console.log(chalk.green('  ✓ Connected to CrewlyAI Cloud'));
      const tier = response.data.data?.tier || response.data.tier || 'unknown';
      console.log(chalk.green(`  ✓ Tier: ${tier}`));
      saveCloudCredentials(token, refreshToken);
      console.log(chalk.green('  ✓ Credentials saved'));
    } else {
      const msg = response.data?.error || 'Unknown error';
      console.log(chalk.red(`  ✗ Failed to connect: ${msg}`));
      process.exit(1);
    }
  } catch (error) {
    handleApiError(error, 'login to CrewlyAI Cloud');
  }
}

// ---------------------------------------------------------------------------
// Status subcommand
// ---------------------------------------------------------------------------

/**
 * Handle the `crewly cloud status` subcommand.
 *
 * Calls GET /api/cloud/status and displays the connection state,
 * tier, cloud URL, and last sync time with color-coded output.
 */
export async function statusCommand(): Promise<void> {
  console.log(chalk.blue('Checking CrewlyAI Cloud status...'));
  console.log('');

  try {
    const response = await axios.get(
      `${BACKEND_URL}${CLOUD_STATUS_ENDPOINT}`,
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      const data: CloudStatusData = response.data.data || {};
      const status = data.connectionStatus || 'unknown';
      const tier = data.tier || 'none';
      const cloudUrl = data.cloudUrl || 'N/A';
      const lastSyncAt = data.lastSyncAt || 'never';

      // Color-code the status
      let statusDisplay: string;
      if (status === 'connected') {
        statusDisplay = chalk.green(status);
      } else if (status === 'token_expired') {
        statusDisplay = chalk.yellow(status);
      } else {
        statusDisplay = chalk.red(status);
      }

      console.log(`  Status:     ${statusDisplay}`);
      console.log(`  Tier:       ${chalk.white(tier)}`);
      console.log(`  Cloud URL:  ${chalk.gray(cloudUrl)}`);
      console.log(`  Last sync:  ${chalk.gray(lastSyncAt)}`);
    } else {
      console.log(chalk.yellow('  Could not retrieve cloud status.'));
    }
  } catch (error) {
    handleApiError(error, 'check cloud status');
  }
}

// ---------------------------------------------------------------------------
// Logout subcommand
// ---------------------------------------------------------------------------

/**
 * Handle the `crewly cloud logout` subcommand.
 *
 * Calls POST /api/cloud/disconnect to terminate the cloud session.
 */
export async function logoutCommand(): Promise<void> {
  console.log(chalk.blue('Disconnecting from CrewlyAI Cloud...'));

  try {
    const response = await axios.post(
      `${BACKEND_URL}${CLOUD_DISCONNECT_ENDPOINT}`,
      {},
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      console.log(chalk.green('  ✓ Disconnected from CrewlyAI Cloud'));
    } else {
      console.log(chalk.yellow('  No active cloud session to disconnect.'));
    }
  } catch (error) {
    handleApiError(error, 'disconnect from CrewlyAI Cloud');
  }
}
