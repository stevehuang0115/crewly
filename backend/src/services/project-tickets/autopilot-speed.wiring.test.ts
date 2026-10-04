/**
 * Tests for the speed-command wiring: the project-name cache the
 * synchronous interceptor reads.
 */
import { KnownProjectsCache } from './autopilot-speed.wiring.js';
import type { Project } from '../../types/index.js';

const project = (id: string, name: string): Project => ({ id, name, path: `/p/${id}`, teams: {}, status: 'active', createdAt: '', updatedAt: '' }) as Project;

describe('KnownProjectsCache', () => {
	afterEach(() => jest.useRealTimers());

	it('starts empty, fills on refresh and keeps the last list when a read fails', async () => {
		let fail = false;
		let list = [project('p-ce', 'CE')];
		const cache = new KnownProjectsCache(async () => {
			if (fail) throw new Error('disk');
			return list;
		});
		expect(cache.list()).toEqual([]);
		await cache.refresh();
		expect(cache.list()).toEqual([{ id: 'p-ce', name: 'CE' }]);
		fail = true;
		list = [];
		await cache.refresh();
		expect(cache.list()).toEqual([{ id: 'p-ce', name: 'CE' }]);
	});

	it('refreshes on its timer until stopped', async () => {
		jest.useFakeTimers();
		const load = jest.fn(async () => [project('p-sf', 'Steam Fun')]);
		const cache = new KnownProjectsCache(load);
		cache.start(1000);
		cache.start(1000); // idempotent
		jest.advanceTimersByTime(2500);
		expect(load).toHaveBeenCalledTimes(2);
		cache.stop();
		jest.advanceTimersByTime(5000);
		expect(load).toHaveBeenCalledTimes(2);
	});
});
