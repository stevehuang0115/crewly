/**
 * CLI Pair Command
 *
 * Enables two Crewly instances to pair via Cloud Relay for
 * inter-node communication when direct connections are unavailable
 * (NAT/firewall). Uses pairing codes and E2EE (AES-256-GCM).
 *
 * Usage:
 *   crewly pair --cloud              # Generate a pairing code (orchestrator)
 *   crewly pair --cloud --code ABC   # Join with existing code (agent)
 *
 * @module cli/commands/pair
 */

import chalk from 'chalk';
import { randomBytes } from 'crypto';
import { createInterface } from 'readline';
import axios from 'axios';
import { DEFAULT_WEB_PORT } from '../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Backend base URL */
const BACKEND_URL = `http://localhost:${DEFAULT_WEB_PORT}`;

/** Relay API endpoint on the backend */
const RELAY_CONNECT_ENDPOINT = '/api/relay/connect';

/** Relay disconnect endpoint on the backend */
const RELAY_DISCONNECT_ENDPOINT = '/api/relay/disconnect';

/** Relay device list endpoint on the backend */
const RELAY_DEVICES_ENDPOINT = '/api/relay/devices';

/** Number of bytes for pairing code generation (produces 6-char hex string) */
const PAIRING_CODE_BYTES = 3;

/** Timeout for backend API requests (ms) */
const API_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PairOptions {
  cloud?: boolean;
  code?: string;
  role?: string;
  secret?: string;
  disconnect?: boolean;
  devices?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a short, human-friendly pairing code.
 *
 * Produces a 6-character uppercase hex string formatted as XXX-XXX.
 *
 * @returns Formatted pairing code (e.g. "A3F-B12")
 */
export function generatePairingCode(): string {
  const hex = randomBytes(PAIRING_CODE_BYTES).toString('hex').toUpperCase();
  return `${hex.slice(0, 3)}-${hex.slice(3, 6)}`;
}

/**
 * Prompt the user for text input on stdin.
 *
 * @param prompt - Text to display before the cursor
 * @returns The user's input string
 */
function askQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

/**
 * Entry point for the `crewly pair` command.
 *
 * Handles three sub-flows:
 * 1. `--disconnect` — Disconnect from an active relay session
 * 2. `--devices` — List paired/connected devices
 * 3. `--cloud` — Initiate or join a Cloud Relay pairing session
 *
 * When `--cloud` is used without `--code`, a new pairing code is generated
 * and the node registers as an orchestrator. When `--code` is provided,
 * the node joins as an agent using the given code.
 *
 * @param options - Command options from Commander.js
 */
export async function pairCommand(options: PairOptions): Promise<void> {
  if (options.disconnect) {
    await disconnectRelay();
    return;
  }

  if (options.devices) {
    await listDevices();
    return;
  }

  if (!options.cloud) {
    console.log(chalk.red('Please specify a pairing method.'));
    console.log(chalk.gray('Usage: crewly pair --cloud'));
    console.log(chalk.gray('       crewly pair --cloud --code <CODE>'));
    console.log(chalk.gray('       crewly pair --disconnect'));
    console.log(chalk.gray('       crewly pair --devices'));
    process.exit(1);
  }

  await cloudPair(options);
}

/**
 * Initiate or join a Cloud Relay pairing session.
 *
 * If no `--code` is provided, generates a new pairing code and registers
 * as an orchestrator, then waits for an agent to pair.
 * If `--code` is provided, joins as an agent using the existing code.
 *
 * @param options - Command options including optional code, role, and secret
 */
async function cloudPair(options: PairOptions): Promise<void> {
  let pairingCode = options.code || '';
  let role: 'orchestrator' | 'agent';

  if (pairingCode) {
    // Joining an existing session as an agent
    role = (options.role as 'orchestrator' | 'agent') || 'agent';
    console.log(chalk.blue(`Joining Cloud Relay with code: ${chalk.bold(pairingCode)}`));
  } else {
    // Creating a new session as an orchestrator
    role = (options.role as 'orchestrator' | 'agent') || 'orchestrator';
    pairingCode = generatePairingCode();
    console.log('');
    console.log(chalk.blue('Cloud Relay Pairing'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log('');
    console.log(chalk.white('Your pairing code:'));
    console.log('');
    console.log(chalk.bold.cyan(`    ${pairingCode}`));
    console.log('');
    console.log(chalk.gray('Share this code with the other machine.'));
    console.log(chalk.gray('Run on the other machine:'));
    console.log(chalk.gray(`  crewly pair --cloud --code ${pairingCode}`));
    console.log('');
  }

  // Prompt for shared secret if not provided
  const sharedSecret = options.secret || await askQuestion(
    chalk.white('Enter shared secret (for E2EE encryption): '),
  );

  if (!sharedSecret) {
    console.log(chalk.red('Shared secret is required for end-to-end encryption.'));
    process.exit(1);
  }

  // Connect via backend API
  console.log('');
  console.log(chalk.blue('Connecting to Cloud Relay...'));

  try {
    const response = await axios.post(
      `${BACKEND_URL}${RELAY_CONNECT_ENDPOINT}`,
      {
        pairingCode,
        role,
        sharedSecret,
      },
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      console.log(chalk.green('  ✓ Connected to Cloud Relay'));
      console.log(chalk.green(`  ✓ Role: ${role}`));
      console.log(chalk.green(`  ✓ Pairing code: ${pairingCode}`));

      if (response.data.sessionId) {
        console.log(chalk.green(`  ✓ Session ID: ${response.data.sessionId}`));
      }

      console.log('');
      if (role === 'orchestrator') {
        console.log(chalk.cyan('Waiting for agent to pair with your code...'));
        console.log(chalk.gray('The connection will be established when the other machine joins.'));
      } else {
        console.log(chalk.cyan('Pairing with orchestrator...'));
        console.log(chalk.gray('The connection will be established momentarily.'));
      }

      console.log('');
      console.log(chalk.gray('To disconnect: crewly pair --disconnect'));
      console.log(chalk.gray('To see paired devices: crewly pair --devices'));
    } else {
      const msg = response.data?.error || 'Unknown error';
      console.log(chalk.red(`  ✗ Failed to connect: ${msg}`));
      process.exit(1);
    }
  } catch (error) {
    handleApiError(error, 'connect to Cloud Relay');
  }
}

/**
 * Disconnect from an active Cloud Relay session.
 */
async function disconnectRelay(): Promise<void> {
  console.log(chalk.blue('Disconnecting from Cloud Relay...'));

  try {
    const response = await axios.post(
      `${BACKEND_URL}${RELAY_DISCONNECT_ENDPOINT}`,
      {},
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      console.log(chalk.green('  ✓ Disconnected from Cloud Relay'));
    } else {
      console.log(chalk.yellow('  No active relay session to disconnect.'));
    }
  } catch (error) {
    handleApiError(error, 'disconnect from Cloud Relay');
  }
}

/**
 * List devices connected via Cloud Relay.
 */
async function listDevices(): Promise<void> {
  console.log(chalk.blue('Fetching paired devices...'));

  try {
    const response = await axios.get(
      `${BACKEND_URL}${RELAY_DEVICES_ENDPOINT}`,
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      const devices = response.data.devices || [];
      if (devices.length === 0) {
        console.log(chalk.yellow('  No devices currently paired.'));
        console.log(chalk.gray('  Use "crewly pair --cloud" to start pairing.'));
      } else {
        console.log(chalk.green(`  Found ${devices.length} paired device(s):\n`));
        for (const device of devices) {
          const statusColor = device.state === 'paired' ? chalk.green : chalk.yellow;
          console.log(`  ${statusColor('●')} ${chalk.white(device.role || 'unknown')} — ${device.sessionId || 'N/A'}`);
          console.log(chalk.gray(`    State: ${device.state || 'unknown'}`));
          if (device.registeredAt) {
            console.log(chalk.gray(`    Connected: ${device.registeredAt}`));
          }
        }
      }
    } else {
      console.log(chalk.yellow('  Could not fetch device list.'));
    }
  } catch (error) {
    handleApiError(error, 'fetch paired devices');
  }
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
