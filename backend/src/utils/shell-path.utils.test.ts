import { toShellPath, toShellPathEntry, windowsPathsToShell } from './shell-path.utils.js';

describe('toShellPath', () => {
	it('uses forward slashes on Windows and keeps the drive', () => {
		expect(toShellPath('C:\\Users\\me\\.crewly\\runtime\\a.settings.json', 'win32')).toBe('C:/Users/me/.crewly/runtime/a.settings.json');
		expect(toShellPath('config\\skills\\agent', 'win32')).toBe('config/skills/agent');
	});

	it('leaves POSIX paths alone, backslashes included', () => {
		expect(toShellPath('/home/me/a b/x.json', 'linux')).toBe('/home/me/a b/x.json');
		expect(toShellPath('/tmp/odd\\name', 'darwin')).toBe('/tmp/odd\\name');
	});
});

describe('toShellPathEntry', () => {
	it('writes a drive path the way MSYS bash reads PATH', () => {
		expect(toShellPathEntry('C:\\Program Files\\nodejs', 'win32')).toBe('/c/Program Files/nodejs');
		expect(toShellPathEntry('D:/tools/bin', 'win32')).toBe('/d/tools/bin');
	});

	it('keeps a path with no drive, and everything on POSIX', () => {
		expect(toShellPathEntry('\\\\server\\share\\bin', 'win32')).toBe('//server/share/bin');
		expect(toShellPathEntry('/usr/local/bin', 'linux')).toBe('/usr/local/bin');
	});
});

describe('windowsPathsToShell', () => {
	it('rewrites every Windows path in a text, mixed separators included', () => {
		const text = 'Run: bash D:\\a\\crewly\\config\\skills\\orchestrator/send-message/execute.sh then `C:\\Users\\me\\.crewly\\x.json`.';
		expect(windowsPathsToShell(text, 'win32')).toBe('Run: bash D:/a/crewly/config/skills/orchestrator/send-message/execute.sh then `C:/Users/me/.crewly/x.json`.');
	});

	it("keeps quotes, the typed cd line and the rest of the text", () => {
		expect(windowsPathsToShell("cd 'C:\\Users\\me\\.crewly'\r", 'win32')).toBe("cd 'C:/Users/me/.crewly'\r");
		expect(windowsPathsToShell('{"a":"x","b":1}', 'win32')).toBe('{"a":"x","b":1}');
	});

	it('does not touch words that only look like a drive, or anything on POSIX', () => {
		expect(windowsPathsToShell('Note:\\n and http://x', 'win32')).toBe('Note:\\n and http://x');
		expect(windowsPathsToShell('bash C:\\a\\b.sh', 'linux')).toBe('bash C:\\a\\b.sh');
	});
});
