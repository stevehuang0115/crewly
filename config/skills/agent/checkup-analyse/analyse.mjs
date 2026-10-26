#!/usr/bin/env node
// =============================================================================
// checkup-analyse — the analysis step of the small-business check-up
// (crewly#1062). Reads the common-schema records that `ingest-exports` wrote,
// links the same person across every file, follows inquiry → sign-up →
// payment → repeat, and lists where that chain breaks:
//
//   inquiry_no_follow_through  a form submission with no sign-up or payment after it
//   signed_up_unpaid           a sign-up with no payment from that person
//   paid_not_listed            a payment from someone on no roster
//   dropped                    a sign-up marked dropped / cancelled
//   lapsed                     a customer with no activity for N days
//   overdue_invoices           an invoice past due with a balance
//   double_entry               the same person keyed into two or more systems
//   not_on_mailing_list        a customer the mailing list does not have
//
// Every break carries an hours/week and $/month estimate with the formula
// written out and marked as an estimate. No model calls, no dependencies.
//
//   node analyse.mjs --in <ingest out folder> [--out <folder>] [--as-of YYYY-MM-DD]
//                    [--assume hourlyValue=40] [--assume lapsedDays=60] ...
// =============================================================================
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

const SCHEMA_VERSION = '1.0';
const DAY_MS = 86_400_000;

/** Sources whose "booking" rows are inquiries (someone asked), not sign-ups. */
const INQUIRY_SOURCES = new Set(['jotform']);
/** Sources that are a mailing list rather than a customer record. */
const MAILING_SOURCES = new Set(['mailchimp']);
const DROPPED_STATUSES = new Set(['dropped', 'cancelled', 'canceled', 'withdrawn']);
const FAILED_PAYMENT_STATUSES = new Set(['failed', 'declined', 'voided', 'void', 'pending']);

/** Every number in an estimate comes from one of these; the owner can change any of them. */
export const DEFAULT_ASSUMPTIONS = {
  hourlyValue: 30, // $ an hour of the owner's or staff's time is worth
  minutesPerManualEntry: 4, // minutes to key one person into one more system
  minutesPerFollowUp: 10, // minutes to chase one inquiry, unpaid sign-up or invoice
  inquiryConversionRate: 0.3, // share of followed-up inquiries that become customers
  winBackRate: 0.2, // share of dropped or lapsed customers a nudge brings back
  listReachRate: 0.1, // share of customers a mailing list brings back for another purchase
  lapsedDays: 90, // days without activity before a customer counts as lapsed
  avgCustomerValue: null, // $ per customer; null = mean paid amount / sign-up fee in the data
};

const BREAK_DEFS = {
  inquiry_no_follow_through: {
    label: 'Inquiries with no sign-up or payment after them',
    agent: 'Reply to each open inquiry within the hour, offer the next free slot, and remind once after three days.',
  },
  signed_up_unpaid: {
    label: 'Sign-ups with no payment',
    agent: 'Send a payment link the day of sign-up and a reminder before the first session; flag anyone still unpaid to the owner.',
  },
  paid_not_listed: {
    label: 'Payments from people on no roster',
    agent: 'Match each payment to a booking or add the person to the roster, and ask the owner about the ones that match nothing.',
  },
  dropped: {
    label: 'Sign-ups that were dropped or cancelled',
    agent: 'Ask each one why in one short message, offer a make-up or the next session, and report the reasons back.',
  },
  lapsed: {
    label: 'Customers with no activity for a while',
    agent: 'Send a personal "we have a spot for you" note with the next dates, in batches, and track who comes back.',
  },
  overdue_invoices: {
    label: 'Invoices past due with a balance',
    agent: 'Send one friendly reminder per overdue invoice with the amount and a payment link, then a second after a week.',
  },
  double_entry: {
    label: 'The same person keyed into two or more systems',
    agent: 'Keep one system as the source of truth and copy new people into the others each day, so nothing is typed twice.',
  },
  not_on_mailing_list: {
    label: 'Customers the mailing list does not have',
    agent: 'Add each paying customer to the list (with consent) so the next class or offer reaches them.',
  },
};

// --- helpers ----------------------------------------------------------------

function isHash(v) {
  return typeof v === 'string' && v.startsWith('h:');
}
function normEmail(v) {
  if (!v) return '';
  const s = String(v).trim();
  return isHash(s) ? s : s.toLowerCase();
}
function normPhone(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (isHash(s)) return s;
  const d = s.replace(/\D/g, '');
  if (d.length < 7) return '';
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
function normName(v) {
  if (!v) return '';
  const s = String(v).trim();
  return isHash(s) ? s : s.toLowerCase().replace(/\s+/g, ' ');
}
function dayOf(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '';
}
function ms(iso) {
  const d = dayOf(iso);
  return d ? Date.parse(`${d}T00:00:00Z`) : NaN;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function money(n) {
  return Math.round(n);
}

// --- people -----------------------------------------------------------------

class People {
  constructor() {
    this.persons = [];
    this.keyToPerson = new Map();
  }
  /** Register a record under every identity it carries; merge persons the record joins. */
  add(rec) {
    const keys = [];
    const email = normEmail(rec.email);
    const phone = normPhone(rec.phone);
    const name = normName(rec.name);
    if (email) keys.push(`e:${email}`);
    if (phone) keys.push(`p:${phone}`);
    if (!email && !phone && name) keys.push(`n:${name}`);
    if (keys.length === 0) return null;
    const found = [...new Set(keys.map((k) => this.keyToPerson.get(k)).filter(Boolean))];
    let person = found[0];
    if (!person) {
      person = { id: this.persons.length + 1, names: new Set(), emails: new Set(), phones: new Set(), sources: new Set(), records: [] };
      this.persons.push(person);
    }
    for (const other of found.slice(1)) this.merge(person, other);
    for (const k of keys) this.keyToPerson.set(k, person);
    if (name) person.names.add(String(rec.name).trim());
    if (email) person.emails.add(email);
    if (phone) person.phones.add(phone);
    person.sources.add(rec.source || 'unknown');
    person.records.push(rec);
    return person;
  }
  merge(into, from) {
    for (const n of from.names) into.names.add(n);
    for (const e of from.emails) into.emails.add(e);
    for (const p of from.phones) into.phones.add(p);
    for (const s of from.sources) into.sources.add(s);
    into.records.push(...from.records);
    for (const [k, p] of this.keyToPerson) if (p === from) this.keyToPerson.set(k, into);
    from.merged = true;
  }
  live() {
    return this.persons.filter((p) => !p.merged);
  }
}

/** The name to show for a person: the adult on a contact or payment row before a child's name on a booking row. */
function label(person) {
  const adult = person.records.find((r) => (r.kind === 'contact' || r.kind === 'payment') && r.name);
  return (adult && String(adult.name).trim()) || [...person.names][0] || [...person.emails][0] || [...person.phones][0] || `person-${person.id}`;
}

// --- events -----------------------------------------------------------------

/** Turn a common-schema record into what happened: inquiry, signup, dropped, payment, refund, invoice, listed, contact. */
export function classify(rec) {
  const status = String(rec.status || '').toLowerCase();
  switch (rec.kind) {
    case 'payment':
      if (status === 'refunded') return 'refund';
      if (FAILED_PAYMENT_STATUSES.has(status)) return 'failed_payment';
      return 'payment';
    case 'invoice':
      return 'invoice';
    case 'booking':
      if (INQUIRY_SOURCES.has(rec.source)) return 'inquiry';
      return DROPPED_STATUSES.has(status) ? 'dropped' : 'signup';
    case 'contact':
      return MAILING_SOURCES.has(rec.source) ? 'listed' : 'contact';
    default:
      return 'other';
  }
}

// --- loading ----------------------------------------------------------------

function loadRecords(inputs) {
  const files = [];
  const problems = [];
  for (const input of inputs) {
    const p = resolve(input);
    if (!existsSync(p)) {
      problems.push(`${input}: not found`);
      continue;
    }
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.endsWith('.json') && f !== 'summary.json') files.push(join(p, f));
      }
    } else if (p.endsWith('.json')) {
      files.push(p);
    } else {
      problems.push(`${input}: not an ingest-exports JSON file (run ingest-exports first)`);
    }
  }
  const records = [];
  const sources = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      if (!Array.isArray(data.records)) {
        problems.push(`${basename(f)}: no records array`);
        continue;
      }
      sources.push({ file: data.file || basename(f), source: data.source || 'unknown', kind: data.kind || 'other', rows: data.records.length });
      records.push(...data.records.map((r) => ({ ...r, event: classify(r) })));
    } catch (e) {
      problems.push(`${basename(f)}: ${e.message}`);
    }
  }
  return { records, sources, problems };
}

// --- analysis ---------------------------------------------------------------

function parseAssumptions(pairs) {
  const a = { ...DEFAULT_ASSUMPTIONS };
  for (const pair of pairs) {
    const [k, v] = String(pair).split('=');
    if (!(k in DEFAULT_ASSUMPTIONS)) throw new Error(`unknown assumption "${k}" (known: ${Object.keys(DEFAULT_ASSUMPTIONS).join(', ')})`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`assumption ${k} needs a number, got "${v}"`);
    a[k] = n;
  }
  return a;
}

export function analyse(records, opts = {}) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...(opts.assumptions || {}) };
  const notes = [];
  const people = new People();
  const anonymous = {};
  let ignored = 0;

  for (const rec of records) {
    if (rec.event === 'other') {
      ignored += 1;
      continue;
    }
    if (!people.add(rec)) anonymous[rec.event] = (anonymous[rec.event] || 0) + 1;
  }
  const persons = people.live();
  const used = records.filter((r) => r.event !== 'other');
  const systems = [...new Set(used.map((r) => r.source || 'unknown'))].sort();
  const hasSignupSystem = records.some((r) => r.event === 'signup' || r.event === 'dropped');
  const hasMailingList = records.some((r) => r.event === 'listed');

  // Period: first activity → as-of (default: the last activity in the data). Activity means
  // something happened (an inquiry, sign-up, payment, invoice), not when a contact was created.
  const ACTIVITY = new Set(['inquiry', 'signup', 'dropped', 'payment', 'refund', 'failed_payment', 'invoice']);
  const ats = used.filter((r) => ACTIVITY.has(r.event)).map((r) => ms(r.at)).filter(Number.isFinite);
  const firstMs = ats.length ? Math.min(...ats) : NaN;
  const lastMs = ats.length ? Math.max(...ats) : NaN;
  const asOfMs = opts.asOf ? ms(opts.asOf) : lastMs;
  if (!Number.isFinite(asOfMs)) throw new Error('no dated records and no --as-of; nothing to analyse');
  const asOf = new Date(asOfMs).toISOString().slice(0, 10);
  const days = Number.isFinite(firstMs) ? Math.max(1, Math.round((asOfMs - firstMs) / DAY_MS)) : 1;
  const weeks = Math.max(1, days / 7);
  const months = Math.max(1, days / 30.44);
  const period = { from: Number.isFinite(firstMs) ? new Date(firstMs).toISOString().slice(0, 10) : asOf, to: asOf, days, weeks: round1(weeks), months: round1(months) };

  // Average customer value: mean of completed payments and sign-up fees unless assumed.
  let avgCustomerValue = a.avgCustomerValue;
  let avgSource = 'assumed';
  if (avgCustomerValue == null) {
    const amounts = records.filter((r) => (r.event === 'payment' || r.event === 'signup') && Number(r.amount) > 0).map((r) => Number(r.amount));
    if (amounts.length) {
      avgCustomerValue = Math.round(amounts.reduce((s, n) => s + n, 0) / amounts.length);
      avgSource = `mean of ${amounts.length} paid amounts and sign-up fees in the data`;
    } else {
      avgCustomerValue = 50;
      avgSource = 'default (no paid amounts in the data)';
      notes.push('No paid amounts or sign-up fees in the data; $ estimates use a $50 customer value.');
    }
  }
  const hoursWeek = (count, minutes) => round1((count * minutes) / 60 / weeks);
  const dollarsMonthFromHours = (h) => money(h * 4.345 * a.hourlyValue);

  const evs = (p, ...types) => p.records.filter((r) => types.includes(r.event));
  const breaks = [];

  // 1. Inquiry with no follow-through
  {
    const items = [];
    for (const p of persons) {
      const inquiries = evs(p, 'inquiry');
      if (!inquiries.length) continue;
      if (evs(p, 'signup', 'dropped', 'payment').length) continue;
      const first = inquiries.sort((x, y) => String(x.at).localeCompare(String(y.at)))[0];
      items.push({ person: label(p), inquiredAt: dayOf(first.at), item: first.item || null, source: first.source });
    }
    const n = items.length;
    const h = hoursWeek(n, a.minutesPerFollowUp);
    const d = money((n * a.inquiryConversionRate * avgCustomerValue) / months);
    breaks.push(mkBreak('inquiry_no_follow_through', items, h, d, `${n} inquiries × ${a.inquiryConversionRate} conversion × $${avgCustomerValue} customer value ÷ ${round1(months)} months = $${d}/month; ${n} × ${a.minutesPerFollowUp} min follow-up ÷ ${round1(weeks)} weeks = ${h} h/week`));
  }

  // 2. Signed up but unpaid
  {
    const items = [];
    for (const p of persons) {
      const payments = evs(p, 'payment');
      for (const s of evs(p, 'signup')) {
        const since = ms(s.at) - 7 * DAY_MS;
        const paid = payments.some((pay) => !Number.isFinite(since) || !Number.isFinite(ms(pay.at)) || ms(pay.at) >= since);
        if (paid) continue;
        items.push({ person: label(p), item: s.item || null, signedUpAt: dayOf(s.at), fee: Number(s.amount) || 0, source: s.source });
      }
    }
    const n = items.length;
    const outstanding = money(items.reduce((s, i) => s + i.fee, 0));
    const h = hoursWeek(n, a.minutesPerFollowUp);
    const d = money(outstanding / months);
    breaks.push(mkBreak('signed_up_unpaid', items, h, d, `$${outstanding} in unpaid fees ÷ ${round1(months)} months = $${d}/month; ${n} × ${a.minutesPerFollowUp} min ÷ ${round1(weeks)} weeks = ${h} h/week`, { outstanding }));
  }

  // 3. Paid but on no roster (only meaningful when a roster system is in the data)
  {
    const items = [];
    if (hasSignupSystem) {
      for (const p of persons) {
        const payments = evs(p, 'payment');
        if (!payments.length || evs(p, 'signup', 'dropped').length) continue;
        for (const pay of payments) items.push({ person: label(p), paidAt: dayOf(pay.at), amount: Number(pay.amount) || 0, item: pay.item || null, source: pay.source });
      }
    } else {
      notes.push('No roster or booking export in the data, so "paid but not listed" could not be checked.');
    }
    const n = items.length;
    const h = hoursWeek(n, a.minutesPerFollowUp);
    breaks.push(mkBreak('paid_not_listed', items, h, 0, `${n} payments × ${a.minutesPerFollowUp} min to reconcile ÷ ${round1(weeks)} weeks = ${h} h/week; no $ figure (the money arrived; the risk is a person who shows up unlisted)`));
  }

  // 4. Dropped sign-ups
  {
    const items = [];
    for (const p of persons) {
      for (const s of evs(p, 'dropped')) items.push({ person: label(p), item: s.item || null, signedUpAt: dayOf(s.at), droppedAt: dayOf(s.endAt) || null, fee: Number(s.amount) || 0, source: s.source });
    }
    const n = items.length;
    const fees = money(items.reduce((s, i) => s + i.fee, 0));
    const h = hoursWeek(n, a.minutesPerFollowUp);
    const d = money((fees * a.winBackRate) / months);
    breaks.push(mkBreak('dropped', items, h, d, `$${fees} in dropped fees × ${a.winBackRate} win-back ÷ ${round1(months)} months = $${d}/month; ${n} × ${a.minutesPerFollowUp} min ÷ ${round1(weeks)} weeks = ${h} h/week`));
  }

  // 5. Lapsed customers
  {
    const items = [];
    const cutoff = asOfMs - a.lapsedDays * DAY_MS;
    for (const p of persons) {
      const customerEvents = evs(p, 'payment', 'signup', 'dropped');
      if (!customerEvents.length) continue;
      const stamps = p.records.flatMap((r) => [ms(r.at), ms(r.endAt)]).filter(Number.isFinite);
      if (!stamps.length) continue;
      const last = Math.max(...stamps);
      if (last >= cutoff) continue;
      const totalPaid = money(evs(p, 'payment').reduce((s, r) => s + (Number(r.amount) || 0), 0));
      items.push({ person: label(p), lastActivity: new Date(last).toISOString().slice(0, 10), daysSince: Math.round((asOfMs - last) / DAY_MS), totalPaid });
    }
    const n = items.length;
    const h = hoursWeek(n, a.minutesPerFollowUp);
    const d = money((n * a.winBackRate * avgCustomerValue) / months);
    breaks.push(mkBreak('lapsed', items, h, d, `${n} lapsed (no activity for ${a.lapsedDays} days) × ${a.winBackRate} win-back × $${avgCustomerValue} ÷ ${round1(months)} months = $${d}/month; ${n} × ${a.minutesPerFollowUp} min ÷ ${round1(weeks)} weeks = ${h} h/week`));
  }

  // 6. Overdue invoices
  {
    const items = [];
    let openNotDue = 0;
    for (const r of records) {
      if (r.event !== 'invoice' || !(Number(r.balance) > 0)) continue;
      const due = ms(r.dueAt);
      if (Number.isFinite(due) && due < asOfMs) {
        items.push({ customer: r.name || null, number: r.id || null, dueAt: dayOf(r.dueAt), daysOverdue: Math.round((asOfMs - due) / DAY_MS), balance: Number(r.balance), source: r.source });
      } else {
        openNotDue += 1;
      }
    }
    const n = items.length;
    const outstanding = money(items.reduce((s, i) => s + i.balance, 0));
    const h = hoursWeek(n, a.minutesPerFollowUp);
    const d = money(outstanding / months);
    breaks.push(mkBreak('overdue_invoices', items, h, d, `$${outstanding} overdue ÷ ${round1(months)} months = $${d}/month; ${n} × ${a.minutesPerFollowUp} min ÷ ${round1(weeks)} weeks = ${h} h/week`, { outstanding, openNotYetDue: openNotDue }));
  }

  // 7. Double entry
  {
    const items = [];
    let extraEntries = 0;
    for (const p of persons) {
      if (p.sources.size < 2) continue;
      const conflicts = [];
      const withPhone = new Set(p.records.filter((r) => normPhone(r.phone)).map((r) => r.source));
      const withoutPhone = [...p.sources].filter((s) => !withPhone.has(s) && p.records.some((r) => r.source === s && r.kind === 'contact'));
      if (withPhone.size && withoutPhone.length) conflicts.push(`phone missing in ${withoutPhone.join(', ')}`);
      // Only names on contact rows are compared: a booking row carries the child's name, which is not a conflict.
      const contactNames = [...new Set(p.records.filter((r) => r.kind === 'contact' && r.name).map((r) => String(r.name).trim()))];
      if (new Set(contactNames.map(normName)).size > 1) conflicts.push(`names differ: ${contactNames.join(' / ')}`);
      extraEntries += p.sources.size - 1;
      items.push({ person: label(p), systems: [...p.sources].sort(), conflicts });
    }
    const n = items.length;
    const h = round1((extraEntries * a.minutesPerManualEntry) / 60 / weeks);
    const d = dollarsMonthFromHours(h);
    breaks.push(mkBreak('double_entry', items, h, d, `${extraEntries} extra entries × ${a.minutesPerManualEntry} min ÷ ${round1(weeks)} weeks = ${h} h/week; × 4.345 weeks × $${a.hourlyValue}/h = $${d}/month`, { extraEntries, people: n }));
  }

  // 8. Customers not on the mailing list (only when a mailing list is in the data)
  {
    const items = [];
    if (hasMailingList) {
      for (const p of persons) {
        if (!evs(p, 'payment', 'signup', 'dropped').length || evs(p, 'listed').length) continue;
        items.push({ person: label(p) });
      }
    } else {
      notes.push('No mailing-list export in the data, so "not on the mailing list" could not be checked.');
    }
    const n = items.length;
    const d = money((n * a.listReachRate * avgCustomerValue) / months);
    breaks.push(mkBreak('not_on_mailing_list', items, 0, d, `${n} customers × ${a.listReachRate} reach × $${avgCustomerValue} ÷ ${round1(months)} months = $${d}/month; adding them is a one-off`));
  }

  const ranked = breaks.filter((b) => b.count > 0).sort((x, y) => y.estimate.dollarsPerMonth - x.estimate.dollarsPerMonth || y.estimate.hoursPerWeek - x.estimate.hoursPerWeek);
  const refunds = records.filter((r) => r.event === 'refund');
  const stats = {
    records: records.length,
    ignoredOtherRows: ignored,
    people: persons.length,
    systems,
    byEvent: countBy(records, (r) => r.event),
    anonymousRows: anonymous,
    refunds: { count: refunds.length, amount: money(refunds.reduce((s, r) => s + (Number(r.amount) || 0), 0)) },
    avgCustomerValue,
    avgCustomerValueFrom: avgSource,
  };
  const totals = {
    hoursPerWeek: round1(breaks.reduce((s, b) => s + b.estimate.hoursPerWeek, 0)),
    dollarsPerMonth: money(breaks.reduce((s, b) => s + b.estimate.dollarsPerMonth, 0)),
  };
  return { schemaVersion: SCHEMA_VERSION, asOf, period, assumptions: { ...a, avgCustomerValue }, stats, breaks, top3: ranked.slice(0, 3).map((b) => b.type), totals, notes };
}

function mkBreak(type, items, hoursPerWeek, dollarsPerMonth, formula, extra = {}) {
  return {
    type,
    label: BREAK_DEFS[type].label,
    count: items.length,
    items,
    estimate: { hoursPerWeek, dollarsPerMonth, ...extra, formula, isEstimate: true },
    whatAnAgentCouldDo: BREAK_DEFS[type].agent,
  };
}

function countBy(list, fn) {
  const out = {};
  for (const x of list) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// --- report -----------------------------------------------------------------

export function renderReport(result, sources) {
  const L = [];
  L.push('# Check-up: where the apps disagree');
  L.push('');
  L.push(`As of ${result.asOf}. Data covers ${result.period.from} to ${result.period.to} (${result.period.days} days) across ${result.stats.systems.join(', ')}: ${result.stats.records} rows, ${result.stats.people} people.`);
  L.push('');
  L.push(`Every hour and dollar figure below is an **estimate** from the assumptions at the end; change an assumption and the numbers follow. Together the breaks come to about **${result.totals.hoursPerWeek} h/week** and **$${result.totals.dollarsPerMonth}/month**.`);
  L.push('');
  L.push('## Top 3');
  L.push('');
  const byType = Object.fromEntries(result.breaks.map((b) => [b.type, b]));
  if (!result.top3.length) L.push('No breaks found in this data.');
  result.top3.forEach((t, i) => {
    const b = byType[t];
    L.push(`### ${i + 1}. ${b.label} — ${b.count}`);
    L.push('');
    L.push(`Estimate: ${b.estimate.hoursPerWeek} h/week, $${b.estimate.dollarsPerMonth}/month.`);
    L.push(`How: ${b.estimate.formula}.`);
    L.push(`What an agent could do: ${b.whatAnAgentCouldDo}`);
    L.push('');
  });
  L.push('## Every break');
  L.push('');
  L.push('| Break | Count | h/week | $/month |');
  L.push('|---|---:|---:|---:|');
  for (const b of result.breaks) L.push(`| ${b.label} | ${b.count} | ${b.estimate.hoursPerWeek} | ${b.estimate.dollarsPerMonth} |`);
  L.push('');
  if (result.notes.length) {
    L.push('## Could not check');
    L.push('');
    for (const n of result.notes) L.push(`- ${n}`);
    L.push('');
  }
  L.push('## Files');
  L.push('');
  for (const s of sources) L.push(`- ${s.file}: ${s.source} ${s.kind}, ${s.rows} rows`);
  L.push('');
  L.push('## Assumptions');
  L.push('');
  for (const [k, v] of Object.entries(result.assumptions)) L.push(`- ${k}: ${v}${k === 'avgCustomerValue' ? ` (${result.stats.avgCustomerValueFrom})` : ''}`);
  L.push('');
  return L.join('\n');
}

// --- CLI --------------------------------------------------------------------

function usage() {
  process.stdout.write(
    JSON.stringify({ success: false, error: 'usage: analyse.mjs --in <ingest-exports out folder or <file>.json> [--out <folder>] [--as-of YYYY-MM-DD] [--assume key=value ...]' }) + '\n',
  );
  process.exit(1);
}

function main(argv) {
  const inputs = [];
  const assume = [];
  let out = null;
  let asOf = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in') inputs.push(argv[++i]);
    else if (arg === '--out') out = argv[++i];
    else if (arg === '--as-of') asOf = argv[++i];
    else if (arg === '--assume') assume.push(argv[++i]);
    else if (arg === '--help' || arg === '-h') usage();
    else usage();
  }
  if (!inputs.length || inputs.some((x) => !x)) usage();
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    process.stdout.write(JSON.stringify({ success: false, error: `--as-of must be YYYY-MM-DD, got "${asOf}"` }) + '\n');
    process.exit(1);
  }
  let assumptions;
  try {
    assumptions = parseAssumptions(assume);
  } catch (e) {
    process.stdout.write(JSON.stringify({ success: false, error: e.message }) + '\n');
    process.exit(1);
  }

  const { records, sources, problems } = loadRecords(inputs);
  if (!records.length) {
    process.stdout.write(JSON.stringify({ success: false, error: 'no records found', problems }) + '\n');
    process.exit(2);
  }
  let result;
  try {
    result = analyse(records, { asOf, assumptions });
  } catch (e) {
    process.stdout.write(JSON.stringify({ success: false, error: e.message, problems }) + '\n');
    process.exit(2);
  }
  result.files = sources;
  result.problems = problems;

  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'breaks.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(out, 'report.md'), renderReport(result, sources));
  }
  const summary = {
    success: problems.length === 0,
    asOf: result.asOf,
    period: result.period,
    people: result.stats.people,
    systems: result.stats.systems,
    breaks: result.breaks.map((b) => ({ type: b.type, count: b.count, hoursPerWeek: b.estimate.hoursPerWeek, dollarsPerMonth: b.estimate.dollarsPerMonth })),
    top3: result.top3,
    totals: result.totals,
    notes: result.notes,
    problems,
    out: out ? resolve(out) : null,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exit(problems.length ? 2 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
