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
import { CONTROL_PLANE_GUARD_CONSTANTS, AGENT_STATUS_HOOK_CONSTANTS, SUBAGENT_GUARD_CONSTANTS } from '../../constants.js';

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
		const { writeDenied, readDenied } = resolveControlPlanePaths(roots, ['team-a', 'team-b']);
		const byPath = new Map(writeDenied.map((p) => [p.path, p.isDirectory]));

		it.each([
			['/h/.crewly/teams/team-a/config.json', false],
			['/h/.crewly/teams/team-b/config.json', false],
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

		// WorkItem 70e54fbc / #798 review: the whole `teams/` subtree used to be
		// write-denied, which also blocked norms/wiki/prompts/sops/cron-tasks.json
		// — files agents write routinely. The guard now protects only each
		// existing team's own config.json (spec Part 2: `teams/*/config.json`).
		it('does NOT protect the teams directory itself, only each team config.json', () => {
			expect(byPath.has('/h/.crewly/teams')).toBe(false);
		});

		it('does not protect a team not passed in (out of scope for this session — documented limit)', () => {
			expect(byPath.has('/h/.crewly/teams/team-c/config.json')).toBe(false);
		});

		it('protects nothing under teams/ when no team ids are given', () => {
			const r = resolveControlPlanePaths({ crewlyHome: '/h/.crewly', installRoot: '/opt/crewly' });
			expect(r.writeDenied.some((p) => p.path.includes(`${path.sep}teams${path.sep}`))).toBe(false);
			expect(r.writeDenied.some((p) => p.path.endsWith(`${path.sep}teams`))).toBe(false);
		});
	});

	describe('toRuleSpecifier', () => {
		it('uses // for an absolute path (a single / is settings-relative in Claude Code)', () => {
			expect(toRuleSpecifier('/h/.crewly/api-token', false)).toBe('//h/.crewly/api-token');
		});

		it('adds /** for a directory', () => {
			expect(toRuleSpecifier('/h/.crewly/triggers', true)).toBe('//h/.crewly/triggers/**');
		});
	});

	describe('buildControlPlaneSettings', () => {
		const settings = buildControlPlaneSettings(resolveControlPlanePaths(roots, ['team-a']), 'bash hook.sh paths');

		it('denies Edit on each team config.json (not the whole teams subtree) and the stop-agent skill', () => {
			expect(settings.permissions.deny).toContain('Edit(//h/.crewly/teams/team-a/config.json)');
			expect(settings.permissions.deny).not.toContain('Edit(//h/.crewly/teams/**)');
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

		it('turns Claude Code prompt suggestions off (2026-10-03 phantom owner input)', () => {
			// A faint predicted user message in an empty input, accepted by Tab,
			// was once submitted as the owner's approval.
			expect(settings.promptSuggestionEnabled).toBe(false);
		});

		it('attaches the hook to PreToolUse for Bash', () => {
			expect(settings.hooks.PreToolUse).toEqual([
				{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash hook.sh paths' }] },
			]);
		});
	});

	describe('buildControlPlaneSettings with the agent-status hook (#815)', () => {
		const paths = resolveControlPlanePaths(roots);
		const guardOnly = buildControlPlaneSettings(paths, 'bash hook.sh paths');
		const merged = buildControlPlaneSettings(paths, 'bash hook.sh paths', 'bash status.sh');

		it('leaves the guard untouched: deny list identical, guard group first and unchanged on PreToolUse', () => {
			expect(JSON.stringify(merged.permissions)).toBe(JSON.stringify(guardOnly.permissions));
			expect(JSON.stringify(merged.hooks.PreToolUse[0])).toBe(JSON.stringify(guardOnly.hooks.PreToolUse[0]));
			// The status hook rides along as a second, all-tools group (runtime turn state).
			expect(merged.hooks.PreToolUse).toEqual([
				guardOnly.hooks.PreToolUse[0],
				{ matcher: '*', hooks: [{ type: 'command', command: 'bash status.sh' }] },
			]);
		});

		it('registers the status hook on exactly its own events, all tools for tool events', () => {
			const statusEvents = Object.keys(merged.hooks).sort();
			expect(statusEvents).toEqual([...AGENT_STATUS_HOOK_CONSTANTS.EVENTS].sort());
			expect(merged.hooks.PermissionRequest).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: 'bash status.sh' }] }]);
			expect(merged.hooks.PostToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: 'bash status.sh' }] }]);
			expect(merged.hooks.Notification).toEqual([{ hooks: [{ type: 'command', command: 'bash status.sh' }] }]);
		});

		it('adds no status events when no status hook is given', () => {
			expect(Object.keys(guardOnly.hooks)).toEqual(['PreToolUse']);
		});

		it('write-protects the status hook directory', () => {
			expect(paths.writeDenied).toContainEqual({ path: '/opt/crewly/config/hooks/agent-status', isDirectory: true });
			expect(merged.permissions.deny).toContain('Edit(//opt/crewly/config/hooks/agent-status/**)');
		});
	});

	describe('buildControlPlaneSettings with the subagent guard (#852)', () => {
		const paths = resolveControlPlanePaths(roots);
		const withStatus = buildControlPlaneSettings(paths, 'bash hook.sh paths', 'bash status.sh');
		const withBoth = buildControlPlaneSettings(paths, 'bash hook.sh paths', 'bash status.sh', 'bash subagent.sh');

		it('registers the subagent guard on SubagentStart and SubagentStop, next to the status hook', () => {
			const status = { hooks: [{ type: 'command', command: 'bash status.sh' }] };
			const guard = { hooks: [{ type: 'command', command: 'bash subagent.sh' }] };
			expect(withBoth.hooks.SubagentStart).toEqual([guard, status]);
			expect(withBoth.hooks.SubagentStop).toEqual([guard, status]);
			const guardOnly = buildControlPlaneSettings(paths, 'bash hook.sh paths', undefined, 'bash subagent.sh');
			expect(Object.keys(guardOnly.hooks).filter((e) => e !== 'PreToolUse').sort()).toEqual([...SUBAGENT_GUARD_CONSTANTS.EVENTS].sort());
		});

		it('leaves the guard and the status hook untouched on every other event', () => {
			for (const event of Object.keys(withStatus.hooks)) {
				if ((SUBAGENT_GUARD_CONSTANTS.EVENTS as readonly string[]).includes(event)) continue;
				expect(JSON.stringify(withBoth.hooks[event])).toBe(JSON.stringify(withStatus.hooks[event]));
			}
			expect(JSON.stringify(withBoth.permissions)).toBe(JSON.stringify(withStatus.permissions));
		});

		it('write-protects the subagent guard directory', () => {
			expect(paths.writeDenied).toContainEqual({ path: '/opt/crewly/config/hooks/subagent-guard', isDirectory: true });
			expect(withBoth.permissions.deny).toContain('Edit(//opt/crewly/config/hooks/subagent-guard/**)');
		});
	});

	describe('buildControlPlaneSettings with the credential guard (specs/2026-10-04-agent-credential-isolation.md)', () => {
		const paths = resolveControlPlanePaths(roots);
		const without = buildControlPlaneSettings(paths, 'bash hook.sh paths', 'bash status.sh');
		const withCred = buildControlPlaneSettings(paths, 'bash hook.sh paths', 'bash status.sh', undefined, {
			hookCommand: "bash '/h/.crewly/runtime/credential-guard/hook-claude.sh'",
			matcher: 'Bash|Read|Grep|Glob|NotebookRead',
			denyRules: ['Read(//h/.crewly/cloud)', 'Read(//h/.crewly/cloud/**)', 'Read(//h/.crewly/api-token)'],
		});

		it('adds its PreToolUse group right after the control-plane group, before the status hook', () => {
			expect(withCred.hooks.PreToolUse[0]).toEqual(without.hooks.PreToolUse[0]);
			expect(withCred.hooks.PreToolUse[1]).toEqual({
				matcher: 'Bash|Read|Grep|Glob|NotebookRead',
				hooks: [{ type: 'command', command: "bash '/h/.crewly/runtime/credential-guard/hook-claude.sh'" }],
			});
			expect(withCred.hooks.PreToolUse.slice(2)).toEqual(without.hooks.PreToolUse.slice(1));
		});

		it('adds its Read deny rules once (the API token rule is not duplicated)', () => {
			expect(withCred.permissions.deny).toContain('Read(//h/.crewly/cloud/**)');
			expect(withCred.permissions.deny.filter((r) => r === 'Read(//h/.crewly/api-token)')).toHaveLength(1);
			for (const rule of withCred.permissions.deny) expect(rule).toMatch(/^(Edit|Read)\(\/\/[^()]+\)$/);
		});

		it('write-protects its own runtime directory (paths file and wrappers)', () => {
			expect(paths.writeDenied).toContainEqual({ path: '/h/.crewly/runtime/credential-guard', isDirectory: true });
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
			const teamDir = path.join(home, 'teams', 'team-a');
			mkdirSync(teamDir, { recursive: true });
			writeFileSync(path.join(teamDir, 'config.json'), '{}\n');
			const r = await prepareControlPlaneGuard('crewly-dev-001', { crewlyHome: home, installRoot: REPO_ROOT }, {});
			expect(r.enabled).toBe(true);
			if (!r.enabled) return;
			expect(r.settingsPath).toBe(path.join(home, 'runtime', 'control-plane', 'crewly-dev-001.settings.json'));
			const settings = JSON.parse(readFileSync(r.settingsPath, 'utf-8')) as ControlPlaneSettings;
			expect(settings.permissions.deny).toContain(`Edit(/${path.join(teamDir, 'config.json')})`);
			expect(settings.permissions.deny).not.toContain(`Edit(/${path.join(home, 'teams')}/**)`);
			expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
				`bash '${path.join(REPO_ROOT, CONTROL_PLANE_GUARD_CONSTANTS.HOOK_SCRIPT)}' '${r.pathsPath}'`,
			);
			const listed = readFileSync(r.pathsPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'));
			expect(listed.length).toBe(r.protectedCount);
			expect(listed).toContain(path.join(teamDir, 'config.json'));
			expect(listed).not.toContain(path.join(home, 'teams'));
		});

		it('protects nothing under teams/ when the directory does not exist yet (fresh install)', async () => {
			const r = await prepareControlPlaneGuard('crewly-dev-002', { crewlyHome: home, installRoot: REPO_ROOT }, {});
			expect(r.enabled).toBe(true);
			if (!r.enabled) return;
			const listed = readFileSync(r.pathsPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'));
			expect(listed.some((l) => l.includes(`${path.sep}teams${path.sep}`))).toBe(false);
		});

		it('writes the agent-status hook into the same settings file (one --settings), pointing at the real script', async () => {
			const r = await prepareControlPlaneGuard('st1', { crewlyHome: home, installRoot: REPO_ROOT }, {});
			if (!r.enabled) throw new Error('expected enabled');
			const settings = JSON.parse(readFileSync(r.settingsPath, 'utf-8')) as ControlPlaneSettings;
			const script = path.join(REPO_ROOT, AGENT_STATUS_HOOK_CONSTANTS.HOOK_SCRIPT);
			expect(existsSync(script)).toBe(true);
			expect(settings.hooks.Notification[0].hooks[0].command).toBe(`bash '${script}'`);
			// Guard first, then the status hook for every tool (runtime turn state).
			expect(settings.hooks.PreToolUse).toHaveLength(2);
			expect(settings.hooks.PreToolUse[1]).toEqual({ matcher: '*', hooks: [{ type: 'command', command: `bash '${script}'` }] });
		});

		it('writes the subagent guard into the same settings file, pointing at the real script (#852)', async () => {
			const r = await prepareControlPlaneGuard('sg1', { crewlyHome: home, installRoot: REPO_ROOT }, {});
			if (!r.enabled) throw new Error('expected enabled');
			const settings = JSON.parse(readFileSync(r.settingsPath, 'utf-8')) as ControlPlaneSettings;
			const script = path.join(REPO_ROOT, SUBAGENT_GUARD_CONSTANTS.HOOK_SCRIPT);
			expect(existsSync(script)).toBe(true);
			expect(settings.hooks.SubagentStart[0].hooks[0].command).toBe(`bash '${script}'`);
			expect(settings.hooks.SubagentStop[0].hooks[0].command).toBe(`bash '${script}'`);
		});

		it('leaves the subagent guard out when its kill switch is 0, keeping the rest', async () => {
			const r = await prepareControlPlaneGuard('sg2', { crewlyHome: home, installRoot: REPO_ROOT }, { CREWLY_SUBAGENT_GUARD: '0' });
			if (!r.enabled) throw new Error('expected enabled');
			const settings = JSON.parse(readFileSync(r.settingsPath, 'utf-8')) as ControlPlaneSettings;
			// Only the status hook remains on the subagent events.
			for (const event of ['SubagentStart', 'SubagentStop']) {
				expect(JSON.stringify(settings.hooks[event])).not.toContain('subagent.sh');
				expect(settings.hooks[event]).toHaveLength(1);
			}
			expect(settings.hooks.PreToolUse).toHaveLength(2);
			expect(settings.hooks.Notification).toBeDefined();
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

		it('end to end: the generated hook command blocks a team-config write, allows a read, and allows writes elsewhere in the team dir', async () => {
			const teamDir = path.join(home, 'teams', 't1');
			const cfg = path.join(teamDir, 'config.json');
			mkdirSync(teamDir, { recursive: true });
			writeFileSync(cfg, '{}\n');
			const r = await prepareControlPlaneGuard('e2e', { crewlyHome: home, installRoot: REPO_ROOT }, {});
			if (!r.enabled) throw new Error('expected enabled');
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

			// WorkItem 70e54fbc: this used to be blocked too, when the whole
			// `teams/` subtree was write-denied. `remember`/`record-learning`
			// write exactly this kind of file.
			const wikiWrite = run(`echo x > ${path.join(teamDir, 'wiki', 'note.md')}`);
			expect(wikiWrite.status).toBe(0);
			const cronWrite = run(`echo x > ${path.join(teamDir, 'cron-tasks.json')}`);
			expect(cronWrite.status).toBe(0);
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
