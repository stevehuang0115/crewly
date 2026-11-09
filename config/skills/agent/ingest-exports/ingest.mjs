#!/usr/bin/env node
/**
 * ingest-exports — read CSV exports from small-business tools and write them
 * in one common schema (crewly#1061, small-business check-up fallback).
 *
 * The source tool is recognised by its column headers; rows become records
 * of kind contact / booking / payment / invoice with the original columns
 * kept. A CSV nobody recognises still loads (kind "other", source "unknown")
 * with a "could not map" note, so nothing the owner exported is lost.
 *
 * Usage (normally through execute.sh):
 *   node ingest.mjs --in <file-or-dir> [--in ...] --out <dir> [--hash-names] [--detect-only]
 *
 * Output: one JSON line on stdout (the summary), and under --out one
 * <name>.json per input file plus summary.json. Exit 0 when every file loaded,
 * 2 when some file could not be read at all, 1 on a usage error.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

/** Schema version written into every output file. */
const SCHEMA_VERSION = '1.0';

/** Record kinds of the common schema. */
const KINDS = ['contact', 'booking', 'payment', 'invoice', 'other'];

/** Columns whose values identify a person; hashed under --hash-names. */
const PERSONAL_COLUMN_RE = /(^|[\s_-])(name|first|last|surname|family|student|child|parent|email|e-mail|phone|mobile|address|contact|customer|invitee)([\s_'-]|$)/i;

/** Columns that mention a person but hold a count or age, not an identity ("Child's Age", "Customer Count"). */
const NOT_PERSONAL_COLUMN_RE = /(^|[\s_-])(age|count|rating|total|spend|visits?)([\s_'-]|$)/i;

/**
 * Source signatures: a file is that source when every `requires` header is
 * present (case-insensitive) and no `forbids` header is. First match wins,
 * so the more specific signatures come first.
 */
const SIGNATURES = [
  {
    source: 'square', kind: 'payment', label: 'Square transactions export',
    requires: ['date', 'gross sales', 'net sales', 'payment id'],
    map: { at: ['date', 'time'], amount: 'total collected', currency: () => 'USD', status: 'payment status', id: 'transaction id', name: 'customer name', email: 'customer email', item: 'description' },
  },
  {
    source: 'square', kind: 'contact', label: 'Square customers export',
    requires: ['first name', 'last name', 'email address', 'creation source'],
    map: { name: ['first name', 'last name'], email: 'email address', phone: 'phone number', at: 'first visit', amount: 'total spend', id: 'reference id' },
  },
  {
    source: 'quickbooks', kind: 'invoice', label: 'QuickBooks Online invoice list',
    requires: ['date', 'transaction type', 'num', 'customer', 'amount', 'open balance'],
    map: { at: 'date', amount: 'amount', currency: () => 'USD', name: 'customer', id: 'num', item: 'memo/description', dueAt: 'due date', balance: 'open balance', status: (r) => (toNumber(r['Open Balance']) === 0 ? 'paid' : 'open') },
  },
  {
    source: 'quickbooks', kind: 'contact', label: 'QuickBooks Online customer list',
    requires: ['customer', 'email', 'phone numbers'],
    map: { name: 'customer', email: 'email', phone: 'phone numbers' },
  },
  {
    source: 'mailchimp', kind: 'contact', label: 'Mailchimp audience export',
    requires: ['email address', 'first name', 'last name', 'member_rating', 'optin_time'],
    map: { name: ['first name', 'last name'], email: 'email address', phone: 'phone number', at: 'optin_time', tags: 'tags', status: () => 'subscribed' },
  },
  {
    source: 'jotform', kind: 'booking', label: 'Jotform submissions export',
    requires: ['submission date', 'submission id'],
    map: { at: 'submission date', id: 'submission id', name: (r) => firstMatching(r, /parent name|^name$|full name|your name/i), email: (r) => firstMatching(r, /e-?mail/i), phone: (r) => firstMatching(r, /phone/i), item: (r) => firstMatching(r, /class|service|event|session|which/i) },
  },
  {
    source: 'jackrabbit', kind: 'booking', label: 'Jackrabbit enrollment export',
    requires: ['family', 'class', 'enroll date'],
    map: { at: 'enroll date', name: ['student first name', 'student last name'], email: 'primary contact email', item: 'class', amount: 'tuition fee', currency: () => 'USD', status: (r) => (r['Drop Date'] ? 'dropped' : 'enrolled'), endAt: 'drop date' },
  },
  {
    source: 'mindbody', kind: 'contact', label: 'Mindbody client export',
    requires: ['client id', 'first name', 'last name'],
    map: { id: 'client id', name: ['first name', 'last name'], email: 'email', phone: (r) => firstMatching(r, /mobile|phone/i), status: 'membership' },
  },
  {
    source: 'calendly', kind: 'booking', label: 'Calendly scheduled events export',
    requires: ['event type', 'invitee name', 'invitee email', 'start date & time'],
    map: { at: 'start date & time', name: 'invitee name', email: 'invitee email', item: 'event type', status: (r) => (r['Canceled'] && /yes|true/i.test(r['Canceled']) ? 'cancelled' : 'scheduled') },
  },
  {
    source: 'stripe', kind: 'payment', label: 'Stripe payments export',
    requires: ['id', 'amount', 'currency', 'status', 'created (utc)'],
    map: { id: 'id', amount: 'amount', currency: 'currency', status: 'status', at: 'created (utc)', email: 'customer email', item: 'description' },
  },
];

/**
 * Parse one CSV text (RFC 4180: quoted fields, doubled quotes, CR/LF, BOM).
 *
 * @param {string} text - File content
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const records = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      records.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); records.push(row); }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

/**
 * Find the signature whose required headers are all present.
 *
 * @param {string[]} headers - Column headers as exported
 * @returns {(typeof SIGNATURES)[number] | null}
 */
export function detectSource(headers) {
  const have = new Set(headers.map((h) => h.toLowerCase().trim()));
  return SIGNATURES.find((sig) => sig.requires.every((h) => have.has(h)) && !(sig.forbids ?? []).some((h) => have.has(h))) ?? null;
}

/** Value of the first column whose header matches `re`, else ''. */
function firstMatching(row, re) {
  const key = Object.keys(row).find((k) => re.test(k));
  return key ? row[key] : '';
}

/**
 * "1,250.00", "$45.00", "(12.50)" → number; '' or junk → null.
 *
 * @param {string | undefined} s - A money or count cell
 * @returns {number | null}
 */
export function toNumber(s) {
  if (s === undefined || s === null) return null;
  const neg = /^\(.*\)$/.test(s.trim());
  const cleaned = s.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

/**
 * Normalise a date cell to ISO `YYYY-MM-DD[THH:MM:SS]`. Accepts ISO, US
 * `MM/DD/YYYY`, and `YYYY-MM-DD HH:MM:SS`; anything else → null.
 *
 * @param {string} date - Date cell
 * @param {string} [time] - Optional separate time cell
 * @returns {string | null}
 */
export function toIsoDate(date, time) {
  if (!date) return null;
  let d = date.trim();
  const us = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/);
  if (us) d = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}${us[4]}`;
  const m = d.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);
  if (!m) return null;
  const t = (time && time.trim().match(/^\d{2}:\d{2}(:\d{2})?/)?.[0]) || m[2];
  return t ? `${m[1]}T${t.length === 5 ? `${t}:00` : t}` : m[1];
}

/** Short stable hash of a personal value (lower-cased, trimmed). */
function hashValue(v) {
  return `h:${createHash('sha256').update(v.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

/** Read a mapping entry: a column name, a list of columns to join, or a function. */
function readField(row, spec) {
  if (spec === undefined) return '';
  if (typeof spec === 'function') return spec(row) ?? '';
  const cols = Array.isArray(spec) ? spec : [spec];
  const lower = Object.fromEntries(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  return cols.map((c) => row[lower[c.toLowerCase()]] ?? '').filter(Boolean).join(' ').trim();
}

/**
 * Turn one CSV row into a common-schema record.
 *
 * @param {Record<string, string>} row - The row as exported
 * @param {(typeof SIGNATURES)[number] | null} sig - Detected source, or null
 * @param {{ file: string, index: number, hashNames: boolean }} ctx
 * @returns {object}
 */
export function toRecord(row, sig, ctx) {
  const rec = {
    kind: sig ? sig.kind : 'other',
    source: sig ? sig.source : 'unknown',
    file: ctx.file,
    row: ctx.index + 1,
  };
  if (sig) {
    const m = sig.map;
    const id = readField(row, m.id); if (id) rec.id = id;
    const name = readField(row, m.name); if (name) rec.name = name;
    const email = readField(row, m.email); if (email) rec.email = email.toLowerCase();
    const phone = readField(row, m.phone); if (phone) rec.phone = phone;
    const atSpec = m.at;
    const at = Array.isArray(atSpec) ? toIsoDate(readField(row, atSpec[0]), readField(row, atSpec[1])) : toIsoDate(readField(row, atSpec));
    if (at) rec.at = at;
    const dueAt = toIsoDate(readField(row, m.dueAt)); if (dueAt) rec.dueAt = dueAt;
    const endAt = toIsoDate(readField(row, m.endAt)); if (endAt) rec.endAt = endAt;
    const amount = toNumber(readField(row, m.amount)); if (amount !== null) rec.amount = amount;
    const balance = toNumber(readField(row, m.balance)); if (balance !== null) rec.balance = balance;
    const currency = readField(row, m.currency); if (currency) rec.currency = currency.toUpperCase();
    const status = readField(row, m.status); if (status) rec.status = status.toLowerCase();
    const item = readField(row, m.item); if (item) rec.item = item;
    const tags = readField(row, m.tags); if (tags) rec.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  rec.original = { ...row };
  if (ctx.hashNames) {
    for (const k of ['name', 'email', 'phone']) if (rec[k]) rec[k] = hashValue(rec[k]);
    for (const [k, v] of Object.entries(rec.original)) {
      if (v && PERSONAL_COLUMN_RE.test(k) && !NOT_PERSONAL_COLUMN_RE.test(k)) rec.original[k] = hashValue(v);
    }
  }
  return rec;
}

/**
 * Ingest one CSV file.
 *
 * @param {string} path - Absolute path
 * @param {{ hashNames: boolean, sourceOverride?: string }} opts
 * @returns {object} The per-file result (also written to <out>/<name>.json)
 */
export function ingestFile(path, opts) {
  const file = basename(path);
  const text = readFileSync(path, 'utf8');
  const { headers, rows } = parseCsv(text);
  let sig = detectSource(headers);
  if (opts.sourceOverride) {
    const forced = SIGNATURES.find((s) => s.source === opts.sourceOverride && s.requires.every((h) => headers.map((x) => x.toLowerCase()).includes(h)));
    sig = forced ?? sig;
  }
  const records = rows.map((row, index) => toRecord(row, sig, { file, index, hashNames: opts.hashNames }));
  const dates = records.map((r) => r.at).filter(Boolean).sort();
  const mappedCols = new Set();
  if (sig) {
    for (const spec of Object.values(sig.map)) {
      if (typeof spec === 'string') mappedCols.add(spec.toLowerCase());
      else if (Array.isArray(spec)) spec.forEach((c) => mappedCols.add(c.toLowerCase()));
    }
  }
  const unmappedColumns = headers.filter((h) => !mappedCols.has(h.toLowerCase()));
  const notes = [];
  if (!sig) notes.push('could not map: no known export matches these headers; rows kept with their original columns only');
  if (headers.length === 0) notes.push('empty file: no header row');
  if (sig && records.length > 0 && dates.length === 0) notes.push('no row has a readable date');
  return {
    schemaVersion: SCHEMA_VERSION,
    file,
    path,
    source: sig ? sig.source : 'unknown',
    sourceLabel: sig ? sig.label : null,
    kind: sig ? sig.kind : 'other',
    rows: records.length,
    columns: headers,
    unmappedColumns,
    dateRange: dates.length ? { from: dates[0].slice(0, 10), to: dates[dates.length - 1].slice(0, 10) } : null,
    namesHashed: opts.hashNames,
    notes,
    records,
  };
}

/** Expand --in arguments: a directory contributes its *.csv files (one level). */
function expandInputs(inputs) {
  const files = [];
  for (const p of inputs) {
    const abs = resolve(p);
    if (!existsSync(abs)) { files.push({ path: abs, error: 'not found' }); continue; }
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (extname(name).toLowerCase() === '.csv') files.push({ path: join(abs, name) });
      }
    } else {
      files.push({ path: abs });
    }
  }
  return files;
}

function usage() {
  process.stderr.write('Usage: node ingest.mjs --in <file-or-dir> [--in ...] [--out <dir>] [--hash-names] [--detect-only] [--source <name>]\n');
  process.exit(1);
}

/** CLI entry. */
function main(argv) {
  const inputs = [];
  let out = '';
  let hashNames = false;
  let detectOnly = false;
  let sourceOverride;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') inputs.push(argv[++i] ?? usage());
    else if (a === '--out') out = argv[++i] ?? usage();
    else if (a === '--hash-names') hashNames = true;
    else if (a === '--detect-only') detectOnly = true;
    else if (a === '--source') sourceOverride = argv[++i] ?? usage();
    else if (a === '--help' || a === '-h') usage();
    else usage();
  }
  if (inputs.length === 0) usage();
  if (!detectOnly && !out) usage();

  const files = expandInputs(inputs);
  const summary = { success: true, schemaVersion: SCHEMA_VERSION, out: detectOnly ? null : resolve(out), namesHashed: hashNames, files: [], totals: { files: 0, rows: 0, byKind: {} } };
  let failed = 0;
  if (!detectOnly) mkdirSync(resolve(out), { recursive: true });
  for (const f of files) {
    if (f.error) { summary.files.push({ file: basename(f.path), path: f.path, error: f.error }); failed++; continue; }
    let result;
    try {
      result = ingestFile(f.path, { hashNames, sourceOverride });
    } catch (err) {
      summary.files.push({ file: basename(f.path), path: f.path, error: err instanceof Error ? err.message : String(err) });
      failed++;
      continue;
    }
    const { records, ...head } = result;
    if (!detectOnly) {
      const target = join(resolve(out), `${basename(f.path, extname(f.path))}.json`);
      writeFileSync(target, JSON.stringify(result, null, 2));
      head.output = target;
    }
    summary.files.push(head);
    summary.totals.files++;
    summary.totals.rows += records.length;
    summary.totals.byKind[head.kind] = (summary.totals.byKind[head.kind] ?? 0) + records.length;
  }
  summary.success = failed === 0;
  if (failed) summary.error = `${failed} file(s) could not be read`;
  if (!detectOnly) writeFileSync(join(resolve(out), 'summary.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(failed ? 2 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2));
}
