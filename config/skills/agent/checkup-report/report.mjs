#!/usr/bin/env node
// =============================================================================
// checkup-report — the report step of the small-business check-up
// (crewly#1062). Turns `breaks.json` from checkup-analyse into the document
// the bundled report App renders (report/current), optionally places the
// number the owner asked to see first (from the intake answers), writes
// daily-summary documents, and copies the App's files into the project so
// publish-app can upload them.
//
//   node report.mjs --app-dir ./checkup-app                       # copy the App page to publish
//   node report.mjs --breaks …/breaks.json --business "Oak Pottery" [--intake answers.json] --out ./checkup-data
//   node report.mjs --daily "Replied to 3 open inquiries; 1 booked." [--date 2026-10-27] --out ./checkup-data
//   node report.mjs --log-step intake --start --out ./checkup-data          # per-step time log → timelog.json
//   node report.mjs --log-step intake --end --out ./checkup-data
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = join(HERE, 'app');
const DEFAULT_EXAMPLES = 3;
/** Crewly App documents are capped at 256 KB; stay well under it. */
const MAX_DOC_BYTES = 200 * 1024;
/** The check-up's steps, in order; the time log accepts no other name. */
export const STEPS = ['intake', 'connect', 'analyse', 'report', 'daily'];
const TIMELOG_FILE = 'timelog.json';

/** The "which number first" choices offered by the intake form, with how each is read off the breaks. */
const FIRST_NUMBER_RULES = [
  { key: 'money_owed', match: /owed|owe|invoice|unpaid|money|cash|balance/i, label: 'Owed to you: overdue invoices plus unpaid sign-ups',
    value: (by) => '$' + Math.round((by.overdue_invoices?.estimate.outstanding || 0) + (by.signed_up_unpaid?.estimate.outstanding || 0)).toLocaleString('en-US') },
  { key: 'missed_inquiries', match: /inquir|lead|enquir|missed|unanswered/i, label: 'Inquiries with no sign-up or payment after them',
    value: (by) => String(by.inquiry_no_follow_through?.count || 0) },
  { key: 'double_entry_hours', match: /double|entry|typing|hours|time|twice/i, label: 'Hours a week spent keying the same people into more than one system (estimate)',
    value: (by) => `${by.double_entry?.estimate.hoursPerWeek || 0} h/week` },
  { key: 'lapsed', match: /laps|stopped|churn|left|came back|coming/i, label: 'Customers with no activity for a while',
    value: (by) => String(by.lapsed?.count || 0) },
];

/** Short, owner-readable examples for a break's first items; none when the data is hashed. */
function examplesFor(b, limit) {
  const out = [];
  for (const it of b.items.slice(0, limit)) {
    const who = it.person || it.customer || '';
    if (!who || String(who).startsWith('h:')) continue;
    switch (b.type) {
      case 'inquiry_no_follow_through': out.push(`${who} asked about ${it.item || 'a class'} on ${it.inquiredAt}`); break;
      case 'signed_up_unpaid': out.push(`${who}: ${it.item || 'sign-up'} on ${it.signedUpAt}, $${it.fee} unpaid`); break;
      case 'paid_not_listed': out.push(`${who} paid $${it.amount} on ${it.paidAt} (${it.item || 'no item'}) and is on no roster`); break;
      case 'dropped': out.push(`${who}: ${it.item || 'sign-up'} dropped${it.droppedAt ? ` on ${it.droppedAt}` : ''}`); break;
      case 'lapsed': out.push(`${who}: last seen ${it.lastActivity}, ${it.daysSince} days ago`); break;
      case 'overdue_invoices': out.push(`${who}: invoice ${it.number || ''} $${it.balance}, ${it.daysOverdue} days overdue`); break;
      case 'double_entry': out.push(`${who} is in ${it.systems.join(', ')}${it.conflicts.length ? ` (${it.conflicts.join('; ')})` : ''}`); break;
      case 'not_on_mailing_list': out.push(`${who}`); break;
      default: out.push(who);
    }
  }
  if (!out.length && b.items.length && String(b.items[0].person || b.items[0].customer || '').startsWith('h:')) {
    out.push(`${b.count} ${b.count === 1 ? 'person' : 'people'} (names hashed)`);
  }
  return out;
}

/**
 * Build the report document the App renders from checkup-analyse output.
 * Items are summarised into a few examples per break so the document stays small
 * and no full list of people lands in the App's data. `opts.timelog` (from
 * `readTimelog`) adds a `timing` block with minutes per step.
 */
export function buildReportDoc(breaks, opts = {}) {
  const by = Object.fromEntries(breaks.breaks.map((b) => [b.type, b]));
  const limit = Number.isFinite(opts.examples) ? opts.examples : DEFAULT_EXAMPLES;
  const doc = {
    business: opts.business || null,
    generatedAt: new Date().toISOString(),
    asOf: breaks.asOf,
    period: breaks.period,
    stats: { people: breaks.stats.people, systems: breaks.stats.systems, records: breaks.stats.records },
    totals: breaks.totals,
    breaks: breaks.breaks.map((b) => ({
      type: b.type,
      label: b.label,
      count: b.count,
      estimate: { hoursPerWeek: b.estimate.hoursPerWeek, dollarsPerMonth: b.estimate.dollarsPerMonth, formula: b.estimate.formula, isEstimate: true },
      whatAnAgentCouldDo: b.whatAnAgentCouldDo,
      examples: examplesFor(b, limit),
    })),
    top3: breaks.top3,
    notes: breaks.notes || [],
    files: (breaks.files || []).map((f) => ({ file: f.file, source: f.source, kind: f.kind, rows: f.rows })),
    assumptions: breaks.assumptions,
  };
  const want = opts.intake && opts.intake.firstNumber ? String(opts.intake.firstNumber) : '';
  if (want) {
    const rule = FIRST_NUMBER_RULES.find((r) => r.match.test(want));
    if (rule) doc.firstNumber = { asked: want, key: rule.key, label: rule.label, value: rule.value(by) };
    else doc.notes = [...doc.notes, `The owner asked to see "${want}" first; no break maps to it, so the top 3 lead.`];
  }
  // How long the check-up took, when the agent logged its steps (`--log-step`).
  if (opts.timelog && opts.timelog.steps.length) doc.timing = summariseTimelog(opts.timelog);
  return doc;
}

/** Read `<dir>/timelog.json`; an absent file is an empty log, a broken one throws. */
export function readTimelog(dir) {
  const file = join(dir, TIMELOG_FILE);
  if (!existsSync(file)) return { steps: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!raw || !Array.isArray(raw.steps)) throw new Error(`${file}: not a time log ({ steps: [] })`);
  return raw;
}

/**
 * Record the start or end of a check-up step in the time log.
 *
 * `--start` opens an entry (a second start on a still-open step restarts it);
 * `--end` closes the latest open entry of that step and fills in `minutes`.
 * `at` overrides the clock (ISO timestamp) for back-filling and tests.
 *
 * @returns the updated log and the entry touched
 * @throws when the step is unknown, `--end` finds no open entry, or `at` is not a date
 */
export function logStep(log, step, mark, at) {
  if (!STEPS.includes(step)) throw new Error(`unknown step "${step}"; use one of ${STEPS.join(', ')}`);
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) throw new Error(`--at must be an ISO timestamp, got "${at}"`);
  const iso = when.toISOString();
  const open = [...log.steps].reverse().find((s) => s.step === step && !s.endedAt);
  let entry;
  if (mark === 'start') {
    if (open) { open.startedAt = iso; entry = open; }
    else { entry = { step, startedAt: iso, endedAt: null, minutes: null }; log.steps.push(entry); }
  } else {
    if (!open) throw new Error(`no open "${step}" entry to end; run --log-step ${step} --start first`);
    if (when.getTime() < new Date(open.startedAt).getTime()) throw new Error(`end (${iso}) is before start (${open.startedAt})`);
    open.endedAt = iso;
    open.minutes = Math.round((when.getTime() - new Date(open.startedAt).getTime()) / 6000) / 10;
    entry = open;
  }
  return { log, entry };
}

/** Fold a time log into the shape the report document carries: closed steps with minutes, plus the total. */
export function summariseTimelog(log) {
  const steps = log.steps.map((s) => ({ step: s.step, startedAt: s.startedAt, endedAt: s.endedAt, minutes: s.minutes }));
  const closed = steps.filter((s) => s.endedAt);
  const totalMinutes = Math.round(closed.reduce((a, s) => a + (s.minutes || 0), 0) * 10) / 10;
  return { steps, totalMinutes, open: steps.filter((s) => !s.endedAt).map((s) => s.step) };
}

/** Read intake answers from a plain document or from app-data's `{ success, data }` output. */
function readIntake(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw && raw.data && typeof raw.data === 'object' && !raw.apps ? raw.data : raw;
}

/** Copy the App page into a directory inside the project so publish-app can upload it. */
function copyApp(dir) {
  mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const f of readdirSync(APP_SRC)) {
    const src = join(APP_SRC, f);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(dir, f));
    copied.push(f);
  }
  return copied;
}

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

function usage() {
  out({ success: false, error: 'usage: report.mjs --app-dir <dir> | --breaks <breaks.json> [--business <name>] [--intake <answers.json>] [--examples N] --out <dir> | --daily "<summary>" [--date YYYY-MM-DD] --out <dir> | --log-step <intake|connect|analyse|report|daily> --start|--end [--at <iso>] --out <dir>' }, 1);
}

function main(argv) {
  const o = { examples: DEFAULT_EXAMPLES };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) usage(); return argv[i]; };
    if (a === '--app-dir') o.appDir = next();
    else if (a === '--breaks') o.breaks = next();
    else if (a === '--business') o.business = next();
    else if (a === '--intake') o.intake = next();
    else if (a === '--examples') o.examples = Number(next());
    else if (a === '--out') o.out = next();
    else if (a === '--daily') o.daily = next();
    else if (a === '--date') o.date = next();
    else if (a === '--log-step') o.logStep = next();
    else if (a === '--start') o.mark = 'start';
    else if (a === '--end') o.mark = 'end';
    else if (a === '--at') o.at = next();
    else usage();
  }
  if (!o.appDir && !o.breaks && !o.daily && !o.logStep) usage();
  if ((o.breaks || o.daily || o.logStep) && !o.out) usage();
  if (o.logStep && !o.mark) usage();
  if (o.mark && !o.logStep) usage();
  if (o.date && !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) out({ success: false, error: `--date must be YYYY-MM-DD, got "${o.date}"` }, 1);
  if (!Number.isFinite(o.examples) || o.examples < 0) out({ success: false, error: '--examples needs a number >= 0' }, 1);

  const result = { success: true };
  if (o.logStep) {
    let log;
    try {
      log = readTimelog(o.out);
    } catch (e) {
      out({ success: false, error: e.message }, 2);
    }
    let entry;
    try {
      ({ entry } = logStep(log, o.logStep, o.mark, o.at));
    } catch (e) {
      out({ success: false, error: e.message }, o.mark === 'end' && /no open/.test(e.message) ? 2 : 1);
    }
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, TIMELOG_FILE), JSON.stringify(log, null, 2));
    result.timelog = resolve(join(o.out, TIMELOG_FILE));
    result.entry = entry;
    result.timing = summariseTimelog(log);
  }
  if (o.appDir) {
    result.appDir = resolve(o.appDir);
    result.copied = copyApp(o.appDir);
    result.next = `publish-app --dir ${o.appDir} --name "<business> check-up" --notify`;
  }
  if (o.breaks) {
    if (!existsSync(o.breaks)) out({ success: false, error: `${o.breaks}: not found (run checkup-analyse with --out first)` }, 2);
    let breaks;
    try {
      breaks = JSON.parse(readFileSync(o.breaks, 'utf8'));
    } catch (e) {
      out({ success: false, error: `${o.breaks}: ${e.message}` }, 2);
    }
    if (!Array.isArray(breaks.breaks) || !breaks.totals) out({ success: false, error: `${o.breaks}: not a checkup-analyse breaks.json` }, 2);
    let intake = null;
    if (o.intake) {
      if (!existsSync(o.intake)) out({ success: false, error: `${o.intake}: not found` }, 2);
      try {
        intake = readIntake(o.intake);
      } catch (e) {
        out({ success: false, error: `${o.intake}: ${e.message}` }, 2);
      }
    }
    let timelog = null;
    try {
      timelog = readTimelog(o.out);
    } catch (e) {
      out({ success: false, error: e.message }, 2);
    }
    const doc = buildReportDoc(breaks, { business: o.business, intake, examples: o.examples, timelog });
    const json = JSON.stringify(doc, null, 2);
    if (Buffer.byteLength(json) > MAX_DOC_BYTES) out({ success: false, error: `report document is ${Buffer.byteLength(json)} bytes; lower --examples` }, 2);
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, 'report-doc.json'), json);
    result.reportDoc = resolve(join(o.out, 'report-doc.json'));
    result.top3 = doc.top3;
    result.totals = doc.totals;
    result.firstNumber = doc.firstNumber || null;
    result.timing = doc.timing || null;
    result.next = `app-data --app <appId> --set report current --data-file ${join(o.out, 'report-doc.json')}`;
  }
  if (o.daily) {
    const summary = String(o.daily).trim();
    if (!summary) out({ success: false, error: '--daily needs text' }, 1);
    const date = o.date || new Date().toISOString().slice(0, 10);
    const doc = { date, summary, postedAt: new Date().toISOString() };
    mkdirSync(o.out, { recursive: true });
    const file = join(o.out, `daily-${date}.json`);
    writeFileSync(file, JSON.stringify(doc, null, 2));
    result.dailyDoc = resolve(file);
    result.next = `app-data --app <appId> --set daily ${date} --data-file ${file}`;
  }
  out(result, 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
