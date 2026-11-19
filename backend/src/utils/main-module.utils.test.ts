import { isBackendEntryScript } from './main-module.utils.js';

describe('isBackendEntryScript', () => {
	it('accepts the entry file with POSIX separators', () => {
		expect(isBackendEntryScript('/opt/crewly/dist/backend/backend/src/index.js')).toBe(true);
		expect(isBackendEntryScript('/repo/backend/src/index.ts')).toBe(true);
	});

	it('accepts the entry file with Windows separators', () => {
		expect(isBackendEntryScript('C:\\npm\\prefix\\node_modules\\crewly\\dist\\backend\\backend\\src\\index.js')).toBe(true);
		expect(isBackendEntryScript('D:\\a\\crewly\\backend\\src\\index.ts')).toBe(true);
	});

	it('refuses other scripts and a missing path', () => {
		expect(isBackendEntryScript('/repo/node_modules/jest/bin/jest.js')).toBe(false);
		expect(isBackendEntryScript('C:\\repo\\dist\\reindex.js')).toBe(false);
		expect(isBackendEntryScript(undefined)).toBe(false);
		expect(isBackendEntryScript('')).toBe(false);
	});
});
