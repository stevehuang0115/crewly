/**
 * Tests for the Claude config helpers (first-run flag, API key approval).
 * Every test uses a temp home — the real ~/.claude.json is never touched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getClaudeConfigFile, getClaudeCredentialsFile, getClaudeDataDir, prepareClaudeConfigForCrewlyLogin } from './claude-config.utils.js';

describe('claude config helpers', () => {
	let home: string;
	let location: { env: NodeJS.ProcessEnv; homeDir: string };

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
		location = { env: {}, homeDir: home };
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it('resolves paths under $HOME by default', () => {
		expect(getClaudeConfigFile(location)).toBe(path.join(home, '.claude.json'));
		expect(getClaudeDataDir(location)).toBe(path.join(home, '.claude'));
		expect(getClaudeCredentialsFile(location)).toBe(path.join(home, '.claude', '.credentials.json'));
	});

	it('honours CLAUDE_CONFIG_DIR', () => {
		const loc = { env: { CLAUDE_CONFIG_DIR: '/cfg' }, homeDir: home };
		expect(getClaudeConfigFile(loc)).toBe('/cfg/.claude.json');
		expect(getClaudeDataDir(loc)).toBe('/cfg');
		expect(getClaudeCredentialsFile(loc)).toBe('/cfg/.credentials.json');
	});

	it('creates the config with hasCompletedOnboarding when missing', () => {
		expect(prepareClaudeConfigForCrewlyLogin({}, location)).toEqual({ changed: true });
		const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
		expect(config).toEqual({ hasCompletedOnboarding: true });
	});

	it('preserves other keys and file mode, and is idempotent', () => {
		const file = path.join(home, '.claude.json');
		fs.writeFileSync(file, JSON.stringify({ theme: 'light', projects: { a: 1 } }), { mode: 0o644 });
		prepareClaudeConfigForCrewlyLogin({}, location);
		const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
		expect(config).toEqual({ theme: 'light', projects: { a: 1 }, hasCompletedOnboarding: true });
		expect(fs.statSync(file).mode & 0o777).toBe(0o644);
		expect(prepareClaudeConfigForCrewlyLogin({}, location)).toEqual({ changed: false });
	});

	it('approves an API key by its last 20 characters and un-rejects it', () => {
		const key = `sk-ant-api03-${'x'.repeat(40)}ABCDEFGHIJKLMNOPQRST`;
		const file = path.join(home, '.claude.json');
		fs.writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: ['old'], rejected: ['ABCDEFGHIJKLMNOPQRST'] } }));
		expect(prepareClaudeConfigForCrewlyLogin({ apiKey: key }, location).changed).toBe(true);
		const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
		expect(config.customApiKeyResponses).toEqual({ approved: ['old', 'ABCDEFGHIJKLMNOPQRST'], rejected: [] });
		expect(fs.readFileSync(file, 'utf-8')).not.toContain(key);
		expect(prepareClaudeConfigForCrewlyLogin({ apiKey: key }, location).changed).toBe(false);
	});

	it('leaves an unreadable config untouched', () => {
		const file = path.join(home, '.claude.json');
		fs.writeFileSync(file, '{not json');
		expect(prepareClaudeConfigForCrewlyLogin({}, location)).toEqual({ changed: false, skippedReason: 'config is not readable JSON' });
		expect(fs.readFileSync(file, 'utf-8')).toBe('{not json');
		fs.writeFileSync(file, '[]');
		expect(prepareClaudeConfigForCrewlyLogin({}, location).skippedReason).toBe('config is not a JSON object');
	});
});
