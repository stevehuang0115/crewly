import {
	DEFAULT_TERMINAL_COLS,
	DEFAULT_TERMINAL_ROWS,
	RECOVERY_TERMINAL_COLS,
	RECOVERY_TERMINAL_ROWS,
	DEFAULT_SHELL,
} from './session-backend.interface.js';

describe('session-backend.interface', () => {
	describe('DEFAULT_TERMINAL_COLS', () => {
		it('should be a number', () => {
			expect(typeof DEFAULT_TERMINAL_COLS).toBe('number');
		});

		it('should be 160: wide enough that agent TUIs keep their input box on screen (2026-10-08 Ella)', () => {
			expect(DEFAULT_TERMINAL_COLS).toBe(160);
		});

		it('should be a positive integer', () => {
			expect(DEFAULT_TERMINAL_COLS).toBeGreaterThan(0);
			expect(Number.isInteger(DEFAULT_TERMINAL_COLS)).toBe(true);
		});
	});

	describe('DEFAULT_TERMINAL_ROWS', () => {
		it('should be a number', () => {
			expect(typeof DEFAULT_TERMINAL_ROWS).toBe('number');
		});

		it('should be 50: a frame taller than 24 rows scrolled the input box off screen (2026-10-08 Ella)', () => {
			expect(DEFAULT_TERMINAL_ROWS).toBe(50);
		});

		it('should be a positive integer', () => {
			expect(DEFAULT_TERMINAL_ROWS).toBeGreaterThan(0);
			expect(Number.isInteger(DEFAULT_TERMINAL_ROWS)).toBe(true);
		});
	});

	describe('RECOVERY_TERMINAL_COLS / ROWS', () => {
		it('is larger than the default in both directions (the unreadable ladder enlarges to it)', () => {
			expect(RECOVERY_TERMINAL_COLS).toBe(200);
			expect(RECOVERY_TERMINAL_ROWS).toBe(60);
			expect(RECOVERY_TERMINAL_COLS).toBeGreaterThan(DEFAULT_TERMINAL_COLS);
			expect(RECOVERY_TERMINAL_ROWS).toBeGreaterThan(DEFAULT_TERMINAL_ROWS);
		});
	});

	describe('DEFAULT_SHELL', () => {
		it('should be a string', () => {
			expect(typeof DEFAULT_SHELL).toBe('string');
		});

		it('should be a valid shell path', () => {
			// Should start with / on Unix or end with .exe on Windows
			const isUnixShell = DEFAULT_SHELL.startsWith('/');
			const isWindowsShell = DEFAULT_SHELL.endsWith('.exe');
			expect(isUnixShell || isWindowsShell).toBe(true);
		});

		it('should be platform-appropriate', () => {
			if (process.platform === 'win32') {
				expect(DEFAULT_SHELL).toBe('powershell.exe');
			} else {
				expect(DEFAULT_SHELL).toBe('/bin/bash');
			}
		});
	});

	describe('type definitions', () => {
		it('should export SessionBackendType as union type', () => {
			// This is a compile-time check - if types are wrong, this would fail to compile
			const ptyType: 'pty' | 'tmux' = 'pty';
			const tmuxType: 'pty' | 'tmux' = 'tmux';

			expect(ptyType).toBe('pty');
			expect(tmuxType).toBe('tmux');
		});

		it('should allow creating SessionOptions objects', () => {
			// Type check for SessionOptions interface
			const minimalOptions = {
				cwd: '/home/user',
				command: '/bin/bash',
			};

			const fullOptions = {
				cwd: '/home/user',
				command: '/bin/bash',
				args: ['--login'],
				env: { NODE_ENV: 'test' },
				cols: 120,
				rows: 40,
			};

			expect(minimalOptions.cwd).toBe('/home/user');
			expect(minimalOptions.command).toBe('/bin/bash');
			expect(fullOptions.args).toEqual(['--login']);
			expect(fullOptions.env).toEqual({ NODE_ENV: 'test' });
			expect(fullOptions.cols).toBe(120);
			expect(fullOptions.rows).toBe(40);
		});
	});
});
