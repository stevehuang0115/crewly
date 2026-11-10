import { EventEmitter } from 'events';
import { KeepAwakeService, KEEP_AWAKE_BACKOFF, CAFFEINATE_PATH, type KeepAwakeSpawn } from './keep-awake.service.js';

class FakeChild extends EventEmitter {
	kill = jest.fn();
}

function setup(platform: NodeJS.Platform = 'darwin') {
	const children: FakeChild[] = [];
	const spawn = jest.fn(() => {
		const c = new FakeChild();
		children.push(c);
		return c;
	});
	const logger = { info: jest.fn(), warn: jest.fn() };
	const service = new KeepAwakeService({
		platform,
		pid: 4242,
		spawn: spawn as unknown as KeepAwakeSpawn,
		logger,
	});
	return { service, spawn, children };
}

describe('KeepAwakeService', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('is a no-op on non-darwin platforms', () => {
		const { service, spawn } = setup('linux');
		service.setEnabled(true);
		expect(spawn).not.toHaveBeenCalled();
		expect(service.getStatus()).toEqual({ enabled: false, active: false });
	});

	it('spawns caffeinate tied to the backend pid when enabled', () => {
		const { service, spawn } = setup();
		service.setEnabled(true);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith(CAFFEINATE_PATH, ['-i', '-s', '-w', '4242'], { stdio: 'ignore' });
		expect(service.getStatus()).toEqual({ enabled: true, active: true });
	});

	it('does not spawn twice when enabled repeatedly', () => {
		const { service, spawn } = setup();
		service.setEnabled(true);
		service.setEnabled(true);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it('kills caffeinate and does not restart when disabled', () => {
		const { service, spawn, children } = setup();
		service.setEnabled(true);
		service.setEnabled(false);
		expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
		children[0].emit('exit', null, 'SIGTERM');
		jest.advanceTimersByTime(KEEP_AWAKE_BACKOFF.MAX_MS * 2);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(service.getStatus()).toEqual({ enabled: false, active: false });
	});

	it('restarts after an unexpected exit with growing backoff', () => {
		const { service, spawn, children } = setup();
		service.setEnabled(true);
		children[0].emit('exit', 1, null);
		expect(service.getStatus()).toEqual({ enabled: true, active: false });
		jest.advanceTimersByTime(KEEP_AWAKE_BACKOFF.INITIAL_MS - 1);
		expect(spawn).toHaveBeenCalledTimes(1);
		jest.advanceTimersByTime(1);
		expect(spawn).toHaveBeenCalledTimes(2);

		children[1].emit('exit', 1, null);
		jest.advanceTimersByTime(KEEP_AWAKE_BACKOFF.INITIAL_MS * 2 - 1);
		expect(spawn).toHaveBeenCalledTimes(2);
		jest.advanceTimersByTime(1);
		expect(spawn).toHaveBeenCalledTimes(3);
	});

	it('caps the backoff at the maximum', () => {
		const { service, spawn, children } = setup();
		service.setEnabled(true);
		for (let i = 0; i < 12; i++) {
			children[children.length - 1].emit('exit', 1, null);
			jest.advanceTimersByTime(KEEP_AWAKE_BACKOFF.MAX_MS);
		}
		expect(spawn).toHaveBeenCalledTimes(13);
	});

	it('treats a spawn error as an exit and retries', () => {
		const { service, spawn, children } = setup();
		service.setEnabled(true);
		children[0].emit('error', new Error('ENOENT'));
		jest.advanceTimersByTime(KEEP_AWAKE_BACKOFF.INITIAL_MS);
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it('stop() releases the assertion and cancels a pending restart', () => {
		const { service, spawn, children } = setup();
		service.setEnabled(true);
		children[0].emit('exit', 1, null);
		service.stop();
		jest.advanceTimersByTime(KEEP_AWAKE_BACKOFF.MAX_MS);
		expect(spawn).toHaveBeenCalledTimes(1);

		service.setEnabled(true);
		service.stop();
		expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
		expect(service.getStatus()).toEqual({ enabled: false, active: false });
	});
});
