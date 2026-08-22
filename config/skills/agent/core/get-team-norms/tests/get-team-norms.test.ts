import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Tests for the `get-team-norms` skill's trigger filtering.
 *
 * The skill reads `~/.crewly/teams/{teamId}/norms/*.md` and filters by the
 * `trigger:` frontmatter field. That field is a COMMA-SEPARATED LIST, but the
 * reader originally compared it to the caller's trigger with string equality,
 * so a query only matched when it reproduced the entire stored list verbatim.
 * Six of the seven norms in the live runtime store lists, making
 * trigger-filtered retrieval non-functional for almost all of them.
 *
 * These tests run the real script against a throwaway CREWLY_HOME, so they
 * assert observable behaviour rather than mirroring the implementation.
 */

const SKILL = join(__dirname, '..', 'execute.sh');
const TEAM_ID = 'test-team-0001';

let home: string;

/**
 * Writes a norm file with the given trigger list into the fixture team.
 *
 * @param name - Basename for the .md file
 * @param trigger - Raw `trigger:` frontmatter value (comma-separated list)
 */
function writeNorm(name: string, trigger: string): void {
  const body = `---\ntitle: ${name}\ntrigger: ${trigger}\nupdatedBy: test\nupdatedAt: 2026-08-21T00:00:00Z\n---\n\nBody of ${name}.\n`;
  writeFileSync(join(home, '.crewly', 'teams', TEAM_ID, 'norms', `${name}.md`), body);
}

/**
 * Runs the skill against the fixture home and returns the parsed response.
 *
 * @param trigger - Trigger query; omit for no filtering
 * @returns Parsed JSON response from the skill
 */
function run(trigger?: string): { count: number; data: Array<{ trigger: string }> } {
  const payload: Record<string, string> = { teamId: TEAM_ID };
  if (trigger !== undefined) payload['trigger'] = trigger;
  const out = execFileSync('bash', [SKILL, JSON.stringify(payload)], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
  });
  return JSON.parse(out);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crewly-norms-'));
  mkdirSync(join(home, '.crewly', 'teams', TEAM_ID, 'norms'), { recursive: true });
  // Shapes taken from the live runtime, including the two substring traps.
  writeNorm('escalation', 'escalation,delegation,blocker');
  writeNorm('onboarding', 'delegation,onboarding');
  writeNorm('sales', 'inbound_lead,sales');
  writeNorm('intake', 'task_intake,new_request');
  writeNorm('org', 'org_structure');
  writeNorm('mutation', 'mutation check,verifying a test fails');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('get-team-norms trigger filtering', () => {
  it('returns every norm when no trigger is supplied', () => {
    expect(run().count).toBe(6);
  });

  it('matches a token inside a comma-separated list', () => {
    // The regression: this returned 0 because no norm's ENTIRE trigger
    // string equals "delegation".
    const res = run('delegation');
    expect(res.count).toBe(2);
    expect(res.data.map((n) => n.trigger).sort()).toEqual([
      'delegation,onboarding',
      'escalation,delegation,blocker',
    ]);
  });

  it('matches a single-token norm', () => {
    expect(run('org_structure').count).toBe(1);
  });

  it('does NOT substring-match a longer token', () => {
    // `lead` must not match `inbound_lead`, `sale` must not match `sales`.
    // A substring fix would return the wrong norms rather than none, which
    // is worse than the original bug because it looks like it works.
    expect(run('lead').count).toBe(0);
    expect(run('sale').count).toBe(0);
    expect(run('legation').count).toBe(0);
  });

  it('still matches the full token that those traps are substrings of', () => {
    expect(run('inbound_lead').count).toBe(1);
    expect(run('sales').count).toBe(1);
  });

  it('ignores surrounding whitespace and case in the query', () => {
    expect(run('  DELEGATION  ').count).toBe(2);
    expect(run('Org_Structure').count).toBe(1);
  });

  it('matches tokens that contain internal spaces', () => {
    // Only leading/trailing whitespace is trimmed — internal spacing is
    // part of the token.
    expect(run('mutation check').count).toBe(1);
    expect(run('verifying a test fails').count).toBe(1);
  });

  it('treats a multi-token query as "any of these"', () => {
    // Union, not verbatim equality: the norm matches if it declares ANY of
    // the requested triggers.
    expect(run('escalation,onboarding').count).toBe(2);
    expect(run('no_such_trigger,delegation').count).toBe(2);
  });

  it('remains compatible with a query that repeats a stored list verbatim', () => {
    // This is the one shape the old exact-equality reader got right; it must
    // keep working.
    const res = run('escalation,delegation,blocker');
    expect(res.count).toBeGreaterThanOrEqual(1);
    expect(res.data.map((n) => n.trigger)).toContain('escalation,delegation,blocker');
  });

  it('returns nothing for an unknown trigger', () => {
    expect(run('no_such_trigger').count).toBe(0);
  });

  it('returns everything for an all-whitespace or comma-only query', () => {
    // Degenerate queries carry no tokens, so they request no filtering
    // rather than filtering everything away.
    expect(run('   ').count).toBe(6);
    expect(run(',,,').count).toBe(6);
  });
});
