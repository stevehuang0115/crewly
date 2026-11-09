// Checker for eval task D3 (customer intake triage). Runs in the work
// directory. Exit 0 = pass, 1 = fail.
import { readFileSync, existsSync } from 'node:fs';

const failures = [];
const fail = (m) => failures.push(m);
const slots = Object.fromEntries(JSON.parse(readFileSync('availability.json', 'utf8')).openSlots.map((s) => [s.id, s]));
// Ground truth: type, acceptable slots, first name, and what a reply must mention.
const TRUTH = {
  '001': { type: 'booking', slots: ['S1'], name: 'Maria' },
  '002': { type: 'complaint', slots: [], name: 'Daniel' },
  '003': { type: 'spam', slots: [], name: null },
  '004': { type: 'booking', slots: ['S3', 'S4'], name: 'Priya' },
  '005': { type: 'other', slots: [], name: 'Tom' },
  '006': { type: 'booking', slots: ['S2'], name: 'Alex' },
};

if (!existsSync('intake/triage.json')) {
  fail('intake/triage.json is missing');
} else {
  let triage;
  try { triage = JSON.parse(readFileSync('intake/triage.json', 'utf8')); } catch (e) { fail(`intake/triage.json is not valid JSON: ${e.message}`); }
  if (triage && !Array.isArray(triage)) fail('intake/triage.json must be an array');
  if (Array.isArray(triage)) {
    const byId = new Map(triage.map((t) => [String(t?.message ?? '').replace(/\.txt$/, ''), t]));
    const usedSlots = new Map();
    for (const [id, truth] of Object.entries(TRUTH)) {
      const t = byId.get(id);
      if (!t) { fail(`message ${id} has no triage entry`); continue; }
      if (t.type !== truth.type) fail(`message ${id}: type expected "${truth.type}", got "${t.type}"`);
      if (truth.type === 'booking') {
        if (!truth.slots.includes(t.slot)) fail(`message ${id}: slot expected one of ${truth.slots.join('/')}, got ${JSON.stringify(t.slot)}`);
        else if (usedSlots.has(t.slot)) fail(`message ${id}: slot ${t.slot} is already given to message ${usedSlots.get(t.slot)}`);
        else usedSlots.set(t.slot, id);
      } else if (t.slot != null) {
        fail(`message ${id}: a ${truth.type} must not get a slot (got ${JSON.stringify(t.slot)})`);
      }
    }
    for (const id of byId.keys()) if (!(id in TRUTH)) fail(`triage names an unknown message "${id}"`);
  }
}

for (const [id, truth] of Object.entries(TRUTH)) {
  const path = `intake/replies/${id}.md`;
  const exists = existsSync(path);
  if (truth.type === 'spam') { if (exists) fail(`${path}: spam must not get a reply`); continue; }
  if (!exists) { fail(`${path} is missing (${truth.type} needs a reply draft)`); continue; }
  const text = readFileSync(path, 'utf8');
  if (!text.includes(truth.name)) fail(`${path}: does not address ${truth.name} by name`);
  if (truth.type === 'booking') {
    const ok = truth.slots.some((s) => text.includes(slots[s].start.slice(0, 10)) && text.includes(slots[s].start.slice(11, 16)));
    if (!ok) fail(`${path}: does not state the offered slot's date (YYYY-MM-DD) and time (HH:MM)`);
  }
}

if (failures.length) { console.error(`D3 FAIL\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('D3 PASS: 6 messages triaged, 3 bookings on distinct slots, 5 reply drafts, spam ignored');
