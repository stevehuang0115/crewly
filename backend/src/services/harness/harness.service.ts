/**
 * Harness service — the one engine behind both setup front ends.
 *
 * The REST API (`/api/harness`, used by the web setup page) and the `crewly`
 * CLI (`crewly onboard`, `crewly login`, `crewly harness`) both call this
 * facade, so detection, install, orc choice and login behave identically.
 * The backend uses the process-wide {@link getHarnessService}; the CLI builds
 * its own instance with {@link createHarnessService} (silent logger, no
 * backend running required).
 *
 * @module services/harness/harness.service
 */

import { LoggerService } from '../core/logger.service.js';
import { HarnessApiKeyService } from './harness-api-key.service.js';
import { HarnessInstallService } from './harness-install.service.js';
import { getHarnessDefinition } from './harness-registry.js';
import { HarnessStatusService } from './harness-status.service.js';
import {
	SILENT_HARNESS_LOGGER,
	isHarnessId,
	type HarnessId,
	type HarnessLogger,
	type HarnessOverview,
	type HarnessStatus,
	type ReloginPending,
	type InstallJob,
	type LoginSession,
} from './harness.types.js';
import { LoginBrokerService } from './login-broker.service.js';
import { OrcHarnessStore, type DefaultRuntimeUpdater } from './orc-harness.store.js';

/** Error for an id that is not a harness (REST: 404). */
export class UnknownHarnessError extends Error {
	/**
	 * @param id - The id that was asked for
	 */
	constructor(public readonly id: string) {
		super(`Unknown harness: ${id}`);
		this.name = 'UnknownHarnessError';
	}
}

/** Parts of the service (each injectable for tests). */
export interface HarnessServiceParts {
	status: HarnessStatusService;
	install: HarnessInstallService;
	broker: LoginBrokerService;
	apiKeys: HarnessApiKeyService;
	orc: OrcHarnessStore;
}

/** Facade over status, install, orc choice, broker login and API-key login. */
export class HarnessService {
	readonly status: HarnessStatusService;
	readonly install: HarnessInstallService;
	readonly broker: LoginBrokerService;
	readonly apiKeys: HarnessApiKeyService;
	readonly orc: OrcHarnessStore;
	/** Pending Slack re-login per harness (set by the backend's re-login coordinator; the CLI has none) */
	private reloginPendingProvider: ((harnessId: HarnessId) => ReloginPending | null) | null = null;

	/**
	 * @param parts - Service parts
	 */
	constructor(parts: HarnessServiceParts) {
		this.status = parts.status;
		this.install = parts.install;
		this.broker = parts.broker;
		this.apiKeys = parts.apiKeys;
		this.orc = parts.orc;
	}

	/**
	 * Validate a harness id.
	 *
	 * @param id - Candidate
	 * @returns The id, typed
	 * @throws UnknownHarnessError for an unknown id
	 */
	requireHarnessId(id: string): HarnessId {
		if (!isHarnessId(id)) throw new UnknownHarnessError(id);
		return id;
	}

	/**
	 * Everything the setup screen needs.
	 *
	 * @returns Harness statuses, the orc harness and system tools
	 */
	async getOverview(): Promise<HarnessOverview> {
		const [statuses, orcHarness] = await Promise.all([this.status.listStatuses(), this.orc.get()]);
		const harnesses = statuses.map((status) => ({ ...status, reloginPending: this.getReloginPending(status.id) }));
		return { harnesses, orcHarness, systemTools: this.status.getSystemTools() };
	}

	/**
	 * Provide the pending-re-login lookup shown in {@link getOverview}.
	 *
	 * @param provider - Lookup, or null to clear
	 */
	setReloginPendingProvider(provider: ((harnessId: HarnessId) => ReloginPending | null) | null): void {
		this.reloginPendingProvider = provider;
	}

	/**
	 * The pending Slack re-login for a harness.
	 *
	 * @param harnessId - Harness id
	 * @returns The pending re-login, or null (also when no provider is set or it throws)
	 */
	getReloginPending(harnessId: HarnessId): ReloginPending | null {
		if (!this.reloginPendingProvider) return null;
		try {
			return this.reloginPendingProvider(harnessId);
		} catch {
			return null;
		}
	}

	/**
	 * Status of one harness.
	 *
	 * @param id - Harness id
	 * @returns The status
	 * @throws UnknownHarnessError for an unknown id
	 */
	async getStatus(id: string): Promise<HarnessStatus> {
		return this.status.getStatus(this.requireHarnessId(id));
	}

	/**
	 * Start installing (or updating) a harness.
	 *
	 * @param id - Harness id
	 * @returns The install job
	 * @throws UnknownHarnessError for an unknown id
	 */
	startInstall(id: string): InstallJob {
		return this.install.startInstall(this.requireHarnessId(id));
	}

	/**
	 * Read an install job.
	 *
	 * @param jobId - Job id
	 * @returns The job
	 * @throws HarnessInstallError job_not_found
	 */
	getInstallJob(jobId: string): InstallJob {
		return this.install.getJob(jobId);
	}

	/**
	 * Set the orchestrator's harness.
	 *
	 * @param id - Harness id
	 * @returns The recorded harness id
	 * @throws UnknownHarnessError for an unknown id
	 */
	async setOrcHarness(id: string): Promise<string> {
		return this.orc.set(this.requireHarnessId(id));
	}

	/**
	 * Start a broker login.
	 *
	 * @param id - Harness id
	 * @param method - Broker login method
	 * @returns The login session
	 * @throws UnknownHarnessError | LoginBrokerError
	 */
	startLogin(id: string, method: string): LoginSession {
		return this.broker.start(this.requireHarnessId(id), method);
	}

	/**
	 * Store an API key for a harness and return its fresh status.
	 *
	 * @param id - Harness id
	 * @param key - The key (never echoed)
	 * @returns The harness status after login
	 * @throws UnknownHarnessError | HarnessApiKeyError
	 */
	async submitApiKey(id: string, key: unknown): Promise<HarnessStatus> {
		const harnessId = this.requireHarnessId(id);
		await this.apiKeys.submit(harnessId, key);
		return this.status.getStatus(harnessId);
	}
}

/** Options for {@link createHarnessService}. */
export interface CreateHarnessServiceOptions {
	logger?: HarnessLogger;
	/** How `settings.general.defaultRuntime` is updated (the CLI passes a fresh SettingsService) */
	updateDefaultRuntime?: DefaultRuntimeUpdater;
	env?: NodeJS.ProcessEnv;
}

/**
 * Build a harness service with real dependencies.
 *
 * Codex broker logins are confirmed with `codex login status` through the
 * status service.
 *
 * @param options - Logger, settings updater, env
 * @returns A new service
 *
 * @example
 * ```ts
 * const harness = createHarnessService({ logger: SILENT_HARNESS_LOGGER });
 * const overview = await harness.getOverview();
 * ```
 */
export function createHarnessService(options: CreateHarnessServiceOptions = {}): HarnessService {
	const logger = options.logger ?? SILENT_HARNESS_LOGGER;
	const env = options.env ?? process.env;
	const status = new HarnessStatusService({ logger, env });
	const install = new HarnessInstallService({ logger, env });
	const broker = new LoginBrokerService({
		logger,
		env,
		verify: async (harnessId) => {
			const def = getHarnessDefinition(harnessId);
			if (!def) return false;
			const installed = await status.getInstalledInfo(def);
			const login = await status.getLoginInfo(def, installed.path);
			return login.loginState === 'logged_in';
		},
	});
	const apiKeys = new HarnessApiKeyService({ logger, env });
	const orc = new OrcHarnessStore(options.updateDefaultRuntime ? { updateDefaultRuntime: options.updateDefaultRuntime } : {});
	return new HarnessService({ status, install, broker, apiKeys, orc });
}

/** Backend singleton. */
let backendInstance: HarnessService | null = null;

/**
 * The backend's harness service (logs through LoggerService).
 *
 * @returns The singleton
 */
export function getHarnessService(): HarnessService {
	if (!backendInstance) {
		backendInstance = createHarnessService({ logger: LoggerService.getInstance().createComponentLogger('Harness') });
	}
	return backendInstance;
}

/**
 * Replace or clear the backend singleton (tests).
 *
 * @param service - Service to use, or null to clear
 */
export function setHarnessServiceForTesting(service: HarnessService | null): void {
	backendInstance = service;
}
