/**
 * Tests for forcing Antigravity CLI onto the Gemini API key provider.
 *
 * Every test works in a temp dir: nothing touches the real ~/.gemini.
 *
 * @module utils/antigravity-settings.utils.test
 */

import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	ensureAntigravityApiKeyProvider,
	getAntigravityConfigDir,
	getAntigravitySettingsPath,
	hasGeminiProvider,
	mergeAntigravitySettings,
	parseAntigravitySettings,
	readAntigravityProviderIsGemini,
} from './antigravity-settings.utils.js';

describe('antigravity settings paths', () => {
	it('lives under ~/.gemini/antigravity-cli (docs: install page)', () => {
		expect(getAntigravityConfigDir('/home/me')).toBe(path.join('/home/me', '.gemini', 'antigravity-cli'));
		expect(getAntigravitySettingsPath('/home/me')).toBe(path.join('/home/me', '.gemini', 'antigravity-cli', 'settings.json'));
	});
});

describe('parseAntigravitySettings', () => {
	it('treats an empty file as empty settings', () => {
		expect(parseAntigravitySettings('  \n')).toEqual({});
	});

	it('returns null for anything that is not a JSON object', () => {
		expect(parseAntigravitySettings('{ bad')).toBeNull();
		expect(parseAntigravitySettings('[]')).toBeNull();
		expect(parseAntigravitySettings('null')).toBeNull();
	});

	it('parses an object', () => {
		expect(parseAntigravitySettings('{"colorScheme":"dark"}')).toEqual({ colorScheme: 'dark' });
	});
});

describe('mergeAntigravitySettings', () => {
	it('selects the gemini provider and keeps other keys', () => {
		const { settings, changed } = mergeAntigravitySettings({ colorScheme: 'dark' });
		expect(changed).toBe(true);
		expect(settings).toEqual({ colorScheme: 'dark', modelProvider: 'gemini' });
		expect(hasGeminiProvider(settings)).toBe(true);
	});

	it('overrides any other provider value (agy only accepts "gemini"; anything else means account login)', () => {
		const { settings } = mergeAntigravitySettings({ modelProvider: 'google-account' });
		expect(settings.modelProvider).toBe('gemini');
	});

	it('appends new trusted folders once, keeping existing order', () => {
		const { settings, changed } = mergeAntigravitySettings(
			{ modelProvider: 'gemini', trustedWorkspaces: ['/a', '/b'] },
			['/b', '/c', '/c'],
		);
		expect(changed).toBe(true);
		expect(settings.trustedWorkspaces).toEqual(['/a', '/b', '/c']);
	});

	it('reports no change when everything is already in place', () => {
		const { changed } = mergeAntigravitySettings({ modelProvider: 'gemini', trustedWorkspaces: ['/a'] }, ['/a']);
		expect(changed).toBe(false);
	});

	it('replaces a malformed trustedWorkspaces value with a list', () => {
		const { settings, changed } = mergeAntigravitySettings({ modelProvider: 'gemini', trustedWorkspaces: 'oops' }, []);
		expect(changed).toBe(true);
		expect(settings.trustedWorkspaces).toEqual([]);
	});
});

describe('ensureAntigravityApiKeyProvider', () => {
	let dir: string;
	let settingsPath: string;

	beforeEach(async () => {
		dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agy-settings-'));
		settingsPath = path.join(dir, '.gemini', 'antigravity-cli', 'settings.json');
	});

	afterEach(async () => {
		await fsPromises.rm(dir, { recursive: true, force: true });
	});

	const read = async (): Promise<Record<string, unknown>> => JSON.parse(await fsPromises.readFile(settingsPath, 'utf8'));

	it('creates the file with the provider in a clean HOME, mode 0600', async () => {
		await expect(ensureAntigravityApiKeyProvider({ settingsPath, trustedPaths: ['/proj'] })).resolves.toBe('written');
		expect(await read()).toEqual({ modelProvider: 'gemini', trustedWorkspaces: ['/proj'] });
		const mode = (await fsPromises.stat(settingsPath)).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it('preserves the settings agy itself wrote (as captured from agy 1.2.11)', async () => {
		await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
		await fsPromises.writeFile(settingsPath, JSON.stringify({ showFeedbackSurvey: false, trustedWorkspaces: ['/old'] }));
		await expect(ensureAntigravityApiKeyProvider({ settingsPath, trustedPaths: ['/new'] })).resolves.toBe('written');
		expect(await read()).toEqual({ showFeedbackSurvey: false, trustedWorkspaces: ['/old', '/new'], modelProvider: 'gemini' });
	});

	it('leaves the file alone when nothing changes', async () => {
		await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
		await fsPromises.writeFile(settingsPath, JSON.stringify({ modelProvider: 'gemini', trustedWorkspaces: ['/p'] }));
		const before = (await fsPromises.stat(settingsPath)).mtimeMs;
		await expect(ensureAntigravityApiKeyProvider({ settingsPath, trustedPaths: ['/p'] })).resolves.toBe('unchanged');
		expect((await fsPromises.stat(settingsPath)).mtimeMs).toBe(before);
	});

	it('never rewrites a file it cannot parse', async () => {
		await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
		await fsPromises.writeFile(settingsPath, '{ "colorScheme": "dark", // comment\n}');
		const warn = jest.fn();
		await expect(ensureAntigravityApiKeyProvider({ settingsPath, logger: { warn, info: jest.fn() } })).resolves.toBe('unparseable');
		expect(await fsPromises.readFile(settingsPath, 'utf8')).toContain('// comment');
		expect(warn).toHaveBeenCalled();
	});

	it('keeps every trusted folder when launches race', async () => {
		await Promise.all(['/a', '/b', '/c', '/d'].map((p) => ensureAntigravityApiKeyProvider({ settingsPath, trustedPaths: [p] })));
		const trusted = (await read()).trustedWorkspaces as string[];
		expect([...trusted].sort()).toEqual(['/a', '/b', '/c', '/d']);
	});

	it('reports read errors other than a missing file', async () => {
		await fsPromises.mkdir(settingsPath, { recursive: true }); // a directory where the file should be
		await expect(ensureAntigravityApiKeyProvider({ settingsPath })).resolves.toBe('error');
	});
});

describe('readAntigravityProviderIsGemini', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agy-provider-'));
	});

	afterEach(async () => {
		await fsPromises.rm(dir, { recursive: true, force: true });
	});

	it('is null when there is no file', async () => {
		await expect(readAntigravityProviderIsGemini(path.join(dir, 'missing.json'))).resolves.toBeNull();
	});

	it('tells whether the provider is gemini', async () => {
		const file = path.join(dir, 'settings.json');
		await fsPromises.writeFile(file, '{"modelProvider":"gemini"}');
		await expect(readAntigravityProviderIsGemini(file)).resolves.toBe(true);
		await fsPromises.writeFile(file, '{}');
		await expect(readAntigravityProviderIsGemini(file)).resolves.toBe(false);
	});
});
