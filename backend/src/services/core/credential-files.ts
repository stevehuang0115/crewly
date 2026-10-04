/**
 * Crewly's credential files: the inventory the runtime credential guard
 * refuses to agents.
 *
 * Spec: specs/2026-10-04-agent-credential-isolation.md (inventory, layer 2).
 * Sealing these files is PR B (same spec); this list is only what the guard
 * matches.
 *
 * @module services/core/credential-files
 */

import * as os from 'os';
import * as path from 'path';
import { getCrewlyHomePath } from './crewly-home.utils.js';
import { getApiTokenFilePath } from './api-token.service.js';
import { HARNESS_CONSTANTS, SLACK_AGENT_IDENTITY_CONSTANTS, SLACK_CLOUD_CONSTANTS, TELEGRAM_CONSTANTS, WHATSAPP_CONSTANTS } from '../../constants.js';
import { CREWLY_CONSTANTS } from '../../../../config/constants.js';

/** A path agents must not read: a file or a whole directory. */
export interface GuardedPath {
	/** Rule id reported when an agent touches it. */
	id: string;
	/** Absolute path. */
	path: string;
	/** Whole subtree. */
	isDirectory: boolean;
}

/**
 * `~/.crewly` as the modules that ignore CREWLY_HOME build it (Slack and
 * Telegram credentials, the messenger route, the encrypted credential
 * store). On a normal install it is the same directory as CREWLY_HOME.
 *
 * @returns Absolute directory
 */
function homeCrewlyDir(): string {
	return path.join(process.env.HOME || os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
}

/**
 * Every credential location the runtime guard refuses to agents.
 *
 * @returns Paths, de-duplicated
 */
export function getGuardedCredentialPaths(): GuardedPath[] {
	const home = getCrewlyHomePath();
	const legacyHome = homeCrewlyDir();
	const out: GuardedPath[] = [];
	const seen = new Set<string>();
	const add = (id: string, p: string, isDirectory: boolean): void => {
		const abs = path.resolve(p);
		if (seen.has(abs)) return;
		seen.add(abs);
		out.push({ id, path: abs, isDirectory });
	};
	add('api-token', getApiTokenFilePath(), false);
	add('cloud-config', path.join(home, 'cloud'), true);
	add('harness-credentials', path.join(home, HARNESS_CONSTANTS.CREDENTIALS_FILE), false);
	add('settings-api-keys', path.join(home, 'settings.json'), false);
	add('slack-agent-identities', path.join(home, SLACK_AGENT_IDENTITY_CONSTANTS.STORE_FILENAME), false);
	add('slack-cloud-config', path.join(home, SLACK_CLOUD_CONSTANTS.CONFIG_CACHE_FILENAME), false);
	add('telegram-credentials', path.join(legacyHome, TELEGRAM_CONSTANTS.CREDENTIALS_FILE), false);
	for (const platform of ['slack', 'telegram', 'discord', 'google-chat']) {
		add(`${platform}-credentials`, path.join(legacyHome, `${platform}-credentials.json`), false);
	}
	add('credential-store', path.join(legacyHome, 'credentials'), true);
	add('credential-store', path.join(home, 'credentials'), true);
	add('whatsapp-session', path.join(home, WHATSAPP_CONSTANTS.AUTH_DIR), true);
	add('claude-accounts', path.join(home, HARNESS_CONSTANTS.CLAUDE.ACCOUNTS.DIR), true);
	return out;
}
