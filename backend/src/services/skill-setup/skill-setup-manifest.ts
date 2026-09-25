/**
 * Skill setup manifest — the optional `setup` block of a skill's `skill.json`.
 *
 * It declares what a skill needs on the machine before it can run, so a
 * runner can install it without a human reading the README:
 *
 * - `command` — a program on PATH (or at a known path), installed per OS with
 *   Homebrew, apt-get, or a script shipped next to the skill.
 * - `file`    — a large file such as a model: URL + sha256 + size + where it goes.
 * - `python`  — packages installed into a Crewly-managed venv
 *   (`$CREWLY_HOME/venv/<name>`), probed by importing modules.
 *
 * The format is declarative on purpose: package names, paths and URLs are
 * validated here, so a registry entry cannot smuggle shell into a field that
 * is only meant to hold a package name. The two places that do run shell —
 * `check.shell` and `install.<os>.script` — are code shipped by the skill
 * itself, which is no more trusted than its `execute.sh` and goes through the
 * same trust rule (see skill-install-job.service).
 *
 * Spec: specs/skill-auto-install.md
 *
 * @module services/skill-setup/skill-setup-manifest
 */

/** Operating-system families a `command` step can carry install recipes for. */
export type OsFamily = 'darwin' | 'debian' | 'linux';

/** Every OS family, in manifest order. */
export const OS_FAMILIES: readonly OsFamily[] = ['darwin', 'debian', 'linux'];

/** How to install a command on one OS family. Exactly the listed methods run, in this order. */
export interface OsInstallRecipe {
	/** Homebrew formulae (`brew install …`) */
	brew?: string[];
	/** Homebrew casks (`brew install --cask …`) */
	brewCask?: string[];
	/** Debian/Ubuntu packages (`apt-get install -y …`, needs root or passwordless sudo) */
	apt?: string[];
	/** A bash script in the skill directory (file name only), run with `bash <skillDir>/<script>` */
	script?: string;
}

/** How to tell whether a command-type dependency is present. Any one match satisfies it. */
export interface CommandCheck {
	/** Bare command names looked up on PATH (plus Homebrew and `$CREWLY_HOME/bin`) */
	commands?: string[];
	/** Paths that satisfy the check when they exist and are executable (`~/` and `$CREWLY_HOME/` expand) */
	paths?: string[];
	/** A bash snippet; exit code 0 means satisfied */
	shell?: string;
}

/** Fields shared by every step. */
interface BaseStep {
	/** Unique id within the manifest (kebab-case), used in logs and progress */
	id: string;
	/** One line a person can read ("ffmpeg — decodes the audio") */
	description?: string;
	/** An optional step that fails does not fail the setup */
	optional?: boolean;
}

/** A program the skill runs. */
export interface CommandStep extends BaseStep {
	type: 'command';
	check: CommandCheck;
	install?: Partial<Record<OsFamily, OsInstallRecipe>>;
	/** Shown when there is no automatic install for this OS */
	manualHint?: string;
}

/** A file (typically a model) downloaded once and verified. */
export interface FileStep extends BaseStep {
	type: 'file';
	/** https URL */
	url: string;
	/** Lower-case hex sha256 of the file */
	sha256: string;
	/** Exact size in bytes */
	sizeBytes: number;
	/** Destination (`~/…` or `$CREWLY_HOME/…`) */
	dest: string;
	/** Other places where an existing copy also satisfies the step */
	alternatives?: string[];
}

/** Python packages in a Crewly-managed virtualenv. */
export interface PythonStep extends BaseStep {
	type: 'python';
	/** venv name under `$CREWLY_HOME/venv/` (defaults to the skill id) */
	venv?: string;
	/** pip requirement specifiers (`pypdf>=4`) */
	packages: string[];
	/** Module names whose import proves the packages are there */
	imports: string[];
}

/** One setup step. */
export type SkillSetupStep = CommandStep | FileStep | PythonStep;

/** The `setup` block of `skill.json`. */
export interface SkillSetupManifest {
	/** Rough minutes a first-time setup takes (quoted to the user) */
	estimatedMinutes?: number;
	/** Steps, performed in order */
	steps: SkillSetupStep[];
}

/** Outcome of {@link validateSetupManifest}. */
export interface SetupManifestValidation {
	valid: boolean;
	errors: string[];
	/** The manifest, typed, when valid */
	manifest?: SkillSetupManifest;
}

/** Step ids and venv names. */
const KEBAB_ID = /^[a-z0-9][a-z0-9-]*$/;
/** Homebrew formula / cask names (`whisper-cpp`, `python@3.12`, `homebrew/cask/foo`). */
const BREW_NAME = /^[a-z0-9][a-z0-9+._@/-]*$/;
/** Debian package names. */
const APT_NAME = /^[a-z0-9][a-z0-9+.-]*$/;
/** A script file directly inside the skill directory. */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sh$/;
/** Bare command names. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** pip requirement: name, optional extras, optional version constraints. */
const PIP_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?((==|>=|<=|~=|!=|<|>)[A-Za-z0-9.*+!-]+(,(==|>=|<=|~=|!=|<|>)[A-Za-z0-9.*+!-]+)*)?$/;
/** Python module path. */
const PY_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** Lower-case hex sha256. */
const SHA256_HEX = /^[a-f0-9]{64}$/;
/** Prefixes a file destination may start with. */
export const DEST_PREFIXES = ['~/', '$CREWLY_HOME/'] as const;
/** Upper bound on estimatedMinutes (anything larger is a typo). */
const MAX_ESTIMATED_MINUTES = 240;

/**
 * Whether a value is a plain object.
 *
 * @param v - Anything
 * @returns True for non-null, non-array objects
 */
function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a list of strings against a pattern.
 *
 * @param value - Candidate list
 * @param pattern - Each entry must match
 * @param where - Field path, for messages
 * @param errors - Collected errors (mutated)
 * @param required - Whether an empty/missing list is an error
 */
function checkStringList(value: unknown, pattern: RegExp, where: string, errors: string[], required = false): void {
	if (value === undefined) {
		if (required) errors.push(`${where} is required`);
		return;
	}
	if (!Array.isArray(value) || (required && value.length === 0)) {
		errors.push(`${where} must be a ${required ? 'non-empty ' : ''}array of strings`);
		return;
	}
	for (const entry of value) {
		if (typeof entry !== 'string' || !pattern.test(entry)) {
			errors.push(`${where}: invalid entry ${JSON.stringify(entry)}`);
		}
	}
}

/**
 * Validate a destination-style path (`~/…` or `$CREWLY_HOME/…`, no `..`).
 *
 * @param value - Candidate path
 * @param where - Field path
 * @param errors - Collected errors (mutated)
 */
function checkHomePath(value: unknown, where: string, errors: string[]): void {
	if (typeof value !== 'string' || !DEST_PREFIXES.some((p) => value.startsWith(p)) || value.split('/').includes('..')) {
		errors.push(`${where} must start with ${DEST_PREFIXES.join(' or ')} and must not contain ".." (got ${JSON.stringify(value)})`);
	}
}

/**
 * Validate a check path: absolute, `~/…` or `$CREWLY_HOME/…`, no `..`.
 *
 * @param value - Candidate path
 * @param where - Field path
 * @param errors - Collected errors (mutated)
 */
function checkProbePath(value: unknown, where: string, errors: string[]): void {
	const ok =
		typeof value === 'string' &&
		(value.startsWith('/') || DEST_PREFIXES.some((p) => value.startsWith(p))) &&
		!value.split('/').includes('..');
	if (!ok) errors.push(`${where} must be absolute, ~/… or $CREWLY_HOME/… without ".." (got ${JSON.stringify(value)})`);
}

/**
 * Validate one OS install recipe.
 *
 * @param recipe - Candidate recipe
 * @param where - Field path
 * @param errors - Collected errors (mutated)
 */
function checkRecipe(recipe: unknown, where: string, errors: string[]): void {
	if (!isObject(recipe)) {
		errors.push(`${where} must be an object`);
		return;
	}
	const allowed = ['brew', 'brewCask', 'apt', 'script'];
	for (const key of Object.keys(recipe)) {
		if (!allowed.includes(key)) errors.push(`${where}.${key} is not a known install method (${allowed.join(', ')})`);
	}
	checkStringList(recipe.brew, BREW_NAME, `${where}.brew`, errors);
	checkStringList(recipe.brewCask, BREW_NAME, `${where}.brewCask`, errors);
	checkStringList(recipe.apt, APT_NAME, `${where}.apt`, errors);
	if (recipe.script !== undefined && (typeof recipe.script !== 'string' || !SCRIPT_NAME.test(recipe.script))) {
		errors.push(`${where}.script must be a .sh file name in the skill directory (got ${JSON.stringify(recipe.script)})`);
	}
	if (recipe.brew === undefined && recipe.brewCask === undefined && recipe.apt === undefined && recipe.script === undefined) {
		errors.push(`${where} lists no install method`);
	}
}

/**
 * Validate one step.
 *
 * @param step - Candidate step
 * @param index - Position, for messages
 * @param errors - Collected errors (mutated)
 */
function checkStep(step: unknown, index: number, errors: string[]): void {
	const where = `setup.steps[${index}]`;
	if (!isObject(step)) {
		errors.push(`${where} must be an object`);
		return;
	}
	if (typeof step.id !== 'string' || !KEBAB_ID.test(step.id)) errors.push(`${where}.id must be kebab-case`);
	if (step.description !== undefined && typeof step.description !== 'string') errors.push(`${where}.description must be a string`);
	if (step.optional !== undefined && typeof step.optional !== 'boolean') errors.push(`${where}.optional must be a boolean`);

	switch (step.type) {
		case 'command': {
			if (!isObject(step.check)) {
				errors.push(`${where}.check is required`);
			} else {
				checkStringList(step.check.commands, COMMAND_NAME, `${where}.check.commands`, errors);
				if (step.check.paths !== undefined) {
					if (!Array.isArray(step.check.paths)) errors.push(`${where}.check.paths must be an array`);
					else step.check.paths.forEach((p, i) => checkProbePath(p, `${where}.check.paths[${i}]`, errors));
				}
				if (step.check.shell !== undefined && (typeof step.check.shell !== 'string' || step.check.shell.trim() === '')) {
					errors.push(`${where}.check.shell must be a non-empty string`);
				}
				if (step.check.commands === undefined && step.check.paths === undefined && step.check.shell === undefined) {
					errors.push(`${where}.check needs commands, paths or shell`);
				}
			}
			if (step.install !== undefined) {
				if (!isObject(step.install)) {
					errors.push(`${where}.install must be an object keyed by OS (${OS_FAMILIES.join(', ')})`);
				} else {
					for (const [os, recipe] of Object.entries(step.install)) {
						if (!(OS_FAMILIES as readonly string[]).includes(os)) errors.push(`${where}.install.${os} is not a known OS (${OS_FAMILIES.join(', ')})`);
						else checkRecipe(recipe, `${where}.install.${os}`, errors);
					}
				}
			}
			if (step.manualHint !== undefined && typeof step.manualHint !== 'string') errors.push(`${where}.manualHint must be a string`);
			break;
		}
		case 'file': {
			if (typeof step.url !== 'string' || !/^https:\/\/[^\s]+$/.test(step.url)) errors.push(`${where}.url must be an https URL`);
			if (typeof step.sha256 !== 'string' || !SHA256_HEX.test(step.sha256)) errors.push(`${where}.sha256 must be 64 lower-case hex characters`);
			if (typeof step.sizeBytes !== 'number' || !Number.isInteger(step.sizeBytes) || step.sizeBytes <= 0) {
				errors.push(`${where}.sizeBytes must be a positive integer`);
			}
			checkHomePath(step.dest, `${where}.dest`, errors);
			if (step.alternatives !== undefined) {
				if (!Array.isArray(step.alternatives)) errors.push(`${where}.alternatives must be an array`);
				else step.alternatives.forEach((p, i) => checkHomePath(p, `${where}.alternatives[${i}]`, errors));
			}
			break;
		}
		case 'python': {
			if (step.venv !== undefined && (typeof step.venv !== 'string' || !KEBAB_ID.test(step.venv))) errors.push(`${where}.venv must be kebab-case`);
			checkStringList(step.packages, PIP_SPEC, `${where}.packages`, errors, true);
			checkStringList(step.imports, PY_MODULE, `${where}.imports`, errors, true);
			break;
		}
		default:
			errors.push(`${where}.type must be one of command, file, python (got ${JSON.stringify(step.type)})`);
	}
}

/**
 * Validate a `setup` block.
 *
 * @param value - The parsed `setup` value from skill.json (or a registry entry)
 * @returns `{ valid, errors, manifest }`; `manifest` is set only when valid
 *
 * @example
 * ```ts
 * const { valid, errors } = validateSetupManifest(skillJson.setup);
 * if (!valid) throw new Error(errors.join('; '));
 * ```
 */
export function validateSetupManifest(value: unknown): SetupManifestValidation {
	const errors: string[] = [];
	if (!isObject(value)) return { valid: false, errors: ['setup must be an object'] };
	for (const key of Object.keys(value)) {
		if (key !== 'steps' && key !== 'estimatedMinutes') errors.push(`setup.${key} is not a known field`);
	}
	if (value.estimatedMinutes !== undefined) {
		const m = value.estimatedMinutes;
		if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > MAX_ESTIMATED_MINUTES) {
			errors.push(`setup.estimatedMinutes must be a number between 0 and ${MAX_ESTIMATED_MINUTES}`);
		}
	}
	if (!Array.isArray(value.steps) || value.steps.length === 0) {
		errors.push('setup.steps must be a non-empty array');
	} else {
		value.steps.forEach((step, i) => checkStep(step, i, errors));
		const ids = value.steps.map((s) => (isObject(s) ? s.id : undefined)).filter((id): id is string => typeof id === 'string');
		const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
		if (dupes.length > 0) errors.push(`setup.steps ids must be unique (duplicated: ${[...new Set(dupes)].join(', ')})`);
	}
	return errors.length === 0 ? { valid: true, errors, manifest: value as unknown as SkillSetupManifest } : { valid: false, errors };
}

/**
 * The install recipes that apply to an OS family, most specific first.
 *
 * A Debian machine uses a `debian` recipe when there is one, else `linux`.
 *
 * @param family - Detected OS family
 * @returns Families to look up, in order
 */
export function recipeLookupOrder(family: OsFamily): OsFamily[] {
	return family === 'debian' ? ['debian', 'linux'] : [family];
}

/**
 * The recipe a command step uses on an OS family.
 *
 * @param step - Command step
 * @param family - Detected OS family
 * @returns The recipe, or undefined when the step has none for this OS
 */
export function recipeFor(step: CommandStep, family: OsFamily): OsInstallRecipe | undefined {
	for (const f of recipeLookupOrder(family)) {
		const recipe = step.install?.[f];
		if (recipe) return recipe;
	}
	return undefined;
}
