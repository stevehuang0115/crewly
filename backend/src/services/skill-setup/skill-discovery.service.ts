/**
 * Skill discovery — find a skill for a capability, locally or in the marketplace.
 *
 * Backs `find-skill` and `install-skill` (specs/skill-auto-install.md). It
 * merges three sources into one candidate list:
 *
 * 1. **Bundled** skills shipped in the npm package (`config/skills/agent/**`).
 *    They are present on every install, so `find-skill` works for them even
 *    when the registry has no entry or the network is down.
 * 2. **Installed** marketplace skills (`~/.crewly/marketplace/skills/<id>`).
 * 3. **Registry** entries (public GitHub registry + crewlyai.com), fetched
 *    with the existing marketplace service (cached, deduplicated).
 *
 * ## What "official" means
 *
 * A skill is official — and may be installed by an agent without asking — when
 * it is **bundled with Crewly**, or it is listed in an **official registry**
 * (the public GitHub registry or crewlyai.com, both curated by Crewly
 * maintainers) with `author` "Crewly Team" / "crewly" or `metadata.verified:
 * true`. Entries from the machine-local registry (`local-registry.json`,
 * written by local publishing) are never official, whatever author they claim.
 * A marketplace skill installed earlier counts as official only when the
 * registry still lists it as official.
 *
 * @module services/skill-setup/skill-discovery.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { SKILL_SETUP_CONSTANTS } from '../../constants.js';
import type { MarketplaceItem, MarketplaceRegistry, InstalledItemsManifest } from '../../types/marketplace.types.js';
import { findPackageRoot } from '../../utils/package-root.js';
import { parseSkillMd } from '../../utils/skill-md-parser.js';
import { fetchRegistry, getInstallPath, loadManifest } from '../marketplace/marketplace.service.js';
import { validateSetupManifest, type SkillSetupManifest } from './skill-setup-manifest.js';
import { getSkillSetupRunner, type SkillSetupRunner } from './skill-setup-runner.service.js';

/** Where a candidate was found. */
export type SkillSource = 'bundled' | 'installed' | 'registry';

/** Setup state reported for a candidate. */
export interface CandidateSetup {
	/** The skill declares a setup block */
	declared: boolean;
	/** Minutes a first-time setup takes (quoted to the user) */
	estimatedMinutes?: number;
	/** Result of a check-only probe (undefined when not probed) */
	satisfied?: boolean;
	/** Steps that are missing (check-only probe) */
	missing?: string[];
}

/** One skill that could provide a capability. */
export interface SkillCandidate {
	/** The id `install-skill --id` takes */
	id: string;
	name: string;
	description: string;
	tags: string[];
	triggers: string[];
	source: SkillSource;
	official: boolean;
	/** Why it is (or is not) official, in words */
	officialReason: string;
	author?: string;
	version?: string;
	/** The skill's files are on this machine */
	installed: boolean;
	/** Installed and its setup (if any) is satisfied — usable right now */
	ready?: boolean;
	/** Local skill directory */
	skillDir?: string;
	/** Local entry point (`<skillDir>/execute.sh`) */
	executePath?: string;
	/** Registry id when it differs from `id` */
	registryId?: string;
	setup: CandidateSetup;
	/** Ranking score (higher is better) */
	score: number;
}

/** A candidate plus the internals install-skill needs. */
export interface ResolvedSkill extends SkillCandidate {
	/** Parsed, validated setup manifest (local copy preferred, registry fallback) */
	manifest?: SkillSetupManifest;
	/** Setup block that failed validation (message) */
	manifestError?: string;
	/** The registry entry, when there is one */
	registryItem?: MarketplaceItem;
}

/** Injectable dependencies. */
export interface SkillDiscoveryDeps {
	/** Root of bundled agent skills (default: `<package>/config/skills/agent`) */
	bundledRoot?: string;
	/** Directory of marketplace-installed skills */
	installedRoot?: string;
	fetchRegistry?: () => Promise<MarketplaceRegistry>;
	loadManifest?: () => Promise<InstalledItemsManifest>;
	runner?: SkillSetupRunner;
}

/** Directories under the bundled root that are not skills or not shipped. */
const SKIP_DIRS = new Set(['_common', 'marketplace']);
/** Words that carry no capability meaning in a query. */
const STOPWORDS = new Set([
	'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'i', 'my', 'me', 'you', 'this', 'that', 'it', 'is', 'can', 'with',
	'from', 'in', 'on', 'into', 'file', 'files', 'please', 'need', 'want', 'how', 'do', 'skill', 'tool', 'some',
]);
/** Registry id prefixes older entries carry (`agent-send-pdf-to-slack`, `skill-nano-banana`). */
const REGISTRY_ID_PREFIXES = ['agent-', 'skill-'];

/** Local metadata read from a skill directory. */
interface LocalSkill {
	id: string;
	dirName: string;
	skillDir: string;
	name: string;
	description: string;
	tags: string[];
	triggers: string[];
	author?: string;
	version?: string;
	setupRaw?: unknown;
	source: 'bundled' | 'installed';
}

/**
 * Split a query into lower-case tokens, dropping stopwords.
 *
 * @param text - Free text
 * @returns Tokens (CJK runs stay whole)
 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}.+#-]+/u)
		.map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
		.filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Expand tokens with synonyms (QUERY_SYNONYMS). CJK tokens also match a
 * synonym key they contain ("语音消息" contains "语音").
 *
 * @param tokens - Query tokens
 * @returns Original tokens (weight 1) and synonyms (weight 0.6), deduplicated
 */
export function expandTokens(tokens: string[]): Array<{ token: string; weight: number }> {
	const out = new Map<string, number>();
	for (const t of tokens) out.set(t, 1);
	const synonyms = SKILL_SETUP_CONSTANTS.QUERY_SYNONYMS;
	for (const t of tokens) {
		for (const [key, values] of Object.entries(synonyms)) {
			const hit = t === key || (/[^\p{ASCII}]/u.test(key) && t.includes(key));
			if (!hit) continue;
			for (const v of values) if (!out.has(v)) out.set(v, 0.6);
		}
	}
	return [...out.entries()].map(([token, weight]) => ({ token, weight }));
}

/** The text fields a candidate is scored on. */
export interface ScoredDoc {
	id: string;
	name: string;
	tags: string[];
	triggers: string[];
	description: string;
}

/**
 * Score how well a skill matches a query.
 *
 * Each query token (and synonym, at reduced weight) takes its best match:
 * exact id/name 10, exact tag 6, id/name contains 5, trigger contains 3,
 * tag overlap 3, description contains 1.5. The whole query appearing in a
 * trigger or the description adds 4.
 *
 * @param query - Free-text need ("transcribe a voice message")
 * @param doc - Candidate fields
 * @returns Score (0 = no match)
 */
export function scoreSkill(query: string, doc: ScoredDoc): number {
	const id = doc.id.toLowerCase();
	const name = doc.name.toLowerCase();
	const tags = doc.tags.map((t) => t.toLowerCase());
	const triggers = doc.triggers.map((t) => t.toLowerCase());
	const description = doc.description.toLowerCase();
	let score = 0;
	for (const { token, weight } of expandTokens(tokenize(query))) {
		let best = 0;
		if (token === id || token === name) best = 10;
		else if (tags.includes(token)) best = 6;
		else if (token.length >= 3 && (id.includes(token) || name.includes(token))) best = 5;
		else if (triggers.some((t) => t.includes(token))) best = 3;
		else if (tags.some((t) => (token.length >= 2 && t.includes(token)) || (t.length >= 3 && token.includes(t)))) best = 3;
		else if (token.length >= 2 && description.includes(token)) best = 1.5;
		score += best * weight;
	}
	const phrase = query.trim().toLowerCase();
	if (phrase.length >= 4 && (triggers.some((t) => t.includes(phrase)) || description.includes(phrase))) score += 4;
	return score;
}

/**
 * Whether a registry entry is official (see module docs).
 *
 * @param item - Registry entry (with registrySource set by fetchRegistry)
 * @returns `{ official, reason }`
 */
export function registryOfficial(item: MarketplaceItem): { official: boolean; reason: string } {
	const source = item.registrySource;
	if (source !== 'public' && source !== 'premium') {
		return { official: false, reason: `third-party: published locally on this machine (author "${item.author}")` };
	}
	if (item.metadata?.verified === true) return { official: true, reason: `verified entry in the official ${source} registry` };
	if ((SKILL_SETUP_CONSTANTS.OFFICIAL_AUTHORS as readonly string[]).includes(item.author)) {
		return { official: true, reason: `published by ${item.author} in the official ${source} registry` };
	}
	return { official: false, reason: `third-party: author "${item.author}"` };
}

/**
 * Registry ids a local skill may be listed under.
 *
 * @param local - Local skill
 * @returns Candidate ids
 */
function aliasesOf(local: LocalSkill): string[] {
	const ids = new Set([local.id, local.dirName]);
	for (const p of REGISTRY_ID_PREFIXES) {
		ids.add(`${p}${local.id}`);
		ids.add(`${p}${local.dirName}`);
	}
	return [...ids];
}

/**
 * Read a string array field.
 *
 * @param v - Value
 * @returns Strings only
 */
function strings(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Finds and describes skills. */
export class SkillDiscoveryService {
	private readonly bundledRoot: string | null;
	private readonly installedRoot: string;
	private readonly fetchRegistryFn: () => Promise<MarketplaceRegistry>;
	private readonly loadManifestFn: () => Promise<InstalledItemsManifest>;
	private readonly runner: SkillSetupRunner;

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: SkillDiscoveryDeps = {}) {
		this.bundledRoot = deps.bundledRoot ?? SkillDiscoveryService.defaultBundledRoot();
		this.installedRoot = deps.installedRoot ?? path.dirname(getInstallPath('skill', 'x'));
		this.fetchRegistryFn = deps.fetchRegistry ?? (() => fetchRegistry());
		this.loadManifestFn = deps.loadManifest ?? loadManifest;
		this.runner = deps.runner ?? getSkillSetupRunner();
	}

	/**
	 * `<package root>/config/skills/agent`, or null when the package root cannot be found.
	 *
	 * @returns Absolute path or null
	 */
	static defaultBundledRoot(): string | null {
		for (const start of SkillDiscoveryService.packageSearchStarts()) {
			try {
				const dir = path.join(findPackageRoot(start), 'config', 'skills', 'agent');
				if (fs.existsSync(dir)) return dir;
			} catch {
				// try the next start point
			}
		}
		return null;
	}

	/**
	 * Where to start looking for the package root.
	 *
	 * The compiled backend and CLI are ES modules, where `__dirname` does not
	 * exist (a bare reference throws); under ts-jest it does. The entry script
	 * (`process.argv[1]`, realpath'd through the global `bin` symlink) is
	 * always inside the package at runtime, so it is the anchor that works
	 * for `crewly` and the backend alike; cwd is the last resort.
	 *
	 * @returns Candidate start directories, most reliable first
	 */
	static packageSearchStarts(): string[] {
		const starts: string[] = [];
		if (typeof __dirname !== 'undefined') starts.push(__dirname);
		const entry = process.argv[1];
		if (entry) {
			try {
				starts.push(path.dirname(fs.realpathSync(entry)));
			} catch {
				starts.push(path.dirname(path.resolve(entry)));
			}
		}
		starts.push(process.cwd());
		return starts;
	}

	/**
	 * Find skills for a need, best first.
	 *
	 * @param query - What the agent needs ("transcribe voice message", "read pdf")
	 * @param options - `limit` (default FIND_MAX_RESULTS); `probe` runs check-only setup on the top few (default true)
	 * @returns Ranked candidates (score > 0) and whether the registry was reachable
	 *
	 * @example
	 * ```ts
	 * const { candidates } = await discovery.find('transcribe a voice message');
	 * candidates[0].id; // 'transcribe-audio'
	 * ```
	 */
	async find(query: string, options: { limit?: number; probe?: boolean } = {}): Promise<{ candidates: SkillCandidate[]; registryAvailable: boolean }> {
		const { all, registryAvailable } = await this.collect();
		const limit = options.limit ?? SKILL_SETUP_CONSTANTS.FIND_MAX_RESULTS;
		const ranked = all
			.map((c) => ({ ...c, score: scoreSkill(query, c) + (c.official ? 0.5 : 0) + (c.installed ? 0.25 : 0) }))
			.filter((c) => c.score > 0.75)
			.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
			.slice(0, limit);
		if (options.probe !== false) {
			await Promise.all(ranked.slice(0, SKILL_SETUP_CONSTANTS.FIND_PROBE_LIMIT).map((c) => this.probe(c)));
		}
		return { candidates: ranked.map((c) => this.publicView(c)), registryAvailable };
	}

	/**
	 * Resolve one skill by id (local id, directory name or registry id).
	 *
	 * @param id - Skill id
	 * @returns The skill, or null when neither bundled, installed nor in the registry
	 */
	async resolve(id: string): Promise<ResolvedSkill | null> {
		return this.pick(id, (await this.collect()).all);
	}

	/**
	 * Resolve a skill that is on this machine (bundled or installed) without
	 * touching the network — for `crewly skills setup` offline.
	 *
	 * Official status of an installed marketplace skill needs the registry, so
	 * here it is reported as not official; bundled skills are official.
	 *
	 * @param id - Skill id or directory name
	 * @returns The skill, or null when it is not on this machine
	 */
	async resolveLocal(id: string): Promise<ResolvedSkill | null> {
		return this.pick(id, (await this.collect({ registry: false })).all);
	}

	/**
	 * Pick a candidate by id, registry id or directory name.
	 *
	 * @param id - Wanted id
	 * @param all - Candidates
	 * @returns The match or null
	 */
	private pick(id: string, all: ResolvedSkill[]): ResolvedSkill | null {
		const wanted = id.trim().toLowerCase();
		const match =
			all.find((c) => c.id === wanted) ??
			all.find((c) => c.registryId === wanted) ??
			all.find((c) => c.skillDir !== undefined && path.basename(c.skillDir) === wanted);
		return match ?? null;
	}

	/**
	 * Run a check-only setup probe and record the result on the candidate.
	 *
	 * @param c - Candidate (mutated)
	 * @returns The same candidate
	 */
	async probe(c: ResolvedSkill): Promise<ResolvedSkill> {
		if (!c.installed || !c.skillDir) return c;
		if (!c.manifest) {
			c.ready = !c.manifestError;
			return c;
		}
		const result = await this.runner.runSetup({ skillId: c.id, skillDir: c.skillDir, manifest: c.manifest, checkOnly: true });
		c.setup.satisfied = result.success;
		c.setup.missing = result.steps.filter((s) => s.status === 'missing' && !s.optional).map((s) => s.id);
		c.ready = result.success;
		return c;
	}

	/**
	 * Strip internals for API output.
	 *
	 * @param c - Resolved candidate
	 * @returns Public candidate
	 */
	publicView(c: ResolvedSkill): SkillCandidate {
		const view: SkillCandidate & Partial<Pick<ResolvedSkill, 'manifest' | 'manifestError' | 'registryItem'>> = { ...c };
		delete view.manifest;
		delete view.manifestError;
		delete view.registryItem;
		return view;
	}

	/**
	 * Build every candidate from all sources.
	 *
	 * @param options - `registry: false` skips the registry fetch
	 * @returns Candidates and registry reachability
	 */
	private async collect(options: { registry?: boolean } = {}): Promise<{ all: ResolvedSkill[]; registryAvailable: boolean }> {
		const locals = [
			...(this.bundledRoot ? this.scanRoot(this.bundledRoot, 'bundled') : []),
			...this.scanRoot(this.installedRoot, 'installed'),
		];
		let registryItems: MarketplaceItem[] = [];
		let registryAvailable = options.registry !== false;
		if (registryAvailable) {
			try {
				registryItems = (await this.fetchRegistryFn()).items.filter((i) => i.type === 'skill');
				if (registryItems.length === 0) registryAvailable = false;
			} catch {
				registryAvailable = false;
			}
		}
		let installedIds = new Set<string>();
		try {
			installedIds = new Set((await this.loadManifestFn()).items.map((r) => r.id));
		} catch {
			// no manifest yet
		}

		const byId = new Map<string, ResolvedSkill>();
		const claimedRegistry = new Set<string>();
		for (const local of locals) {
			if (byId.has(local.id)) continue; // bundled wins over an installed copy of the same skill
			const aliases = aliasesOf(local);
			const item = registryItems.find(
				(i) => aliases.includes(i.id) || (typeof i.assets.archive === 'string' && !i.assets.archive.endsWith('.tar.gz') && path.basename(i.assets.archive) === local.dirName),
			);
			if (item) claimedRegistry.add(item.id);
			byId.set(local.id, this.fromLocal(local, item));
		}
		for (const item of registryItems) {
			if (claimedRegistry.has(item.id) || byId.has(item.id)) continue;
			byId.set(item.id, this.fromRegistry(item, installedIds.has(item.id)));
		}
		return { all: [...byId.values()], registryAvailable };
	}

	/**
	 * Candidate for a local (bundled or installed) skill.
	 *
	 * @param local - Local skill
	 * @param item - Matching registry entry, if any
	 * @returns Candidate
	 */
	private fromLocal(local: LocalSkill, item: MarketplaceItem | undefined): ResolvedSkill {
		let official: boolean;
		let officialReason: string;
		if (local.source === 'bundled') {
			official = true;
			officialReason = 'bundled with Crewly';
		} else if (item) {
			({ official, reason: officialReason } = registryOfficial(item));
		} else {
			official = false;
			officialReason = 'third-party: installed from a source that is no longer in an official registry';
		}
		const setupRaw = local.setupRaw ?? (item?.metadata?.setup as unknown);
		const candidate: ResolvedSkill = {
			id: local.id,
			name: local.name,
			description: local.description,
			tags: local.tags,
			triggers: local.triggers,
			source: local.source,
			official,
			officialReason,
			author: local.author ?? item?.author,
			version: local.version ?? item?.version,
			installed: true,
			skillDir: local.skillDir,
			executePath: path.join(local.skillDir, 'execute.sh'),
			...(item && item.id !== local.id ? { registryId: item.id } : {}),
			setup: { declared: false },
			score: 0,
			registryItem: item,
		};
		this.attachSetup(candidate, setupRaw);
		return candidate;
	}

	/**
	 * Candidate for a registry-only skill.
	 *
	 * @param item - Registry entry
	 * @param installed - The marketplace manifest lists it (files may still be missing)
	 * @returns Candidate
	 */
	private fromRegistry(item: MarketplaceItem, installed: boolean): ResolvedSkill {
		const { official, reason } = registryOfficial(item);
		const candidate: ResolvedSkill = {
			id: item.id,
			name: item.name,
			description: item.description,
			tags: item.tags ?? [],
			triggers: strings(item.metadata?.triggers),
			source: 'registry',
			official,
			officialReason: reason,
			author: item.author,
			version: item.version,
			installed,
			setup: { declared: false },
			score: 0,
			registryItem: item,
		};
		this.attachSetup(candidate, item.metadata?.setup);
		return candidate;
	}

	/**
	 * Validate a raw setup block and record it on the candidate.
	 *
	 * @param c - Candidate (mutated)
	 * @param raw - Raw `setup` value
	 */
	private attachSetup(c: ResolvedSkill, raw: unknown): void {
		if (raw === undefined || raw === null) return;
		const v = validateSetupManifest(raw);
		c.setup.declared = true;
		if (v.valid && v.manifest) {
			c.manifest = v.manifest;
			c.setup.estimatedMinutes = v.manifest.estimatedMinutes ?? SKILL_SETUP_CONSTANTS.DEFAULT_ESTIMATED_MINUTES;
		} else {
			c.manifestError = v.errors.join('; ');
		}
	}

	/**
	 * Scan a skills root: direct skill dirs, and one level of category dirs.
	 *
	 * @param root - Directory
	 * @param source - Label for what is found
	 * @returns Local skills
	 */
	private scanRoot(root: string, source: 'bundled' | 'installed'): LocalSkill[] {
		const out: LocalSkill[] = [];
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
			const dir = path.join(root, entry.name);
			const skill = this.readLocal(dir, source);
			if (skill) {
				out.push(skill);
				continue;
			}
			// Category directory (core/, marketing/, …)
			let nested: fs.Dirent[] = [];
			try {
				nested = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const n of nested) {
				if (!n.isDirectory() || SKIP_DIRS.has(n.name)) continue;
				const s = this.readLocal(path.join(dir, n.name), source);
				if (s) out.push(s);
			}
		}
		return out;
	}

	/**
	 * Read one skill directory (SKILL.md frontmatter wins over skill.json, as in the registry builder).
	 *
	 * @param dir - Skill directory
	 * @param source - Label
	 * @returns The skill, or null when the directory has no manifest
	 */
	private readLocal(dir: string, source: 'bundled' | 'installed'): LocalSkill | null {
		const mdPath = path.join(dir, 'SKILL.md');
		const jsonPath = path.join(dir, 'skill.json');
		let fm: Record<string, unknown> = {};
		let json: Record<string, unknown> = {};
		const hasMd = fs.existsSync(mdPath);
		const hasJson = fs.existsSync(jsonPath);
		if (!hasMd && !hasJson) return null;
		try {
			if (hasMd) fm = parseSkillMd(fs.readFileSync(mdPath, 'utf-8')).frontmatter as Record<string, unknown>;
		} catch {
			fm = {};
		}
		try {
			if (hasJson) json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
		} catch {
			json = {};
		}
		const merged = { ...json, ...fm };
		const dirName = path.basename(dir);
		const id = typeof json.id === 'string' && json.id ? json.id : dirName;
		return {
			id,
			dirName,
			skillDir: dir,
			name: typeof merged.name === 'string' ? merged.name : dirName,
			description: typeof merged.description === 'string' ? merged.description : '',
			tags: strings(merged.tags),
			triggers: strings(merged.triggers),
			author: typeof merged.author === 'string' ? merged.author : undefined,
			version: typeof merged.version === 'string' ? merged.version : undefined,
			setupRaw: json.setup,
			source,
		};
	}
}

let discoverySingleton: SkillDiscoveryService | null = null;

/**
 * The process-wide discovery service.
 *
 * @returns The service
 */
export function getSkillDiscoveryService(): SkillDiscoveryService {
	if (!discoverySingleton) discoverySingleton = new SkillDiscoveryService();
	return discoverySingleton;
}
