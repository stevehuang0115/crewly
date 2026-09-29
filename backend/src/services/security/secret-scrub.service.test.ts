/**
 * Tests for the one-time on-disk secret scrub.
 *
 * Runs entirely in a temp CREWLY_HOME and a temp home directory — never the
 * real ~/.crewly or shell history.
 *
 * @module services/security/secret-scrub.service.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { collectSettingsSecretValues, listScrubTargets, scrubSecretsOnDisk } from './secret-scrub.service.js';

const GEMINI = ('AIza' + 'SyTESTfakeGeminiKey0123456789abcdefg');
const SLACK = ('xoxb-' + '1234567890123-1234567890123-TESTfakeSlackBot');
const SETTINGS_ONLY = 'plainhexsecret0123456789abcdef00'; // no known shape: found only via settings.json

describe('scrubSecretsOnDisk', () => {
	let root: string;
	let crewlyHome: string;
	let homeDir: string;
	let sessionLog: string;
	let archive: string;
	let bashHistory: string;
	let zshHistory: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrub-'));
		crewlyHome = path.join(root, 'crewly-home');
		homeDir = path.join(root, 'home');
		await fs.mkdir(path.join(crewlyHome, 'logs', 'sessions'), { recursive: true });
		await fs.mkdir(path.join(crewlyHome, 'logs', 'archive'), { recursive: true });
		await fs.mkdir(homeDir, { recursive: true });

		sessionLog = path.join(crewlyHome, 'logs', 'sessions', 'dev-1.log');
		await fs.writeFile(sessionLog, `$ export GEMINI_API_KEY="${GEMINI}"\nbot ${SLACK}\nkey ${SETTINGS_ONLY}\nTOKEN_COUNT=5\n`);
		archive = path.join(crewlyHome, 'logs', 'archive', 'dev-1-2026-09-01.gz');
		await fs.writeFile(archive, gzipSync(Buffer.from(`export SLACK_BOT_TOKEN=${SLACK}\n`)));
		await fs.writeFile(path.join(crewlyHome, 'logs', 'archive', 'notes.txt'), GEMINI); // not a .gz: ignored

		bashHistory = path.join(homeDir, '.bash_history');
		await fs.writeFile(bashHistory, `ls\nexport GEMINI_API_KEY="${GEMINI}"\ncd /tmp\n`, { mode: 0o600 });
		zshHistory = path.join(homeDir, '.zsh_history');
		// zsh "metafied" bytes (0x83 escape) must survive byte-for-byte
		const meta = Buffer.from([0x83, 0xa4, 0x83, 0xb8]);
		await fs.writeFile(zshHistory, Buffer.concat([
			Buffer.from(': 1700000000:0;echo '), meta, Buffer.from(`\n: 1700000001:0;export OPENAI_API_KEY=sk-proj-TESTfake0123456789abcdefghij\n`),
		]), { mode: 0o600 });

		await fs.writeFile(path.join(crewlyHome, 'settings.json'), JSON.stringify({ apiKeys: { global: { deepseek: SETTINGS_ONLY } } }));
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('dry run reports counts per file and changes nothing', async () => {
		const before = await Promise.all([sessionLog, archive, bashHistory, zshHistory].map((p) => fs.readFile(p)));
		const summary = await scrubSecretsOnDisk({ crewlyHome, homeDir, envs: [] });

		expect(summary.applied).toBe(false);
		expect(summary.filesScanned).toBe(4);
		expect(summary.filesWithSecrets).toBe(4);
		expect(summary.filesRewritten).toBe(0);
		expect(summary.secrets).toBe(3 + 1 + 1 + 1);
		expect(summary.errors).toBe(0);
		const after = await Promise.all([sessionLog, archive, bashHistory, zshHistory].map((p) => fs.readFile(p)));
		after.forEach((buf, i) => expect(buf.equals(before[i])).toBe(true));
	});

	it('never returns a secret value in its result', async () => {
		const summary = await scrubSecretsOnDisk({ crewlyHome, homeDir, envs: [] });
		const serialized = JSON.stringify(summary);
		for (const v of [GEMINI, SLACK, SETTINGS_ONLY, ('sk-proj-' + 'TESTfake')]) expect(serialized).not.toContain(v);
	});

	it('apply masks every secret, keeps modes and non-UTF-8 bytes, and is idempotent', async () => {
		const first = await scrubSecretsOnDisk({ crewlyHome, homeDir, apply: true, envs: [] });
		expect(first.applied).toBe(true);
		expect(first.filesRewritten).toBe(4);
		expect(first.secrets).toBe(6);

		const log = await fs.readFile(sessionLog, 'utf8');
		expect(log).not.toContain(GEMINI);
		expect(log).not.toContain(SLACK);
		expect(log).not.toContain(SETTINGS_ONLY);
		expect(log).toContain('GEMINI_API_KEY="[REDACTED]"');
		expect(log).toContain('TOKEN_COUNT=5');

		const arch = gunzipSync(await fs.readFile(archive)).toString('utf8');
		expect(arch).toBe('export SLACK_BOT_TOKEN=[REDACTED]\n');

		const bash = await fs.readFile(bashHistory, 'utf8');
		expect(bash).toBe('ls\nexport GEMINI_API_KEY="[REDACTED]"\ncd /tmp\n');
		expect((await fs.stat(bashHistory)).mode & 0o777).toBe(0o600);

		const zsh = await fs.readFile(zshHistory);
		expect(zsh.includes(Buffer.from([0x83, 0xa4, 0x83, 0xb8]))).toBe(true);
		expect(zsh.toString('latin1')).toContain('export OPENAI_API_KEY=[REDACTED]');

		const second = await scrubSecretsOnDisk({ crewlyHome, homeDir, apply: true, envs: [] });
		expect(second.secrets).toBe(0);
		expect(second.filesRewritten).toBe(0);
	});

	it('masks by exact value the secrets held in the given env', async () => {
		const held = 'abcdefabcdef0123456789heldvalue';
		await fs.writeFile(sessionLog, `value ${held}\n`);
		const summary = await scrubSecretsOnDisk({ crewlyHome, homeDir, apply: true, includeShellHistory: false, envs: [{ SLACK_SIGNING_SECRET: held }] });
		expect(summary.files.find((f) => f.path === sessionLog)?.secrets).toBe(1);
		expect(await fs.readFile(sessionLog, 'utf8')).toBe('value [REDACTED SLACK_SIGNING_SECRET]\n');
	});

	it('skips shell history when asked', async () => {
		const targets = await listScrubTargets(crewlyHome, homeDir, false);
		expect(targets.map((t) => t.kind).sort()).toEqual(['session-log', 'session-log-archive']);
	});

	it('reports an unreadable archive as an error without content', async () => {
		await fs.writeFile(archive, 'not gzip');
		const summary = await scrubSecretsOnDisk({ crewlyHome, homeDir, envs: [] });
		const bad = summary.files.find((f) => f.path === archive);
		expect(bad?.error).toBeDefined();
		expect(summary.errors).toBe(1);
	});

	it('works when nothing exists', async () => {
		const empty = await scrubSecretsOnDisk({ crewlyHome: path.join(root, 'none'), homeDir: path.join(root, 'none'), envs: [] });
		expect(empty).toMatchObject({ filesScanned: 0, secrets: 0, errors: 0 });
	});
});

describe('collectSettingsSecretValues', () => {
	it('returns [] for a missing or malformed settings file', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrub-settings-'));
		expect(await collectSettingsSecretValues(dir)).toEqual([]);
		await fs.writeFile(path.join(dir, 'settings.json'), '{not json');
		expect(await collectSettingsSecretValues(dir)).toEqual([]);
		await fs.rm(dir, { recursive: true, force: true });
	});
});
