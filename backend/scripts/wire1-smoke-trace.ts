/**
 * F-CYCLE7-2 — WIRE-1 smoke trace
 *
 * Re-runs the smoke harness from the project root (per audit cycle 7 §2.2,
 * which found a stale harness at `/private/tmp/crewly-leo-fix6/...` that has
 * since been cleaned). Loads a real team config from `~/.crewly/teams/<id>/
 * config.json`, picks a member, builds the canonical ModuleConfig via
 * `buildModuleConfigFromTeamMember`, then renders the role-boundary module
 * to prove that:
 *
 *   1. `deriveOrgRole(member, team)` resolves a concrete orgRole.
 *   2. `RoleBoundaryModule.build(config)` does NOT throw the V4 error
 *      (`canDelegate=true but orgRole is undefined`).
 *   3. The first 5–10 lines of the rendered boundary match the resolved role.
 *
 * Usage (from project root):
 *   npx tsx backend/scripts/wire1-smoke-trace.ts \
 *     --team 28a4ac10-f37f-4286-ad8c-6926a0e177f5 \
 *     --session crewly-product-sam-9487fefe
 *
 * Defaults match the audit reference (Crewly Product team, Sam TL).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildModuleConfigFromTeamMember,
	deriveOrgRole,
	type SessionRuntimeContext,
} from '../src/services/ai/prompt-builder.service.js';
import { RoleBoundaryModule } from '../src/services/ai/prompt-modules/role-boundary.module.js';
import type { Team, TeamMember } from '../src/types/index.js';

interface CliArgs {
	teamId: string;
	sessionName: string;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		teamId: '28a4ac10-f37f-4286-ad8c-6926a0e177f5',
		sessionName: 'crewly-product-sam-9487fefe',
	};
	for (let i = 2; i < argv.length; i++) {
		const flag = argv[i];
		const next = argv[i + 1];
		if (flag === '--team' && next) {
			args.teamId = next;
			i++;
		} else if (flag === '--session' && next) {
			args.sessionName = next;
			i++;
		}
	}
	return args;
}

function loadTeam(teamId: string): Team {
	const teamConfigPath = path.join(os.homedir(), '.crewly', 'teams', teamId, 'config.json');
	if (!fs.existsSync(teamConfigPath)) {
		throw new Error(`Team config not found at ${teamConfigPath}`);
	}
	return JSON.parse(fs.readFileSync(teamConfigPath, 'utf-8')) as Team;
}

async function main() {
	const args = parseArgs(process.argv);
	const projectRoot = path.resolve(__dirname, '..', '..');

	const team = loadTeam(args.teamId);
	const member = (team.members ?? []).find(
		(m: TeamMember) => m.sessionName === args.sessionName,
	);
	if (!member) {
		throw new Error(
			`Member with sessionName=${args.sessionName} not found in team ${args.teamId}`,
		);
	}

	console.log('='.repeat(72));
	console.log('F-CYCLE7-2 — WIRE-1 smoke trace (from project root)');
	console.log('='.repeat(72));
	console.log(`projectRoot:      ${projectRoot}`);
	console.log(`team.id:          ${team.id}`);
	console.log(`team.name:        ${team.name}`);
	console.log(`member.id:        ${member.id}`);
	console.log(`member.name:      ${member.name}`);
	console.log(`member.role:      ${member.role}`);
	console.log(`member.session:   ${member.sessionName}`);
	console.log(`member.canDelegate: ${member.canDelegate}`);
	console.log(`member.subordinateIds: ${JSON.stringify(member.subordinateIds ?? [])}`);
	console.log('-'.repeat(72));

	// (1) deriveOrgRole — pure function, must resolve to one of three roles
	const derived = deriveOrgRole(member, team);
	console.log(`deriveOrgRole():  ${derived}`);

	// (2) buildModuleConfigFromTeamMember — wires every autonomy/team field
	const runtime: SessionRuntimeContext = {
		sessionName: args.sessionName,
		projectPath: projectRoot,
		runtimeType: 'claude-code',
		agentSkillsPath: path.join(projectRoot, 'config', 'skills', 'agent'),
		tlSkillsPath: path.join(projectRoot, 'config', 'skills', 'team-leader'),
		projectRoot,
	};
	const config = buildModuleConfigFromTeamMember(member, team, runtime);
	console.log(`config.orgRole:   ${config.orgRole}`);
	console.log(`config.canDelegate: ${config.canDelegate}`);
	console.log('-'.repeat(72));

	// (3) RoleBoundaryModule.build — must NOT throw; output must match orgRole
	const moduleInstance = new RoleBoundaryModule();
	let output: string;
	try {
		output = await moduleInstance.build(config);
	} catch (err) {
		console.error('FAIL — RoleBoundaryModule.build threw:');
		console.error(err);
		process.exit(1);
	}

	console.log('RoleBoundaryModule.build() — first 10 lines of output:');
	const lines = output.split('\n').slice(0, 10);
	lines.forEach((line, idx) => {
		console.log(`  ${String(idx + 1).padStart(2, ' ')} | ${line}`);
	});
	console.log('-'.repeat(72));
	console.log(`output length:    ${output.length} chars`);
	console.log(`output lines:     ${output.split('\n').length}`);

	// (4) Sanity assertions — orgRole must match boundary content
	const expectedAnchor =
		config.orgRole === 'team-lead'
			? 'Objective owner'
			: config.orgRole === 'orchestrator'
				? 'User secretary'
				: 'Scoped implementer';
	if (!output.includes(expectedAnchor)) {
		console.error(
			`FAIL — expected anchor "${expectedAnchor}" for orgRole=${config.orgRole} not found.`,
		);
		process.exit(1);
	}
	console.log(`PASS — orgRole=${config.orgRole} → "${expectedAnchor}" anchor found in output.`);
	console.log('='.repeat(72));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
