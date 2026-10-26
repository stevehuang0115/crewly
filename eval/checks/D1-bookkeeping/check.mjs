// Checker for eval task D1 (bookkeeping month-end summary). Runs in the work
// directory; recomputes the expected numbers from transactions.csv + the rules
// and compares them with what the agent wrote. Exit 0 = pass, 1 = fail.
import { readFileSync, existsSync } from 'node:fs';

const RULES = [
  ['sales', ['stripe payout', 'shopify payout']],
  ['software', ['adobe', 'google workspace', 'zoom']],
  ['travel', ['uber', 'lyft']],
  ['office_supplies', ['office depot']],
  ['advertising', ['meta ads']],
  ['rent', ['rent']],
];
const failures = [];
const fail = (m) => failures.push(m);
const round2 = (n) => Math.round(n * 100) / 100;

const rows = readFileSync('transactions.csv', 'utf8').trim().split('\n').slice(1).map((l) => {
  const [date, description, amount] = l.split(',');
  return { date, description, amount: Number(amount) };
});
const byCategory = {};
let income = 0, expenses = 0;
const uncategorized = [];
for (const r of rows) {
  const d = r.description.toLowerCase();
  const rule = RULES.find(([, kws]) => kws.some((k) => d.includes(k)));
  if (!rule) { uncategorized.push(r); continue; }
  byCategory[rule[0]] = round2((byCategory[rule[0]] ?? 0) + r.amount);
  if (r.amount > 0) income += r.amount; else expenses += -r.amount;
}
income = round2(income); expenses = round2(expenses);
const net = round2(income - expenses);

if (!existsSync('reports/2026-09-summary.json')) {
  fail('reports/2026-09-summary.json is missing');
} else {
  let got;
  try { got = JSON.parse(readFileSync('reports/2026-09-summary.json', 'utf8')); } catch (e) { fail(`summary is not valid JSON: ${e.message}`); }
  if (got) {
    const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.011;
    if (got.month !== '2026-09') fail(`month: expected "2026-09", got ${JSON.stringify(got.month)}`);
    if (!near(got.income, income)) fail(`income: expected ${income}, got ${got.income}`);
    if (!near(got.expenses, expenses)) fail(`expenses: expected ${expenses}, got ${got.expenses}`);
    if (!near(got.net, net)) fail(`net: expected ${net}, got ${got.net}`);
    const gotCats = got.byCategory && typeof got.byCategory === 'object' ? got.byCategory : {};
    for (const [cat, sum] of Object.entries(byCategory)) {
      if (!near(gotCats[cat], sum)) fail(`byCategory.${cat}: expected ${sum}, got ${gotCats[cat]}`);
    }
    for (const cat of Object.keys(gotCats)) {
      if (!(cat in byCategory)) fail(`byCategory has an unexpected category "${cat}"`);
    }
  }
}

if (!existsSync('reports/needs-review.csv')) {
  fail('reports/needs-review.csv is missing');
} else {
  const lines = readFileSync('reports/needs-review.csv', 'utf8').trim().split('\n');
  if (lines[0]?.trim() !== 'date,description,amount') fail(`needs-review.csv header: expected "date,description,amount", got "${lines[0]}"`);
  const got = lines.slice(1).map((l) => l.trim()).filter(Boolean).sort();
  const want = uncategorized.map((r) => `${r.date},${r.description},${r.amount.toFixed(2)}`).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`needs-review.csv rows: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

if (failures.length) { console.error(`D1 FAIL\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log(`D1 PASS: income ${income}, expenses ${expenses}, net ${net}, ${uncategorized.length} rows for review`);
