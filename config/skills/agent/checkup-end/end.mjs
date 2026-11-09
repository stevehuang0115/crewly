#!/usr/bin/env node
// =============================================================================
// checkup-end — the last step of the small-business check-up (crewly#1055):
// delete every file the check-up produced on this machine (ingested exports,
// the analysis with its list of people, the report and daily documents, the
// intake answers, the time log, the copied App page, and optionally the raw
// CSV exports the owner handed over) and write a receipt that says what was
// deleted, what was kept, and what the lead still has to do (unpublish the
// App, revoke any access the owner granted).
//
//   node end.mjs --dir <project> [--business "Oak Pottery"] [--app <appId>] [--exports <csv dir>] [--dry-run]
//   node end.mjs --dir . --ingest ./ingest --analysis ./analysis --data ./checkup-data --app-dir ./checkup-app --intake ./intake.json
//
// Only the files the check-up skills are known to write are deleted; anything
// else found in those folders is listed in the receipt as a leftover and left
// alone. Symbolic links are never followed. Exit 0 = done (or dry run),
// 2 = the folder does not look like a check-up, 1 = usage.
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';

/** Where the check-up team writes each kind of file, relative to the project (`--dir`). */
export const DEFAULT_LAYOUT = {
  ingest: ['ingest'],
  analysis: ['analysis'],
  data: ['checkup-data', 'data'],
  appDir: ['checkup-app'],
  intake: ['intake.json'],
};

const RECEIPT_JSON = 'checkup-end-receipt.json';
const RECEIPT_MD = 'checkup-end-receipt.md';

/**
 * What each check-up skill writes, by folder: file-name test and what the
 * receipt calls it. Only these are deleted.
 */
const KNOWN = {
  ingest: [
    { test: (f) => f === 'summary.json', kind: 'ingest summary', people: false },
    { test: (f) => f === 'unknown-report.json', kind: 'ingest note (unmapped file)', people: true },
    { test: (f) => f.endsWith('.json'), kind: 'ingested export (rows of people)', people: true },
  ],
  analysis: [
    { test: (f) => f === 'breaks.json', kind: 'analysis (every break with its people)', people: true },
    { test: (f) => f === 'report.md', kind: 'analysis report', people: true },
  ],
  data: [
    { test: (f) => f === 'report-doc.json', kind: 'App report document', people: true },
    { test: (f) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f), kind: 'daily summary', people: false },
    { test: (f) => f === 'timelog.json', kind: 'time log', people: false },
  ],
  appDir: [
    { test: (f) => f === 'index.html', kind: 'App page copy', people: false },
  ],
  exports: [
    { test: (f) => /\.csv$/i.test(f), kind: 'raw export (owner-provided CSV)', people: true },
  ],
};

/** Files that mark a folder as a check-up; at least one must exist or nothing is touched. */
const MARKERS = [
  ['ingest', 'summary.json'],
  ['analysis', 'breaks.json'],
  ['data', 'report-doc.json'],
  ['data', 'timelog.json'],
  ['intake', null],
];

/** Resolve a folder/file for one slot: the explicit flag, else the first default that exists under `--dir`. */
function resolveSlot(o, slot) {
  if (o[slot]) return resolve(o[slot]);
  for (const candidate of DEFAULT_LAYOUT[slot]) {
    const p = resolve(o.dir, candidate);
    if (existsSync(p)) return p;
  }
  return resolve(o.dir, DEFAULT_LAYOUT[slot][0]);
}

/** True when the path exists and is not a symbolic link (links are never followed). */
function isRealFile(p) {
  try {
    const st = lstatSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function isRealDir(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk one folder (not recursive) and split its entries into the files the
 * check-up wrote (to delete) and everything else (to leave and report).
 */
function inventoryDir(dir, rules, root) {
  const toDelete = [];
  const leftovers = [];
  if (!isRealDir(dir)) return { toDelete, leftovers, present: false };
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    const rel = relative(root, p) || name;
    if (st.isSymbolicLink()) { leftovers.push({ path: rel, note: 'symbolic link, not followed' }); continue; }
    if (st.isDirectory()) { leftovers.push({ path: rel, note: 'folder, not entered' }); continue; }
    const rule = rules.find((r) => r.test(name));
    if (rule) toDelete.push({ path: rel, abs: p, bytes: st.size, kind: rule.kind, people: rule.people });
    else leftovers.push({ path: rel, note: 'not written by a check-up skill' });
  }
  return { toDelete, leftovers, present: true };
}

/** Read the intake answers (plain document or app-data's `{ success, data }`) for the apps to revoke; missing → null. */
function readIntakeApps(path) {
  if (!isRealFile(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const doc = raw && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
    return Array.isArray(doc.apps) ? doc.apps.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()) : [];
  } catch {
    return [];
  }
}

/** Whether ingest-exports hashed the names (then the stored rows held no name, email or phone). */
function readNamesHashed(ingestDir) {
  const p = join(ingestDir, 'summary.json');
  if (!isRealFile(p)) return null;
  try {
    return Boolean(JSON.parse(readFileSync(p, 'utf8')).namesHashed);
  } catch {
    return null;
  }
}

/**
 * Build the end-of-check-up plan: every file to delete, the leftovers, the
 * App and access the lead still has to deal with. Deletes nothing.
 */
export function planEnd(o) {
  const root = resolve(o.dir);
  const slots = {
    ingest: resolveSlot(o, 'ingest'),
    analysis: resolveSlot(o, 'analysis'),
    data: resolveSlot(o, 'data'),
    appDir: resolveSlot(o, 'appDir'),
    intake: resolveSlot(o, 'intake'),
  };
  const looksLikeCheckup = MARKERS.some(([slot, file]) => (file ? isRealFile(join(slots[slot], file)) : isRealFile(slots[slot])));
  const toDelete = [];
  const leftovers = [];
  const folders = [];
  for (const slot of ['ingest', 'analysis', 'data', 'appDir']) {
    const inv = inventoryDir(slots[slot], KNOWN[slot], root);
    toDelete.push(...inv.toDelete);
    leftovers.push(...inv.leftovers);
    if (inv.present) folders.push(slots[slot]);
  }
  if (o.exports) {
    const dir = resolve(o.exports);
    const inv = inventoryDir(dir, KNOWN.exports, root);
    toDelete.push(...inv.toDelete);
    leftovers.push(...inv.leftovers);
    if (inv.present) folders.push(dir);
  }
  if (isRealFile(slots.intake)) {
    toDelete.push({ path: relative(root, slots.intake) || basename(slots.intake), abs: slots.intake, bytes: lstatSync(slots.intake).size, kind: 'intake answers', people: false });
  }
  const apps = readIntakeApps(slots.intake);
  const namesHashed = readNamesHashed(slots.ingest);
  return { root, slots, looksLikeCheckup, toDelete, leftovers, folders, apps, namesHashed };
}

/** The steps this skill cannot do itself, in the order the lead should take them. */
function todoFor(o, plan) {
  const todo = [];
  if (o.app) {
    todo.push({
      step: 'unpublish the App',
      why: 'the report, the intake answers and the daily lines live in the App until it is deleted',
      command: `publish-app --app ${o.app} --delete`,
    });
  } else {
    todo.push({
      step: 'unpublish the App',
      why: 'the report, the intake answers and the daily lines live in the App until it is deleted (pass --app <appId> to put the exact command here)',
      command: 'publish-app --app <appId> --delete',
    });
  }
  const apps = plan.apps && plan.apps.length ? plan.apps : [];
  todo.push({
    step: 'revoke access',
    why: apps.length
      ? `the owner named ${apps.join(', ')}; Crewly stored no key or login for them in this check-up (exports only), so any key, login or read-only share the owner handed over is revoked in that app`
      : 'any key, login or read-only share the owner handed over for the check-up is revoked in that app; Crewly stored none',
    apps,
  });
  return todo;
}

/** The receipt as Markdown the lead can paste to the owner. */
function receiptMarkdown(r) {
  const lines = [];
  lines.push(`# Check-up ended${r.business ? ` — ${r.business}` : ''}`);
  lines.push('');
  lines.push(`Ended at ${r.endedAt}${r.dryRun ? ' (dry run: nothing was deleted)' : ''}.`);
  lines.push('');
  lines.push(`## Deleted (${r.deleted.length} file${r.deleted.length === 1 ? '' : 's'}, ${r.bytes.toLocaleString('en-US')} bytes)`);
  lines.push('');
  if (!r.deleted.length) lines.push('- nothing: no check-up files were found');
  for (const f of r.deleted) lines.push(`- \`${f.path}\` — ${f.kind}${f.people ? ' (held people data)' : ''}`);
  lines.push('');
  if (r.namesHashed === true) lines.push('Names, emails and phones were hashed when the exports were ingested; the stored rows held none.');
  else if (r.namesHashed === false) lines.push('The ingested rows held names as exported; they are gone with the files above.');
  lines.push('');
  lines.push('## Kept');
  lines.push('');
  lines.push(`- this receipt (\`${r.receipt.json}\`, \`${r.receipt.md}\`)`);
  for (const l of r.leftovers) lines.push(`- \`${l.path}\` — ${l.note}`);
  lines.push('');
  lines.push('## Still to do');
  lines.push('');
  for (const t of r.todo) {
    lines.push(`- **${t.step}**: ${t.why}${t.command ? ` — \`${t.command}\`` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Delete the planned files, then remove any check-up folder left empty. Returns what was actually removed. */
function applyPlan(plan) {
  const deleted = [];
  const failed = [];
  for (const f of plan.toDelete) {
    try {
      unlinkSync(f.abs);
      deleted.push(f);
    } catch (e) {
      failed.push({ path: f.path, error: e.message });
    }
  }
  const removedFolders = [];
  for (const dir of plan.folders) {
    try {
      if (isRealDir(dir) && readdirSync(dir).length === 0) {
        rmdirSync(dir);
        removedFolders.push(relative(plan.root, dir) || dir);
      }
    } catch {
      /* a folder that will not go is simply kept */
    }
  }
  return { deleted, failed, removedFolders };
}

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

function usage() {
  out({ success: false, error: 'usage: end.mjs --dir <project> [--business <name>] [--app <appId>] [--exports <csv dir>] [--ingest <dir>] [--analysis <dir>] [--data <dir>] [--app-dir <dir>] [--intake <file>] [--receipt <dir>] [--dry-run]' }, 1);
}

function main(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) usage(); return argv[i]; };
    if (a === '--dir') o.dir = next();
    else if (a === '--business') o.business = next();
    else if (a === '--app') o.app = next();
    else if (a === '--exports') o.exports = next();
    else if (a === '--ingest') o.ingest = next();
    else if (a === '--analysis') o.analysis = next();
    else if (a === '--data') o.data = next();
    else if (a === '--app-dir') o.appDir = next();
    else if (a === '--intake') o.intake = next();
    else if (a === '--receipt') o.receipt = next();
    else if (a === '--dry-run') o.dryRun = true;
    else usage();
  }
  if (!o.dir) usage();
  if (!isRealDir(o.dir)) out({ success: false, error: `${o.dir}: not a folder` }, 2);
  if (o.exports && !isRealDir(o.exports)) out({ success: false, error: `${o.exports}: not a folder` }, 2);

  const plan = planEnd(o);
  if (!plan.looksLikeCheckup) {
    out({
      success: false,
      error: `${plan.root} does not look like a check-up folder (no ingest/summary.json, analysis/breaks.json, report-doc.json, timelog.json or intake.json); nothing deleted`,
    }, 2);
  }

  const endedAt = new Date().toISOString();
  const receiptDir = resolve(o.receipt || plan.root);
  const receipt = { json: join(receiptDir, RECEIPT_JSON), md: join(receiptDir, RECEIPT_MD) };
  const result = o.dryRun ? { deleted: plan.toDelete, failed: [], removedFolders: [] } : applyPlan(plan);
  const bytes = result.deleted.reduce((n, f) => n + f.bytes, 0);
  const r = {
    schemaVersion: '1.0',
    business: o.business || null,
    endedAt,
    dryRun: Boolean(o.dryRun),
    root: plan.root,
    deleted: result.deleted.map(({ path, bytes: b, kind, people }) => ({ path, bytes: b, kind, people })),
    bytes,
    failed: result.failed,
    removedFolders: result.removedFolders,
    leftovers: plan.leftovers,
    namesHashed: plan.namesHashed,
    todo: todoFor(o, plan),
    receipt,
  };
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(receipt.json, JSON.stringify(r, null, 2));
  writeFileSync(receipt.md, receiptMarkdown(r));

  out({
    success: result.failed.length === 0,
    dryRun: r.dryRun,
    deleted: r.deleted.length,
    bytes,
    peopleFiles: r.deleted.filter((f) => f.people).length,
    leftovers: r.leftovers.length,
    failed: result.failed,
    receipt,
    next: r.todo.map((t) => t.command || `${t.step}: ${t.why}`),
  }, result.failed.length ? 2 : 0);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) main(process.argv.slice(2));
