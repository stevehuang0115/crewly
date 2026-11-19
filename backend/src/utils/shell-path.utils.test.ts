import { toShellPath, toShellPathEntry } from './shell-path.utils.js';

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
