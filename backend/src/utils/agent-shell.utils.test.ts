import { gitBashCandidates, resolveAgentShell } from './agent-shell.utils.js';

const WIN_ENV = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

describe('resolveAgentShell', () => {
	it('uses $SHELL on macOS and Linux, else /bin/bash', () => {
		expect(resolveAgentShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' } })).toBe('/bin/zsh');
		expect(resolveAgentShell({ platform: 'linux', env: {} })).toBe('/bin/bash');
	});

	it('uses Git for Windows bash on Windows, never /bin/bash', () => {
		expect(resolveAgentShell({ platform: 'win32', env: WIN_ENV, exists: (f) => f === GIT_BASH })).toBe(GIT_BASH);
	});

	it('finds a per-user Git install', () => {
		const perUser = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
		expect(resolveAgentShell({ platform: 'win32', env: WIN_ENV, exists: (f) => f === perUser })).toBe(perUser);
	});

	it('an explicit Windows path wins; a POSIX-style $SHELL is ignored there', () => {
		const custom = 'D:\\tools\\bash.exe';
		expect(resolveAgentShell({ platform: 'win32', env: { ...WIN_ENV, CREWLY_SHELL: custom }, exists: () => true })).toBe(custom);
		expect(resolveAgentShell({ platform: 'win32', env: { ...WIN_ENV, SHELL: '/usr/bin/bash' }, exists: (f) => f === GIT_BASH })).toBe(GIT_BASH);
		expect(resolveAgentShell({ platform: 'win32', env: { ...WIN_ENV, CLAUDE_CODE_GIT_BASH_PATH: custom }, exists: (f) => f === custom })).toBe(custom);
	});

	it('falls back to bash.exe on PATH when Git Bash is not found', () => {
		expect(resolveAgentShell({ platform: 'win32', env: WIN_ENV, exists: () => false })).toBe('bash.exe');
	});
});

describe('gitBashCandidates', () => {
	it('never offers the WSL launcher in System32', () => {
		const all = gitBashCandidates({ ...WIN_ENV, SystemRoot: 'C:\\Windows' });
		expect(all.length).toBeGreaterThan(0);
		expect(all.some((f) => /system32/i.test(f))).toBe(false);
	});
});
