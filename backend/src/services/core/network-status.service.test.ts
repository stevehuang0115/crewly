const warn = jest.fn();
const info = jest.fn();
jest.mock('./logger.service.js', () => ({
	LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info, debug: jest.fn(), warn, error: jest.fn() }) }) },
}));

import { NETWORK_STATUS_CONSTANTS } from '../../constants.js';
import { NetworkStatusService, extractOfflineErrorCode } from './network-status.service.js';

/** undici's shape: `TypeError: fetch failed` with the real code on `cause`. */
function fetchFailed(code: string): Error {
	const cause = Object.assign(new Error(`getaddrinfo ${code} api.crewlyai.com`), { code });
	return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('extractOfflineErrorCode', () => {
	it('reads the code off the error itself (ws style)', () => {
		expect(extractOfflineErrorCode(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }))).toBe('ENOTFOUND');
	});

	it('follows the cause chain (undici style)', () => {
		expect(extractOfflineErrorCode(fetchFailed('EAI_AGAIN'))).toBe('EAI_AGAIN');
	});

	it('falls back to the message text and to plain strings', () => {
		expect(extractOfflineErrorCode(new Error('Cloud unreachable: getaddrinfo ENOTFOUND api.crewlyai.com'))).toBe('ENOTFOUND');
		expect(extractOfflineErrorCode('ENETUNREACH')).toBe('ENETUNREACH');
	});

	it('ignores errors that mean the server, not the network, is down', () => {
		expect(extractOfflineErrorCode(new TypeError('fetch failed'))).toBeNull();
		expect(extractOfflineErrorCode(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBeNull();
		expect(extractOfflineErrorCode({ status: 503 })).toBeNull();
		expect(extractOfflineErrorCode(null)).toBeNull();
	});
});

describe('NetworkStatusService', () => {
	let svc: NetworkStatusService;
	let clock = 0;

	beforeEach(() => {
		NetworkStatusService.resetInstance();
		svc = NetworkStatusService.getInstance();
		clock = 1_000_000;
		svc.now = () => clock;
		warn.mockClear();
		info.mockClear();
	});

	it('is online until enough consecutive offline-class failures arrive', () => {
		const n = NETWORK_STATUS_CONSTANTS.OFFLINE_AFTER_FAILURES;
		for (let i = 1; i < n; i++) {
			expect(svc.recordFailure('relay', fetchFailed('ENOTFOUND'))).toBe(true);
			expect(svc.isOffline()).toBe(false);
		}
		svc.recordFailure('cloud-sync', fetchFailed('ENOTFOUND'));
		expect(svc.isOffline()).toBe(true);
		expect(svc.getStatus()).toMatchObject({
			offline: true,
			offlineSince: new Date(clock).toISOString(),
			consecutiveFailures: n,
			lastFailureSource: 'cloud-sync',
			lastErrorCode: 'ENOTFOUND',
		});
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('does not count server-side failures, so a Cloud outage never trips it', () => {
		for (let i = 0; i < 10; i++) {
			expect(svc.recordFailure('cloud-sync', new TypeError('fetch failed'))).toBe(false);
			svc.recordFailure('cloud-sync', { status: 502 });
		}
		expect(svc.isOffline()).toBe(false);
		expect(svc.getStatus().consecutiveFailures).toBe(0);
	});

	it('resets on success and reports the outage length', () => {
		const offline = jest.fn();
		const online = jest.fn();
		svc.on('offline', offline);
		svc.on('online', online);
		for (let i = 0; i < NETWORK_STATUS_CONSTANTS.OFFLINE_AFTER_FAILURES; i++) svc.recordFailure('relay', fetchFailed('ENOTFOUND'));
		expect(offline).toHaveBeenCalledTimes(1);
		clock += 25 * 60_000;
		expect(svc.offlineMinutes()).toBe(25);
		svc.recordSuccess('relay');
		expect(svc.isOffline()).toBe(false);
		expect(online).toHaveBeenCalledWith(25 * 60_000);
		expect(info).toHaveBeenCalledWith('Network is back', { source: 'relay', offlineMinutes: 25 });
		expect(svc.getStatus()).toEqual({ offline: false, consecutiveFailures: 0 });
	});

	it('a success between failures keeps the count from accumulating', () => {
		svc.recordFailure('relay', fetchFailed('ENOTFOUND'));
		svc.recordFailure('relay', fetchFailed('ENOTFOUND'));
		svc.recordSuccess('cloud-sync');
		svc.recordFailure('relay', fetchFailed('ENOTFOUND'));
		expect(svc.isOffline()).toBe(false);
		expect(svc.getStatus().consecutiveFailures).toBe(1);
	});

	describe('shouldLog', () => {
		it('always logs while online', () => {
			expect(svc.shouldLog('relay')).toBe(true);
			expect(svc.shouldLog('relay')).toBe(true);
		});

		it('throttles each source to one line per interval while offline, independently', () => {
			for (let i = 0; i < NETWORK_STATUS_CONSTANTS.OFFLINE_AFTER_FAILURES; i++) svc.recordFailure('relay', fetchFailed('ENOTFOUND'));
			expect(svc.shouldLog('relay')).toBe(true);
			expect(svc.shouldLog('relay')).toBe(false);
			expect(svc.shouldLog('cloud-sync')).toBe(true);
			clock += NETWORK_STATUS_CONSTANTS.REPEAT_LOG_INTERVAL_MS - 1;
			expect(svc.shouldLog('relay')).toBe(false);
			clock += 1;
			expect(svc.shouldLog('relay')).toBe(true);
		});

		it('forgets the throttle once the network is back', () => {
			for (let i = 0; i < NETWORK_STATUS_CONSTANTS.OFFLINE_AFTER_FAILURES; i++) svc.recordFailure('relay', fetchFailed('ENOTFOUND'));
			svc.shouldLog('relay');
			svc.recordSuccess('relay');
			expect(svc.shouldLog('relay')).toBe(true);
		});
	});
});
