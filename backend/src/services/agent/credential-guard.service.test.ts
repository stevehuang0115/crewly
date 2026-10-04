/**
 * Tests for the credential guard wiring (specs/2026-10-04-agent-credential-isolation.md, layer 2).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildCredentialGuardPathsBody,
	claudeCredentialReadDenyRules,
	codexCredentialGuardArgs,
	credentialGuardEnvFor,
	isCredentialGuardEnabled,
	prepareCredentialGuard,
	syncAntigravityCredentialHook,
	withCodexCredentialGuard,
	writeGeminiCredentialGuardSettings,
} from './credential-guard.service.js';

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'credguard-svc-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('paths file', () => {
	it('lists the home, then abs / tail / rel forms of each guarded path', () => {
		const body = buildCredentialGuardPathsBody('/h/.crewly', [
			{ id: 'cloud-config', path: '/h/.crewly/cloud', isDirectory: true },
			{ id: 'secret-store', path: '/h/.local/share/crewly/secrets/x', isDirectory: true },
		]);
		expect(body.split('\n')).toEqual([
			'home\t-\t/h/.crewly',
			'abs\tcloud-config\t/h/.crewly/cloud',
			'tail\tcloud-config\t.crewly/cloud',
			'rel\tcloud-config\tcloud',
			'abs\tsecret-store\t/h/.local/share/crewly/secrets/x',
			'tail\tsecret-store\tsecrets/x',
			'',
		]);
	});

	it('writes the paths file and one argument-free wrapper per format', () => {
		const home = path.join(tmp, '.crewly');
		const files = prepareCredentialGuard(home, '/opt/crewly', [{ id: 'api-token', path: path.join(home, 'api-token'), isDirectory: false }]);
		expect(fs.readFileSync(files.pathsFile, 'utf8')).toContain(`abs\tapi-token\t${path.join(home, 'api-token')}`);
		const wrapper = fs.readFileSync(files.wrappers.antigravity, 'utf8');
		expect(wrapper).toContain("exec bash '/opt/crewly/config/hooks/credential-guard/guard.sh' antigravity");
		expect(wrapper).toContain(`\${CREWLY_CREDENTIAL_GUARD_PATHS:-${files.pathsFile}}`);
		expect(fs.statSync(files.wrappers.codex).mode & 0o111).not.toBe(0);
	});

	it('agent env points at the paths file and script; empty when switched off', () => {
		expect(credentialGuardEnvFor('/h/.crewly', '/opt/c', {})).toEqual({
			CREWLY_CREDENTIAL_GUARD_PATHS: '/h/.crewly/runtime/credential-guard/paths',
			CREWLY_CREDENTIAL_GUARD_SCRIPT: '/opt/c/config/hooks/credential-guard/guard.sh',
		});
		expect(credentialGuardEnvFor('/h/.crewly', '/opt/c', { CREWLY_CREDENTIAL_GUARD: '0' })).toEqual({});
		expect(isCredentialGuardEnabled({ CREWLY_CREDENTIAL_GUARD: '0' })).toBe(false);
		expect(isCredentialGuardEnabled({})).toBe(true);
	});
});

describe('Claude Code', () => {
	it('emits absolute Read deny rules, with the subtree for directories', () => {
		expect(claudeCredentialReadDenyRules([
			{ id: 'a', path: '/h/.crewly/api-token', isDirectory: false },
			{ id: 'c', path: '/h/.crewly/cloud', isDirectory: true },
		])).toEqual(['Read(//h/.crewly/api-token)', 'Read(//h/.crewly/cloud)', 'Read(//h/.crewly/cloud/**)']);
	});
});

describe('Codex', () => {
	it('adds the trust flag and a session PreToolUse hook after the codex word (also after `codex resume`)', () => {
		const args = codexCredentialGuardArgs('/h/.crewly/runtime/credential-guard/hook-codex.sh') as string;
		expect(args).toBe(`--dangerously-bypass-hook-trust -c 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="/h/.crewly/runtime/credential-guard/hook-codex.sh"}]}]'`);
		expect(withCodexCredentialGuard('codex --no-daemon -a never', args)).toBe(`codex ${args} --no-daemon -a never`);
		expect(withCodexCredentialGuard('codex resume --no-daemon abc', args)).toBe(`codex resume ${args} --no-daemon abc`);
		expect(withCodexCredentialGuard(`codex ${args}`, args)).toBe(`codex ${args}`);
		expect(withCodexCredentialGuard('CODEX_HOME=~/.codex codex', args)).toBe(`CODEX_HOME=~/.codex codex ${args}`);
	});

	it('refuses a wrapper path that cannot be embedded', () => {
		expect(codexCredentialGuardArgs("/it's/hook.sh")).toBeNull();
	});
});

describe('Gemini CLI', () => {
	it('writes a system settings file with a BeforeTool hook', () => {
		const file = writeGeminiCredentialGuardSettings(tmp, '/w/hook-gemini.sh', 'freebsd' as NodeJS.Platform);
		const s = JSON.parse(fs.readFileSync(file, 'utf8'));
		expect(s.hooks.BeforeTool[0]).toEqual({
			matcher: expect.stringContaining('run_shell_command'),
			hooks: [{ name: 'crewly-credential-guard', type: 'command', command: '/w/hook-gemini.sh', timeout: 5000 }],
		});
	});
});

describe('Antigravity (agy global hooks file)', () => {
	const hooksFile = () => path.join(tmp, '.gemini', 'config', 'hooks.json');

	it('adds its entry and keeps every other hook', () => {
		fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
		fs.writeFileSync(hooksFile(), JSON.stringify({ 'owner-hook': { PostToolUse: [] } }));
		expect(syncAntigravityCredentialHook('/w/hook-antigravity.sh', tmp)).toBe('written');
		const h = JSON.parse(fs.readFileSync(hooksFile(), 'utf8'));
		expect(h['owner-hook']).toEqual({ PostToolUse: [] });
		expect(h['crewly-credential-guard']).toEqual({
			PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/w/hook-antigravity.sh', timeout: 10 }] }],
		});
		expect(syncAntigravityCredentialHook('/w/hook-antigravity.sh', tmp)).toBe('unchanged');
	});

	it('creates the file when missing, and removes only its own entry', () => {
		expect(syncAntigravityCredentialHook('/w/h.sh', tmp)).toBe('written');
		expect(syncAntigravityCredentialHook(null, tmp)).toBe('removed');
		expect(JSON.parse(fs.readFileSync(hooksFile(), 'utf8'))).toEqual({});
		expect(syncAntigravityCredentialHook(null, tmp)).toBe('unchanged');
	});

	it('leaves a file that is not a JSON object alone', () => {
		fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
		fs.writeFileSync(hooksFile(), '[oops');
		expect(syncAntigravityCredentialHook('/w/h.sh', tmp)).toBe('skipped-not-object');
		expect(fs.readFileSync(hooksFile(), 'utf8')).toBe('[oops');
	});
});
