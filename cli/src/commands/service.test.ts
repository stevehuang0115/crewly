/**
 * Tests for the CLI service command.
 *
 * Validates install, uninstall, and status subcommands for both
 * macOS (Login Item) and Linux (systemd) service management.
 */

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy(
		{},
		{
			get: () => {
				const fn = (s: string) => s;
				return new Proxy(fn, {
					get: () => fn,
					apply: (_t: unknown, _this: unknown, args: string[]) => args[0],
				});
			},
		},
	),
}));

const mockExecAsync = jest.fn();
const mockExecSync = jest.fn((_cmd: string): string => '');
jest.mock('child_process', () => ({
	exec: jest.fn(
		(
			cmd: string,
			...rest: unknown[]
		) => {
			// exec(cmd, cb) or exec(cmd, opts, cb)
			const cb = typeof rest[0] === 'function'
				? rest[0] as (err: Error | null, result: { stdout: string; stderr: string }) => void
				: rest[1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;

			const result = mockExecAsync(cmd);
			if (result instanceof Error) {
				cb(result, { stdout: '', stderr: result.message });
			} else {
				Promise.resolve(result).then((r) => {
					if (r instanceof Error) {
						cb(r, { stdout: '', stderr: r.message });
					} else {
						cb(null, {
							stdout: typeof r === 'string' ? r : '',
							stderr: '',
						});
					}
				});
			}
		},
	),
	spawn: jest.fn(),
	execSync: jest.fn((cmd: string) => mockExecSync(cmd)),
}));

jest.mock('../../../config/index.js', () => ({
	CREWLY_CONSTANTS: {
		PATHS: {
			CREWLY_HOME: '.crewly',
		},
	},
}));

const mockExistsSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

import {
	serviceCommand,
	captureServiceEnvironment,
	generateCommandFile,
	generateSystemdUnit,
	generateLinuxWrapper,
	enableLinger,
	getLingerState,
	getRunningPid,
	getSystemdState,
	isLoginItemRegistered,
} from './service.js';
import { setCliModuleDir } from '../utils/package-root.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serviceCommand', () => {
	let logSpy: jest.SpyInstance;
	let errorSpy: jest.SpyInstance;
	let exitSpy: jest.SpyInstance;
	const originalPlatform = process.platform;

	beforeEach(() => {
		logSpy = jest.spyOn(console, 'log').mockImplementation();
		errorSpy = jest.spyOn(console, 'error').mockImplementation();
		exitSpy = jest
			.spyOn(process, 'exit')
			.mockImplementation(() => undefined as never);
		jest.clearAllMocks();
		Object.defineProperty(process, 'platform', { value: 'darwin' });
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
		Object.defineProperty(process, 'platform', { value: originalPlatform });
	});

	// -----------------------------------------------------------------------
	// Routing & platform guard
	// -----------------------------------------------------------------------

	describe('action routing', () => {
		it('rejects unknown actions', async () => {
			await serviceCommand('bogus', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Unknown action: bogus');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects unsupported platforms', async () => {
			Object.defineProperty(process, 'platform', { value: 'win32' });

			await serviceCommand('install', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('not supported on win32');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});

	// -----------------------------------------------------------------------
	// macOS install
	// -----------------------------------------------------------------------

	describe('install (macOS)', () => {
		it('skips if already installed without --force', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('.plist')) return false;
				if (p.includes('crewly-start.command')) return true;
				if (p.includes('package.json')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify({ name: 'crewly' }),
			);

			await serviceCommand('install', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('already installed');
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('writes .command file and registers Login Item on fresh install', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('.plist')) return false;
				if (p.includes('crewly-start.command')) return false;
				if (p.includes('crewly-service.sh')) return false;
				if (p.includes('package.json')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify({ name: 'crewly' }),
			);

			mockExecAsync.mockReturnValue('login item Crewly Backend');

			await serviceCommand('install', {});

			expect(mockWriteFileSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly-start.command'),
				expect.stringContaining('#!/bin/bash'),
				expect.objectContaining({ mode: 0o755 }),
			);

			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('make login item'),
			);

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('installed successfully');
		});

		it('overwrites existing installation with --force', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('.plist')) return false;
				if (p.includes('crewly-start.command')) return true;
				if (p.includes('crewly-service.sh')) return false;
				if (p.includes('package.json')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify({ name: 'crewly' }),
			);

			mockExecAsync.mockReturnValue('login item Crewly Backend');

			await serviceCommand('install', { force: true });

			expect(mockWriteFileSync).toHaveBeenCalled();
		});

		it('migrates legacy LaunchAgent plist during install', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('.plist')) return true;
				if (p.includes('crewly-start.command')) return false;
				if (p.includes('crewly-service.sh')) return true;
				if (p.includes('package.json')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify({ name: 'crewly' }),
			);

			mockExecAsync.mockReturnValue('');

			await serviceCommand('install', {});

			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('launchctl bootout'),
			);

			expect(mockUnlinkSync).toHaveBeenCalledWith(
				expect.stringContaining('.plist'),
			);

			expect(mockUnlinkSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly-service.sh'),
			);
		});
	});

	// -----------------------------------------------------------------------
	// start subcommand
	// -----------------------------------------------------------------------

	describe('start (macOS)', () => {
		it('opens .command file when not running', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.pid')) return false;
				if (p.includes('crewly-start.command')) return true;
				return false;
			});

			mockExecAsync.mockReturnValue('');

			await serviceCommand('start', {});

			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('open'),
			);

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('started');
		});

		it('shows warning if already running', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.pid')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue('12345');

			const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);

			await serviceCommand('start', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('already running');

			killSpy.mockRestore();
		});

		it('clears stale PID file before starting', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.pid')) return true;
				if (p.includes('crewly-start.command')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue('99999');

			// PID check fails → stale
			const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
				throw new Error('ESRCH');
			});
			mockExecAsync.mockReturnValue('');

			await serviceCommand('start', {});

			expect(mockUnlinkSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly.pid'),
			);

			killSpy.mockRestore();
		});

		it('exits with error if not installed', async () => {
			mockExistsSync.mockReturnValue(false);

			await serviceCommand('start', {});

			expect(exitSpy).toHaveBeenCalledWith(1);
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('not installed');
		});
	});

	describe('start (Linux)', () => {
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
		});

		it('calls systemctl start when installed', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.pid')) return false;
				if (p.includes('crewly.service')) return true;
				return false;
			});
			mockExecAsync.mockReturnValue('');

			await serviceCommand('start', {});

			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('systemctl --user start'),
			);
		});
	});

	// -----------------------------------------------------------------------
	// upgrade subcommand
	// -----------------------------------------------------------------------

	describe('upgrade (macOS)', () => {
		it('stops, installs, regenerates, and starts', async () => {
			// Stop phase: no running process
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.pid')) return false;
				if (p.includes('crewly-start.command')) return true;
				if (p.includes('package.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly' }));
			mockExecAsync.mockReturnValue('');

			await serviceCommand('upgrade', { version: '1.5.0' });

			// Should run npm install
			expect(mockExecAsync).toHaveBeenCalledWith(
				'npm install -g crewly@1.5.0',
			);

			// Should regenerate .command file
			expect(mockWriteFileSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly-start.command'),
				expect.stringContaining('#!/bin/bash'),
				expect.objectContaining({ mode: 0o755 }),
			);

			// Should open the .command file to start
			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('open'),
			);
		});

		it('defaults to latest when no version specified', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.pid')) return false;
				if (p.includes('crewly-start.command')) return true;
				if (p.includes('package.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly' }));
			mockExecAsync.mockReturnValue('');

			await serviceCommand('upgrade', {});

			expect(mockExecAsync).toHaveBeenCalledWith(
				'npm install -g crewly@latest',
			);
		});
	});

	// -----------------------------------------------------------------------
	// help text
	// -----------------------------------------------------------------------

	describe('help text', () => {
		it('shows start and upgrade in usage message', async () => {
			await serviceCommand('bogus', {});
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('start');
			expect(output).toContain('upgrade');
		});
	});

	// -----------------------------------------------------------------------
	// macOS uninstall
	// -----------------------------------------------------------------------

	describe('uninstall (macOS)', () => {
		it('removes Login Item, .command file, and kills process', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly-start.command')) return true;
				if (p.includes('crewly.pid')) return true;
				if (p.includes('.plist')) return false;
				return false;
			});

			mockReadFileSync.mockReturnValue('12345');

			const killSpy = jest
				.spyOn(process, 'kill')
				.mockImplementation(() => true);

			mockExecAsync.mockReturnValue('');

			await serviceCommand('uninstall', {});

			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('delete login item'),
			);

			expect(mockUnlinkSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly-start.command'),
			);

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('uninstalled');

			killSpy.mockRestore();
		});
	});

	// -----------------------------------------------------------------------
	// macOS status
	// -----------------------------------------------------------------------

	describe('status (macOS)', () => {
		it('shows fully operational when everything is running', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly-start.command')) return true;
				if (p.includes('crewly.pid')) return true;
				if (p.includes('.plist')) return false;
				return false;
			});

			mockReadFileSync.mockReturnValue('12345');

			const killSpy = jest
				.spyOn(process, 'kill')
				.mockImplementation(() => true);

			mockExecAsync.mockReturnValue('Crewly Backend');

			await serviceCommand('status', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('.command file: Installed');
			expect(output).toContain('Login Item: Registered');
			expect(output).toContain('Running (PID 12345)');
			expect(output).toContain('fully operational');

			killSpy.mockRestore();
		});

		it('shows not installed when nothing exists', async () => {
			mockExistsSync.mockReturnValue(false);
			mockExecAsync.mockReturnValue('');

			await serviceCommand('status', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('.command file: Not found');
			expect(output).toContain('Login Item: Not registered');
			expect(output).toContain('Not running');
			expect(output).toContain('not installed');
		});

		it('warns about legacy LaunchAgent plist', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('.plist')) return true;
				return false;
			});

			mockExecAsync.mockReturnValue('');

			await serviceCommand('status', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Legacy LaunchAgent');
		});
	});

	// -----------------------------------------------------------------------
	// Linux install
	// -----------------------------------------------------------------------

	describe('install (Linux)', () => {
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
		});

		it('writes wrapper script and systemd unit on fresh install', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.service')) return false;
				if (p.includes('package.json')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify({ name: 'crewly' }),
			);

			mockExecAsync.mockReturnValue('');

			await serviceCommand('install', {});

			// Should write wrapper script
			expect(mockWriteFileSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly-start.sh'),
				expect.stringContaining('#!/bin/bash'),
				expect.objectContaining({ mode: 0o755 }),
			);

			// Should write systemd unit file
			expect(mockWriteFileSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly.service'),
				expect.stringContaining('[Unit]'),
			);

			// Should call systemctl daemon-reload and enable
			expect(mockExecAsync).toHaveBeenCalledWith(
				'systemctl --user daemon-reload',
			);
			expect(mockExecAsync).toHaveBeenCalledWith(
				'systemctl --user enable crewly.service',
			);

			// finding 10: linger is enabled so the user manager survives logout
			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringMatching(/^loginctl enable-linger \S+$/),
			);

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('installed successfully');
		});

		it('prints the manual linger command when loginctl is missing, and still installs', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.service')) return false;
				if (p.includes('package.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly' }));
			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.startsWith('loginctl')) return new Error('loginctl: command not found');
				return '';
			});

			await serviceCommand('install', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Could not enable linger');
			expect(output).toMatch(/Run manually: loginctl enable-linger \S+/);
			expect(output).toContain('installed successfully');
		});

		it('skips if already installed without --force', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.service')) return true;
				if (p.includes('package.json')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify({ name: 'crewly' }),
			);

			await serviceCommand('install', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('already installed');
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('overwrites with --force', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.service')) return true;
				if (p.includes('package.json')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify({ name: 'crewly' }),
			);

			mockExecAsync.mockReturnValue('');

			await serviceCommand('install', { force: true });

			expect(mockWriteFileSync).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// Linux uninstall
	// -----------------------------------------------------------------------

	describe('uninstall (Linux)', () => {
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
		});

		it('stops service, removes unit and wrapper, reloads systemd', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.service')) return true;
				if (p.includes('crewly-start.sh')) return true;
				if (p.includes('crewly.pid')) return false;
				return false;
			});

			mockExecAsync.mockReturnValue('');

			await serviceCommand('uninstall', {});

			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('systemctl --user stop'),
			);
			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('systemctl --user disable'),
			);
			expect(mockUnlinkSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly.service'),
			);
			expect(mockUnlinkSync).toHaveBeenCalledWith(
				expect.stringContaining('crewly-start.sh'),
			);

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('uninstalled');
		});
	});

	// -----------------------------------------------------------------------
	// Linux status
	// -----------------------------------------------------------------------

	describe('status (Linux)', () => {
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
		});

		it('shows fully operational when active with PID', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('crewly.service')) return true;
				if (p.includes('crewly.pid')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue('54321');

			const killSpy = jest
				.spyOn(process, 'kill')
				.mockImplementation(() => true);

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('is-active')) return 'active';
				return '';
			});

			await serviceCommand('status', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Unit file: Installed');
			expect(output).toContain('Active (running)');
			expect(output).toContain('Running (PID 54321)');
			expect(output).toContain('fully operational');

			killSpy.mockRestore();
		});

		it('warns when linger is disabled', async () => {
			mockExistsSync.mockReturnValue(false);
			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('show-user')) return 'no\n';
				throw new Error('not found');
			});

			await serviceCommand('status', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toMatch(/Linger: Disabled — run: loginctl enable-linger \S+/);
		});

		it('shows not installed when nothing exists', async () => {
			mockExistsSync.mockReturnValue(false);
			mockExecAsync.mockImplementation(() => {
				throw new Error('not found');
			});

			await serviceCommand('status', {});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Unit file: Not found');
			expect(output).toContain('Not registered');
			expect(output).toContain('not installed');
		});
	});
});

// ---------------------------------------------------------------------------
// Unit tests for exported helpers
// ---------------------------------------------------------------------------

describe('generateCommandFile', () => {
	it('includes the project root path', () => {
		const content = generateCommandFile('/path/to/crewly');
		expect(content).toContain('CREWLY_DIR="/path/to/crewly"');
	});

	it('sources zshrc for NVM/PATH', () => {
		const content = generateCommandFile('/any/path');
		expect(content).toContain('.zshrc');
	});

	it('also exports the captured PATH/node and sources service.env', () => {
		const content = generateCommandFile('/any/path', fakeEnv);
		expect(content).toContain('export PATH="/opt/npm/bin:/opt/node/bin:/usr/local/bin:/usr/bin"');
		expect(content).toContain('NODE_BIN="/opt/node/bin/node"');
		expect(content).toContain('SERVICE_ENV="$HOME/.crewly/service.env"');
		expect(content).toContain('"$NODE_BIN" dist/cli/cli/src/index.js start');
	});

	it('includes PID-based duplicate prevention', () => {
		const content = generateCommandFile('/any/path');
		expect(content).toContain('PIDFILE');
		expect(content).toContain('kill -0');
	});

	it('includes crash restart loop', () => {
		const content = generateCommandFile('/any/path');
		expect(content).toContain('while true');
		expect(content).toContain('restarting in 5s');
	});

	it('includes native module arch check', () => {
		const content = generateCommandFile('/any/path');
		expect(content).toContain('pty.node');
		expect(content).toContain('npm rebuild node-pty');
		expect(content).toContain('Architecture mismatch');
	});

	it('#244: has cd INSIDE the while loop (not before it)', () => {
		const content = generateCommandFile('/any/path');
		const whilePos = content.indexOf('while true');
		const cdPos = content.indexOf('cd "$CREWLY_DIR"');
		// cd must appear AFTER 'while true', not before it
		expect(whilePos).toBeGreaterThan(-1);
		expect(cdPos).toBeGreaterThan(whilePos);
	});

	it('#244: cd has error handling', () => {
		const content = generateCommandFile('/any/path');
		expect(content).toContain('cd "$CREWLY_DIR" || {');
	});
});

describe('generateSystemdUnit', () => {
	it('includes [Unit], [Service], and [Install] sections', () => {
		const content = generateSystemdUnit('/path/to/crewly');
		expect(content).toContain('[Unit]');
		expect(content).toContain('[Service]');
		expect(content).toContain('[Install]');
	});

	it('uses the wrapper script as ExecStart', () => {
		const content = generateSystemdUnit('/path/to/crewly');
		expect(content).toContain('ExecStart=');
		expect(content).toContain('crewly-start.sh');
	});

	it('sets WorkingDirectory to project root', () => {
		const content = generateSystemdUnit('/opt/crewly');
		expect(content).toContain('WorkingDirectory=/opt/crewly');
	});

	it('configures restart on failure with 5s delay', () => {
		const content = generateSystemdUnit('/any/path');
		expect(content).toContain('Restart=on-failure');
		expect(content).toContain('RestartSec=5');
	});

	it('loads the optional ~/.crewly/service.env (missing file tolerated)', () => {
		const content = generateSystemdUnit('/any/path');
		expect(content).toContain('EnvironmentFile=-%h/.crewly/service.env');
	});

	it('targets default.target for user services', () => {
		const content = generateSystemdUnit('/any/path');
		expect(content).toContain('WantedBy=default.target');
	});
});

/** Deterministic environment for wrapper-generation assertions. */
const fakeEnv = {
	nodeBin: '/opt/node/bin/node',
	npmGlobalBin: '/opt/npm/bin',
	path: '/usr/local/bin:/usr/bin',
};

describe('captureServiceEnvironment', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('captures execPath, npm prefix bin and PATH', () => {
		mockExecSync.mockReturnValue('/usr/local\n');
		const env = captureServiceEnvironment();
		expect(env.nodeBin).toBe(process.execPath);
		expect(env.npmGlobalBin).toBe('/usr/local/bin');
		expect(env.path).toBe(process.env.PATH);
		expect(mockExecSync).toHaveBeenCalledWith('npm prefix -g');
	});

	it('degrades to null npm bin when npm is unavailable', () => {
		mockExecSync.mockImplementation(() => {
			throw new Error('npm: not found');
		});
		expect(captureServiceEnvironment().npmGlobalBin).toBeNull();
	});
});

describe('generateLinuxWrapper', () => {
	it('includes the project root path', () => {
		const content = generateLinuxWrapper('/path/to/crewly');
		expect(content).toContain('CREWLY_DIR="/path/to/crewly"');
	});

	it('does NOT source .bashrc (finding 9: it returns early under systemd)', () => {
		const content = generateLinuxWrapper('/any/path', fakeEnv);
		expect(content).not.toContain('source "$HOME/.bashrc"');
	});

	it('exports the captured PATH with npm global bin and node dir first', () => {
		const content = generateLinuxWrapper('/any/path', fakeEnv);
		expect(content).toContain('export PATH="/opt/npm/bin:/opt/node/bin:/usr/local/bin:/usr/bin"');
	});

	it('pins NODE_BIN to the absolute node binary and execs it', () => {
		const content = generateLinuxWrapper('/any/path', fakeEnv);
		expect(content).toContain('NODE_BIN="/opt/node/bin/node"');
		expect(content).toContain('exec "$NODE_BIN" dist/cli/cli/src/index.js start');
	});

	it('sources ~/.crewly/service.env when present (with allexport)', () => {
		const content = generateLinuxWrapper('/any/path', fakeEnv);
		expect(content).toContain('SERVICE_ENV="$HOME/.crewly/service.env"');
		expect(content).toContain('set -a');
		expect(content).toContain('source "$SERVICE_ENV"');
	});

	it('lets service.env override NODE_ENV', () => {
		const content = generateLinuxWrapper('/any/path', fakeEnv);
		expect(content).toContain('export NODE_ENV="${NODE_ENV:-development}"');
	});

	it('tolerates an unknown npm global bin dir', () => {
		const content = generateLinuxWrapper('/any/path', { ...fakeEnv, npmGlobalBin: null });
		expect(content).toContain('export PATH="/opt/node/bin:/usr/local/bin:/usr/bin"');
	});

	it('de-duplicates PATH entries already present in the captured PATH', () => {
		const content = generateLinuxWrapper('/any/path', { ...fakeEnv, path: '/opt/node/bin:/usr/bin' });
		expect(content).toContain('export PATH="/opt/npm/bin:/opt/node/bin:/usr/bin"');
	});

	it('writes PID file', () => {
		const content = generateLinuxWrapper('/any/path');
		expect(content).toContain('PIDFILE');
		expect(content).toContain('echo $$');
	});

	it('uses exec to replace shell with node', () => {
		const content = generateLinuxWrapper('/any/path', fakeEnv);
		expect(content).toContain('exec "$NODE_BIN"');
	});

	it('includes native module arch check', () => {
		const content = generateLinuxWrapper('/any/path');
		expect(content).toContain('pty.node');
		expect(content).toContain('npm rebuild node-pty');
	});
});

describe('getRunningPid', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns null when PID file does not exist', () => {
		mockExistsSync.mockReturnValue(false);
		expect(getRunningPid()).toBeNull();
	});

	it('returns null when PID file has non-numeric content', () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue('not-a-number');
		expect(getRunningPid()).toBeNull();
	});

	it('returns null when process is not alive', () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue('99999');

		const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
			throw new Error('ESRCH');
		});

		expect(getRunningPid()).toBeNull();

		killSpy.mockRestore();
	});

	it('returns the PID when process is alive', () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue('12345');

		const killSpy = jest
			.spyOn(process, 'kill')
			.mockImplementation(() => true);

		expect(getRunningPid()).toBe(12345);

		killSpy.mockRestore();
	});
});

describe('enableLinger', () => {
	let logSpy: jest.SpyInstance;

	beforeEach(() => {
		jest.clearAllMocks();
		logSpy = jest.spyOn(console, 'log').mockImplementation();
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('runs loginctl enable-linger for the user and reports success', async () => {
		mockExecAsync.mockImplementation((cmd: string) => (cmd.includes('show-user') ? 'yes\n' : ''));
		expect(await enableLinger('alice')).toBe(true);
		expect(mockExecAsync).toHaveBeenCalledWith('loginctl enable-linger alice');
		const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
		expect(output).toContain('Enabled linger for alice');
	});

	it('returns false and prints the manual command when enable-linger fails', async () => {
		mockExecAsync.mockReturnValue(new Error('Interactive authentication required'));
		expect(await enableLinger('alice')).toBe(false);
		const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
		expect(output).toContain('Interactive authentication required');
		expect(output).toContain('Run manually: loginctl enable-linger alice');
	});

	it('returns false when enable-linger exits 0 but Linger is still "no"', async () => {
		mockExecAsync.mockImplementation((cmd: string) => (cmd.includes('show-user') ? 'no\n' : ''));
		expect(await enableLinger('alice')).toBe(false);
		const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
		expect(output).toContain('Linger is still off');
	});

	it('trusts the enable call when show-user is unavailable', async () => {
		mockExecAsync.mockImplementation((cmd: string) => {
			if (cmd.includes('show-user')) return new Error('unknown option');
			return '';
		});
		expect(await enableLinger('alice')).toBe(true);
	});
});

describe('getLingerState', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns yes/no from loginctl', async () => {
		mockExecAsync.mockReturnValue('yes\n');
		expect(await getLingerState('alice')).toBe('yes');
		mockExecAsync.mockReturnValue('no\n');
		expect(await getLingerState('alice')).toBe('no');
	});

	it('returns null when loginctl is unavailable', async () => {
		mockExecAsync.mockReturnValue(new Error('not found'));
		expect(await getLingerState('alice')).toBeNull();
	});
});

describe('getSystemdState', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns "active" when service is active', async () => {
		mockExecAsync.mockReturnValue('active');
		expect(await getSystemdState()).toBe('active');
	});

	it('returns "inactive" when service is loaded but stopped', async () => {
		mockExecAsync.mockReturnValue('inactive');
		expect(await getSystemdState()).toBe('inactive');
	});

	it('returns "enabled" when is-active fails but is-enabled succeeds', async () => {
		mockExecAsync.mockImplementation((cmd: string) => {
			if (cmd.includes('is-active')) throw new Error('inactive');
			if (cmd.includes('is-enabled')) return 'enabled';
			return '';
		});
		expect(await getSystemdState()).toBe('enabled');
	});

	it('returns null when service is not registered', async () => {
		mockExecAsync.mockImplementation(() => {
			throw new Error('not found');
		});
		expect(await getSystemdState()).toBeNull();
	});
});

describe('isLoginItemRegistered', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns true when Login Item is in the list', async () => {
		mockExecAsync.mockReturnValue('Crewly Backend, SomeOther');
		expect(await isLoginItemRegistered()).toBe(true);
	});

	it('returns false when Login Item is not in the list', async () => {
		mockExecAsync.mockReturnValue('SomeOther, AnotherItem');
		expect(await isLoginItemRegistered()).toBe(false);
	});

	it('returns false when osascript fails', async () => {
		mockExecAsync.mockReturnValue(new Error('osascript error'));
		expect(await isLoginItemRegistered()).toBe(false);
	});
});

describe('install from an unrelated cwd (finding 8)', () => {
	const originalPlatform = process.platform;
	let logSpy: jest.SpyInstance;
	let cwdSpy: jest.SpyInstance;

	beforeEach(() => {
		jest.clearAllMocks();
		logSpy = jest.spyOn(console, 'log').mockImplementation();
		cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/home/operator');
		Object.defineProperty(process, 'platform', { value: 'linux' });
		setCliModuleDir('/opt/crewly-install/dist/cli/cli/src');
	});

	afterEach(() => {
		setCliModuleDir(null);
		cwdSpy.mockRestore();
		logSpy.mockRestore();
		Object.defineProperty(process, 'platform', { value: originalPlatform });
	});

	it('resolves the package root from the CLI module location, not cwd', async () => {
		mockExistsSync.mockImplementation((p: string) => p === '/opt/crewly-install/package.json');
		mockReadFileSync.mockReturnValue(JSON.stringify({ name: 'crewly' }));
		mockExecAsync.mockReturnValue('');

		await serviceCommand('install', {});

		expect(mockWriteFileSync).toHaveBeenCalledWith(
			expect.stringContaining('crewly-start.sh'),
			expect.stringContaining('CREWLY_DIR="/opt/crewly-install"'),
			expect.objectContaining({ mode: 0o755 }),
		);
		const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
		expect(output).not.toContain('Could not find');
	});
});
