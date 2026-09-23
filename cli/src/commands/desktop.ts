/**
 * `crewly desktop remote on|off|status` — allow or forbid watching and
 * driving this machine's desktop from the portal and the phone.
 *
 * It has to be run on the machine: the backend accepts the switch only from
 * loopback, so this is the "someone at the Mac said yes" step.
 *
 * @module cli/commands/desktop
 */

import chalk from 'chalk';
import { WEB_CONSTANTS } from '../../../config/index.js';

const BACKEND_PORT = process.env.WEB_PORT || WEB_CONSTANTS.PORTS.BACKEND;

/**
 * Run `crewly desktop <area> <action>`.
 *
 * @param area - Only `remote` for now
 * @param action - `on`, `off` or `status`
 * @param fetchImpl - Injectable for tests
 * @returns Exit code
 */
export async function desktopCommand(area: string, action: string | undefined, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (area !== 'remote' || !['on', 'off', 'status', undefined].includes(action)) {
    console.log(chalk.red('Usage: crewly desktop remote on|off|status'));
    return 1;
  }
  const url = `http://127.0.0.1:${BACKEND_PORT}/api/desktop/remote`;
  try {
    const res =
      action === 'on' || action === 'off'
        ? await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: action === 'on' }) })
        : await fetchImpl(url);
    const body = (await res.json()) as { success?: boolean; data?: { enabled?: boolean }; message?: string };
    if (!res.ok || !body.success) {
      console.log(chalk.red(body.message ?? `Crewly answered ${res.status}`));
      return 1;
    }
    const on = body.data?.enabled === true;
    console.log(
      on
        ? chalk.green('Remote desktop is ON — you can watch and drive this machine from crewlyai.com (Desktop) and the phone.')
        : chalk.yellow('Remote desktop is OFF.'),
    );
    return 0;
  } catch {
    console.log(chalk.red('Crewly is not running here. Start it with: crewly start'));
    return 1;
  }
}
