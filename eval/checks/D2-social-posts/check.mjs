// Checker for eval task D2 (three social posts). Runs in the work directory.
// Exit 0 = pass, 1 = fail.
import { readFileSync, existsSync } from 'node:fs';

const failures = [];
const fail = (m) => failures.push(m);
const BANNED = ['synergy', 'game-changer', 'revolutionary', 'cheap'];
const CTA = 'https://rise-and-grind.test/order';
const LIMITS = { x: 280, instagram: 2200, linkedin: 3000 };
const products = JSON.parse(readFileSync('products.json', 'utf8')).map((p) => p.name);

if (!existsSync('posts/week-41.json')) {
  fail('posts/week-41.json is missing');
} else {
  let posts;
  try { posts = JSON.parse(readFileSync('posts/week-41.json', 'utf8')); } catch (e) { fail(`posts/week-41.json is not valid JSON: ${e.message}`); }
  if (posts && !Array.isArray(posts)) fail('posts/week-41.json must be an array');
  if (Array.isArray(posts)) {
    if (posts.length !== 3) fail(`expected exactly 3 posts, got ${posts.length}`);
    const platforms = posts.map((p) => p?.platform);
    for (const want of Object.keys(LIMITS)) if (!platforms.includes(want)) fail(`no post for platform "${want}"`);
    const used = new Set();
    posts.forEach((p, i) => {
      const where = `post ${i + 1} (${p?.platform ?? 'no platform'})`;
      if (typeof p?.text !== 'string' || !p.text.trim()) { fail(`${where}: text is missing`); return; }
      if (!products.includes(p.product)) fail(`${where}: product "${p.product}" is not a product name from products.json`);
      else if (used.has(p.product)) fail(`${where}: product "${p.product}" is used by another post`);
      used.add(p.product);
      if (p.product && !p.text.includes(p.product)) fail(`${where}: text does not name the product "${p.product}" verbatim`);
      if (!p.text.trimEnd().endsWith(CTA)) fail(`${where}: text does not end with the order link ${CTA}`);
      const lower = p.text.toLowerCase();
      for (const b of BANNED) if (lower.includes(b)) fail(`${where}: uses the banned word "${b}"`);
      const limit = LIMITS[p.platform];
      if (!limit) fail(`${where}: unknown platform "${p.platform}"`);
      else if ([...p.text].length > limit) fail(`${where}: ${[...p.text].length} characters, limit ${limit}`);
      if (p.platform === 'instagram') {
        const tags = (p.text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
        if (tags < 3) fail(`${where}: ${tags} hashtag(s), at least 3 required`);
      }
    });
  }
}

if (failures.length) { console.error(`D2 FAIL\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('D2 PASS: 3 posts, one per platform, brand rules kept');
