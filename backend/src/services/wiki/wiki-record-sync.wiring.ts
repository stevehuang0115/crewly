/**
 * Wiring for {@link WikiRecordSyncService}: the process-wide instance, the
 * vaults it walks, and the timer that keeps entity pages current.
 *
 * @module services/wiki/wiki-record-sync.wiring
 */

import path from 'path';
import { WIKI_RECORD_SYNC_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { machineVaults } from './wiki-record-attach.wiring.js';
import { WikiRecordSyncService, type RecordSyncReport } from './wiki-record-sync.service.js';

let instance: WikiRecordSyncService | null = null;
let timers: { first: NodeJS.Timeout; every: NodeJS.Timeout } | null = null;

/**
 * The process-wide service: it reads App data as the vault's team lead and writes pages
 * through the wiki's own ingest (retention gate, privacy masking, index and
 * history all apply).
 *
 * @returns The service
 */
export function getWikiRecordSyncService(): WikiRecordSyncService {
	if (!instance) {
		const logger = LoggerService.getInstance().createComponentLogger('WikiRecordSync');
		instance = new WikiRecordSyncService({
			readerFor: async (vaultPath) => {
				const [{ resolveWikiOwner }, { StorageService }] = await Promise.all([import('./wiki-owner.resolver.js'), import('../core/storage.service.js')]);
				return resolveWikiOwner(StorageService.getInstance(), vaultPath);
			},
			listDocs: async (appId, collection, opts, agentSession) => {
				const { getAppsParts } = await import('../apps/apps.wiring.js');
				return getAppsParts().service.listDocs(appId, collection, opts, { agentSession });
			},
			ingest: async (input) => {
				const { WikiIngestService } = await import('./wiki-ingest.service.js');
				return WikiIngestService.getInstance().ingest(input);
			},
			logger,
		});
	}
	return instance;
}

/**
 * Replace the process-wide service (tests).
 *
 * @param service - The service, or null to build a fresh one on next use
 */
export function setWikiRecordSyncService(service: WikiRecordSyncService | null): void {
	instance = service;
}

/**
 * Sync one vault, or every team vault and the global vault of this machine.
 *
 * @param vaultPath - A vault root, or undefined for all of them
 * @returns One report per vault that lists sources
 * @throws When `vaultPath` is not one of this machine's vaults
 */
export async function syncRecords(vaultPath?: string): Promise<RecordSyncReport[]> {
	const service = getWikiRecordSyncService();
	const vaults = machineVaults();
	if (!vaultPath) return service.syncVaults(vaults);
	const wanted = path.resolve(vaultPath);
	if (!vaults.some((vault) => path.resolve(vault) === wanted)) throw new Error('Not a team or global wiki vault on this machine.');
	return [await service.syncVault(wanted)];
}

/**
 * Start the periodic sync: once shortly after start, then on the interval.
 * Idempotent; a failed run is logged and the next one still happens.
 */
export function startRecordSync(): void {
	if (timers) return;
	const logger = LoggerService.getInstance().createComponentLogger('WikiRecordSync');
	const run = (): void => {
		void syncRecords().catch((error: unknown) => logger.warn('Record sync failed', { error: error instanceof Error ? error.message : String(error) }));
	};
	const first = setTimeout(run, WIKI_RECORD_SYNC_CONSTANTS.FIRST_RUN_DELAY_MS);
	const every = setInterval(run, WIKI_RECORD_SYNC_CONSTANTS.INTERVAL_MS);
	first.unref?.();
	every.unref?.();
	timers = { first, every };
}

/** Stop the periodic sync (shutdown, tests). */
export function stopRecordSync(): void {
	if (!timers) return;
	clearTimeout(timers.first);
	clearInterval(timers.every);
	timers = null;
}
