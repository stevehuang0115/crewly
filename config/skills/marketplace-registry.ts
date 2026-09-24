/**
 * Builds the public marketplace registry (config/skills/registry.json) from
 * the skill directories under config/skills/agent/marketplace/.
 *
 * Pure, filesystem-reading logic shared by scripts/generate-registry.ts (which
 * writes the file) and the registry guard test (which checks the committed file
 * is up to date). It lives under config/ so jest runs its tests.
 *
 * @module config/skills/marketplace-registry
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import YAML from 'yaml';
import { MARKETPLACE_CONSTANTS } from '../constants.js';

/** Repo-relative directory holding marketplace skills. */
export const MARKETPLACE_SKILLS_REL_DIR = 'config/skills/agent/marketplace';

/** Manifest fields the registry reads, from SKILL.md frontmatter or skill.json. */
export interface SkillManifest {
	id?: string;
	name?: string;
	description?: string;
	version?: string;
	category?: string;
	author?: string;
	license?: string;
	tags?: string[];
	skillType?: string;
	assignableRoles?: string[];
	triggers?: string[];
}

/** One public registry entry. */
export interface RegistryItem {
	id: string;
	type: 'skill';
	name: string;
	description: string;
	author: string;
	version: string;
	category: string;
	tags: string[];
	license: string;
	downloads: number;
	rating: number;
	createdAt: string;
	updatedAt: string;
	source: string;
	assets: { archive: string; checksum: string; sizeBytes: number };
	metadata: { skillType?: string; assignableRoles?: string[]; triggers?: string[] };
}

/** The public registry document. */
export interface Registry {
	schemaVersion: number;
	lastUpdated: string;
	cdnBaseUrl: string;
	source: string;
	items: RegistryItem[];
}

/** A marketplace directory that could not be listed, and why. */
export interface SkippedDir {
	dir: string;
	reason: string;
}

/**
 * Parse the YAML frontmatter of a SKILL.md file.
 *
 * @param markdown - SKILL.md contents
 * @returns The frontmatter object, or null when the file has none
 */
export function parseFrontmatter(markdown: string): Record<string, unknown> | null {
	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	if (!match) return null;
	const parsed = YAML.parse(match[1]) as unknown;
	return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

/**
 * Read a skill directory's manifest. SKILL.md frontmatter wins field by field
 * (the CLI installs SKILL.md first); skill.json fills anything it lacks.
 *
 * @param skillDir - Absolute skill directory
 * @returns The merged manifest, or null when the directory has neither file
 */
export function readSkillManifest(skillDir: string): SkillManifest | null {
	const mdPath = path.join(skillDir, 'SKILL.md');
	const jsonPath = path.join(skillDir, 'skill.json');
	const fromMd = existsSync(mdPath) ? parseFrontmatter(readFileSync(mdPath, 'utf-8')) : null;
	const fromJson = existsSync(jsonPath) ? (JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>) : null;
	if (!fromMd && !fromJson) return null;
	return { ...(fromJson ?? {}), ...(fromMd ?? {}) } as SkillManifest;
}

/** Total size in bytes of the regular files directly inside a directory. */
function directorySize(dir: string): number {
	return readdirSync(dir)
		.map((f) => statSync(path.join(dir, f)))
		.filter((s) => s.isFile())
		.reduce((sum, s) => sum + s.size, 0);
}

/** The fields derived from the skill's files (everything except dates and counters). */
function contentOf(item: RegistryItem): string {
	return JSON.stringify({ ...item, createdAt: undefined, updatedAt: undefined, downloads: undefined, rating: undefined });
}

/**
 * Build the registry from the marketplace directories.
 *
 * Ids are stable: a skill the registry already lists (matched by source path)
 * keeps its published id, because users and published docs install it by that
 * id (e.g. `crewly install agent-send-pdf-to-slack`). A new skill gets its
 * directory name, the id the CLI installs under. The same id must be used by
 * crewlyai.com's registry, or the CLI cannot pair the two entries.
 * Name, description and version come from the manifest.
 *
 * Skills outside the marketplace directory (e.g. config/skills/agent/browse-stealth)
 * are listed only when the committed registry already lists them: their entry
 * is rebuilt from the same source directory, or reported as skipped when that
 * directory is gone. Items are sorted by id.
 *
 * Entries that already exist (matched by source path) keep createdAt,
 * downloads and rating; updatedAt changes only when the entry's content
 * changes, and lastUpdated only when any entry changes. Re-running with no
 * skill changes therefore reproduces the committed file byte for byte.
 *
 * @param repoRoot - Repository root
 * @param previous - The currently committed registry, if any
 * @param now - ISO timestamp for new or changed entries
 * @returns The registry and the directories that could not be listed
 */
export function buildRegistry(
	repoRoot: string,
	previous: Registry | null,
	now: string
): { registry: Registry; skipped: SkippedDir[] } {
	const baseDir = path.join(repoRoot, MARKETPLACE_SKILLS_REL_DIR);
	const previousBySource = new Map((previous?.items ?? []).map((i) => [i.source, i]));
	const skipped: SkippedDir[] = [];
	const items: RegistryItem[] = [];

	const dirs = readdirSync(baseDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort((a, b) => a.localeCompare(b));

	// Marketplace directories, plus sources outside it that the registry already lists.
	const sources = dirs.map((dir) => `${MARKETPLACE_SKILLS_REL_DIR}/${dir}`);
	for (const prior of previous?.items ?? []) {
		if (!prior.source.startsWith(`${MARKETPLACE_SKILLS_REL_DIR}/`) && !sources.includes(prior.source)) {
			sources.push(prior.source);
		}
	}

	for (const source of sources) {
		const dir = path.basename(source);
		const skillDir = path.join(repoRoot, source);
		if (!existsSync(skillDir)) {
			skipped.push({ dir: source, reason: 'listed in the registry but the directory no longer exists' });
			continue;
		}
		const manifest = readSkillManifest(skillDir);
		if (!manifest) {
			skipped.push({ dir: source, reason: 'no SKILL.md frontmatter or skill.json' });
			continue;
		}
		if (!manifest.name) {
			skipped.push({ dir: source, reason: 'manifest has no name' });
			continue;
		}
		const prior = previousBySource.get(source);
		const draft: RegistryItem = {
			id: prior?.id ?? dir,
			type: 'skill',
			name: manifest.name,
			description: manifest.description ?? '',
			author: manifest.author || 'Crewly Team',
			version: manifest.version || '1.0.0',
			category: (manifest.category && MARKETPLACE_CONSTANTS.CATEGORY_MAP[manifest.category]) || 'development',
			tags: manifest.tags ?? [],
			license: manifest.license || 'MIT',
			downloads: 0,
			rating: 0,
			createdAt: now,
			updatedAt: now,
			source,
			assets: { archive: source, checksum: '', sizeBytes: directorySize(skillDir) },
			metadata: {
				skillType: manifest.skillType,
				assignableRoles: manifest.assignableRoles,
				triggers: manifest.triggers,
			},
		};
		if (prior) {
			draft.createdAt = prior.createdAt;
			draft.downloads = prior.downloads;
			draft.rating = prior.rating;
			if (contentOf(prior) === contentOf(draft)) draft.updatedAt = prior.updatedAt;
		}
		items.push(draft);
	}
	items.sort((a, b) => a.id.localeCompare(b.id));

	const unchanged =
		previous !== null &&
		previous.items.length === items.length &&
		previous.items.every((p, i) => JSON.stringify(p) === JSON.stringify(items[i]));

	return {
		registry: {
			schemaVersion: MARKETPLACE_CONSTANTS.SCHEMA_VERSION,
			lastUpdated: unchanged ? previous.lastUpdated : now,
			cdnBaseUrl: MARKETPLACE_CONSTANTS.PUBLIC_CDN_BASE,
			source: 'github',
			items,
		},
		skipped,
	};
}
