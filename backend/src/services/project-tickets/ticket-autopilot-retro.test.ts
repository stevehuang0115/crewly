/**
 * Tests for the daily autopilot retro's pure parts: the input contract, the
 * brief, the wiki page and the harness-gap dedupe.
 */

import {
  buildRetroBrief,
  duplicateOf,
  durationWords,
  renderRetroMarkdown,
  RetroInputError,
  statsLines,
  titleSimilarity,
  topStallCauses,
  validateRetroInput,
  harnessGapTeamId,
} from './ticket-autopilot-retro.js';
import { computeAutopilotStats } from './ticket-autopilot-stats.js';

const stats = computeAutopilotStats({ projectId: 'p', days: ['2026-10-02'], traces: [], dailyBudgetTokens: 20_000_000, stallMinutes: 30, now: new Date(2026, 9, 3) });
const day = stats.days[0];

describe('ticket-autopilot-retro', () => {
  it('validates a retro and says what to fix', () => {
    const ok = validateRetroInput({
      day: '2026-10-02',
      summary: 'Shipped CE-12; CE-15 stalled on the owner.',
      problems: [{ class: 'harness_gap', title: '  Triage   listed a stopped member as busy ', detail: 'd', evidence: 'tr-1' }, { class: 'owner_dependency', title: 'CE-15 waited' }],
    });
    expect(ok.problems[0]).toEqual({ class: 'harness_gap', title: 'Triage listed a stopped member as busy', detail: 'd', evidence: 'tr-1' });
    expect(validateRetroInput({ day: '2026-10-02', summary: 'Nothing moved today; nobody was idle.' }).problems).toEqual([]);
    const bad: Array<[unknown, RegExp]> = [
      [null, /Body must be/],
      [{ day: '10/02', summary: 'x'.repeat(30) }, /day must be/],
      [{ day: '2026-10-02', summary: 'short' }, /summary is required/],
      [{ day: '2026-10-02', summary: 'x'.repeat(30), problems: [{ class: 'bug', title: 'Something broke' }] }, /class must be one of/],
      [{ day: '2026-10-02', summary: 'x'.repeat(30), problems: [{ class: 'harness_gap', title: 'x' }] }, /title must be/],
      [{ day: '2026-10-02', summary: 'x'.repeat(30), problems: 'nope' }, /problems must be a list/],
    ];
    for (const [input, msg] of bad) expect(() => validateRetroInput(input)).toThrow(msg);
    expect(() => validateRetroInput(null)).toThrow(RetroInputError);
  });

  it('dedupes gaps by word overlap', () => {
    expect(titleSimilarity('Triage brief lists a stopped member as busy', 'triage brief lists stopped member as busy!')).toBeGreaterThanOrEqual(0.6);
    expect(titleSimilarity('Triage brief lists a stopped member as busy', 'Slack thread replies are lost')).toBeLessThan(0.2);
    expect(duplicateOf('Reconciler misses the wake of a stopped lead', ['Slack replies lost', 'The reconciler misses the wake of a stopped lead'])).toBe(
      'The reconciler misses the wake of a stopped lead',
    );
    expect(duplicateOf('Brand new gap here', ['Unrelated thing'])).toBeNull();
  });

  it('builds the brief with the numbers, the traces and the submit command', () => {
    const brief = buildRetroBrief({ project: { id: 'p-ce', name: 'CE' }, day: '2026-10-02', stats: day, traces: [{ traceId: 'tr-20261002-aaaaaaaa', title: 'Run trace 2026-10-02' }] });
    expect(brief).toContain('# Autopilot retro: CE, 2026-10-02');
    expect(brief).toContain('Tickets: 0 triaged, 0 started');
    expect(brief).toContain('trace-read/execute.sh --trace tr-20261002-aaaaaaaa');
    expect(brief).toContain('project-tickets/execute.sh retro --project p-ce --day 2026-10-02');
    expect(brief).toMatch(/harness_gap/);
  });

  it('renders the wiki page grouped by class', () => {
    const md = renderRetroMarkdown({
      project: { name: 'CE' },
      retro: validateRetroInput({
        day: '2026-10-02',
        summary: 'Shipped CE-12; CE-15 stalled on the owner.',
        problems: [{ class: 'owner_dependency', title: 'CE-15 waited 3h' }, { class: 'harness_gap', title: 'Triage listed a stopped member as busy' }],
      }),
      stats: day,
      by: 'ce-owen',
      filed: [{ id: 'CRW-40', title: 'Triage listed a stopped member as busy' }],
      runTraceId: 'tr-20261002-aaaaaaaa',
    });
    expect(md).toContain('# Autopilot retro — CE — 2026-10-02');
    expect(md.indexOf('### Harness gap')).toBeLessThan(md.indexOf('### Owner dependency'));
    expect(md).toContain('- CRW-40: Triage listed a stopped member as busy');
    expect(md).toContain('Run trace: `tr-20261002-aaaaaaaa`');
  });

  it('words', () => {
    expect(durationWords(0)).toBe('0m');
    expect(durationWords(90 * 60_000)).toBe('1h 30m');
    expect(durationWords(72 * 3_600_000)).toBe('3d');
    expect(statsLines(day)).toHaveLength(6);
    const s = { ...day, stalls: { count: 2, totalMs: 3 * 3_600_000, byCause: { ...day.stalls.byCause, waiting_on_owner: { count: 1, ms: 2 * 3_600_000 }, nobody_pushing: { count: 1, ms: 3_600_000 } } } };
    expect(topStallCauses(s)).toEqual(['waiting on the owner: 1 (2h)', 'nobody pushing: 1 (1h)']);
  });
});

describe('harnessGapTeamId (CREW-397)', () => {
  const teams = [
    { id: 't-mkt', name: 'Crewly Marketing', projectIds: ['p1'] },
    { id: 't-prod', name: 'crewly-product-team', projectIds: ['p1'] },
    { id: 't-old', name: 'crewly-product-team', archived: true, projectIds: ['p1'] },
  ];
  it('finds the product team on the harness project', () => {
    expect(harnessGapTeamId(teams, 'p1')).toBe('t-prod');
  });
  it('returns null when the team is not on the project', () => {
    expect(harnessGapTeamId(teams, 'p2')).toBeNull();
    expect(harnessGapTeamId([], 'p1')).toBeNull();
  });
});
