/**
 * Static coverage test: every skill invocation advertised in a role prompt or
 * fragment must point at a skill directory that actually exists.
 *
 * Server-install finding 12: the orchestrator prompt told the orc to run
 * `{{ORCHESTRATOR_SKILLS_PATH}}/recall/execute.sh`, but `recall` lives under
 * `config/skills/agent/core/`. The orc printed an `ls` error on every cold
 * start, guessed, and carried on. This scan catches the next drift at test
 * time instead of in the orc's first turn.
 *
 * Mirrors the static-scan pattern of `operating-principles-role-coverage.test.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

/** Repo root — this file lives five directories below it. */
const REPO_ROOT = resolve(__dirname, '../../../../..');
const ROLES_DIR = join(REPO_ROOT, 'config', 'roles');
const SKILLS_DIR = join(REPO_ROOT, 'config', 'skills');

/** Placeholder → on-disk skills root it resolves to. */
const PLACEHOLDER_ROOTS: Record<string, string> = {
	ORCHESTRATOR_SKILLS_PATH: join(SKILLS_DIR, 'orchestrator'),
	AGENT_SKILLS_PATH: join(SKILLS_DIR, 'agent'),
	TL_SKILLS_PATH: join(SKILLS_DIR, 'team-leader'),
};

/** `{{PLACEHOLDER}}/<segments...>/execute.sh` */
const SKILL_INVOCATION = /\{\{(ORCHESTRATOR_SKILLS_PATH|AGENT_SKILLS_PATH|TL_SKILLS_PATH)\}\}\/([A-Za-z0-9_./-]+?)\/execute\.sh/g;

/** Recursively list every .md file under a directory. */
function listMarkdownFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...listMarkdownFiles(full));
		else if (name.endsWith('.md')) out.push(full);
	}
	return out;
}

/** One advertised invocation. */
interface Reference {
	file: string;
	placeholder: string;
	skillPath: string;
	resolved: string;
}

/** Collect every skill invocation from every role markdown file. */
function collectReferences(): Reference[] {
	const refs: Reference[] = [];
	for (const file of listMarkdownFiles(ROLES_DIR)) {
		const content = readFileSync(file, 'utf-8');
		for (const match of content.matchAll(SKILL_INVOCATION)) {
			const [, placeholder, skillPath] = match;
			refs.push({
				file: file.slice(REPO_ROOT.length + 1),
				placeholder,
				skillPath,
				resolved: join(PLACEHOLDER_ROOTS[placeholder], skillPath),
			});
		}
	}
	return refs;
}

describe('Role prompts advertise only skill paths that exist (finding 12)', () => {
	const refs = collectReferences();

	it('finds skill invocations to check', () => {
		expect(refs.length).toBeGreaterThan(20);
	});

	it('every {{*_SKILLS_PATH}}/<skill>/execute.sh reference resolves to an existing skill directory', () => {
		const missing = refs
			.filter((r) => !existsSync(r.resolved))
			.map((r) => `${r.file}: {{${r.placeholder}}}/${r.skillPath} → ${r.resolved.slice(REPO_ROOT.length + 1)} does not exist`);
		expect([...new Set(missing)]).toEqual([]);
	});

	it('memory skills are advertised under agent/core, never under the orchestrator namespace', () => {
		const wrong = refs.filter(
			(r) => r.placeholder === 'ORCHESTRATOR_SKILLS_PATH' && /^(recall|remember|record-learning)$/.test(r.skillPath),
		);
		expect(wrong.map((r) => `${r.file}: ${r.skillPath}`)).toEqual([]);
	});
});
