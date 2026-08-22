import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Enforces the mirror-comment convention across skill shell scripts.
 *
 * Shell skills cannot import TypeScript constants, so a literal on the wire
 * is unavoidable. The convention makes that literal auditable instead of
 * mysterious: write the literal, and name the constant it mirrors in a
 * comment directly above it.
 *
 *     # waitTimeout matches EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT (120000ms)
 *     ... waitTimeout: 120000 ...
 *
 * The value of the convention is entirely in being CHECKABLE. A mirror
 * comment nobody verifies is worse than no comment, because it asserts a
 * relationship a reader will trust — and if the constant later moves, the
 * comment becomes a confident lie. This test is what makes the claim
 * mechanical: every mirror comment must name a constant that exists and
 * whose value is exactly the number the comment states.
 *
 * Scope note (WI dae79289): this checks mirror comments that EXIST. It
 * deliberately does not demand one at every literal — several delivery
 * literals have no constant they can honestly be said to mirror, and
 * inventing one by value-matching would manufacture exactly the false
 * relationship this test exists to prevent.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SKILLS_DIR = join(REPO_ROOT, 'config', 'skills');
const CONSTANTS_FILE = join(REPO_ROOT, 'backend', 'src', 'constants.ts');

/**
 * A mirror comment found in a shell script.
 */
interface MirrorClaim {
  file: string;
  line: number;
  /** Dotted constant path, e.g. `EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT`. */
  constantPath: string;
  /** Numeric value the comment claims the constant holds. */
  claimedValue: number;
}

/**
 * Recursively lists shell scripts under a directory.
 *
 * @param dir - Directory to walk
 * @returns Absolute paths of every `.sh` file found
 */
function listShellScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue; // dangling symlink — covered by its own guard, not this one
    }
    if (stats.isDirectory()) out.push(...listShellScripts(full));
    else if (entry.endsWith('.sh')) out.push(full);
  }
  return out;
}

/**
 * Extracts mirror-comment claims from a script.
 *
 * Matches comments of the shape `... matches SOME_CONST.PATH (12345ms)`.
 *
 * @param file - Absolute path of the script
 * @returns Every claim the file makes
 */
function extractClaims(file: string): MirrorClaim[] {
  const claims: MirrorClaim[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const pattern = /#.*\bmatches\s+([A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)+)\s*\((\d[\d_]*)\s*ms\)/;
  lines.forEach((line, i) => {
    const m = pattern.exec(line);
    if (m && m[1] && m[2]) {
      claims.push({
        file,
        line: i + 1,
        constantPath: m[1],
        claimedValue: Number(m[2].replace(/_/g, '')),
      });
    }
  });
  return claims;
}

/**
 * Reads a constant's numeric value out of `constants.ts` by its dotted path.
 *
 * Deliberately textual: importing the module would drag the backend's
 * dependency graph into a config-level test.
 *
 * @param source - Full text of constants.ts
 * @param path - Dotted path such as `GROUP.MEMBER`
 * @returns The numeric value, or null when the constant is absent
 */
function lookupConstant(source: string, path: string): number | null {
  const [group, member] = path.split('.');
  if (!group || !member) return null;
  const groupMatch = new RegExp(
    `export const ${group}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}\\s*as const;`,
  ).exec(source);
  if (!groupMatch || !groupMatch[1]) return null;
  const memberMatch = new RegExp(`\\b${member}\\s*:\\s*(\\d[\\d_]*)`).exec(groupMatch[1]);
  if (!memberMatch || !memberMatch[1]) return null;
  return Number(memberMatch[1].replace(/_/g, ''));
}

describe('mirror-comment convention', () => {
  const constantsSource = readFileSync(CONSTANTS_FILE, 'utf8');
  const claims = listShellScripts(SKILLS_DIR).flatMap(extractClaims);

  it('finds the mirror comments that exist in the skill corpus', () => {
    // A guard that silently matches nothing would pass forever while
    // enforcing nothing, so pin that the scanner actually sees the corpus.
    expect(claims.length).toBeGreaterThan(0);
  });

  it.each(claims.length ? claims : [])(
    'names a real constant with the stated value: $constantPath',
    ({ file, line, constantPath, claimedValue }: MirrorClaim) => {
      const actual = lookupConstant(constantsSource, constantPath);
      const where = `${relative(REPO_ROOT, file)}:${line}`;
      expect(actual === null ? `MISSING CONSTANT (${where})` : actual).toBe(claimedValue);
    },
  );

  it('resolves a known-good constant, proving the lookup is not vacuously passing', () => {
    // If lookupConstant silently returned null for everything, every claim
    // above would fail loudly rather than pass — but pin the positive case
    // too, so a lookup that broke toward `undefined` could not hide.
    expect(lookupConstant(constantsSource, 'EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT')).toBe(120000);
    expect(lookupConstant(constantsSource, 'EVENT_DELIVERY_CONSTANTS.TOTAL_DELIVERY_TIMEOUT')).toBe(30000);
  });

  it('returns null for a constant that does not exist', () => {
    expect(lookupConstant(constantsSource, 'EVENT_DELIVERY_CONSTANTS.NOT_A_REAL_CONSTANT')).toBeNull();
  });
});
