#!/usr/bin/env tsx
/**
 * Generate Registry Index
 *
 * Scans config/skills/agent/marketplace/<name>/ (SKILL.md frontmatter, or
 * skill.json) and writes config/skills/registry.json, the public registry the
 * CLI reads from GitHub raw content. The logic lives in
 * config/skills/marketplace-registry.ts, where it is unit-tested, and a guard
 * test fails when the committed file is out of date.
 *
 * Re-running with no skill changes rewrites the file byte for byte (existing
 * entries keep their dates), so the diff shows only real changes.
 *
 * Run: npx tsx scripts/generate-registry.ts
 *
 * @module scripts/generate-registry
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { buildRegistry, MARKETPLACE_SKILLS_REL_DIR, type Registry } from '../config/skills/marketplace-registry.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const REGISTRY_OUTPUT = path.join(PROJECT_ROOT, 'config', 'skills', 'registry.json');

/**
 * Regenerate config/skills/registry.json and print what changed.
 *
 * @throws Error when no marketplace directory could be listed
 */
function main(): void {
	const previous = existsSync(REGISTRY_OUTPUT)
		? (JSON.parse(readFileSync(REGISTRY_OUTPUT, 'utf-8')) as Registry)
		: null;
	const { registry, skipped } = buildRegistry(PROJECT_ROOT, previous, new Date().toISOString());

	for (const s of skipped) console.log(`  SKIP ${s.dir} (${s.reason})`);
	const examined = registry.items.length + skipped.length;
	if (registry.items.length === 0) {
		throw new Error(`No skills listed (${examined} directories examined); refusing to write an empty registry`);
	}

	const beforeIds = new Set((previous?.items ?? []).map((i) => i.id));
	const afterIds = new Set(registry.items.map((i) => i.id));
	for (const id of afterIds) if (!beforeIds.has(id)) console.log(`  + ${id}`);
	for (const id of beforeIds) if (!afterIds.has(id)) console.log(`  - ${id}`);

	writeFileSync(REGISTRY_OUTPUT, JSON.stringify(registry, null, 2) + '\n');
	const inMarketplace = registry.items.filter((i) => i.source.startsWith(`${MARKETPLACE_SKILLS_REL_DIR}/`)).length;
	console.log(
		`\n${examined} source dir(s) examined (${inMarketplace} listed from ${MARKETPLACE_SKILLS_REL_DIR}/, ` +
			`${registry.items.length - inMarketplace} kept from elsewhere): ${registry.items.length} listed, ` +
			`${skipped.length} skipped (registry before: ${previous?.items.length ?? 0} item(s))`
	);
}

main();
