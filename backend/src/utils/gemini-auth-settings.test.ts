/**
 * Tests for pre-selecting Gemini CLI's auth method.
 *
 * @module utils/gemini-auth-settings.test
 */

import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureGeminiApiKeyAuthSelected, GEMINI_API_KEY_AUTH_TYPE } from './gemini-auth-settings.js';

describe('ensureGeminiApiKeyAuthSelected', () => {
	let dir: string;
	let settingsPath: string;

	beforeEach(async () => {
		dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gemini-auth-'));
		settingsPath = path.join(dir, '.gemini', 'settings.json');
	});

	afterEach(async () => {
		await fsPromises.rm(dir, { recursive: true, force: true });
	});

	const read = async () => JSON.parse(await fsPromises.readFile(settingsPath, 'utf8'));

	it('selects "Use Gemini API Key" in a clean HOME (no settings file yet)', async () => {
		await expect(ensureGeminiApiKeyAuthSelected(undefined, settingsPath)).resolves.toBe('seeded');
		expect(await read()).toEqual({ security: { auth: { selectedType: GEMINI_API_KEY_AUTH_TYPE } } });
	});

	it('keeps every other setting when it adds the auth method', async () => {
		await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
		await fsPromises.writeFile(settingsPath, JSON.stringify({ ui: { theme: 'Dracula' }, security: { folderTrust: { enabled: true } } }));

		await expect(ensureGeminiApiKeyAuthSelected(undefined, settingsPath)).resolves.toBe('seeded');
		expect(await read()).toEqual({
			ui: { theme: 'Dracula' },
			security: { folderTrust: { enabled: true }, auth: { selectedType: GEMINI_API_KEY_AUTH_TYPE } },
		});
	});

	it("never overrides a method the user already chose (e.g. Login with Google)", async () => {
		await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
		const mine = { security: { auth: { selectedType: 'oauth-personal' } } };
		await fsPromises.writeFile(settingsPath, JSON.stringify(mine));

		await expect(ensureGeminiApiKeyAuthSelected(undefined, settingsPath)).resolves.toBe('kept');
		expect(await read()).toEqual(mine);
	});

	it('leaves a settings file with comments untouched rather than rewriting it', async () => {
		await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
		const jsonc = '{\n  // my theme\n  "ui": { "theme": "Dracula" }\n}\n';
		await fsPromises.writeFile(settingsPath, jsonc);
		const logger = { warn: jest.fn(), info: jest.fn() };

		await expect(ensureGeminiApiKeyAuthSelected(logger, settingsPath)).resolves.toBe('unparseable');
		expect(await fsPromises.readFile(settingsPath, 'utf8')).toBe(jsonc);
		expect(logger.warn).toHaveBeenCalled();
	});

	it('treats an empty settings file like a missing one', async () => {
		await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
		await fsPromises.writeFile(settingsPath, '\n');

		await expect(ensureGeminiApiKeyAuthSelected(undefined, settingsPath)).resolves.toBe('seeded');
	});
});
