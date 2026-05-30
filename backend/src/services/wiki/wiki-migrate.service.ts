/**
 * WikiMigrateService — one-shot conversion from legacy OSS knowledge
 * stores into the v2.1 three-scope vault structure.
 *
 * Legacy sources covered (per v2.1 spec §6 migration table):
 *   - `<project>/.crewly/knowledge/decisions.json[]`   → llm-curated/decisions/
 *   - `<project>/.crewly/knowledge/patterns.json[]`    → llm-curated/patterns/
 *   - `<project>/.crewly/knowledge/gotchas.json[]`     → llm-curated/patterns/  (gotchas are a kind of pattern)
 *   - `<project>/.crewly/knowledge/relationships.json[]` → llm-curated/people/
 *   - `<project>/.crewly/knowledge/learnings.md`       → append to llm-curated/log.md
 *   - `<project>/.crewly/knowledge/*.md` (loose)       → llm-curated/decisions/  (or skipped per heuristic)
 *   - `~/.crewly/agents/<id>/memory.json roleKnowledge[]` → llm-curated/{patterns,decisions}/  (copy; original stays)
 *
 * Design rules (locked 2026-05-24):
 *  - Default DRY-RUN. Caller must pass `{ apply: true }` to write.
 *  - Idempotent. A manifest at `<vault>/.migration-state.json` records
 *    each migrated entry's content hash + source + target. Re-runs skip
 *    entries already in the manifest.
 *  - LEGACY FILES ARE NEVER DELETED. Rollback path stays open.
 *  - Routing: everything → project vault. Items that look cross-project
 *    (mention foreign team UUIDs / customer names) are tagged
 *    `routing_uncertain: true` in frontmatter; wiki-lint surfaces them
 *    later for human review.
 *  - Per-agent memory.json is COPIED, not moved. The agent's private
 *    memory store is preserved untouched.
 *
 * @module services/wiki/wiki-migrate.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

/** Filename inside the project vault where we record migrated entries. */
export const WIKI_MIGRATE_MANIFEST_FILENAME = '.migration-state.json';
/** Manifest format version. Bump on any breaking schema change. */
export const WIKI_MIGRATE_MANIFEST_VERSION = 1;
/** Hard cap on loose .md files we walk (defensive). */
export const WIKI_MIGRATE_MAX_LOOSE_MD = 200;

/**
 * Name of the frozen `okr/` folder added to TEAM + PROJECT vaults for the
 * OKR cascade (spec okr-cascade.md §5). Holds AUTHORED OKR narrative only —
 * runtime Mission/KeyResult entities remain the cascade source-of-truth; this
 * folder optionally mirrors approved Missions and is read-only to agents.
 */
export const WIKI_OKR_FOLDER = 'okr';

/**
 * Service reference recorded in the `okr/` frozen-folder schema block's
 * `referenced_by` list. Lets the schema-loader / referenced-by resolver link
 * the folder back to the cascade service that owns its mirrored content.
 */
export const WIKI_OKR_REFERENCED_BY = 'service:okr-cascade.service';

/** Human-readable description for the TEAM-scope `okr/` frozen-folder block. */
export const WIKI_OKR_TEAM_DESCRIPTION =
  'Authored OKR narrative for this team. Mirrors approved Missions; agents read-only, Steve authors.';

/** Human-readable description for the PROJECT-scope `okr/` frozen-folder block. */
export const WIKI_OKR_PROJECT_DESCRIPTION =
  'Authored OKR narrative for this project. Mirrors approved Missions; agents read-only, Steve authors.';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface WikiMigrateInput {
  /** Absolute path to the project root (the dir containing `.crewly/`). */
  projectRoot: string;
  /**
   * When false (default), the call only PROPOSES migrations and returns a
   * preview. When true, files are written, manifest is updated, and
   * vaults are bootstrapped on the fly.
   */
  apply?: boolean;
  /**
   * Override the home dir used to locate `~/.crewly/agents/` and
   * `~/.crewly/teams/`. Tests use this; production leaves it undefined
   * so `os.homedir()` wins.
   */
  homeDir?: string;
  /**
   * Override `process.cwd()` semantics for the "current project". Tests
   * use this; production leaves it undefined.
   */
  includeAgentMemory?: boolean;
}

export type WikiMigrateSourceType =
  | 'decision'
  | 'pattern'
  | 'gotcha'
  | 'relationship'
  | 'learning-log'
  | 'loose-md'
  | 'memory-entry'
  | 'sop-role'
  | 'sop-common'
  | 'sop-domain'
  | 'sop-pro-template';

export interface WikiMigrateProposedPage {
  sourceType: WikiMigrateSourceType;
  /** Display path of the legacy source (relative-ish, suitable for UI). */
  sourceFile: string;
  /** Stable id for the source entry. Random uuid for entries without one. */
  sourceId: string;
  /** sha256 of the generated markdown body — drives idempotency. */
  contentHash: string;
  /** Absolute vault path the migration lands in. */
  targetVaultPath: string;
  /** Path relative to vault root. */
  targetRelativePath: string;
  /** Human-readable title pulled / synthesized from the source. */
  title: string;
  /** True when the entry mentions content suggesting cross-project scope. */
  routingUncertain: boolean;
  /** Reason this entry was skipped (already migrated, malformed, etc.). */
  skipReason?: string;
}

export interface WikiMigrateBootstrapNeeded {
  /** True when the project vault `.crewly/wiki/SCHEMA.md` is missing. */
  project: boolean;
  /** True when `~/.crewly/global-wiki/SCHEMA.md` is missing. */
  global: boolean;
  /** UUIDs of team vaults missing their SCHEMA.md. */
  teams: string[];
}

/**
 * Per-vault outcome of an `okr/` frozen-folder backfill (OKR cascade spec §5).
 * One entry per existing vault we inspected; `changed` is true only when this
 * run actually created the folder and/or injected the schema block.
 */
export interface WikiOkrFolderResult {
  /** Vault scope this entry describes. */
  scope: 'team' | 'project';
  /** Absolute path to the vault root (the dir containing `SCHEMA.md`). */
  vaultPath: string;
  /** True when the `okr/` directory was created this run. */
  folderCreated: boolean;
  /** True when the `okr/` block was injected into `SCHEMA.md` this run. */
  schemaUpdated: boolean;
  /** Convenience: folderCreated || schemaUpdated. */
  changed: boolean;
}

/**
 * Aggregate result of {@link WikiMigrateService.ensureOkrFolders}. Lists every
 * existing TEAM/PROJECT vault that was inspected and whether it changed.
 */
export interface WikiEnsureOkrResult {
  ok: true;
  /** When false (default), describes what WOULD change without writing. */
  applied: boolean;
  /** One entry per existing vault inspected. */
  vaults: WikiOkrFolderResult[];
  /** Count of vaults that changed (or would change) this run. */
  changedCount: number;
}

export interface WikiMigrateScanResult {
  ok: true;
  /** Resolved absolute project vault path. */
  vaultPath: string;
  /** True when ANY legacy source was discovered. */
  legacyDetected: boolean;
  /** Per-entry proposals (skipped ones stay in this list with a reason). */
  proposedPages: WikiMigrateProposedPage[];
  /** Vault scopes still missing SCHEMA.md. Apply will bootstrap them. */
  bootstrapNeeded: WikiMigrateBootstrapNeeded;
  /** Summary counters for UI. */
  summary: {
    decisions: number;
    patterns: number;
    gotchas: number;
    relationships: number;
    learnings: number;
    looseMd: number;
    memoryEntries: number;
    alreadyMigrated: number;
  };
}

export interface WikiMigrateApplyResult extends WikiMigrateScanResult {
  /** Count of pages newly written this run. */
  applied: number;
  /** Count of pages skipped (already migrated or malformed). */
  skipped: number;
  /** Vaults newly bootstrapped this run. */
  bootstrapped: string[];
  /** Path to the manifest after the run. */
  manifestPath: string;
}

export type WikiMigrateOutcome =
  | WikiMigrateScanResult
  | WikiMigrateApplyResult
  | {
      ok: false;
      reason: 'invalid_input' | 'project_root_missing';
      message: string;
    };

interface ManifestEntry {
  sourceId: string;
  contentHash: string;
  targetRelativePath: string;
  migratedAt: string;
}

interface Manifest {
  version: number;
  entries: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// Legacy file shapes (loose typing — we lean on runtime guards)
// ---------------------------------------------------------------------------

interface LegacyDecision {
  id?: string;
  title?: string;
  decision?: string;
  rationale?: string;
  decidedBy?: string;
  decidedAt?: string;
  status?: string;
}

interface LegacyPattern {
  id?: string;
  category?: string;
  title?: string;
  description?: string;
  discoveredBy?: string;
  createdAt?: string;
}

interface LegacyGotcha {
  id?: string;
  title?: string;
  problem?: string;
  solution?: string;
  severity?: string;
  discoveredBy?: string;
  createdAt?: string;
}

interface LegacyRelationship {
  id?: string;
  title?: string;
  subject?: string;
  description?: string;
  createdAt?: string;
}

interface LegacyMemoryFile {
  agentId?: string;
  role?: string;
  roleKnowledge?: Array<{
    id?: string;
    category?: string;
    content?: string;
    createdAt?: string;
    confidence?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Singleton service exposing scan() + apply(). Stateless across calls;
 * the manifest on disk is the persistence layer.
 */
export class WikiMigrateService {
  private static instance: WikiMigrateService | null = null;

  static getInstance(): WikiMigrateService {
    if (!this.instance) this.instance = new WikiMigrateService();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  /**
   * Dry-run preview of what `apply()` would do.
   */
  async scan(input: WikiMigrateInput): Promise<WikiMigrateOutcome> {
    return this.run({ ...input, apply: false });
  }

  /**
   * Execute the migration: bootstrap vaults, write pages, persist manifest.
   */
  async apply(input: WikiMigrateInput): Promise<WikiMigrateOutcome> {
    return this.run({ ...input, apply: true });
  }

  /**
   * Migrate OSS-distributed SOPs (the ones that ship with Crewly OSS itself)
   * into the GLOBAL vault's `llm-curated/sops/` tree so wiki-query can find
   * them. Without this, the org-wide SOPs (content-production-pipeline,
   * git-workflow, blocker-handling, etc.) sit in `<crewly-src>/config/sops/`
   * + `config/domain-sops/` + `config/templates/pro-sops/` and are invisible
   * to `wiki-query` — which is why ORC reported "no marketing SOP" despite
   * the file existing on disk (2026-05-27 incident).
   *
   * Routing:
   *   `config/sops/<role>/<n>.md`             → llm-curated/sops/<role>/<n>.md
   *   `config/sops/common/<n>.md`              → llm-curated/sops/common/<n>.md
   *   `config/sops/<n>.md` (no role)           → llm-curated/sops/general/<n>.md
   *   `config/domain-sops/<n>.sop.md`          → llm-curated/sops/domain/<n>.md
   *   `config/templates/pro-sops/norms/<n>.md` → llm-curated/sops/pro-norms/<n>.md
   *
   * Idempotent via the global vault's manifest. Legacy source files are NEVER
   * deleted. Bootstraps the global vault if missing.
   *
   * @param input.crewlySourceRoot - Absolute path to the Crewly OSS source
   *   directory (the one containing `config/sops/`). Defaults to process.cwd()
   *   when the OSS happens to BE running from its own source dir.
   * @param input.apply - false for dry-run, true to write.
   */
  async migrateOssSops(
    input: { crewlySourceRoot?: string; apply?: boolean; homeDir?: string },
  ): Promise<WikiMigrateOutcome> {
    const crewlySrc = input.crewlySourceRoot ?? process.cwd();
    const homeDir = input.homeDir ?? os.homedir();

    if (!path.isAbsolute(crewlySrc)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'crewlySourceRoot must be an absolute path',
      };
    }
    if (!existsSync(path.join(crewlySrc, 'config'))) {
      return {
        ok: false,
        reason: 'project_root_missing',
        message: `${crewlySrc} doesn't look like Crewly source (no config/ dir)`,
      };
    }

    const globalVault = path.join(homeDir, '.crewly', 'global-wiki');
    const bootstrapNeeded: WikiMigrateBootstrapNeeded = {
      project: false,
      global: !existsSync(path.join(globalVault, 'SCHEMA.md')),
      teams: [],
    };

    // Manifest lives inside the global vault — reuse the same shape as
    // project migrations so re-runs are idempotent across both flows.
    const manifestPath = path.join(globalVault, WIKI_MIGRATE_MANIFEST_FILENAME);
    const manifest = await this.loadManifest(manifestPath);
    const migratedIds = new Set(manifest.entries.map((e) => e.sourceId));
    const migratedHashes = new Set(manifest.entries.map((e) => e.contentHash));

    const proposed: WikiMigrateProposedPage[] = [];
    const sources: Array<{
      type: WikiMigrateSourceType;
      relRoot: string;
      targetSubdir: (relPath: string) => string;
    }> = [
      {
        type: 'sop-role',
        relRoot: 'config/sops',
        targetSubdir: (rel) => {
          // rel: e.g. "developer/git-workflow.md" → "developer"
          // or top-level "xhs-requirement-log.v1.md" → "general"
          const parts = rel.split('/');
          return parts.length > 1 ? parts[0] : 'general';
        },
      },
      {
        type: 'sop-domain',
        relRoot: 'config/domain-sops',
        targetSubdir: () => 'domain',
      },
      {
        type: 'sop-pro-template',
        relRoot: 'config/templates/pro-sops/norms',
        targetSubdir: () => 'pro-norms',
      },
    ];

    for (const src of sources) {
      const absRoot = path.join(crewlySrc, src.relRoot);
      if (!existsSync(absRoot)) continue;
      await this.collectSopFiles(absRoot, '', async (relPath, absPath) => {
        // Skip EXAMPLE files used for in-source documentation only.
        const lower = relPath.toLowerCase();
        if (lower.includes('example')) return;

        let body: string;
        try {
          body = await fs.readFile(absPath, 'utf8');
        } catch {
          return;
        }
        const sourceId = `${src.type}:${path.posix.join(src.relRoot, relPath)}`;
        const subdir = src.targetSubdir(relPath.replace(/\\/g, '/'));
        const slugBase = path
          .basename(relPath)
          .replace(/\.sop\.md$/i, '')
          .replace(/\.md$/i, '');
        const targetRel = `llm-curated/sops/${subdir}/${slugBase}.md`;
        const titleFromBody = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slugBase;
        const enriched = `${frontmatterForSop(src.type, relPath, src.relRoot, titleFromBody)}${body.replace(/^#\s+.+\n/, '')}`;
        const hash = sha256(enriched);
        const skipReason =
          migratedIds.has(sourceId) || migratedHashes.has(hash) ? 'already migrated' : undefined;
        proposed.push({
          sourceType: src.type,
          sourceFile: path.posix.join(src.relRoot, relPath.replace(/\\/g, '/')),
          sourceId,
          contentHash: hash,
          targetVaultPath: globalVault,
          targetRelativePath: targetRel,
          title: titleFromBody.slice(0, 100),
          routingUncertain: false,
        });
        if (skipReason) proposed[proposed.length - 1].skipReason = skipReason;
        // Cache the rendered body so apply() doesn't have to re-render.
        sopRenderCache.set(sourceId, enriched);
      });
    }

    const summary = this.summarize(proposed);
    const scan: WikiMigrateScanResult = {
      ok: true,
      vaultPath: globalVault,
      legacyDetected: proposed.length > 0,
      proposedPages: proposed,
      bootstrapNeeded,
      summary,
    };
    if (!input.apply) return scan;

    // ── APPLY phase ────────────────────────────────────────────────────
    const bootstrapped: string[] = [];
    if (bootstrapNeeded.global) {
      await this.writeGlobalVaultSkeleton(globalVault);
      bootstrapped.push(globalVault);
    }

    let applied = 0;
    let skipped = 0;
    for (const page of proposed) {
      if (page.skipReason) {
        skipped++;
        continue;
      }
      const body = sopRenderCache.get(page.sourceId);
      if (!body) {
        page.skipReason = 'render_cache_miss';
        skipped++;
        continue;
      }
      try {
        const abs = path.join(page.targetVaultPath, page.targetRelativePath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, body, 'utf8');
        manifest.entries.push({
          sourceId: page.sourceId,
          contentHash: page.contentHash,
          targetRelativePath: page.targetRelativePath,
          migratedAt: new Date().toISOString(),
        });
        applied++;
      } catch (err) {
        page.skipReason = `write_failed: ${(err as Error).message}`;
        skipped++;
      }
    }
    if (applied > 0) {
      await this.persistManifest(manifestPath, manifest);
    }

    const applyResult: WikiMigrateApplyResult = {
      ...scan,
      applied,
      skipped,
      bootstrapped,
      manifestPath,
    };
    return applyResult;
  }

  /**
   * Recursive walk of a SOP source dir, calling `visit` for every `.md` file
   * with its path RELATIVE to `root`.
   */
  private async collectSopFiles(
    root: string,
    relPrefix: string,
    visit: (relPath: string, absPath: string) => Promise<void>,
  ): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, relPrefix), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.posix.join(relPrefix, entry.name);
      const abs = path.join(root, rel);
      if (entry.isDirectory()) {
        await this.collectSopFiles(root, rel, visit);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        await visit(rel, abs);
      }
    }
  }

  /**
   * Shared implementation. Branches on `input.apply` for the write phase.
   */
  private async run(input: WikiMigrateInput): Promise<WikiMigrateOutcome> {
    const { projectRoot } = input;
    if (!projectRoot || !path.isAbsolute(projectRoot)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'projectRoot must be an absolute path',
      };
    }
    if (!existsSync(projectRoot)) {
      return {
        ok: false,
        reason: 'project_root_missing',
        message: `projectRoot does not exist: ${projectRoot}`,
      };
    }

    const homeDir = input.homeDir ?? os.homedir();
    const includeMemory = input.includeAgentMemory ?? true;
    const vaultPath = path.join(projectRoot, '.crewly', 'wiki');

    // Bootstrap scoping is needed up-front because we may need to write
    // into the project vault (which requires its SCHEMA.md to exist for
    // the OSS reads — and for the lint contract).
    const bootstrapNeeded = await this.detectBootstrapNeeded(projectRoot, homeDir);

    // Manifest (skip when not yet bootstrapped — we'll create it on apply).
    const manifestPath = path.join(vaultPath, WIKI_MIGRATE_MANIFEST_FILENAME);
    const manifest = await this.loadManifest(manifestPath);
    const migratedIds = new Set(manifest.entries.map((e) => e.sourceId));
    const migratedHashes = new Set(manifest.entries.map((e) => e.contentHash));

    // Discover + propose.
    const proposedPages: WikiMigrateProposedPage[] = [];
    let legacyDetected = false;

    const knowledgeDir = path.join(projectRoot, '.crewly', 'knowledge');
    if (existsSync(knowledgeDir)) {
      legacyDetected = true;
      await this.proposeFromJsonArray(
        knowledgeDir,
        'decisions.json',
        'decision',
        vaultPath,
        proposedPages,
        migratedIds,
        migratedHashes,
        this.decisionToPage.bind(this),
      );
      await this.proposeFromJsonArray(
        knowledgeDir,
        'patterns.json',
        'pattern',
        vaultPath,
        proposedPages,
        migratedIds,
        migratedHashes,
        this.patternToPage.bind(this),
      );
      await this.proposeFromJsonArray(
        knowledgeDir,
        'gotchas.json',
        'gotcha',
        vaultPath,
        proposedPages,
        migratedIds,
        migratedHashes,
        this.gotchaToPage.bind(this),
      );
      await this.proposeFromJsonArray(
        knowledgeDir,
        'relationships.json',
        'relationship',
        vaultPath,
        proposedPages,
        migratedIds,
        migratedHashes,
        this.relationshipToPage.bind(this),
      );
      await this.proposeLearningsLog(
        knowledgeDir,
        vaultPath,
        proposedPages,
        migratedIds,
        migratedHashes,
      );
      await this.proposeLooseMarkdown(
        knowledgeDir,
        vaultPath,
        proposedPages,
        migratedIds,
        migratedHashes,
      );
    }

    // (2026-05-27) ALSO scan project ROOT for deploy/agent docs that agents
    // reach for first when asked "how do I deploy this". These live OUTSIDE
    // .crewly/ traditionally — `<root>/CLAUDE.md`, `<root>/DEPLOYMENT.md`,
    // `<root>/AGENTS.md`, `<root>/deploy/*.md`, `<root>/docs/deploy*.md`.
    // Without this pass agents can't wiki-query for deploy procedures and
    // fall back to reading raw CLAUDE.md (the 2026-05-27 Closie deploy
    // incident — ORC told Steve "wiki 里没有部署文档" though CLAUDE.md
    // had it).
    await this.proposeProjectRootDocs(
      projectRoot,
      vaultPath,
      proposedPages,
      migratedIds,
      migratedHashes,
    );

    // (2026-05-27) ALSO scan <project>/.crewly/docs/*.md — the legacy
    // `query-knowledge` skill's storage. Same project as Crewly itself has
    // 114 such docs (blog drafts, case studies, business-model, cloud-mvp
    // plan, competitive scans). Without this they're invisible to
    // wiki-query and stuck in the deprecated `query-knowledge` path.
    await this.proposeProjectDocs(
      projectRoot,
      vaultPath,
      proposedPages,
      migratedIds,
      migratedHashes,
    );

    if (includeMemory) {
      const agentsDir = path.join(homeDir, '.crewly', 'agents');
      if (existsSync(agentsDir)) {
        const found = await this.proposeFromAgentMemory(
          agentsDir,
          vaultPath,
          proposedPages,
          migratedIds,
          migratedHashes,
        );
        if (found) legacyDetected = true;
      }
    }

    const summary = this.summarize(proposedPages);

    const scan: WikiMigrateScanResult = {
      ok: true,
      vaultPath,
      legacyDetected,
      proposedPages,
      bootstrapNeeded,
      summary,
    };

    if (!input.apply) return scan;

    // ── APPLY PHASE ─────────────────────────────────────────────────────
    const bootstrapped = await this.bootstrapMissingVaults(
      projectRoot,
      homeDir,
      bootstrapNeeded,
    );

    let applied = 0;
    let skipped = 0;
    for (const page of proposedPages) {
      if (page.skipReason) {
        skipped++;
        continue;
      }
      try {
        const finalRel = await this.writePage(page);
        manifest.entries.push({
          sourceId: page.sourceId,
          contentHash: page.contentHash,
          targetRelativePath: finalRel,
          migratedAt: new Date().toISOString(),
        });
        applied++;
      } catch (err) {
        page.skipReason = `write_failed: ${(err as Error).message}`;
        skipped++;
      }
    }

    if (applied > 0) {
      await this.persistManifest(manifestPath, manifest);
    }

    const applyResult: WikiMigrateApplyResult = {
      ...scan,
      applied,
      skipped,
      bootstrapped,
      manifestPath,
    };
    return applyResult;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap detection + execution
  // ---------------------------------------------------------------------------

  private async detectBootstrapNeeded(
    projectRoot: string,
    homeDir: string,
  ): Promise<WikiMigrateBootstrapNeeded> {
    const projectVault = path.join(projectRoot, '.crewly', 'wiki', 'SCHEMA.md');
    const globalVault = path.join(homeDir, '.crewly', 'global-wiki', 'SCHEMA.md');
    const teams: string[] = [];
    const teamsRoot = path.join(homeDir, '.crewly', 'teams');
    if (existsSync(teamsRoot)) {
      try {
        const entries = await fs.readdir(teamsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name === 'orchestrator') continue;
          const schemaPath = path.join(teamsRoot, entry.name, 'wiki', 'SCHEMA.md');
          if (!existsSync(schemaPath)) teams.push(entry.name);
        }
      } catch {
        // partial discovery is fine
      }
    }
    return {
      project: !existsSync(projectVault),
      global: !existsSync(globalVault),
      teams,
    };
  }

  private async bootstrapMissingVaults(
    projectRoot: string,
    homeDir: string,
    needed: WikiMigrateBootstrapNeeded,
  ): Promise<string[]> {
    const created: string[] = [];

    if (needed.project) {
      const dir = path.join(projectRoot, '.crewly', 'wiki');
      await this.writeProjectVaultSkeleton(dir);
      created.push(dir);
    }
    if (needed.global) {
      const dir = path.join(homeDir, '.crewly', 'global-wiki');
      await this.writeGlobalVaultSkeleton(dir);
      created.push(dir);
    }
    for (const teamUuid of needed.teams) {
      const dir = path.join(homeDir, '.crewly', 'teams', teamUuid, 'wiki');
      let teamName = teamUuid;
      try {
        const cfgRaw = await fs.readFile(
          path.join(homeDir, '.crewly', 'teams', teamUuid, 'config.json'),
          'utf8',
        );
        const cfg = JSON.parse(cfgRaw) as { name?: string; teamName?: string };
        teamName = cfg.name ?? cfg.teamName ?? teamUuid;
      } catch {
        // config.json missing — use UUID
      }
      await this.writeTeamVaultSkeleton(dir, teamUuid, teamName);
      created.push(dir);
    }
    return created;
  }

  private async writeProjectVaultSkeleton(vaultDir: string): Promise<void> {
    await fs.mkdir(path.join(vaultDir, 'memory'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'sop-overrides'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, WIKI_OKR_FOLDER), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'llm-curated'), { recursive: true });
    await fs.writeFile(
      path.join(vaultDir, 'SCHEMA.md'),
      PROJECT_VAULT_SCHEMA_MD,
      'utf8',
    );
  }

  private async writeGlobalVaultSkeleton(vaultDir: string): Promise<void> {
    await fs.mkdir(path.join(vaultDir, 'okr'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'decisions'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'llm-curated'), { recursive: true });
    await fs.writeFile(
      path.join(vaultDir, 'SCHEMA.md'),
      GLOBAL_VAULT_SCHEMA_MD,
      'utf8',
    );
  }

  private async writeTeamVaultSkeleton(
    vaultDir: string,
    teamUuid: string,
    teamName: string,
  ): Promise<void> {
    await fs.mkdir(path.join(vaultDir, 'sop'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'team-norm'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, WIKI_OKR_FOLDER), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'llm-curated'), { recursive: true });
    const schema = teamVaultSchemaMd(teamUuid, teamName);
    await fs.writeFile(path.join(vaultDir, 'SCHEMA.md'), schema, 'utf8');
  }

  // ---------------------------------------------------------------------------
  // Manifest persistence
  // ---------------------------------------------------------------------------

  private async loadManifest(manifestPath: string): Promise<Manifest> {
    if (!existsSync(manifestPath)) {
      return { version: WIKI_MIGRATE_MANIFEST_VERSION, entries: [] };
    }
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Manifest;
      if (!parsed || typeof parsed !== 'object') {
        return { version: WIKI_MIGRATE_MANIFEST_VERSION, entries: [] };
      }
      return {
        version: parsed.version ?? WIKI_MIGRATE_MANIFEST_VERSION,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      // Corrupt manifest — treat as empty. Apply will overwrite.
      return { version: WIKI_MIGRATE_MANIFEST_VERSION, entries: [] };
    }
  }

  private async persistManifest(manifestPath: string, manifest: Manifest): Promise<void> {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const payload = JSON.stringify(
      { ...manifest, version: WIKI_MIGRATE_MANIFEST_VERSION },
      null,
      2,
    );
    await fs.writeFile(manifestPath, payload, 'utf8');
  }

  // ---------------------------------------------------------------------------
  // Proposers — one per legacy source type
  // ---------------------------------------------------------------------------

  private async readJsonArray<T>(
    dir: string,
    filename: string,
  ): Promise<T[] | null> {
    const file = path.join(dir, filename);
    if (!existsSync(file)) return null;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  private async proposeFromJsonArray<T extends { id?: string }>(
    knowledgeDir: string,
    filename: string,
    type: WikiMigrateSourceType,
    vaultPath: string,
    out: WikiMigrateProposedPage[],
    migratedIds: Set<string>,
    migratedHashes: Set<string>,
    convert: (entry: T, knowledgeDir: string, filename: string, vaultPath: string) => Omit<
      WikiMigrateProposedPage,
      'sourceType' | 'sourceFile' | 'sourceId' | 'contentHash' | 'targetVaultPath' | 'skipReason'
    > & { sourceId: string; targetRelativePath: string; body: string },
  ): Promise<void> {
    const items = await this.readJsonArray<T>(knowledgeDir, filename);
    if (items === null) return;
    for (const entry of items) {
      const converted = convert(entry, knowledgeDir, filename, vaultPath);
      const hash = sha256(converted.body);
      const skipReason =
        migratedIds.has(converted.sourceId) || migratedHashes.has(hash)
          ? 'already migrated'
          : undefined;
      out.push({
        sourceType: type,
        sourceFile: path.join('.crewly/knowledge', filename),
        sourceId: converted.sourceId,
        contentHash: hash,
        targetVaultPath: vaultPath,
        targetRelativePath: converted.targetRelativePath,
        title: converted.title,
        routingUncertain: converted.routingUncertain,
        skipReason,
      });
    }
  }

  private decisionToPage(entry: LegacyDecision, _dir: string, _file: string, _vault: string) {
    const id = entry.id ?? sha256(JSON.stringify(entry));
    const date = isoDateOnly(entry.decidedAt) ?? UNDATED_PREFIX;
    const title = entry.title?.trim() && entry.title.trim() !== 'Untitled Decision'
      ? entry.title.trim()
      : firstSentence(entry.decision ?? 'untitled decision');
    const slug = makeSlug(title);
    const body = renderDecisionPage(entry, title, id);
    return {
      sourceId: id,
      targetRelativePath: `llm-curated/decisions/${date}-${slug}.md`,
      title,
      routingUncertain: looksCrossProject(entry.decision ?? '', entry.rationale ?? ''),
      body,
    };
  }

  private patternToPage(entry: LegacyPattern, _dir: string, _file: string, _vault: string) {
    const id = entry.id ?? sha256(JSON.stringify(entry));
    const date = isoDateOnly(entry.createdAt) ?? UNDATED_PREFIX;
    const title = entry.title?.trim() && entry.title.trim() !== 'Untitled Pattern'
      ? entry.title.trim()
      : firstSentence(entry.description ?? 'untitled pattern');
    const slug = makeSlug(title);
    const body = renderPatternPage(entry, title, id);
    return {
      sourceId: id,
      targetRelativePath: `llm-curated/patterns/${date}-${slug}.md`,
      title,
      routingUncertain: looksCrossProject(entry.description ?? '', entry.category ?? ''),
      body,
    };
  }

  private gotchaToPage(entry: LegacyGotcha, _dir: string, _file: string, _vault: string) {
    const id = entry.id ?? sha256(JSON.stringify(entry));
    const date = isoDateOnly(entry.createdAt) ?? UNDATED_PREFIX;
    const title = entry.title?.trim() && entry.title.trim() !== 'Gotcha'
      ? entry.title.trim()
      : firstSentence(entry.problem ?? 'untitled gotcha');
    const slug = makeSlug(title);
    const body = renderGotchaPage(entry, title, id);
    return {
      sourceId: id,
      targetRelativePath: `llm-curated/patterns/${date}-${slug}.md`,
      title,
      routingUncertain: looksCrossProject(entry.problem ?? '', entry.solution ?? ''),
      body,
    };
  }

  private relationshipToPage(entry: LegacyRelationship, _dir: string, _file: string, _vault: string) {
    const id = entry.id ?? sha256(JSON.stringify(entry));
    const date = isoDateOnly(entry.createdAt) ?? UNDATED_PREFIX;
    const title = entry.title?.trim() || entry.subject?.trim() || 'untitled relationship';
    const slug = makeSlug(title);
    const body = renderRelationshipPage(entry, title, id);
    return {
      sourceId: id,
      targetRelativePath: `llm-curated/people/${date}-${slug}.md`,
      title,
      routingUncertain: false,
      body,
    };
  }

  private async proposeLearningsLog(
    knowledgeDir: string,
    vaultPath: string,
    out: WikiMigrateProposedPage[],
    migratedIds: Set<string>,
    migratedHashes: Set<string>,
  ): Promise<void> {
    const file = path.join(knowledgeDir, 'learnings.md');
    if (!existsSync(file)) return;
    let raw = '';
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    if (!raw.trim()) return;
    const sourceId = `learnings:${sha256(raw).slice(0, 16)}`;
    const body = `\n\n## Migrated learnings.md — imported ${new Date().toISOString()}\n\n${raw.trim()}\n`;
    const hash = sha256(body);
    const skipReason =
      migratedIds.has(sourceId) || migratedHashes.has(hash) ? 'already migrated' : undefined;
    out.push({
      sourceType: 'learning-log',
      sourceFile: '.crewly/knowledge/learnings.md',
      sourceId,
      contentHash: hash,
      targetVaultPath: vaultPath,
      targetRelativePath: 'llm-curated/log.md',
      title: 'learnings.md (legacy import)',
      routingUncertain: false,
      skipReason,
    });
  }

  private async proposeLooseMarkdown(
    knowledgeDir: string,
    vaultPath: string,
    out: WikiMigrateProposedPage[],
    migratedIds: Set<string>,
    migratedHashes: Set<string>,
  ): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(knowledgeDir, { withFileTypes: true });
    } catch {
      return;
    }
    let count = 0;
    for (const entry of entries) {
      if (count >= WIKI_MIGRATE_MAX_LOOSE_MD) break;
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name.toLowerCase() === 'learnings.md') continue;
      count++;
      const absPath = path.join(knowledgeDir, entry.name);
      let raw: string;
      try {
        raw = await fs.readFile(absPath, 'utf8');
      } catch {
        continue;
      }
      const sourceId = `loose:${entry.name}:${sha256(raw).slice(0, 12)}`;
      const slug = makeSlug(entry.name.replace(/\.md$/i, ''));
      const body = renderLooseMdPage(entry.name, raw);
      const hash = sha256(body);
      const skipReason =
        migratedIds.has(sourceId) || migratedHashes.has(hash) ? 'already migrated' : undefined;
      out.push({
        sourceType: 'loose-md',
        sourceFile: path.join('.crewly/knowledge', entry.name),
        sourceId,
        contentHash: hash,
        targetVaultPath: vaultPath,
        targetRelativePath: `llm-curated/decisions/${slug}.md`,
        title: entry.name.replace(/\.md$/i, ''),
        routingUncertain: looksCrossProject(raw, ''),
        skipReason,
      });
    }
  }

  /**
   * (NEW 2026-05-27) Scan the project root for deploy/agent docs that
   * agents would otherwise miss. Each project keeps "how do I deploy"
   * knowledge OUTSIDE `.crewly/` in well-known locations:
   *
   *   `<root>/CLAUDE.md`                     → llm-curated/runbooks/claude-md.md
   *   `<root>/AGENTS.md`                     → llm-curated/runbooks/agents-md.md
   *   `<root>/DEPLOYMENT.md`                 → llm-curated/runbooks/deployment.md
   *   `<root>/DEPLOYMENT-GUIDE.md`           → llm-curated/runbooks/deployment-guide.md
   *   `<root>/deploy/*.md`                   → llm-curated/runbooks/deploy-<n>.md
   *   `<root>/docs/deploy*.md`               → llm-curated/runbooks/docs-<n>.md
   *   `<root>/.claude/commands/deploy*.md`   → llm-curated/runbooks/claude-cmd-<n>.md
   *
   * Frontmatter sets `kind: runbook` so wiki-query / lint can distinguish
   * these from llm-curated/decisions/.
   */
  private async proposeProjectRootDocs(
    projectRoot: string,
    vaultPath: string,
    out: WikiMigrateProposedPage[],
    migratedIds: Set<string>,
    migratedHashes: Set<string>,
  ): Promise<void> {
    const candidates: Array<{ rel: string; targetSlug: string }> = [];

    // 1) Well-known top-level files.
    const topLevelNames = [
      'CLAUDE.md',
      'AGENTS.md',
      'DEPLOYMENT.md',
      'DEPLOYMENT-GUIDE.md',
      'DEPLOY.md',
      'RUNBOOK.md',
    ];
    for (const name of topLevelNames) {
      if (existsSync(path.join(projectRoot, name))) {
        candidates.push({
          rel: name,
          targetSlug: name.toLowerCase().replace(/\.md$/, ''),
        });
      }
    }

    // 2) <root>/deploy/*.md
    const deployDir = path.join(projectRoot, 'deploy');
    if (existsSync(deployDir)) {
      try {
        const entries = await fs.readdir(deployDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.md')) {
            candidates.push({
              rel: `deploy/${e.name}`,
              targetSlug: `deploy-${makeSlug(e.name.replace(/\.md$/, ''))}`,
            });
          }
        }
      } catch {
        // ignore
      }
    }

    // 3) <root>/docs/deploy*.md / runbook*.md
    const docsDir = path.join(projectRoot, 'docs');
    if (existsSync(docsDir)) {
      try {
        const entries = await fs.readdir(docsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith('.md')) continue;
          if (!/^(deploy|runbook)/i.test(e.name)) continue;
          candidates.push({
            rel: `docs/${e.name}`,
            targetSlug: `docs-${makeSlug(e.name.replace(/\.md$/, ''))}`,
          });
        }
      } catch {
        // ignore
      }
    }

    // 4) <root>/.claude/commands/deploy*.md (Claude Code custom commands)
    const claudeCmdDir = path.join(projectRoot, '.claude', 'commands');
    if (existsSync(claudeCmdDir)) {
      try {
        const entries = await fs.readdir(claudeCmdDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith('.md')) continue;
          if (!/deploy|runbook|release/i.test(e.name)) continue;
          candidates.push({
            rel: `.claude/commands/${e.name}`,
            targetSlug: `claude-cmd-${makeSlug(e.name.replace(/\.md$/, ''))}`,
          });
        }
      } catch {
        // ignore
      }
    }

    for (const c of candidates) {
      const absPath = path.join(projectRoot, c.rel);
      let raw: string;
      try {
        raw = await fs.readFile(absPath, 'utf8');
      } catch {
        continue;
      }
      // Skip empty / nearly-empty files (e.g. fresh AGENTS.md placeholders).
      if (raw.trim().length < 40) continue;
      const sourceId = `runbook:${c.rel}:${sha256(raw).slice(0, 12)}`;
      const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? c.rel.replace(/\.md$/, '');
      const body =
        frontmatter({
          title: title.slice(0, 120),
          kind: 'runbook',
          migrated_from: c.rel,
        }) + raw.replace(/^#\s+.+\n/, '');
      const hash = sha256(body);
      const skipReason =
        migratedIds.has(sourceId) || migratedHashes.has(hash) ? 'already migrated' : undefined;
      out.push({
        sourceType: 'loose-md',
        sourceFile: c.rel,
        sourceId,
        contentHash: hash,
        targetVaultPath: vaultPath,
        targetRelativePath: `llm-curated/runbooks/${c.targetSlug}.md`,
        title: title.slice(0, 100),
        routingUncertain: false,
        skipReason,
      });
      // Cache rendered body so writePage doesn't need to re-render.
      runbookRenderCache.set(sourceId, body);
    }
  }

  /**
   * (NEW 2026-05-27) Scan `<project>/.crewly/docs/*.md` — the storage of
   * the deprecated `query-knowledge` skill. Each file → its own page under
   * `llm-curated/docs/<slug>.md`. Lets wiki-query (v2.1) reach the same
   * content that `query-knowledge` (legacy) used to.
   *
   * Capped at WIKI_MIGRATE_MAX_LOOSE_MD to keep scan bounded.
   */
  private async proposeProjectDocs(
    projectRoot: string,
    vaultPath: string,
    out: WikiMigrateProposedPage[],
    migratedIds: Set<string>,
    migratedHashes: Set<string>,
  ): Promise<void> {
    const docsDir = path.join(projectRoot, '.crewly', 'docs');
    if (!existsSync(docsDir)) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(docsDir, { withFileTypes: true });
    } catch {
      return;
    }
    let count = 0;
    for (const entry of entries) {
      if (count >= WIKI_MIGRATE_MAX_LOOSE_MD) break;
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      count++;
      const abs = path.join(docsDir, entry.name);
      let raw: string;
      try {
        raw = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (raw.trim().length < 40) continue;
      const sourceId = `proj-doc:${entry.name}:${sha256(raw).slice(0, 12)}`;
      const slug = makeSlug(entry.name.replace(/\.md$/i, ''));
      const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? entry.name.replace(/\.md$/, '');
      const body =
        frontmatter({
          title: title.slice(0, 120),
          kind: 'project-doc',
          migrated_from: `.crewly/docs/${entry.name}`,
        }) + raw.replace(/^#\s+.+\n/, '');
      const hash = sha256(body);
      const skipReason =
        migratedIds.has(sourceId) || migratedHashes.has(hash) ? 'already migrated' : undefined;
      out.push({
        sourceType: 'loose-md',
        sourceFile: path.join('.crewly/docs', entry.name),
        sourceId,
        contentHash: hash,
        targetVaultPath: vaultPath,
        targetRelativePath: `llm-curated/docs/${slug}.md`,
        title: title.slice(0, 100),
        routingUncertain: false,
        skipReason,
      });
      runbookRenderCache.set(sourceId, body);
    }
  }

  private async proposeFromAgentMemory(
    agentsDir: string,
    vaultPath: string,
    out: WikiMigrateProposedPage[],
    migratedIds: Set<string>,
    migratedHashes: Set<string>,
  ): Promise<boolean> {
    let agentDirs: import('fs').Dirent[];
    try {
      agentDirs = await fs.readdir(agentsDir, { withFileTypes: true });
    } catch {
      return false;
    }
    let anyFound = false;
    for (const agentEntry of agentDirs) {
      if (!agentEntry.isDirectory()) continue;
      const memoryFile = path.join(agentsDir, agentEntry.name, 'memory.json');
      if (!existsSync(memoryFile)) continue;
      let raw: string;
      try {
        raw = await fs.readFile(memoryFile, 'utf8');
      } catch {
        continue;
      }
      let parsed: LegacyMemoryFile;
      try {
        parsed = JSON.parse(raw) as LegacyMemoryFile;
      } catch {
        continue;
      }
      if (!parsed.roleKnowledge?.length) continue;
      anyFound = true;
      for (const item of parsed.roleKnowledge) {
        const id = item.id ?? sha256(JSON.stringify(item));
        const date = isoDateOnly(item.createdAt) ?? UNDATED_PREFIX;
        const title = firstSentence(item.content ?? 'untitled memory');
        const slug = makeSlug(title);
        const folder = memoryCategoryToFolder(item.category);
        const targetRel = `llm-curated/${folder}/${date}-${slug}.md`;
        const body = renderMemoryEntryPage(item, agentEntry.name, title, id);
        const hash = sha256(body);
        const skipReason =
          migratedIds.has(id) || migratedHashes.has(hash) ? 'already migrated' : undefined;
        out.push({
          sourceType: 'memory-entry',
          sourceFile: path.join('~/.crewly/agents', agentEntry.name, 'memory.json'),
          sourceId: id,
          contentHash: hash,
          targetVaultPath: vaultPath,
          targetRelativePath: targetRel,
          title,
          routingUncertain: looksCrossProject(item.content ?? '', ''),
          skipReason,
        });
      }
    }
    return anyFound;
  }

  // ---------------------------------------------------------------------------
  // Write phase
  // ---------------------------------------------------------------------------

  /**
   * Write the proposed page's body to disk under the target vault.
   * Returns the FINAL relativePath written (with a suffix if a collision
   * forced one).
   */
  private async writePage(page: WikiMigrateProposedPage): Promise<string> {
    const body = await this.renderForPage(page);

    // Special case: log.md — APPEND rather than overwrite/collide. The
    // log is shared across all imports and the page emitter writes a
    // delimiter header, so concatenation is safe + expected.
    if (page.sourceType === 'learning-log') {
      const abs = path.join(page.targetVaultPath, page.targetRelativePath);
      const existing = existsSync(abs) ? await fs.readFile(abs, 'utf8') : '';
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, existing + body, 'utf8');
      return page.targetRelativePath;
    }

    let relativePath = page.targetRelativePath;
    let abs = path.join(page.targetVaultPath, relativePath);

    // If a different file already exists at the target, append a suffix
    // until we find an unused slot. (Skip when content matches — that
    // means a previous run already wrote this exact body.)
    let attempt = 0;
    while (existsSync(abs)) {
      try {
        const existing = await fs.readFile(abs, 'utf8');
        if (existing === body) return relativePath;
      } catch {
        // unreadable; treat as collision
      }
      attempt++;
      const m = page.targetRelativePath.match(/^(.+)\.md$/);
      const stem = m ? m[1] : page.targetRelativePath;
      relativePath = `${stem}-${attempt}.md`;
      abs = path.join(page.targetVaultPath, relativePath);
      if (attempt > 50) {
        throw new Error('collision_resolution_exhausted');
      }
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
    return relativePath;
  }

  /**
   * Re-emit the body for a page. The body is computed once during scan
   * (for content-hash determination) but we don't keep it on the proposal
   * — re-derive from the source on apply. This avoids duplicating large
   * blobs in API responses.
   */
  private async renderForPage(page: WikiMigrateProposedPage): Promise<string> {
    // For simplicity we re-read the source and re-render. The hash will
    // re-match because the rendering is deterministic.
    // TODO(perf): cache the rendered bodies on the page object if scans
    // become slow.

    // Cache fast-path: runbook scans (proposeProjectRootDocs) populate
    // runbookRenderCache during scan because their source path lives
    // OUTSIDE .crewly/knowledge/ — the legacy re-read paths below can't
    // find them. SOP migration uses sopRenderCache the same way.
    const cached =
      runbookRenderCache.get(page.sourceId) ?? sopRenderCache.get(page.sourceId);
    if (cached) return cached;

    switch (page.sourceType) {
      case 'decision':
      case 'pattern':
      case 'gotcha':
      case 'relationship': {
        const filename = path.basename(page.sourceFile);
        const knowledgeDir = path.join(
          page.targetVaultPath.replace(/\.crewly\/wiki$/, ''),
          '.crewly',
          'knowledge',
        );
        const items = await this.readJsonArray<{ id?: string }>(knowledgeDir, filename);
        if (!items) throw new Error('source_file_vanished');
        // Match by id when present, else by content hash via re-render.
        for (const entry of items) {
          let convert;
          switch (page.sourceType) {
            case 'decision':
              convert = this.decisionToPage.bind(this);
              break;
            case 'pattern':
              convert = this.patternToPage.bind(this);
              break;
            case 'gotcha':
              convert = this.gotchaToPage.bind(this);
              break;
            default:
              convert = this.relationshipToPage.bind(this);
              break;
          }
          const proposed = convert(entry, knowledgeDir, filename, page.targetVaultPath);
          if (proposed.sourceId === page.sourceId) return proposed.body;
        }
        throw new Error('source_entry_vanished');
      }
      case 'learning-log': {
        const knowledgeDir = path.join(
          page.targetVaultPath.replace(/\.crewly\/wiki$/, ''),
          '.crewly',
          'knowledge',
        );
        const file = path.join(knowledgeDir, 'learnings.md');
        const raw = await fs.readFile(file, 'utf8');
        return `\n\n## Migrated learnings.md — imported ${new Date().toISOString()}\n\n${raw.trim()}\n`;
      }
      case 'loose-md': {
        const knowledgeDir = path.join(
          page.targetVaultPath.replace(/\.crewly\/wiki$/, ''),
          '.crewly',
          'knowledge',
        );
        const filename = path.basename(page.sourceFile);
        const raw = await fs.readFile(path.join(knowledgeDir, filename), 'utf8');
        return renderLooseMdPage(filename, raw);
      }
      case 'memory-entry': {
        // sourceId is the entry id; re-find by scanning agent dirs.
        const homeAgentsRoot = page.sourceFile.replace(/~\/\.crewly\/agents\/.*$/, '');
        const home = homeAgentsRoot.startsWith('~/')
          ? path.join(os.homedir(), '.crewly', 'agents')
          : path.join(os.homedir(), '.crewly', 'agents');
        const m = page.sourceFile.match(/agents\/([^/]+)\//);
        if (!m) throw new Error('memory_source_unparseable');
        const agentName = m[1];
        const raw = await fs.readFile(
          path.join(home, agentName, 'memory.json'),
          'utf8',
        );
        const parsed = JSON.parse(raw) as LegacyMemoryFile;
        const item = parsed.roleKnowledge?.find((k) => k.id === page.sourceId);
        if (!item) throw new Error('memory_entry_vanished');
        const title = firstSentence(item.content ?? 'untitled memory');
        return renderMemoryEntryPage(item, agentName, title, page.sourceId);
      }
      default:
        throw new Error(`unknown_source_type: ${page.sourceType}`);
    }
  }

  private summarize(pages: WikiMigrateProposedPage[]): WikiMigrateScanResult['summary'] {
    const s = {
      decisions: 0,
      patterns: 0,
      gotchas: 0,
      relationships: 0,
      learnings: 0,
      looseMd: 0,
      memoryEntries: 0,
      alreadyMigrated: 0,
    };
    for (const p of pages) {
      if (p.skipReason === 'already migrated') s.alreadyMigrated++;
      switch (p.sourceType) {
        case 'decision':
          s.decisions++;
          break;
        case 'pattern':
          s.patterns++;
          break;
        case 'gotcha':
          s.gotchas++;
          break;
        case 'relationship':
          s.relationships++;
          break;
        case 'learning-log':
          s.learnings++;
          break;
        case 'loose-md':
          s.looseMd++;
          break;
        case 'memory-entry':
          s.memoryEntries++;
          break;
      }
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // OKR cascade — `okr/` frozen-folder backfill for EXISTING vaults (spec §5)
  // ---------------------------------------------------------------------------

  /**
   * Idempotently add the frozen `okr/` folder + SCHEMA.md block to EXISTING
   * team and project vaults that predate the OKR cascade.
   *
   * New vaults already seed `okr/` via the skeleton writers; this method covers
   * vaults already on disk. It is the analogue of {@link bootstrapMissingVaults}
   * for a single added frozen folder: only vaults whose `SCHEMA.md` already
   * exists are touched (a fully-missing vault is bootstrapped elsewhere).
   *
   * Detection is idempotent — a vault that already declares `okr/` in its
   * SCHEMA.md and has the directory on disk is reported as `changed: false`.
   * The cascade source-of-truth stays the runtime Mission tree; this folder
   * holds authored narrative only.
   *
   * @param input.projectRoot - Absolute path to the project root (dir holding
   *   `.crewly/wiki/`). Its project vault is backfilled when present.
   * @param input.homeDir - Override for `~`; team vaults live under
   *   `<homeDir>/.crewly/teams/<uuid>/wiki/`. Tests pass a scratch dir.
   * @param input.apply - false (default) for a dry-run preview; true to write.
   * @returns Per-vault results and a changed-vault count.
   * @example
   * ```typescript
   * const res = await WikiMigrateService.getInstance().ensureOkrFolders({
   *   projectRoot, homeDir, apply: true,
   * });
   * ```
   */
  async ensureOkrFolders(input: {
    projectRoot?: string;
    homeDir?: string;
    apply?: boolean;
  }): Promise<WikiEnsureOkrResult> {
    const apply = input.apply ?? false;
    const homeDir = input.homeDir ?? os.homedir();
    const vaults: WikiOkrFolderResult[] = [];

    // Project vault (only when its SCHEMA.md already exists on disk).
    if (input.projectRoot) {
      const projectVault = path.join(input.projectRoot, '.crewly', 'wiki');
      if (existsSync(path.join(projectVault, 'SCHEMA.md'))) {
        vaults.push(
          await this.ensureOkrForVault(
            projectVault,
            'project',
            WIKI_OKR_PROJECT_DESCRIPTION,
            apply,
          ),
        );
      }
    }

    // Team vaults under <home>/.crewly/teams/<uuid>/wiki/.
    const teamsRoot = path.join(homeDir, '.crewly', 'teams');
    if (existsSync(teamsRoot)) {
      let entries: import('fs').Dirent[] = [];
      try {
        entries = await fs.readdir(teamsRoot, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'orchestrator') continue;
        const teamVault = path.join(teamsRoot, entry.name, 'wiki');
        if (!existsSync(path.join(teamVault, 'SCHEMA.md'))) continue;
        vaults.push(
          await this.ensureOkrForVault(
            teamVault,
            'team',
            WIKI_OKR_TEAM_DESCRIPTION,
            apply,
          ),
        );
      }
    }

    return {
      ok: true,
      applied: apply,
      vaults,
      changedCount: vaults.filter((v) => v.changed).length,
    };
  }

  /**
   * Backfill a single existing vault with the frozen `okr/` folder + schema
   * block. Idempotent: a no-op (changed=false) when the folder and the schema
   * block are both already present.
   *
   * @param vaultDir - Absolute path to the vault root (contains `SCHEMA.md`).
   * @param scope - Vault scope, used to pick the schema description copy.
   * @param description - Description string for the injected `okr/` block.
   * @param apply - When false, only reports what would change.
   * @returns The per-vault outcome.
   */
  private async ensureOkrForVault(
    vaultDir: string,
    scope: 'team' | 'project',
    description: string,
    apply: boolean,
  ): Promise<WikiOkrFolderResult> {
    const okrDir = path.join(vaultDir, WIKI_OKR_FOLDER);
    const schemaPath = path.join(vaultDir, 'SCHEMA.md');

    const folderMissing = !existsSync(okrDir);

    let schema = '';
    try {
      schema = await fs.readFile(schemaPath, 'utf8');
    } catch {
      schema = '';
    }
    const schemaMissingBlock = !schemaDeclaresOkr(schema);

    if (apply) {
      if (folderMissing) {
        await fs.mkdir(okrDir, { recursive: true });
      }
      if (schemaMissingBlock && schema) {
        const next = injectOkrBlock(schema, description);
        if (next !== schema) {
          await fs.writeFile(schemaPath, next, 'utf8');
        }
      }
    }

    return {
      scope,
      vaultPath: vaultDir,
      folderCreated: folderMissing,
      schemaUpdated: schemaMissingBlock && schema.length > 0,
      changed: folderMissing || (schemaMissingBlock && schema.length > 0),
    };
  }
}

// ---------------------------------------------------------------------------
// Renderers — pure functions (test-friendly)
// ---------------------------------------------------------------------------

const UNDATED_PREFIX = '0000-00-00';

/**
 * In-memory cache of (sopSourceId → rendered body). Populated during scan
 * and read by apply so we don't re-read source files twice. Keyed by the
 * stable sourceId so re-running scan+apply within one process doesn't
 * re-render. Stays in memory only — never persisted.
 */
const sopRenderCache = new Map<string, string>();

/**
 * Same cache pattern for runbook / deploy doc imports (proposeProjectRootDocs).
 * Lets writePage skip the re-read in `renderForPage`.
 */
const runbookRenderCache = new Map<string, string>();

/**
 * Frontmatter line for a migrated SOP page. Lets wiki-query / lint
 * distinguish OSS-distributed SOPs from team-authored ones and lets
 * future re-imports detect "this came from config/<x>" exactly.
 */
function frontmatterForSop(
  type: WikiMigrateSourceType,
  relPath: string,
  relRoot: string,
  title: string,
): string {
  return frontmatter({
    title,
    sop_kind: type,
    migrated_from: `${relRoot}/${relPath.replace(/\\/g, '/')}`,
    canonical: true,
  });
}

function renderDecisionPage(entry: LegacyDecision, title: string, id: string): string {
  return `${frontmatter({
    title,
    migrated_from: '.crewly/knowledge/decisions.json',
    original_id: id,
    original_author: entry.decidedBy,
    original_date: entry.decidedAt,
    status: entry.status,
    routing_uncertain: looksCrossProject(entry.decision ?? '', entry.rationale ?? ''),
  })}# ${escapeHeading(title)}

${entry.decision ?? '(no decision text)'}

${entry.rationale ? `\n## Rationale\n\n${entry.rationale}\n` : ''}
`;
}

function renderPatternPage(entry: LegacyPattern, title: string, id: string): string {
  return `${frontmatter({
    title,
    migrated_from: '.crewly/knowledge/patterns.json',
    original_id: id,
    original_author: entry.discoveredBy,
    original_date: entry.createdAt,
    category: entry.category,
    routing_uncertain: looksCrossProject(entry.description ?? '', entry.category ?? ''),
  })}# ${escapeHeading(title)}

${entry.description ?? '(no description)'}
`;
}

function renderGotchaPage(entry: LegacyGotcha, title: string, id: string): string {
  return `${frontmatter({
    title,
    migrated_from: '.crewly/knowledge/gotchas.json',
    original_id: id,
    original_author: entry.discoveredBy,
    original_date: entry.createdAt,
    severity: entry.severity,
    routing_uncertain: looksCrossProject(entry.problem ?? '', entry.solution ?? ''),
  })}# ${escapeHeading(title)}

## Problem

${entry.problem ?? '(no problem text)'}

${entry.solution ? `## Solution\n\n${entry.solution}\n` : ''}
`;
}

function renderRelationshipPage(entry: LegacyRelationship, title: string, id: string): string {
  return `${frontmatter({
    title,
    migrated_from: '.crewly/knowledge/relationships.json',
    original_id: id,
    original_date: entry.createdAt,
  })}# ${escapeHeading(title)}

${entry.description ?? entry.subject ?? '(no description)'}
`;
}

function renderLooseMdPage(filename: string, raw: string): string {
  const trimmed = raw.trim();
  // If the file already starts with a YAML frontmatter block we leave it
  // intact; otherwise we prepend our own.
  if (trimmed.startsWith('---')) return raw;
  return `${frontmatter({
    title: filename.replace(/\.md$/i, ''),
    migrated_from: `.crewly/knowledge/${filename}`,
  })}${raw}`;
}

function renderMemoryEntryPage(
  item: NonNullable<LegacyMemoryFile['roleKnowledge']>[number],
  agentName: string,
  title: string,
  id: string,
): string {
  return `${frontmatter({
    title,
    migrated_from: `agent/${agentName}/memory.json`,
    original_id: id,
    original_author: agentName,
    original_date: item.createdAt,
    category: item.category,
    confidence: item.confidence,
    routing_uncertain: looksCrossProject(item.content ?? '', ''),
  })}# ${escapeHeading(title)}

${item.content ?? '(no content)'}
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isoDateOnly(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function makeSlug(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base.length > 0 ? base.slice(0, 80) : 'untitled';
}

function firstSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'untitled';
  const cut = trimmed.split(/[.!?\n]/)[0].trim();
  return (cut.length > 0 ? cut : trimmed).slice(0, 100);
}

function escapeHeading(value: string): string {
  return value.replace(/\n/g, ' ');
}

function memoryCategoryToFolder(category: string | undefined): string {
  switch ((category ?? '').toLowerCase()) {
    case 'best-practice':
    case 'pattern':
    case 'gotcha':
    case 'lesson':
      return 'patterns';
    case 'decision':
      return 'decisions';
    case 'person':
    case 'people':
    case 'customer':
      return 'people';
    default:
      return 'patterns';
  }
}

/**
 * Cheap heuristic for "this entry looks like it might span projects."
 * Returns true when the content references multiple known foreign-scope
 * markers (team UUIDs, foreign project names, ALL-CAPS pricing or OKR
 * lingo). Used to flag entries for human review during the next lint.
 */
function looksCrossProject(...texts: string[]): boolean {
  const joined = texts.join(' ').toLowerCase();
  if (!joined) return false;
  const signals = [
    /\bteam[- ]uuid\b/,
    /\bokr\b/,
    /\bcompany[- ]?wide\b/,
    /\bclosie\b/,
    /\bglitchy\b/,
    /\bportal\b.*\bproduct\b/,
  ];
  return signals.some((re) => re.test(joined));
}

function frontmatter(
  fields: Record<string, string | number | boolean | undefined | null>,
): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string') {
      lines.push(`${key}: "${value.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

/**
 * True when a SCHEMA.md already declares the frozen `okr/` folder. Cheap
 * line-scan for a `- path: okr/` hardcoded entry; used to keep the OKR
 * backfill idempotent without parsing the full YAML.
 *
 * @param schema - Raw SCHEMA.md contents.
 * @returns true when an `okr/` path block is present.
 */
function schemaDeclaresOkr(schema: string): boolean {
  return new RegExp(`(^|\\n)\\s*-\\s*path:\\s*${WIKI_OKR_FOLDER}/\\s*(\\n|$)`).test(schema);
}

/**
 * Inject an `okr/` frozen-folder block into an existing SCHEMA.md, immediately
 * before the `llm_curated:` section (so it sits with the other `hardcoded:`
 * entries). Falls back to appending the block at end-of-file when no
 * `llm_curated:` marker exists. Returns the input unchanged when `okr/` is
 * already declared (defensive double-check).
 *
 * @param schema - Raw SCHEMA.md contents to mutate.
 * @param description - Description copy for the injected block.
 * @returns The updated SCHEMA.md contents.
 */
function injectOkrBlock(schema: string, description: string): string {
  if (schemaDeclaresOkr(schema)) return schema;
  const block =
    `  - path: ${WIKI_OKR_FOLDER}/\n` +
    `    frozen: true\n` +
    `    description: "${description.replace(/"/g, '\\"')}"\n` +
    `    referenced_by:\n` +
    `      - ${WIKI_OKR_REFERENCED_BY}\n\n`;

  const marker = '\nllm_curated:';
  const idx = schema.indexOf(marker);
  if (idx === -1) {
    const sep = schema.endsWith('\n') ? '' : '\n';
    return `${schema}${sep}\n${block}`;
  }
  return schema.slice(0, idx + 1) + block + schema.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// SCHEMA.md skeletons
// ---------------------------------------------------------------------------

const PROJECT_VAULT_SCHEMA_MD = `# Project vault — SCHEMA.md
# Bootstrapped by wiki-migrate per v2.1 spec §1(C).

vault_scope: project
vault_id: project

hardcoded:
  - path: memory/
    frozen: true
    description: "Project-scoped facts agents share. Replaces scattered .crewly/knowledge/learnings.md."
    referenced_by:
      - skill:remember
      - skill:recall

  - path: sop-overrides/
    frozen: true
    description: "Project-specific SOP deltas. get-sops reads team-vault sop/ first, then this override layer."
    referenced_by:
      - skill:get-sops

  - path: ${WIKI_OKR_FOLDER}/
    frozen: true
    description: "${WIKI_OKR_PROJECT_DESCRIPTION}"
    referenced_by:
      - ${WIKI_OKR_REFERENCED_BY}

llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs:
      - decisions
      - patterns
      - people
      - log.md
      - index.md
    llm_can_create_subdirs: true
    lint_may_restructure: true

write_policy:
  canonical:
    - team-leader
    - orchestrator
  proposed_only:
    - worker
    - researcher
  schema_writer:
    - steve
    - architect
`;

const GLOBAL_VAULT_SCHEMA_MD = `# Global ORC vault — SCHEMA.md
# Bootstrapped by wiki-migrate per v2.1 spec §1(B).

vault_scope: global
vault_id: crewly-global

hardcoded:
  - path: okr/
    frozen: true
    description: "Company OKRs. Authored by Steve; agents read-only."
    referenced_by:
      - skill:get-sops

  - path: decisions/
    frozen: true
    description: "Cross-project decisions (Anthropic-SMB pricing, etc.). TLs promote project-scoped decisions up here when they apply across teams."
    referenced_by:
      - service:sop.service

llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs:
      - roadmap
      - patterns
      - people
      - log.md
      - index.md
    llm_can_create_subdirs: true
    lint_may_restructure: true

write_policy:
  canonical:
    - orchestrator
  proposed_only:
    - team-leader
  schema_writer:
    - steve
    - architect
`;

function teamVaultSchemaMd(teamUuid: string, teamName: string): string {
  const safeName = teamName.replace(/"/g, '\\"');
  return `# ${safeName} team vault — SCHEMA.md
# Bootstrapped by wiki-migrate per v2.1 spec §1(A).
# Team UUID: ${teamUuid}

vault_scope: team
vault_id: ${teamUuid}

hardcoded:
  - path: sop/
    frozen: true
    description: "Team SOPs. Canonical source for get-sops once migrated; today config/sops/<role>/ remains the fallback."
    referenced_by:
      - skill:get-sops
      - service:sop.service

  - path: team-norm/
    frozen: true
    description: "Team norms (canDelegate, role conventions, ROE). Maps from config/sops/<role>/team-norm/ over Phase 2 migration."
    referenced_by:
      - skill:get-team-norms

  - path: ${WIKI_OKR_FOLDER}/
    frozen: true
    description: "${WIKI_OKR_TEAM_DESCRIPTION}"
    referenced_by:
      - ${WIKI_OKR_REFERENCED_BY}

llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs:
      - people
      - decisions
      - patterns
      - log.md
      - index.md
    llm_can_create_subdirs: true
    lint_may_restructure: true

write_policy:
  canonical:
    - team-leader
    - orchestrator
  proposed_only:
    - worker
    - researcher
  schema_writer:
    - steve
    - architect
`;
}
