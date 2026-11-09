/**
 * Claude token migration — retire the Claude sign-in tokens older Crewly
 * versions saved, without locking anyone out.
 *
 * Anthropic's Claude Code legal page: developers may not collect, store or
 * intermediate Claude.ai credentials or session tokens; sign-in must finish
 * through Anthropic's own flow. Older Crewly ran `claude setup-token`, read
 * the token off the screen and saved it in `harness-credentials.json`
 * (`claude.oauthToken` for the default login, `claudeAccounts.<name>.oauthToken`
 * for named accounts). Crewly now signs in with Claude Code's own
 * `claude auth login` and stores nothing (login-broker.service.ts).
 *
 * Rules of the transition:
 *
 * - A saved token keeps being handed to its account's Claude Code processes
 *   until that account is signed in natively (store.legacyClaudeTokenEnv).
 *   Nothing stops working on upgrade.
 * - A token is deleted only after the account's native login is verified by
 *   a real Claude turn run WITHOUT any token or key in the env
 *   (claude-native-login.ts). A login that only looks signed in is not enough.
 * - A named account's own config dir can only have been signed in by Crewly's
 *   flow or by the owner, so a verified native login there retires its token
 *   at once (the periodic run notices a login done by hand too). The default
 *   login is different: the machine's own Claude login may be another
 *   account than the one the saved token belongs to, so its token is retired
 *   only by a sign-in done through Crewly (`login claude`), never guessed.
 * - The owner is told once per machine which accounts need one re-sign-in
 *   (state file `claude-token-migration.json`, no secrets in it).
 * - When no saved token remains, the leftover Claude keys are removed from
 *   `harness-credentials.json`; other keys are untouched, the file is
 *   rewritten atomically with mode 0600, and no backup is kept.
 *
 * @module services/harness/claude-token-migration.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { claudeAccountConfigDir } from './claude-accounts.js';
import { probeClaudeNativeLogin, readClaudeAuthStatus, setCachedClaudeNativeLogin } from './claude-native-login.js';
import { getHarnessCredentialsStore, type HarnessCredentialsStore } from './harness-credentials.store.js';
import { SILENT_HARNESS_LOGGER, type HarnessLogger, type LoginState } from './harness.types.js';

const MIGRATION = HARNESS_CONSTANTS.CLAUDE.TOKEN_MIGRATION;

/** A login that still depends on a token an older Crewly saved. */
export interface LegacyTokenEntry {
	/** Named account; null = the default login */
	account: string | null;
}

/** What one run did. */
export interface MigrationResult {
	/** Logins whose token was deleted this run */
	retired: Array<string | null>;
	/** Logins that still run on a saved token (need a native sign-in) */
	pending: Array<string | null>;
	/** The owner notice was sent this run */
	notified: boolean;
}

/** Owner DM sender. */
export interface MigrationNotifier {
	sendToOwner(text: string): Promise<unknown>;
}

/** Persisted bookkeeping. Never holds a credential. */
interface MigrationState {
	version: 1;
	/** ISO time the owner was told */
	notifiedAt?: string;
	/** Logins the notice named (account names; `default` for the default login) */
	notifiedFor?: string[];
}

/** Injectable dependencies. */
export interface ClaudeTokenMigrationDeps {
	credentials?: Pick<
		HarnessCredentialsStore,
		| 'getLegacyClaudeOauthToken'
		| 'listClaudeAccountsWithToken'
		| 'clearLegacyClaudeOauthToken'
		| 'clearClaudeAccount'
		| 'pruneLegacyClaudeKeys'
	>;
	/** Real Claude turn on Claude Code's own login, no token in the env */
	probe?: (configDir: string | null) => Promise<LoginState>;
	/** `claude auth status` on Claude Code's own login */
	readStatus?: (configDir: string | null) => Promise<boolean | null>;
	/** Config dir of a named account */
	accountConfigDir?: (account: string) => string;
	notifier?: () => MigrationNotifier | null;
	/** Directory of the state file (default CREWLY_HOME) */
	crewlyHome?: string;
	logger?: HarnessLogger;
	now?: () => number;
}

/**
 * Display name of a login for the owner.
 *
 * @param account - Named account; null = the default login
 * @returns e.g. `login claude work` / `login claude`
 */
function loginCommandFor(account: string | null): string {
	return account ? `login claude ${account}` : 'login claude';
}

/** Retires saved Claude tokens once the account is signed in natively. */
export class ClaudeTokenMigrationService {
	private readonly credentials: NonNullable<ClaudeTokenMigrationDeps['credentials']>;
	private readonly probe: (configDir: string | null) => Promise<LoginState>;
	private readonly readStatus: (configDir: string | null) => Promise<boolean | null>;
	private readonly accountConfigDir: (account: string) => string;
	private notifier: () => MigrationNotifier | null;
	private readonly crewlyHome: string | undefined;
	private readonly logger: HarnessLogger;
	private readonly now: () => number;
	private running: Promise<MigrationResult> | null = null;
	private timer: NodeJS.Timeout | null = null;

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: ClaudeTokenMigrationDeps = {}) {
		this.credentials = deps.credentials ?? getHarnessCredentialsStore();
		this.probe = deps.probe ?? ((configDir) => probeClaudeNativeLogin(configDir));
		this.readStatus = deps.readStatus ?? ((configDir) => readClaudeAuthStatus(configDir));
		this.accountConfigDir = deps.accountConfigDir ?? ((account) => claudeAccountConfigDir(account));
		this.notifier = deps.notifier ?? (() => null);
		this.crewlyHome = deps.crewlyHome;
		this.logger = deps.logger ?? SILENT_HARNESS_LOGGER;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * Where the owner notice is sent.
	 *
	 * @param notifier - Lazy owner DM sender
	 */
	setNotifier(notifier: () => MigrationNotifier | null): void {
		this.notifier = notifier;
	}

	/**
	 * Logins that still depend on a saved token.
	 *
	 * @returns Entries (default login first)
	 */
	listLegacy(): LegacyTokenEntry[] {
		const entries: LegacyTokenEntry[] = [];
		if (this.credentials.getLegacyClaudeOauthToken() !== null) entries.push({ account: null });
		for (const account of this.credentials.listClaudeAccountsWithToken()) entries.push({ account });
		return entries;
	}

	/**
	 * Check every login that still has a saved token; retire what can be
	 * retired and tell the owner about the rest, once. Safe to call at any
	 * time and as often as you like (idempotent); concurrent calls share one run.
	 *
	 * @returns What happened; never rejects
	 */
	run(): Promise<MigrationResult> {
		if (!this.running) {
			this.running = this.runOnce()
				.catch((error): MigrationResult => {
					this.logger.warn('Claude token migration failed', { error: error instanceof Error ? error.message : String(error) });
					return { retired: [], pending: [], notified: false };
				})
				.finally(() => {
					this.running = null;
				});
		}
		return this.running;
	}

	/**
	 * A sign-in done through Crewly just completed and was verified: retire
	 * the saved token of that login (default or named).
	 *
	 * @param account - Named account; null = the default login
	 * @returns Resolves when done; never rejects
	 */
	async afterLogin(account: string | null): Promise<void> {
		try {
			if (!this.hasLegacy(account)) {
				this.finishCleanup();
				return;
			}
			await this.retireIfVerified(account);
			this.finishCleanup();
		} catch (error) {
			this.logger.warn('Claude token migration after a login failed', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Run now (after a short delay) and then on an interval.
	 *
	 * @param startDelayMs - Delay before the first run
	 */
	start(startDelayMs: number = MIGRATION.START_DELAY_MS): void {
		if (this.timer) return;
		const first = setTimeout(() => {
			void this.run();
			this.timer = setInterval(() => void this.run(), MIGRATION.RUN_INTERVAL_MS);
			this.timer.unref?.();
		}, startDelayMs);
		first.unref?.();
		this.timer = first;
	}

	/** Stop the timers. */
	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			clearInterval(this.timer);
		}
		this.timer = null;
	}

	// ----------------------------------------------------------------- internals

	private hasLegacy(account: string | null): boolean {
		return account === null ? this.credentials.getLegacyClaudeOauthToken() !== null : this.credentials.listClaudeAccountsWithToken().includes(account);
	}

	private configDirOf(account: string | null): string | null {
		return account ? this.accountConfigDir(account) : null;
	}

	/**
	 * Delete the saved token of a login when its native login passes a real
	 * Claude turn with no token in the env.
	 *
	 * @param account - Named account; null = the default login
	 * @returns True when the token was deleted
	 */
	private async retireIfVerified(account: string | null): Promise<boolean> {
		const configDir = this.configDirOf(account);
		if ((await this.probe(configDir)) !== 'logged_in') return false;
		if (account) this.credentials.clearClaudeAccount(account);
		else this.credentials.clearLegacyClaudeOauthToken();
		setCachedClaudeNativeLogin(account, true, this.now());
		this.logger.info('Retired a saved Claude token: the account is signed in through Claude Code itself', { account: account ?? 'default' });
		return true;
	}

	/** Remove leftover Claude keys once no saved token remains. */
	private finishCleanup(): void {
		if (this.listLegacy().length === 0) this.credentials.pruneLegacyClaudeKeys();
	}

	private async runOnce(): Promise<MigrationResult> {
		const result: MigrationResult = { retired: [], pending: [], notified: false };
		for (const { account } of this.listLegacy()) {
			// The default login is retired only by a sign-in done through Crewly
			// (afterLogin): the machine's own Claude login may be another account.
			if (account !== null && (await this.readStatus(this.configDirOf(account))) === true && (await this.retireIfVerified(account))) {
				result.retired.push(account);
				continue;
			}
			result.pending.push(account);
		}
		this.finishCleanup();
		if (result.pending.length > 0) result.notified = await this.notifyOnce(result.pending);
		return result;
	}

	private statePath(): string {
		return path.join(this.crewlyHome ?? getCrewlyHomePath(), MIGRATION.STATE_FILE);
	}

	private readState(): MigrationState {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.statePath(), 'utf-8'));
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { version: 1, ...(parsed as Partial<MigrationState>) };
		} catch {
			// no state yet
		}
		return { version: 1 };
	}

	private writeState(state: MigrationState): void {
		const file = this.statePath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: HARNESS_CONSTANTS.CREDENTIALS_FILE_MODE });
		fs.renameSync(tmp, file);
	}

	/**
	 * Tell the owner, once per machine, which logins need one re-sign-in.
	 *
	 * @param pending - Logins that still run on a saved token
	 * @returns True when the notice was delivered now
	 */
	private async notifyOnce(pending: Array<string | null>): Promise<boolean> {
		if (this.readState().notifiedAt) return false;
		const notifier = this.notifier();
		if (!notifier) return false;
		const lines = pending.map((account) => `• ${account ? `Claude account "${account}"` : 'The default Claude login'}: reply \`${loginCommandFor(account)}\``);
		const text = [
			'Anthropic requires Claude sign-in to finish inside Claude Code itself, so Crewly no longer saves Claude sign-in tokens.',
			'Everything keeps working as before. Please sign these in once more, when you have a minute:',
			...lines,
			'After that, the old saved token is deleted from this machine.',
		].join('\n');
		try {
			const delivered = await notifier.sendToOwner(text);
			if (delivered === false) return false;
		} catch {
			return false;
		}
		this.writeState({ version: 1, notifiedAt: new Date(this.now()).toISOString(), notifiedFor: pending.map((a) => a ?? 'default') });
		return true;
	}
}

/** Backend singleton. */
let instance: ClaudeTokenMigrationService | null = null;

/**
 * The backend's token migration, bound to the stored credentials.
 *
 * @returns The singleton
 */
export function getClaudeTokenMigrationService(): ClaudeTokenMigrationService {
	if (!instance) instance = new ClaudeTokenMigrationService();
	return instance;
}

/**
 * Replace or clear the singleton (tests).
 *
 * @param service - Service, or null
 */
export function setClaudeTokenMigrationServiceForTesting(service: ClaudeTokenMigrationService | null): void {
	instance?.stop();
	instance = service;
}
