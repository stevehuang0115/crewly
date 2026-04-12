import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const BASE = 'http://localhost:3457';
const DIR = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // 2b. Marketplace detail page (direct navigation)
  console.log('2b. Marketplace detail page');
  await page.goto(`${BASE}/marketplace/skill-nano-banana`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '02-marketplace-detail-page.png'), fullPage: true });
  console.log('  - Detail page captured at /marketplace/skill-nano-banana');

  // 3b. Projects — Completed section (collapsed)
  console.log('\n3b. Projects — Completed toggle');
  await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Find the Completed toggle/button and click to expand
  const completedBtn = page.locator('button:has-text("Completed"), [role="button"]:has-text("Completed"), summary:has-text("Completed")').first();
  if (await completedBtn.count() > 0) {
    console.log('  - Completed toggle found, clicking to expand...');
    // Force click since element might be in a collapsed section
    await completedBtn.click({ force: true }).catch(() => console.log('  - Click failed, trying JS click'));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(DIR, '03-projects-completed-expanded.png'), fullPage: true });
  } else {
    console.log('  - No Completed button, checking DOM...');
    const completedInfo = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      return els.filter(e => e.textContent?.includes('Completed') && e.children.length < 5)
        .slice(0, 5)
        .map(e => ({ tag: e.tagName, class: e.className?.substring?.(0, 60), text: e.textContent?.substring(0, 80), hidden: e.hidden || getComputedStyle(e).display === 'none' }));
    });
    console.log('  - Completed elements:', JSON.stringify(completedInfo, null, 2));
  }

  // 4b. Dashboard — full nav with grouping
  console.log('\n4b. Dashboard with nav');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Check nav groups
  const navInfo = await page.evaluate(() => {
    const nav = document.querySelector('nav');
    if (!nav) return { found: false };
    const text = nav.innerText;
    const groups = ['Work', 'Communicate', 'Tools', 'System', 'WORK', 'COMMUNICATE', 'TOOLS', 'SYSTEM'];
    const foundGroups = groups.filter(g => text.includes(g));
    return { found: true, text: text.substring(0, 500), groups: foundGroups };
  });
  console.log('  Nav info:', JSON.stringify(navInfo, null, 2));

  await browser.close();
  console.log('\nDone!');
}

run().catch(err => { console.error(err); process.exit(1); });
