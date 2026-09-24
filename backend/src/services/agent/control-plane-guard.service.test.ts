import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import * as path from 'path';
import {
	isControlPlaneGuardEnabled,
	resolveControlPlanePaths,
	toRuleSpecifier,
	buildControlPlaneSettings,
	toSafeFileStem,
	prepareControlPlaneGuard,
	applyControlPlaneSettingsFlag,
	ControlPlaneSettings,
} from './control-plane-guard.service.js';
import { CONTROL_PLANE_GUARD_CONSTANTS } from '../../constants.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('control-plane-guard.service', () => {
	const roots = { crewlyHome: '/h/.crewly', installRoot: '/opt/crewly', projectPath: '/work/proj' };

	describe('isControlPlaneGuardEnabled (kill switch)', () => {
		it('is on when the variable is unset', () => {
			expect(isControlPlaneGuardEnabled({})).toBe(true);
		});

		it('is off only for exactly "0"', () => {
			expect(isControlPlaneGuardEnabled({ CREWLY_CONTROL_PLANE_GUARD: '0' })).toBe(false);
			expect(isControlPlaneGuardEnabled({ CREWLY_CONTROL_PLANE_GUARD: '1' })).toBe(true);
			expect(isControlPlaneGuardEnabled({ CREWLY_CONTROL_PLANE_GUARD: 'false' })).toBe(true);
			expect(isControlPlaneGuardEnabled({ CREWLY_CONTROL_PLANE_GUARD: '' })).toBe(true);
		});
	});

	describe('resolveControlPlanePaths', () => {
		const { writeDenied, readDenied } = resolveControlPlanePaths(roots);
		const byPath = new Map(writeDenied.map((p) => [p.path, p.isDirectory]));

		it.each([
			['/h/.crewly/teams', true],
			['/h/.crewly/triggers', true],
			['/h/.crewly/runtime/control-plane', true],
			['/h/.crewly/recurring-checks.json', false],
			['/h/.crewly/one-time-checks.json', false],
			['/h/.crewly/scheduled-messages.json', false],
			['/h/.crewly/settings.json', false],
			['/h/.crewly/runtime-pids.json', false],
			['/h/.crewly/session-state.json', false],
			['/h/.crewly/api-token', false],
			['/opt/crewly/config/skills/orchestrator/stop-agent', true],
			['/opt/crewly/config/skills/orchestrator/start-agent', true],
			['/opt/crewly/config/skills/orchestrator/terminate-agent', true],
			['/opt/crewly/config/skills/orchestrator/stop-team', true],
			['/opt/crewly/config/skills/orchestrator/start-team', true],
			['/opt/crewly/config/skills/orchestrator/restart-crewly', true],
			['/opt/crewly/config/skills/_common/lib.sh', false],
			['/opt/crewly/config/hooks/control-plane-guard', true],
			['/opt/crewly/dist', true],
			['/work/proj/.claude/agents', true],
			['/work/proj/.crewly/triggers', true],
		])('write-protects %s (directory=%s)', (p, isDir) => {
			expect(byPath.get(p)).toBe(isDir);
		});

		it('read-denies only the API token', () => {
			expect(readDenied).toEqual(['/h/.crewly/api-token']);
		});

		it('omits project paths when no project path is given', () => {
			const r = resolveControlPlanePaths({ crewlyHome: roots.crewlyHome, installRoot: roots.installRoot });
			expect(r.writeDenied.some((p) => p.path.startsWith('/work/proj'))).toBe(false);
		});

		it('de-duplicates when the project path is the install root', () => {
			const r = resolveControlPlanePaths({ crewlyHome: '/h/.crewly', installRoot: '/opt/crewly', projectPath: '/h' });
			const all = r.writeDenied.map((p) => p.path);
			expect(new Set(all).size).toBe(all.length);
		});

		it('every protected install-root path exists in this repo (no stale entry)', () => {
			const repo = resolveControlPlanePaths({ crewlyHome: '/unused', installRoot: REPO_ROOT });
			const installEntries = repo.writeDenied.filter(
				(p) => p.path.startsWith(REPO_ROOT) && !p.path.endsWith(`${path.sep}dist`),
			);
			expect(installEntries.length).toBe(
				CONTROL_PLANE_GUARD_CONSTANTS.INSTALL_DIRS.length - 1 + CONTROL_PLANE_GUARD_CONSTANTS.INSTALL_FILES.length,
			);
			const missing = installEntries.filter((p) => !existsSync(p.path)).map((p) => p.path);
			expect(missing).toEqual([]);
		});
	});

	describe('toRuleSpecifier', () => {
		it('uses // for an absolute path (a single / is settings-relative in Claude Code)', () => {
			expect(toRuleSpecifier('/h/.crewly/api-token', false)).toBe('//h/.crewly/api-token');
		});

		it('adds /** for a directory', () => {
			expect(toRuleSpecifier('/h/.crewly/teams', true)).toBe('//h/.crewly/teams/**');
		});
	});

	describe('buildControlPlaneSettings', () => {
		const settings = buildControlPlaneSettings(resolveControlPlanePaths(roots), 'bash hook.sh paths');

		it('denies Edit on the team config subtree and the stop-agent skill', () => {
			expect(settings.permissions.deny).toContain('Edit(//h/.crewly/teams/**)');
			expect(settings.permissions.deny).toContain('Edit(//opt/crewly/config/skills/orchestrator/stop-agent/**)');
		});

		it('denies Read on the API token', () => {
			expect(settings.permissions.deny).toContain('Read(//h/.crewly/api-token)');
		});

		it('never denies Read on the team config (agents legitimately read it)', () => {
			expect(settings.permissions.deny.filter((r) => r.startsWith('Read(') && r.includes('/teams'))).toEqual([]);
		});

		it('uses only documented rule forms: Edit(//...) and Read(//...)', () => {
			for (const rule of settings.permissions.deny) {
				expect(rule).toMatch(/^(Edit|Read)\(\/\/[^()]+\)$/);
			}
		});

		it('attaches the hook to PreToolUse for Bash', () => {
			expect(settings.hooks.PreToolUse).toEqual([
				{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash hook.sh paths' }] },
			]);
		});
	});

	describe('toSafeFileStem', () => {
		it('keeps ordinary session names', () => {
			expect(toSafeFileStem('crewly-product-team-max-358c7cb7')).toBe('crewly-product-team-max-358c7cb7');
		});

		it('neutralises path separators and leading dots', () => {
			expect(toSafeFileStem('../../etc/passwd')).toBe('__.._etc_passwd');
			expect(toSafeFileStem('a/b c')).toBe('a_b_c');
			expect(toSafeFileStem('')).toBe('_');
		});
	});

	describe('prepareControlPlaneGuard', () => {
		let home: string;

		beforeEach(() => {
			home = mkdtempSync(path.join(tmpdir(), 'cpg-svc-'));
		});

		afterEach(() => {
			rmSync(home, { recursive: true, force: true });
		});

		it('writes the settings file and the paths list, and reports the count', async () => {
			const r = await prepareControlPlaneGuard('crewly-dev-001', { crewlyHome: home, installRoot: REPO_ROOT }, {});
			expect(r.enabled).toBe(true);
			if (!r.enabled) return;
			expect(r.settingsPath).toBe(path.join(home, 'runtime', 'control-plane', 'crewly-dev-001.settings.json'));
			const settings = JSON.parse(readFileSync(r.settingsPath, 'utf-8')) as ControlPlaneSettings;
			expect(settings.permissions.deny).toContain(`Edit(/${path.join(home, 'teams')}/**)`);
			expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
				`bash '${path.join(REPO_ROOT, CONTROL_PLANE_GUARD_CONSTANTS.HOOK_SCRIPT)}' '${r.pathsPath}'`,
			);
			const listed = readFileSync(r.pathsPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'));
			expect(listed.length).toBe(r.protectedCount);
			expect(listed).toContain(path.join(home, 'teams'));
		});

		it('puts its own generated files under a protected directory', async () => {
			const r = await prepareControlPlaneGuard('s1', { crewlyHome: home, installRoot: REPO_ROOT }, {});
			if (!r.enabled) throw new Error('expected enabled');
			const listed = readFileSync(r.pathsPath, 'utf-8').split('\n');
			const dir = path.join(home, 'runtime', 'control-plane');
			expect(listed).toContain(dir);
			expect(r.settingsPath.startsWith(`${dir}${path.sep}`)).toBe(true);
		});

		it('writes nothing and reports the reason when the kill switch is 0', async () => {
			const r = await prepareControlPlaneGuard('s1', { crewlyHome: home, installRoot: REPO_ROOT }, { CREWLY_CONTROL_PLANE_GUARD: '0' });
			expect(r).toEqual({ enabled: false, reason: 'CREWLY_CONTROL_PLANE_GUARD=0' });
			expect(existsSync(path.join(home, 'runtime'))).toBe(false);
		});

		it('end to end: the generated hook command blocks a team-config write and allows a read', async () => {
			const r = await prepareControlPlaneGuard('e2e', { crewlyHome: home, installRoot: REPO_ROOT }, {});
			if (!r.enabled) throw new Error('expected enabled');
			const cfg = path.join(home, 'teams', 't1', 'config.json');
			mkdirSync(path.dirname(cfg), { recursive: true });
			writeFileSync(cfg, '{}\n');
			const hookCommand = JSON.parse(readFileSync(r.settingsPath, 'utf-8')).hooks.PreToolUse[0].hooks[0].command as string;
			const run = (command: string) =>
				spawnSync('bash', ['-c', hookCommand], {
					input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: REPO_ROOT }),
					encoding: 'utf-8',
				});

			const write = run(`echo x > ${cfg}`);
			expect(write.status).toBe(2);
			expect(write.stderr).toContain(`checked ${r.protectedCount} protected path(s)`);

			const read = run(`cat ${cfg}`);
			expect(read.status).toBe(0);
			expect(read.stdout).toContain(`${r.protectedCount} protected path(s) checked`);

			const stopSkill = run('echo "exit 0" > config/skills/orchestrator/stop-agent/execute.sh');
			expect(stopSkill.status).toBe(2);
		});
	});

	describe('applyControlPlaneSettingsFlag', () => {
		it('appends --settings to the Claude agent launch line', () => {
			expect(applyControlPlaneSettingsFlag('claude --dangerously-skip-permissions', '/h/s.json')).toBe(
				'claude --dangerously-skip-permissions --settings "/h/s.json"',
			);
		});

		it('leaves a command without --dangerously-skip-permissions alone', () => {
			expect(applyControlPlaneSettingsFlag('claude', '/h/s.json')).toBe('claude');
		});

		it('does not add a second --settings', () => {
			const cmd = 'claude --dangerously-skip-permissions --settings /mine.json';
			expect(applyControlPlaneSettingsFlag(cmd, '/h/s.json')).toBe(cmd);
			const eq = 'claude --dangerously-skip-permissions --settings=/mine.json';
			expect(applyControlPlaneSettingsFlag(eq, '/h/s.json')).toBe(eq);
		});

		it('is not fooled by a similar flag name', () => {
			expect(applyControlPlaneSettingsFlag('claude --dangerously-skip-permissions --settings-foo x', '/h/s.json')).toContain(
				'--settings "/h/s.json"',
			);
		});

		it('strips shell metacharacters from the path', () => {
			expect(applyControlPlaneSettingsFlag('claude --dangerously-skip-permissions', '/h/$(x)`y`.json')).toBe(
				'claude --dangerously-skip-permissions --settings "/h/(x)y.json"',
			);
		});
	});
});
