/**
 * Which harness the orchestrator runs on.
 *
 * The orchestrator's runtime is `runtimeType` in
 * `<crewlyHome>/teams/orchestrator/config.json` — the same field
 * `PUT /api/orchestrator/runtime` and StorageService.updateOrchestratorRuntimeType
 * write, and the one the orchestrator is launched with (a `DEFAULT_RUNTIME`
 * env var still overrides it at boot). Setting the orc harness also sets
 * `settings.general.defaultRuntime`, so new team members default to the one
 * harness first-time setup installed.
 *
 * This module writes the file directly (same lock key and atomic write as
 * StorageService) instead of instantiating StorageService, so the CLI can use
 * it without starting the backend's logger. `get` never creates the file:
 * a fresh machine reports null ("not chosen yet").
 *
 * @module services/harness/orc-harness.store
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { CREWLY_CONSTANTS, HARNESS_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { atomicWriteFile, withOperationLock } from '../../utils/file-io.utils.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { getSettingsService } from '../settings/settings.service.js';
import type { HarnessId } from './harness.types.js';

/** Updates `settings.general.defaultRuntime`. */
export type DefaultRuntimeUpdater = (harnessId: HarnessId) => Promise<void>;

/** Injectable dependencies. */
export interface OrcHarnessStoreDeps {
	/** Crewly home dir (defaults to CREWLY_HOME / ~/.crewly, resolved per call) */
	crewlyHome?: () => string;
	/** Settings updater; defaults to the backend SettingsService singleton */
	updateDefaultRuntime?: DefaultRuntimeUpdater;
}

/**
 * Default updater: the backend's settings singleton (keeps its cache coherent).
 *
 * @param harnessId - Harness id
 */
const defaultUpdateDefaultRuntime: DefaultRuntimeUpdater = async (harnessId) => {
	await getSettingsService().updateSettings({ general: { defaultRuntime: harnessId } });
};

/** Reads and writes the orchestrator's harness. */
export class OrcHarnessStore {
	private readonly crewlyHome: () => string;
	private readonly updateDefaultRuntime: DefaultRuntimeUpdater;

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: OrcHarnessStoreDeps = {}) {
		this.crewlyHome = deps.crewlyHome ?? getCrewlyHomePath;
		this.updateDefaultRuntime = deps.updateDefaultRuntime ?? defaultUpdateDefaultRuntime;
	}

	/**
	 * Orchestrator config file path.
	 *
	 * @returns `<crewlyHome>/teams/orchestrator/config.json`
	 */
	getFilePath(): string {
		return path.join(this.crewlyHome(), ...HARNESS_CONSTANTS.ORCHESTRATOR_CONFIG_SEGMENTS);
	}

	/**
	 * The orchestrator's runtime, if one is recorded.
	 *
	 * @returns Runtime id, or null when nothing is recorded yet
	 */
	async get(): Promise<string | null> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.getFilePath(), 'utf-8')) as { runtimeType?: unknown };
			return typeof parsed.runtimeType === 'string' && parsed.runtimeType.length > 0 ? parsed.runtimeType : null;
		} catch {
			return null;
		}
	}

	/**
	 * Set the orchestrator's harness (and the default runtime for new members).
	 *
	 * Takes effect the next time the orchestrator starts.
	 *
	 * @param harnessId - Harness id
	 * @returns The harness id now recorded
	 */
	async set(harnessId: HarnessId): Promise<string> {
		const file = this.getFilePath();
		await withOperationLock(file, async () => {
			let orchestrator: Record<string, unknown>;
			try {
				orchestrator = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
			} catch {
				const now = new Date().toISOString();
				orchestrator = {
					sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
					agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
					workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
					runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
					createdAt: now,
					updatedAt: now,
				};
			}
			orchestrator.runtimeType = harnessId;
			orchestrator.updatedAt = new Date().toISOString();
			await fs.mkdir(path.dirname(file), { recursive: true });
			await atomicWriteFile(file, JSON.stringify(orchestrator, null, 2));
		});
		// The orchestrator runtime is what matters; a settings failure (e.g. an
		// invalid settings file) must not undo or fail the orc choice.
		try {
			await this.updateDefaultRuntime(harnessId);
		} catch {
			// Default runtime for new members stays as it was.
		}
		return harnessId;
	}
}
