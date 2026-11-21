import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { BrowserPinStore, BrowserTargetError, chooseBrowser, labelBrowser, matchBrowsers, type BrowserCandidate } from './browser-target.js';

const mini: BrowserCandidate = { instanceId: 'aaaa1111-0000', instanceName: 'Chrome (macOS)', lastSeenAt: '2026-11-20T10:00:00Z' };
const mbp: BrowserCandidate = { instanceId: 'bbbb2222-0000', instanceName: 'Chrome (macOS)', lastSeenAt: '2026-11-20T11:00:00Z' };
const air: BrowserCandidate = { instanceId: 'cccc3333-0000', instanceName: 'Air-personal', lastSeenAt: '2026-11-20T09:00:00Z' };

/**
 * Run a choice and return the refusal it throws.
 *
 * @param fn - The choice
 * @returns The BrowserTargetError
 */
function refusal(fn: () => unknown): BrowserTargetError {
	try {
		fn();
	} catch (err) {
		if (err instanceof BrowserTargetError) return err;
		throw err;
	}
	throw new Error('expected a BrowserTargetError');
}

describe('matchBrowsers', () => {
	it('matches an exact id, a name ignoring case, then an id prefix', () => {
		expect(matchBrowsers([mini, mbp, air], 'bbbb2222-0000')).toEqual([mbp]);
		expect(matchBrowsers([mini, mbp, air], 'air-PERSONAL')).toEqual([air]);
		expect(matchBrowsers([mini, mbp, air], 'cccc')).toEqual([air]);
	});

	it('returns every browser sharing a name, and nothing for a too-short prefix', () => {
		expect(matchBrowsers([mini, mbp, air], 'Chrome (macOS)')).toEqual([mini, mbp]);
		expect(matchBrowsers([mini, mbp, air], 'aaa')).toEqual([]);
		expect(matchBrowsers([mini], '  ')).toEqual([]);
	});
});

describe('chooseBrowser', () => {
	it('uses the only connected browser', () => {
		expect(chooseBrowser({ instances: [mini], requireChoice: true })).toBe(mini);
	});

	it('refuses to guess for an agent when several are connected, listing them', () => {
		const err = refusal(() => chooseBrowser({ instances: [mini, mbp, air], requireChoice: true }));
		expect(err.code).toBe('BROWSER_AMBIGUOUS');
		expect(err.browsers).toHaveLength(3);
		expect(err.message).toContain(labelBrowser(air));
		expect(err.message).toContain('--action use-browser');
	});

	it('keeps the most recent browser for a caller with no agent identity', () => {
		expect(chooseBrowser({ instances: [mini, mbp, air] })).toBe(mbp);
	});

	it('honours a named browser and rejects a name two browsers share', () => {
		expect(chooseBrowser({ instances: [mini, mbp, air], explicit: 'Air-personal', requireChoice: true })).toBe(air);
		expect(chooseBrowser({ instances: [mini, mbp, air], explicit: 'aaaa1111', requireChoice: true })).toBe(mini);
		expect(refusal(() => chooseBrowser({ instances: [mini, mbp], explicit: 'Chrome (macOS)' })).code).toBe('BROWSER_AMBIGUOUS');
		expect(refusal(() => chooseBrowser({ instances: [mini], explicit: 'nope' })).code).toBe('BROWSER_NOT_CONNECTED');
	});

	it('follows the bound tab and refuses to switch browser under it', () => {
		expect(chooseBrowser({ instances: [mini, mbp], boundInstanceId: mini.instanceId, pinnedInstanceId: mbp.instanceId, requireChoice: true })).toBe(mini);
		expect(refusal(() => chooseBrowser({ instances: [mini, air], explicit: 'Air-personal', boundInstanceId: mini.instanceId })).code).toBe('BROWSER_BOUND_ELSEWHERE');
		expect(refusal(() => chooseBrowser({ instances: [mbp, air], boundInstanceId: mini.instanceId })).code).toBe('BROWSER_NOT_CONNECTED');
	});

	it('uses the pin, and never falls back to another browser when the pinned one is offline', () => {
		expect(chooseBrowser({ instances: [mini, mbp, air], pinnedInstanceId: air.instanceId, requireChoice: true })).toBe(air);
		expect(refusal(() => chooseBrowser({ instances: [mini], pinnedInstanceId: air.instanceId })).code).toBe('BROWSER_NOT_CONNECTED');
	});

	it('reports no browser at all', () => {
		expect(refusal(() => chooseBrowser({ instances: [], requireChoice: true })).code).toBe('NO_BROWSER_CLIENT');
	});
});

describe('BrowserPinStore', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'browser-pins-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	});

	it('prefers an agent pin over the machine default and survives a reload', () => {
		const store = BrowserPinStore.inHome(dir);
		expect(store.pinFor('owen')).toBeUndefined();
		store.set(mini);
		expect(store.pinFor('owen')?.instanceId).toBe(mini.instanceId);
		store.set(air, 'owen');
		expect(store.pinFor('owen')?.instanceId).toBe(air.instanceId);
		expect(store.pinFor('ella')?.instanceId).toBe(mini.instanceId);

		const reloaded = BrowserPinStore.inHome(dir);
		expect(reloaded.describe('owen')).toMatchObject({ agent: { instanceId: air.instanceId }, machineDefault: { instanceId: mini.instanceId } });
	});

	it('clears one layer at a time', () => {
		const store = BrowserPinStore.inHome(dir);
		store.set(mini);
		store.set(air, 'owen');
		expect(store.clear('owen')).toBe(true);
		expect(store.clear('owen')).toBe(false);
		expect(store.pinFor('owen')?.instanceId).toBe(mini.instanceId);
		expect(store.clear()).toBe(true);
		expect(store.pinFor('owen')).toBeUndefined();
	});
});
