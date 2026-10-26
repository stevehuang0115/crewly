// Checker for eval task D4 (payment reminders). Runs in the work directory.
// Exit 0 = pass, 1 = fail.
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const failures = [];
const fail = (m) => failures.push(m);
const today = readFileSync('today.txt', 'utf8').trim();
const rows = readFileSync('invoices.csv', 'utf8').trim().split('\n').slice(1).map((l) => {
  const [invoice, customer, email, issued, due, amount, status] = l.split(',');
  return { invoice, customer, email, issued, due, amount: Number(amount), status };
});
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const overdue = rows
  .filter((r) => r.status === 'unpaid' && r.due < today)
  .map((r) => ({ ...r, days: daysBetween(r.due, today) }))
  .sort((a, b) => b.days - a.days);
const money = (n) => `USD ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const present = existsSync('reminders') ? readdirSync('reminders').filter((f) => f.endsWith('.md')) : [];
for (const f of present) {
  const inv = f.replace(/\.md$/, '');
  if (!overdue.some((r) => r.invoice === inv)) fail(`reminders/${f}: ${inv} is paid, not yet due, or unknown — no reminder expected`);
}
for (const r of overdue) {
  const path = `reminders/${r.invoice}.md`;
  if (!existsSync(path)) { fail(`${path} is missing (${r.days} days overdue)`); continue; }
  const text = readFileSync(path, 'utf8');
  if (!text.includes(r.invoice)) fail(`${path}: does not name the invoice ${r.invoice}`);
  if (!text.includes(money(r.amount))) fail(`${path}: does not state the amount as "${money(r.amount)}"`);
  if (!text.includes(r.due)) fail(`${path}: does not state the due date ${r.due}`);
  if (!text.includes(`${r.days} days overdue`)) fail(`${path}: does not say "${r.days} days overdue"`);
  if (!text.includes(`https://pay.example.test/${r.invoice}`)) fail(`${path}: missing the payment link https://pay.example.test/${r.invoice}`);
}

if (!existsSync('reminders/index.csv')) {
  fail('reminders/index.csv is missing');
} else {
  const lines = readFileSync('reminders/index.csv', 'utf8').trim().split('\n').map((l) => l.trim());
  if (lines[0] !== 'invoice,email,days_overdue') fail(`index.csv header: expected "invoice,email,days_overdue", got "${lines[0]}"`);
  const want = overdue.map((r) => `${r.invoice},${r.email},${r.days}`);
  const got = lines.slice(1).filter(Boolean);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`index.csv rows (most overdue first): expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

if (failures.length) { console.error(`D4 FAIL\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log(`D4 PASS: ${overdue.length} reminders, index in order`);
