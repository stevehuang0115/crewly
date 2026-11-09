/**
 * Tests for WikiLogCompileService (#1345).
 *
 * @module services/wiki/wiki-log-compile.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { WikiLogCompileService, isoWeekLabel } from './wiki-log-compile.service.js';
import { WikiIngestService } from './wiki-ingest.service.js';
import { WikiIndexService } from './wiki-index.service.js';
import { WIKI_LOG_HEADER, serializeLogEntry } from './wiki-log-entries.js';
import { parsePage } from './wiki-page.js';

const SCHEMA = `
vault_scope: project
vault_id: test-project
hardcoded:
  - path: memory/
    frozen: true
    description: "Project memory."
    referenced_by: [skill:remember]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [decisions]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader, orchestrator]
  proposed_only: [worker]
  schema_writer: [steve]
`;

const NOW = Date.parse('2026-10-17T12:00:00.000Z'); // Saturday, ISO week 42
const DAY = 86_400_000;
const NOISE = '(learning) [pattern] [[WorkItem-x]] task:done running→done. timestamp=2026-10-17T01:59:15.178Z. Source: task:done:x.';

function entry(ageDays: number, body: string, caller = 'leo'): string {
  return serializeLogEntry({ timestamp: new Date(NOW - ageDays * DAY).toISOString(), sourceType: 'record_learning', caller, ref: `ref-${ageDays}-${caller}`, body });
}

describe('isoWeekLabel', () => {
  it('labels ISO weeks, including the year boundary', () => {
    expect(isoWeekLabel(NOW)).toBe('2026-W42');
    expect(isoWeekLabel(Date.parse('2027-01-01T00:00:00.000Z'))).toBe('2026-W53');
    expect(isoWeekLabel(Date.parse('2026-01-05T00:00:00.000Z'))).toBe('2026-W02');
  });
});

describe('WikiLogCompileService', () => {
  let vault: string;
  let service: WikiLogCompileService;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-compile-test-'));
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), SCHEMA, 'utf8');
    await fs.mkdir(path.join(vault, 'llm-curated'), { recursive: true });
    service = new WikiLogCompileService(new WikiIngestService());
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  const writeLog = (body: string) => fs.writeFile(path.join(vault, 'llm-curated/log.md'), WIKI_LOG_HEADER + body, 'utf8');

  it('reports no_log without a log and too_few_entries under the threshold', async () => {
    expect(await service.compile(vault, { now: NOW })).toMatchObject({ compiled: false, reason: 'no_log' });
    await writeLog(entry(1, 'only one') + entry(2, NOISE));
    expect(await service.compile(vault, { now: NOW })).toMatchObject({ compiled: false, reason: 'too_few_entries', candidates: 1 });
  });

  it('writes a digest page grouped by category/topic, indexed, and remembers what it compiled', async () => {
    await writeLog(
      entry(6, '(gotcha) complete-task rejects queued→done; accept-task first.', 'leo') +
        entry(5, '(gotcha) [[Relay]] queue id is owned by the first account; a 403 means re-pair.', 'orc') +
        entry(4, '(decision) [[Relay]] free tier keeps the relay open to every signed-in user.', 'orc') +
        entry(3, NOISE) +
        entry(2, 'plain learning without a prefix', 'mia') +
        entry(10, 'outside the window'),
    );
    const r = await service.compile(vault, { now: NOW });
    expect(r).toMatchObject({ compiled: true, entriesCompiled: 4, pagePath: 'llm-curated/digests/2026-W42.md' });
    expect(r.groups).toBe(4); // gotcha, gotcha / Relay, decision / Relay, learning

    const page = parsePage(await fs.readFile(path.join(vault, r.pagePath!), 'utf8'));
    expect(page.frontmatter.title).toBe('Digest 2026-W42');
    expect(page.frontmatter.keep_because).toBe('reusable_method');
    expect(page.frontmatter.summary).toContain('4 learnings');
    expect(page.body).toContain('### gotcha / Relay (1)');
    expect(page.body).toContain('accept-task first');
    expect(page.body).not.toContain('task:done running→done');
    expect(page.body).not.toContain('outside the window');

    const index = await WikiIndexService.getInstance().read(vault);
    expect(index.entries.map((e) => e.relativePath)).toContain('llm-curated/digests/2026-W42.md');

    const state = JSON.parse(await fs.readFile(path.join(vault, '.wiki-compile-state.json'), 'utf8')) as { compiledKeys: string[] };
    expect(state.compiledKeys).toHaveLength(4);

    // A second run finds nothing new.
    expect(await service.compile(vault, { now: NOW })).toMatchObject({ compiled: false, reason: 'too_few_entries', candidates: 0 });
  });

  it('appends to the same week page on a later run with new entries', async () => {
    await writeLog(entry(3, 'a') + entry(2, 'b') + entry(1, 'c'));
    await service.compile(vault, { now: NOW });
    await writeLog(entry(3, 'a') + entry(2, 'b') + entry(1, 'c') + entry(0.5, 'd') + entry(0.4, 'e') + entry(0.3, 'f'));
    const r = await service.compile(vault, { now: NOW });
    expect(r).toMatchObject({ compiled: true, entriesCompiled: 3 });
    const page = await fs.readFile(path.join(vault, 'llm-curated/digests/2026-W42.md'), 'utf8');
    expect(page.match(/## Compiled 2026-10-17/g)).toHaveLength(2);
    expect(page).toContain(': d');
  });

  it('a week too long for one page is compiled in parts: oldest first, the rest on the next run (2026-10-26)', async () => {
    // 150 candidates × ~400 quoted chars ≈ 60 KB, over the body cap.
    const long = (i: number) => `(learning) [[Topic-${i % 7}]] ` + `entry ${i} ` + 'x'.repeat(420);
    let log = '';
    for (let i = 0; i < 150; i++) log += entry(6 - (i * 5) / 150, long(i), i % 2 ? 'leo' : 'mia');
    await writeLog(log);
    const first = await service.compile(vault, { now: NOW });
    expect(first.compiled).toBe(true);
    expect(first.candidates).toBe(150);
    expect(first.entriesCompiled).toBeLessThan(150);
    expect(first.entriesCompiled).toBeGreaterThanOrEqual(3);
    const page = parsePage(await fs.readFile(path.join(vault, first.pagePath!), 'utf8'));
    expect(Buffer.byteLength(page.body, 'utf8')).toBeLessThanOrEqual(56 * 1024);
    // The oldest entries went first; the newest waits.
    expect(page.body).toContain('entry 0 ');
    expect(page.body).not.toContain('entry 149 ');
    const state = JSON.parse(await fs.readFile(path.join(vault, '.wiki-compile-state.json'), 'utf8')) as { compiledKeys: string[] };
    expect(state.compiledKeys).toHaveLength(first.entriesCompiled);
    // The next run takes the rest.
    const second = await service.compile(vault, { now: NOW });
    expect(second).toMatchObject({ compiled: true, candidates: 150 - first.entriesCompiled });
    const again = await fs.readFile(path.join(vault, first.pagePath!), 'utf8');
    expect(again).toContain('entry 149 ');
    expect(second.entriesCompiled + first.entriesCompiled).toBeLessThanOrEqual(150);
  });

  it('dry run plans without writing a page or state', async () => {
    await writeLog(entry(3, 'a') + entry(2, 'b') + entry(1, 'c'));
    const r = await service.compile(vault, { now: NOW, dryRun: true });
    expect(r).toMatchObject({ compiled: true, dryRun: true, entriesCompiled: 3 });
    expect(existsSync(path.join(vault, 'llm-curated/digests'))).toBe(false);
    expect(existsSync(path.join(vault, '.wiki-compile-state.json'))).toBe(false);
  });

  it('compileAll keeps going past a vault without a schema', async () => {
    const broken = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-compile-test-'));
    try {
      await fs.mkdir(path.join(broken, 'llm-curated'), { recursive: true });
      await fs.writeFile(path.join(broken, 'llm-curated/log.md'), WIKI_LOG_HEADER + entry(1, 'a') + entry(2, 'b') + entry(3, 'c'), 'utf8');
      await writeLog(entry(3, 'a') + entry(2, 'b') + entry(1, 'c'));
      const results = await service.compileAll([broken, vault], { now: NOW });
      expect(results.map((r) => r.compiled)).toEqual([false, true]);
      expect(results[0].reason).toBe('ingest_refused');
    } finally {
      await fs.rm(broken, { recursive: true, force: true });
    }
  });

  it('gives work records their own sections and renders task titles, never ticket ids (#1349)', async () => {
    const record = (title: string, asked: string, done: string, outcome: string, extra: string, meta: string): string =>
      [`(record) **${title}** — ${outcome}`, `asked by: ${asked} — "please"`, `done by: ${done}`, 'did: the work', extra, `outcome: ${outcome}, 12 min`, `meta: ${meta}`].filter(Boolean).join('\n');
    await writeLog(
      serializeLogEntry({ timestamp: new Date(NOW - 2 * DAY).toISOString(), sourceType: 'work_record', caller: 'nova', ref: 'work-record:a#final', body: record('Update the news section', 'Owen (team lead)', 'Nova', 'verified by Owen', 'outputs: https://example.com/pr/1; 2 checks passed\nerrors: Bash `npm test` exit 1 (fixed)\nhelpers: delegated to Leo: "check claims" → done; reviewed by Owen', 'wi=a phase=final status=verified ticket=CE-376 done_by=nova') }) +
        serializeLogEntry({ timestamp: new Date(NOW - DAY).toISOString(), sourceType: 'work_record', caller: 'leo', ref: 'work-record:b#final', body: record('Check the legal claims', 'Nova', 'Leo', 'done (no review)', 'helpers: asked Ella → answered', 'wi=b phase=final status=done ticket=CE-377 done_by=leo') }) +
        serializeLogEntry({ timestamp: new Date(NOW - DAY).toISOString(), sourceType: 'work_record', caller: 'nova', ref: 'work-record:c#final', body: record('Translate the note', 'Owen (team lead)', 'Nova', 'rejected by Owen', '', 'wi=c phase=final status=rejected ticket=CE-378 done_by=nova') }) +
        entry(1, '(gotcha) complete-task rejects queued→done; accept-task first.', 'leo'),
    );
    const r = await service.compile(vault, { now: NOW });
    expect(r).toMatchObject({ compiled: true, entriesCompiled: 4, groups: 1 });
    const page = parsePage(await fs.readFile(path.join(vault, r.pagePath!), 'utf8'));
    expect(page.frontmatter.summary).toContain('3 work records and 1 learnings');
    expect(page.body).toContain('### Work done (3)');
    expect(page.body).toContain('**Update the news section** — asked by Owen (team lead) → done by Nova → the work → outputs: https://example.com/pr/1; 2 checks passed → verified by Owen, 12 min');
    expect(page.body).toContain('### Errors and fixes (1)');
    expect(page.body).toContain('Update the news section (Nova): Bash `npm test` exit 1 (fixed)');
    expect(page.body).toContain('### Collaboration (3 pairs)');
    expect(page.body).toContain('- Owen → Nova: 2 delegations, 1 review');
    expect(page.body).toContain('- Nova → Leo: 2 delegations');
    expect(page.body).toContain('- Leo → Ella: 1 ask answered');
    expect(page.body).toContain('### gotcha (1)');
    expect(page.body.indexOf('### Work done')).toBeLessThan(page.body.indexOf('### gotcha'));
    expect(page.body).not.toContain('CE-37');
    expect(page.body).not.toContain('meta:');
  });
});
