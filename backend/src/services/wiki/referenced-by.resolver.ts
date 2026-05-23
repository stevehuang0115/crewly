/**
 * Symbolic `referenced_by:` resolver.
 *
 * SCHEMA.md `referenced_by:` entries use `<kind>:<name>` symbols
 * (`skill:get-sops`, `service:sop.service`) rather than absolute filesystem
 * paths, so SCHEMA.md stays portable across users, machines, and runtimes
 * (Sonnet vs DeepSeek install roots differ, $HOME differs, Pro vs OSS install
 * roots differ).
 *
 * This resolver maps a symbol to the absolute path on the current machine.
 *
 * Per v2.1 spec §2 (Symbolic referenced_by registry):
 *   `skill:<name>`   → config/skills/{agent/core, orchestrator}/<name>/execute.sh
 *   `service:<name>` → backend/src/services/<dir>/<name>.service.ts
 *
 * @module services/wiki/referenced-by.resolver
 */

import * as path from 'path';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import { ReferencedBySymbol, ResolvedReference } from './wiki.types.js';

/**
 * Search roots within the Crewly project for each symbol kind. Ordered:
 * first hit wins, so put the canonical location first.
 */
interface SearchPlan {
  /** Subdirectories (relative to crewlyRoot) to scan, in order. */
  searchDirs: string[];
  /** Filename pattern relative to a matched dir entry, e.g. `execute.sh`. */
  fileSuffix: string;
}

const SEARCH_PLANS: Record<'skill' | 'service', SearchPlan> = {
  skill: {
    // Skills live under config/skills/{agent/core, orchestrator}/<name>/execute.sh
    searchDirs: ['config/skills/agent/core', 'config/skills/orchestrator'],
    fileSuffix: 'execute.sh',
  },
  service: {
    // Symbol `service:sop.service` → file basename `sop.service.ts`. The `.service`
    // segment is part of the symbol's name, so we only append `.ts` when forming
    // the wanted filename. (Resolves backend/src/services/<area>/<name>.ts.)
    searchDirs: ['backend/src/services'],
    fileSuffix: '.ts',
  },
};

/**
 * Resolves SCHEMA.md `referenced_by:` symbols to absolute filesystem paths.
 *
 * @example
 *   const resolver = new ReferencedByResolver('/path/to/crewly');
 *   const resolved = await resolver.resolve('skill:get-sops');
 *   // resolved.absolutePath === '/path/to/crewly/config/skills/agent/core/get-sops/execute.sh'
 */
export class ReferencedByResolver {
  private readonly crewlyRoot: string;
  private readonly cache = new Map<string, ResolvedReference>();

  /**
   * @param crewlyRoot - Absolute path to the Crewly project root (contains
   *   `config/` and `backend/`). Must be absolute — relative paths are
   *   rejected so the resolver behaves deterministically regardless of cwd.
   */
  constructor(crewlyRoot: string) {
    if (!path.isAbsolute(crewlyRoot)) {
      throw new Error(
        `ReferencedByResolver: crewlyRoot must be absolute, got "${crewlyRoot}"`,
      );
    }
    this.crewlyRoot = crewlyRoot;
  }

  /**
   * Resolve a symbol to an absolute path.
   *
   * @param symbol - A `skill:<name>` or `service:<name>` reference.
   * @returns The resolved reference. `exists: false` if no candidate file
   *   was found on disk — callers should treat this as a lint warning.
   * @throws If the symbol has an unknown kind prefix.
   */
  async resolve(symbol: ReferencedBySymbol): Promise<ResolvedReference> {
    const cached = this.cache.get(symbol);
    if (cached) {
      return cached;
    }

    const parsed = this.parseSymbol(symbol);
    const plan = SEARCH_PLANS[parsed.kind];

    let absolutePath: string | null = null;
    let exists = false;

    for (const dir of plan.searchDirs) {
      const candidate = await this.findInDir(
        path.join(this.crewlyRoot, dir),
        parsed.name,
        plan.fileSuffix,
        parsed.kind,
      );
      if (candidate) {
        absolutePath = candidate;
        exists = true;
        break;
      }
    }

    // If nothing found, emit a path that *would* be the canonical location
    // so lint can surface a clear "expected here, missing" message.
    if (!absolutePath) {
      absolutePath = this.fallbackCanonicalPath(parsed.kind, parsed.name);
      exists = existsSync(absolutePath);
    }

    const result: ResolvedReference = { symbol, absolutePath, exists };
    this.cache.set(symbol, result);
    return result;
  }

  /**
   * Resolve many symbols in one pass.
   */
  async resolveAll(symbols: ReferencedBySymbol[]): Promise<ResolvedReference[]> {
    return Promise.all(symbols.map((s) => this.resolve(s)));
  }

  /**
   * Clear the in-memory cache. Useful in tests, or after a vault change
   * has moved a referenced file.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private parseSymbol(symbol: ReferencedBySymbol): {
    kind: 'skill' | 'service';
    name: string;
  } {
    const colonIdx = symbol.indexOf(':');
    if (colonIdx <= 0) {
      throw new Error(
        `ReferencedByResolver: malformed symbol "${symbol}" — expected "<kind>:<name>"`,
      );
    }
    const kind = symbol.slice(0, colonIdx);
    const name = symbol.slice(colonIdx + 1);

    if (!name) {
      throw new Error(
        `ReferencedByResolver: empty name in symbol "${symbol}"`,
      );
    }
    if (kind !== 'skill' && kind !== 'service') {
      throw new Error(
        `ReferencedByResolver: unknown kind "${kind}" in symbol "${symbol}" — expected "skill" or "service"`,
      );
    }
    return { kind, name };
  }

  /**
   * Locate a file matching `<name>/<fileSuffix>` (skill) or `<name><fileSuffix>`
   * (service) inside a search directory. Returns absolute path or null.
   *
   * For skills: the name IS a directory name → look for `<dir>/<name>/execute.sh`.
   * For services: the name is a basename → recurse for `<name>.service.ts`.
   */
  private async findInDir(
    dir: string,
    name: string,
    suffix: string,
    kind: 'skill' | 'service',
  ): Promise<string | null> {
    if (kind === 'skill') {
      const candidate = path.join(dir, name, suffix);
      return existsSync(candidate) ? candidate : null;
    }
    // Service: recurse one level looking for `<name>.service.ts`.
    if (!existsSync(dir)) {
      return null;
    }
    const wantedFile = `${name}${suffix}`;
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          // Skip test/build artifacts to keep the scan bounded.
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
            continue;
          }
          stack.push(full);
        } else if (entry.isFile() && entry.name === wantedFile) {
          return full;
        }
      }
    }
    return null;
  }

  /**
   * The path we'd expect a missing symbol to live at — used so lint can
   * tell the user where to create the file.
   */
  private fallbackCanonicalPath(kind: 'skill' | 'service', name: string): string {
    if (kind === 'skill') {
      return path.join(this.crewlyRoot, 'config/skills/agent/core', name, 'execute.sh');
    }
    // Convention: `service:foo.service` → dir `foo`, file `foo.service.ts`.
    // Fall back to using the full name as the dir if no `.service` suffix.
    const areaDir = name.endsWith('.service') ? name.slice(0, -'.service'.length) : name;
    return path.join(this.crewlyRoot, 'backend/src/services', areaDir, `${name}.ts`);
  }
}
