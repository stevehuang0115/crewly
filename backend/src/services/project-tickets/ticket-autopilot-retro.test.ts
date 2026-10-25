/**
 * Tests for the daily autopilot retro's pure parts: the input contract, the
 * brief, the wiki page and the harness-gap dedupe.
 */

import {
  buildRetroBrief,
  buildWeeklyRetroBrief,
  isoWeekOf,
  isoWeekRange,
  previousIsoWeek,
  renderWeeklyRetroMarkdown,
  validateWeeklyRetroInput,
  duplicateOf,
  durationWords,
  renderRetroMarkdown,
  RetroInputError,
  statsLines,
  titleSimilarity,
  topStallCauses,
  validateRetroInput,
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

  describe('weekly cross-team retro (#985)', () => {
    it('ISO weeks: label, range and the previous week', () => {
      expect(isoWeekOf('2026-09-28')).toBe('2026-W40');
      expect(isoWeekOf('2026-10-04')).toBe('2026-W40');
      expect(isoWeekOf('2026-10-05')).toBe('2026-W41');
      expect(isoWeekOf('2027-01-01')).toBe('2026-W53'); // Friday; the week belongs to 2026
      expect(isoWeekOf('2026-01-01')).toBe('2026-W01');
      expect(isoWeekRange('2026-W40')).toEqual({ start: '2026-09-28', end: '2026-10-04' });
      expect(isoWeekRange('2026-W01')).toEqual({ start: '2025-12-29', end: '2026-01-04' });
      expect(isoWeekRange('2026-W53')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
      expect(() => isoWeekRange('2026-40')).toThrow('Not an ISO week');
      expect(previousIsoWeek('2026-10-05')).toEqual({ week: '2026-W40', start: '2026-09-28', end: '2026-10-04' });
      expect(previousIsoWeek('2026-10-11')).toEqual({ week: '2026-W40', start: '2026-09-28', end: '2026-10-04' });
      expect(previousIsoWeek('2026-01-01')).toEqual({ week: '2025-W52', start: '2025-12-22', end: '2025-12-28' });
    });

    it('validates the weekly retro input', () => {
      const ok = validateWeeklyRetroInput({ week: '2026-W40', summary: 'Two teams stalled on approvals.', problems: [{ class: 'harness_gap', title: 'Brief misreads paused teams' }] });
      expect(ok).toEqual({ week: '2026-W40', summary: 'Two teams stalled on approvals.', problems: [{ class: 'harness_gap', title: 'Brief misreads paused teams' }] });
      expect(() => validateWeeklyRetroInput({ week: '2026-10-05', summary: 'x', problems: [] })).toThrow(RetroInputError);
      expect(() => validateWeeklyRetroInput({ week: '2026-10-05', summary: 'x', problems: [] })).toThrow('YYYY-Www');
      expect(() => validateWeeklyRetroInput({ week: '2026-W40', summary: '', problems: [] })).toThrow(RetroInputError);
      expect(() => validateWeeklyRetroInput({ week: '2026-W40', summary: 'x', problems: [{ class: 'nope', title: 't' }] })).toThrow(RetroInputError);
    });

    it('builds the orchestrator brief across projects and renders the global wiki page', () => {
      const projects = [
        { id: 'p-ce', name: 'CE', stats: stats.total, retros: [{ day: '2026-09-30', page: '/data/ce/wiki/llm-curated/autopilot-retros/2026-09-30.md', problems: 2, gaps: 1 }] },
        { id: 'p-fp', name: 'Flopost', stats: null, retros: [{ day: '2026-10-01', page: 'llm-curated/autopilot-retros/2026-10-01.md', problems: 1, gaps: 0 }] },
      ];
      const brief = buildWeeklyRetroBrief({
        week: '2026-W40',
        start: '2026-09-28',
        end: '2026-10-04',
        projects,
        gaps: [{ id: 'CREWLY-7', title: 'Reconciler never woke the stopped lead', project: 'CE', day: '2026-09-30' }],
      });
      expect(brief).toContain('# Weekly autopilot retro: 2026-W40 (2026-09-28 → 2026-10-04)');
      expect(brief).toContain('daily retros for 2 projects');
      expect(brief).toContain('### CE');
      expect(brief).toContain('- 2026-09-30: 2 problems, 1 harness gap filed — `/data/ce/wiki/llm-curated/autopilot-retros/2026-09-30.md`');
      expect(brief).toContain('### Flopost');
      expect(brief).toContain('- Numbers unavailable (traces could not be read)');
      expect(brief).toContain('- CREWLY-7 — Reconciler never woke the stopped lead (CE, 2026-09-30)');
      expect(brief).toContain('retro --week 2026-W40');
      expect(brief).toContain('llm-curated/autopilot-retros/weekly/2026-W40.md');

      const many = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, stats: null, retros: [] }));
      expect(buildWeeklyRetroBrief({ week: '2026-W40', start: '2026-09-28', end: '2026-10-04', projects: many, gaps: [] })).toContain('…and 2 more projects');

      const md = renderWeeklyRetroMarkdown({
        week: '2026-W40',
        start: '2026-09-28',
        end: '2026-10-04',
        retro: { week: '2026-W40', summary: 'Approvals stalled two teams.', problems: [{ class: 'owner_dependency', title: 'Copy approvals waited a day' }, { class: 'harness_gap', title: 'Brief misreads paused teams' }] },
        by: 'crewly-orc',
        projects,
        filed: [{ id: 'CREWLY-9', title: 'Brief misreads paused teams' }],
      });
      expect(md).toContain('# Weekly autopilot retro — 2026-W40 (2026-09-28 → 2026-10-04)');
      expect(md).toContain('Filed by crewly-orc.');
      expect(md).toContain('- **CE**: daily retros 2026-09-30 — ');
      expect(md).toContain('- **Flopost**: daily retros 2026-10-01');
      expect(md).toContain('### Owner dependency');
      expect(md).toContain('### Harness gap');
      expect(md).toContain("- CREWLY-9: Brief misreads paused teams (waiting for the owner's OK)");
    });
  });
});
