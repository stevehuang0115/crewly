import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Tests for the control-plane guard's PreToolUse Bash hook
 * (Request 72c9427a, specs/2026-09-24-control-plane-isolation.md Part 3).
 *
 * Each test runs the real script and pipes a Claude Code PreToolUse JSON
 * payload on stdin, as Claude Code does. The fixture is a throwaway HOME and
 * install root, so nothing touches the real ~/.crewly.
 *
 * Exit contract: 0 allowed, 2 blocked (Claude Code feeds stderr back to the
 * agent), 1 nothing could be checked (non-blocking error, never a silent pass).
 */

const HOOK = join(__dirname, 'pretooluse-bash.sh');

let home: string;
let install: string;
let pathsFile: string;
let teamsDir: string;
let teamConfig: string;
let stopAgentDir: string;
let stopAgentScript: string;

interface HookRun {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run the hook with a PreToolUse payload on stdin.
 *
 * @param command - Bash command the agent is about to run
 * @param opts - Optional cwd, tool name, and paths-file override
 * @returns Exit status and captured output
 */
function runHook(command: string, opts: { cwd?: string; tool?: string; paths?: string } = {}): HookRun {
	const payload = {
		session_id: 'test',
		hook_event_name: 'PreToolUse',
		tool_name: opts.tool ?? 'Bash',
		tool_input: { command },
		cwd: opts.cwd ?? install,
	};
	const r = spawnSync('bash', [HOOK, opts.paths ?? pathsFile], {
		input: JSON.stringify(payload),
		encoding: 'utf-8',
		env: { ...process.env, HOME: home },
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'cpg-home-'));
	install = mkdtempSync(join(tmpdir(), 'cpg-install-'));
	teamsDir = join(home, '.crewly', 'teams');
	teamConfig = join(teamsDir, 'team-0001', 'config.json');
	stopAgentDir = join(install, 'config', 'skills', 'orchestrator', 'stop-agent');
	stopAgentScript = join(stopAgentDir, 'execute.sh');
	mkdirSync(join(teamsDir, 'team-0001'), { recursive: true });
	mkdirSync(stopAgentDir, { recursive: true });
	writeFileSync(teamConfig, '{"members":[]}\n');
	writeFileSync(stopAgentScript, '#!/bin/bash\n');
	pathsFile = join(home, 'paths');
	writeFileSync(pathsFile, ['# protected', teamsDir, stopAgentDir, join(home, '.crewly', 'api-token'), ''].join('\n'));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(install, { recursive: true, force: true });
});

describe('control-plane guard hook — the four required cases', () => {
	it('blocks a write to the team config (absolute path)', () => {
		const r = runHook(`echo '{}' > ${teamConfig}`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`BLOCKED — matched redirection '>' onto it: ${teamsDir}`);
		expect(r.stderr).toContain('checked 3 protected path(s)');
	});

	it('blocks a write to stop-agent/execute.sh (cwd-relative path)', () => {
		const r = runHook('echo "exit 0" >> config/skills/orchestrator/stop-agent/execute.sh');
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`BLOCKED — matched redirection '>' onto it: ${stopAgentDir}`);
		expect(r.stderr).toContain('checked 3 protected path(s)');
	});

	it('allows a cat of the team config', () => {
		const r = runHook(`cat ${teamConfig}`);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('allowed — no write to a protected path matched; 3 protected path(s) checked');
	});

	it('allows an unrelated write', () => {
		const r = runHook(`echo hello > ${join(install, 'notes.txt')}`);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('3 protected path(s) checked');
	});
});

describe('control-plane guard hook — write forms that are blocked', () => {
	const cases: Array<[string, () => string, string]> = [
		['~ form', () => 'echo x > ~/.crewly/teams/team-0001/config.json', "redirection '>'"],
		['$HOME form', () => 'echo x > $HOME/.crewly/teams/team-0001/config.json', "redirection '>'"],
		['${HOME} form, quoted', () => 'echo x > "${HOME}/.crewly/teams/team-0001/config.json"', "redirection '>'"],
		['redirection with stderr redirect after it', () => `echo x > ${teamConfig} 2>/dev/null`, "redirection '>'"],
		['sed -i', () => `sed -i '' 's/a/b/' ${teamConfig}`, "'sed -i' (in-place edit)"],
		['perl -pi -e', () => `perl -pi -e 's/a/b/' ${teamConfig}`, "'perl -i' (in-place edit)"],
		['tee', () => `echo x | tee ${teamConfig}`, "'tee' on it"],
		['tee -a', () => `echo x | tee -a ${teamConfig}`, "'tee' on it"],
		['mv onto', () => `mv /tmp/x ${teamConfig}`, "'mv' on it"],
		['mv away', () => `mv ${teamConfig} /tmp/x`, "'mv' on it"],
		['rm', () => `rm -f ${teamConfig}`, "'rm' on it"],
		['rm -rf the directory', () => `rm -rf ${teamsDir}`, "'rm' on it"],
		['chmod', () => 'chmod -x config/skills/orchestrator/stop-agent/execute.sh', "'chmod' on it"],
		['truncate', () => `truncate -s 0 ${teamConfig}`, "'truncate' on it"],
		['cp onto (destination)', () => 'cp /tmp/evil.sh ./config/skills/orchestrator/stop-agent/execute.sh', "'cp' with it as the destination"],
		['dd of=', () => `dd if=/dev/null of=${teamConfig}`, "'dd of=' onto it"],
		['git checkout', () => 'git checkout HEAD -- config/skills/orchestrator/stop-agent/execute.sh', "'git checkout' on it"],
		['sudo prefix', () => `sudo rm ${teamConfig}`, "'rm' on it"],
		['write after a read in the same line', () => `cat ${teamConfig} && echo x > ${teamConfig}`, "redirection '>'"],
		['backgrounded write', () => `sleep 1 & echo x > ${teamConfig}`, "redirection '>'"],
	];

	it.each(cases)('blocks: %s', (_label, cmd, rule) => {
		const r = runHook(cmd());
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(rule);
		expect(r.stderr).toContain('checked 3 protected path(s)');
	});
});

describe('control-plane guard hook — reads that stay allowed', () => {
	const cases: Array<[string, () => string]> = [
		['jq', () => `jq '.members' ${teamConfig}`],
		['grep', () => `grep -rn member ${teamsDir}`],
		['ls', () => `ls -la ~/.crewly/teams`],
		['head', () => 'head -5 config/skills/orchestrator/stop-agent/execute.sh'],
		['cat piped with 2>&1', () => `cat ${teamConfig} | jq . 2>&1`],
		['cat redirected elsewhere', () => `cat ${teamConfig} > /tmp/copy.json`],
		['cp FROM the config', () => `cp ${teamConfig} /tmp/copy.json`],
		['sed without -i', () => `sed -n '1p' ${teamConfig}`],
		['bash running the stop skill', () => `bash config/skills/orchestrator/stop-agent/execute.sh '{"sessionName":"x"}'`],
		['git diff of the skill', () => 'git diff -- config/skills/orchestrator/stop-agent/execute.sh'],
	];

	it.each(cases)('allows: %s', (_label, cmd) => {
		const r = runHook(cmd());
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('3 protected path(s) checked');
	});

	it('does not confuse a sibling whose name only shares a prefix', () => {
		const r = runHook(`echo x > ${teamsDir}-backup/config.json`);
		expect(r.status).toBe(0);
	});
});

describe('control-plane guard hook — reports what it examined', () => {
	it('refuses to call a command safe when the paths file is missing (exit 1, not 0)', () => {
		const r = runHook(`echo x > ${teamConfig}`, { paths: join(home, 'does-not-exist') });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('NO PATHS CHECKED');
	});

	it('refuses to call a command safe when the paths file has only comments', () => {
		const empty = join(home, 'empty-paths');
		writeFileSync(empty, '# nothing\n\n');
		const r = runHook('echo hi', { paths: empty });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('NO PATHS CHECKED');
	});

	it('ignores non-Bash tools and says so', () => {
		const r = runHook('', { tool: 'Edit' });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('not a Bash call (Edit)');
	});

	it('names the rule, the path and the segment when it blocks', () => {
		const r = runHook(`ls && rm ${teamConfig}`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`'rm' on it: ${teamsDir}`);
		expect(r.stderr).toContain(`command segment:  rm ${teamConfig}`);
		expect(r.stderr).toContain('routine operations');
	});
});
