/**
 * Tests for ChromeDiscoveryService (#175)
 *
 * Validates Chrome process discovery, CDP port probing,
 * and platform-specific binary/profile resolution.
 */

import { ChromeDiscoveryService } from './chrome-discovery.service.js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';

// Mock dependencies
jest.mock('child_process');
jest.mock('fs', () => ({
	existsSync: jest.fn(),
	mkdirSync: jest.fn(),
}));
// platform is a jest.fn so binary lookup can be tested for every OS on any host
jest.mock('os', () => {
	const actual = jest.requireActual<typeof import('os')>('os');
	return { ...actual, platform: jest.fn(() => actual.platform()) };
});

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				debug: jest.fn(),
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

const mockExecSync = execSync as unknown as jest.Mock;
const mockExistsSync = existsSync as unknown as jest.Mock;
const mockPlatform = os.platform as unknown as jest.Mock;
const actualPlatform = jest.requireActual<typeof import('os')>('os').platform;

describe('ChromeDiscoveryService', () => {
	let service: ChromeDiscoveryService;

	beforeEach(() => {
		jest.clearAllMocks();
		mockPlatform.mockImplementation(actualPlatform);
		ChromeDiscoveryService.resetInstance();
		service = ChromeDiscoveryService.getInstance();
	});

	describe('singleton', () => {
		it('should return the same instance', () => {
			const a = ChromeDiscoveryService.getInstance();
			const b = ChromeDiscoveryService.getInstance();
			expect(a).toBe(b);
		});

		it('should create new instance after reset', () => {
			const a = ChromeDiscoveryService.getInstance();
			ChromeDiscoveryService.resetInstance();
			const b = ChromeDiscoveryService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe('probePort', () => {
		it('should return ChromeInstance when CDP is active', async () => {
			mockExecSync.mockReturnValue(JSON.stringify({
				Browser: 'Chrome/131.0.6778.86',
				webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
			}));

			const result = await service.probePort(9222);

			expect(result).not.toBeNull();
			expect(result!.port).toBe(9222);
			expect(result!.wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc');
			expect(result!.version).toBe('Chrome/131.0.6778.86');
			expect(result!.httpEndpoint).toBe('http://127.0.0.1:9222');
		});

		it('should return null when CDP is not active', async () => {
			mockExecSync.mockImplementation(() => { throw new Error('Connection refused'); });

			const result = await service.probePort(9222);
			expect(result).toBeNull();
		});
	});

	describe('scanProcesses', () => {
		it('should find Chrome processes with remote-debugging-port', () => {
			mockExecSync.mockReturnValue(
				'user  12345  0.5  2.0  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/profile\n'
			);

			const results = service.scanProcesses();

			expect(results).toHaveLength(1);
			expect(results[0].pid).toBe(12345);
			expect(results[0].port).toBe(9222);
			expect(results[0].profileDir).toBe('/tmp/profile');
		});

		it('should return empty when no Chrome with CDP found', () => {
			mockExecSync.mockImplementation(() => { throw new Error('No results'); });

			const results = service.scanProcesses();
			expect(results).toHaveLength(0);
		});

		it('should detect stealth profiles as non-primary', () => {
			mockExecSync.mockReturnValue(
				'user  12345  0.5  2.0  chrome --remote-debugging-port=9222 --user-data-dir=/home/.crewly/chrome-stealth-profile\n'
			);

			const results = service.scanProcesses();
			expect(results).toHaveLength(1);
			expect(results[0].isPrimary).toBe(false);
		});
	});

	describe('isChromeRunning', () => {
		it('should return true when Chrome is running', () => {
			mockExecSync.mockReturnValue('');
			expect(service.isChromeRunning()).toBe(true);
		});

		it('should return false when Chrome is not running', () => {
			mockExecSync.mockImplementation(() => { throw new Error('No process'); });
			expect(service.isChromeRunning()).toBe(false);
		});
	});

	describe('findChromeBinary', () => {
		it('should find the macOS Chrome binary when it exists', () => {
			mockPlatform.mockReturnValue('darwin');
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('Google Chrome')
			);

			expect(service.findChromeBinary()).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
		});

		it('should find a Linux Chrome binary, trying candidates in order', () => {
			mockPlatform.mockReturnValue('linux');
			mockExistsSync.mockImplementation((p: string) =>
				p === '/usr/bin/google-chrome-stable' || p === '/usr/bin/chromium'
			);

			expect(service.findChromeBinary()).toBe('/usr/bin/google-chrome-stable');
		});

		it('should find the Windows Chrome binary when it exists', () => {
			mockPlatform.mockReturnValue('win32');
			mockExistsSync.mockImplementation((p: string) =>
				p === 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
			);

			expect(service.findChromeBinary()).toBe('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
		});

		it('should return null on a platform with no known Chrome locations', () => {
			mockPlatform.mockReturnValue('aix');
			mockExistsSync.mockReturnValue(true);

			expect(service.findChromeBinary()).toBeNull();
		});

		it('should return null when no Chrome found', () => {
			mockExistsSync.mockReturnValue(false);
			expect(service.findChromeBinary()).toBeNull();
		});
	});

	describe('getDefaultProfileDir', () => {
		it('should return platform-appropriate profile directory', () => {
			const profileDir = service.getDefaultProfileDir();
			expect(profileDir).toContain(os.homedir());
			// Should contain Chrome-related path component
			expect(profileDir.toLowerCase()).toMatch(/chrome|google/i);
		});
	});

	describe('discover', () => {
		it('should return found=true when CDP instances exist', async () => {
			// Mock probePort to find instance on 9222
			mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes('curl') && cmd.includes('9222')) {
					return JSON.stringify({
						Browser: 'Chrome/131.0.0',
						webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
					});
				}
				if (cmd.includes('pgrep')) {
					return ''; // Chrome is running
				}
				throw new Error('Not found');
			});

			const result = await service.discover();
			expect(result.found).toBe(true);
			expect(result.instances.length).toBeGreaterThan(0);
		});

		it('should return found=false with suggestion when Chrome runs without CDP', async () => {
			mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes('curl')) {
					throw new Error('Connection refused');
				}
				if (cmd.includes('pgrep') || cmd.includes('ps aux')) {
					return ''; // Chrome is running but no CDP
				}
				throw new Error('Not found');
			});

			const result = await service.discover();
			expect(result.found).toBe(false);
			expect(result.chromeRunning).toBe(true);
			expect(result.suggestion).toContain('remote-debugging-port');
		});

		it('should return found=false when no Chrome at all', async () => {
			mockExecSync.mockImplementation(() => { throw new Error('Not found'); });

			const result = await service.discover();
			expect(result.found).toBe(false);
			expect(result.chromeRunning).toBe(false);
		});
	});
});
