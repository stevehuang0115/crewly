/**
 * Tests for the crewly upgrade command
 *
 * @module cli/commands/upgrade.test
 */

// Mock chalk (ESM-only)
jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy({}, {
		get: () => {
			const fn = (s: string) => s;
			return new Proxy(fn, { get: () => fn, apply: (_t, _this, args) => args[0] });
		},
	}),
}));

// Mock the version-check module
jest.mock('../utils/version-check.js', () => ({
	checkForUpdate: jest.fn(),
	printUpdateNotification: jest.fn(),
}));

// Mock child_process
jest.mock('child_process', () => ({
	spawn: jest.fn(),
	execSync: jest.fn(),
}));

// Mock fs
jest.mock('fs', () => ({
	existsSync: jest.fn(),
	mkdirSync: jest.fn(),
	readFileSync: jest.fn(),
}));

// Mock os
jest.mock('os', () => ({
	homedir: jest.fn(() => '/mock-home'),
}));

import { upgradeCommand, installProAddon } from './upgrade.js';
import { checkForUpdate, printUpdateNotification } from '../utils/version-check.js';
import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { ADDON_CONSTANTS } from '../../../config/constants.js';

const mockedCheckForUpdate = checkForUpdate as jest.MockedFunction<typeof checkForUpdate>;
const mockedPrintUpdateNotification = printUpdateNotification as jest.MockedFunction<typeof printUpdateNotification>;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockedExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockedMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockedReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;

describe('upgradeCommand', () => {
	let consoleSpy: jest.SpyInstance;
	let consoleErrorSpy: jest.SpyInstance;
	let processExitSpy: jest.SpyInstance;

	beforeEach(() => {
		consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		jest.clearAllMocks();
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	describe('with --check flag', () => {
		it('should print update notification when update is available', async () => {
			mockedCheckForUpdate.mockResolvedValue({
				currentVersion: '1.0.0',
				latestVersion: '2.0.0',
				updateAvailable: true,
			});

			await upgradeCommand({ check: true });

			expect(mockedCheckForUpdate).toHaveBeenCalled();
			expect(mockedPrintUpdateNotification).toHaveBeenCalledWith('1.0.0', '2.0.0');
		});

		it('should print up-to-date message when on latest version', async () => {
			mockedCheckForUpdate.mockResolvedValue({
				currentVersion: '1.0.0',
				latestVersion: '1.0.0',
				updateAvailable: false,
			});

			await upgradeCommand({ check: true });

			expect(mockedCheckForUpdate).toHaveBeenCalled();
			expect(mockedPrintUpdateNotification).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('latest version')
			);
		});

		it('should print warning when check fails', async () => {
			mockedCheckForUpdate.mockResolvedValue({
				currentVersion: '1.0.0',
				latestVersion: null,
				updateAvailable: false,
			});

			await upgradeCommand({ check: true });

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Unable to check')
			);
		});
	});

	describe('without --pro flag (standard upgrade)', () => {
		it('should spawn npm install -g crewly@latest', () => {
			const mockChild = {
				on: jest.fn(),
			};
			mockedSpawn.mockReturnValue(mockChild as any);

			upgradeCommand({});

			expect(mockedSpawn).toHaveBeenCalledWith(
				'npm',
				['install', '-g', 'crewly@latest'],
				expect.objectContaining({ stdio: 'inherit', shell: true })
			);
		});

		it('should log success on exit code 0', () => {
			const mockChild = {
				on: jest.fn(),
			};
			mockedSpawn.mockReturnValue(mockChild as any);

			upgradeCommand({});

			const exitHandler = mockChild.on.mock.calls.find(
				(call: any[]) => call[0] === 'exit'
			)?.[1] as (code: number) => void;

			if (exitHandler) {
				exitHandler(0);
				expect(consoleSpy).toHaveBeenCalledWith(
					expect.stringContaining('upgraded successfully')
				);
			}
		});

		it('should log error on non-zero exit code', () => {
			const mockChild = {
				on: jest.fn(),
			};
			mockedSpawn.mockReturnValue(mockChild as any);

			upgradeCommand({});

			const exitHandler = mockChild.on.mock.calls.find(
				(call: any[]) => call[0] === 'exit'
			)?.[1] as (code: number) => void;

			if (exitHandler) {
				exitHandler(1);
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					expect.stringContaining('Upgrade failed')
				);
				expect(processExitSpy).toHaveBeenCalledWith(1);
			}
		});
	});

	describe('with --pro flag', () => {
		it('should install from --source path', async () => {
			const tarball = '/path/to/crewly-pro.tar.gz';
			mockedExistsSync.mockImplementation((p) => {
				if (p === tarball) return true;
				// manifest check
				if (String(p).includes(ADDON_CONSTANTS.MANIFEST_FILE)) return true;
				return false;
			});
			mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly-pro', version: '1.0.0' }));

			await upgradeCommand({ pro: true, source: tarball });

			expect(mockedExecSync).toHaveBeenCalledWith(
				expect.stringContaining(`tar xzf "${tarball}"`),
				expect.anything()
			);
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('crewly-pro v1.0.0')
			);
		});

		it('should fall back to default tarball when no --source', async () => {
			mockedExistsSync.mockReturnValue(true);
			mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly-pro', version: '2.0.0' }));

			await upgradeCommand({ pro: true });

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Looking for default tarball')
			);
			expect(mockedExecSync).toHaveBeenCalledWith(
				expect.stringContaining(ADDON_CONSTANTS.PRO_ADDON.DEFAULT_TARBALL),
				expect.anything()
			);
		});

		it('should log Cloud API not available when --token provided then fall back', async () => {
			mockedExistsSync.mockReturnValue(true);
			mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly-pro', version: '1.0.0' }));

			await upgradeCommand({ pro: true, token: 'my-token' });

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Cloud API download is not yet available')
			);
			// Should still attempt local installation
			expect(mockedExecSync).toHaveBeenCalled();
		});

		it('should log Cloud API warning and still use --source if both --token and --source provided', async () => {
			const tarball = '/custom/path.tar.gz';
			mockedExistsSync.mockReturnValue(true);
			mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly-pro', version: '1.0.0' }));

			await upgradeCommand({ pro: true, token: 'tok', source: tarball });

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Cloud API download is not yet available')
			);
			expect(mockedExecSync).toHaveBeenCalledWith(
				expect.stringContaining(`tar xzf "${tarball}"`),
				expect.anything()
			);
		});
	});
});

describe('installProAddon', () => {
	let consoleSpy: jest.SpyInstance;
	let consoleErrorSpy: jest.SpyInstance;
	let processExitSpy: jest.SpyInstance;

	beforeEach(() => {
		consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		jest.clearAllMocks();
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it('should exit if tarball does not exist', async () => {
		mockedExistsSync.mockReturnValue(false);

		await installProAddon('/nonexistent.tar.gz');

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Tarball not found')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should create addons directory recursively', async () => {
		mockedExistsSync.mockReturnValue(true);
		mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly-pro', version: '1.0.0' }));

		await installProAddon('/path/to/addon.tar.gz');

		expect(mockedMkdirSync).toHaveBeenCalledWith(
			expect.stringContaining(ADDON_CONSTANTS.PATHS.ADDONS_DIR),
			{ recursive: true }
		);
	});

	it('should extract tarball using tar xzf', async () => {
		mockedExistsSync.mockReturnValue(true);
		mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly-pro', version: '1.0.0' }));

		await installProAddon('/path/to/addon.tar.gz');

		expect(mockedExecSync).toHaveBeenCalledWith(
			expect.stringContaining('tar xzf "/path/to/addon.tar.gz"'),
			{ stdio: 'pipe' }
		);
	});

	it('should exit if extraction fails', async () => {
		mockedExistsSync.mockImplementation((p) => {
			if (String(p).includes(ADDON_CONSTANTS.MANIFEST_FILE)) return false;
			return true;
		});
		mockedExecSync.mockImplementation(() => { throw new Error('tar failed'); });

		await installProAddon('/path/to/bad.tar.gz');

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to extract tarball')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit if manifest.json not found after extraction', async () => {
		mockedExistsSync.mockImplementation((p) => {
			if (String(p).includes(ADDON_CONSTANTS.MANIFEST_FILE)) return false;
			return true;
		});

		await installProAddon('/path/to/addon.tar.gz');

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('manifest.json not found')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should print success with addon name and version from manifest', async () => {
		mockedExistsSync.mockReturnValue(true);
		mockedReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly-pro', version: '3.1.0' }));

		await installProAddon('/path/to/addon.tar.gz');

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('crewly-pro v3.1.0')
		);
	});
});
