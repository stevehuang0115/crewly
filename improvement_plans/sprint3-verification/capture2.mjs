import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const BASE = 'http://localhost:3457';
const DIR = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // ═══════════════════════════════════════════
  // 2. Security — Security Score Widget
  // ═══════════════════════════════════════════
  console.log('=== 2. Security — Score Widget ===');
  await page.goto(`${BASE}/security`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '02-security-full.png'), fullPage: true });

  // Check for score widget by testid, class, or text
  const scoreByTestId = page.locator('[data-testid*="score"]');
  const scoreByClass = page.locator('[class*="Score"]');
  const scoreByText = page.getByText(/Security Score/i);
  const scoreNum = page.getByText(/\/100/);

  const counts = {
    testId: await scoreByTestId.count(),
    class: await scoreByClass.count(),
    text: await scoreByText.count(),
    num: await scoreNum.count(),
  };
  console.log('  Score element counts:', JSON.stringify(counts));

  if (counts.class > 0) {
    await scoreByClass.first().screenshot({ path: path.join(DIR, '02-security-score-closeup.png') });
    console.log('  Score widget captured (by class)');
  } else if (counts.text > 0) {
    const parent = scoreByText.first().locator('..');
    await parent.screenshot({ path: path.join(DIR, '02-security-score-closeup.png') });
    console.log('  Score widget captured (by text)');
  } else if (counts.testId > 0) {
    await scoreByTestId.first().screenshot({ path: path.join(DIR, '02-security-score-closeup.png') });
    console.log('  Score widget captured (by testid)');
  } else {
    console.log('  No score widget found. Checking page content...');
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    const scoreRelated = bodyText.match(/score|Score|rating|\d+\/100|\d+\s*%/gi);
    console.log('  Score-related text:', scoreRelated || 'NONE');

    // Capture top section anyway
    const topSection = page.locator('main > div').first();
    if (await topSection.count() > 0) {
      await topSection.screenshot({ path: path.join(DIR, '02-security-top-section.png') });
    }
  }

  // ═══════════════════════════════════════════
  // 3. Navigation — Pinned Favorites
  // ═══════════════════════════════════════════
  console.log('\n=== 3. Navigation — Pinned Favorites ===');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const nav = page.locator('nav').first();
  if (await nav.count() > 0) {
    await nav.screenshot({ path: path.join(DIR, '03-nav-sidebar.png') });
    const navText = await nav.innerText();
    console.log('  Nav text:', navText.replace(/\n+/g, ' | '));

    const navHTML = await nav.innerHTML();
    const hasPinIcon = navHTML.includes('pin') || navHTML.includes('Pin') || navHTML.includes('star') || navHTML.includes('Star') || navHTML.includes('favorite') || navHTML.includes('Favorite') || navHTML.includes('bookmark') || navHTML.includes('Bookmark');
    console.log(`  Pin/Star/Favorite/Bookmark: ${hasPinIcon ? 'FOUND' : 'NOT FOUND'}`);

    const hasFavorites = navText.includes('Favorites') || navText.includes('Pinned') || navText.includes('FAVORITES') || navText.includes('PINNED');
    console.log(`  Favorites/Pinned label: ${hasFavorites ? 'FOUND' : 'NOT FOUND'}`);

    // Check WORK group for any pin affordance
    const workSection = navText.split('COMMUNICATE')[0];
    console.log(`  WORK section: "${workSection.trim()}"`);

    // Check for any pin-like SVG (pin has specific path shapes)
    const pinSvg = page.locator('nav svg');
    const svgCount = await pinSvg.count();
    console.log(`  Total SVGs in nav: ${svgCount}`);

    // Check each nav link for pin icon
    const navLinks = page.locator('nav a, nav button');
    const linkCount = await navLinks.count();
    for (let i = 0; i < Math.min(linkCount, 15); i++) {
      const linkText = (await navLinks.nth(i).textContent())?.trim();
      const linkHTML = await navLinks.nth(i).innerHTML();
      const hasPin = linkHTML.includes('Pin') || linkHTML.includes('pin') || linkHTML.includes('star');
      if (hasPin || (linkText && linkText.length > 0)) {
        console.log(`  Nav item ${i}: "${linkText}" ${hasPin ? '📌 HAS PIN' : ''}`);
      }
    }
  }

  // ═══════════════════════════════════════════
  // 4. Color System — Blue/Purple Unification
  // ═══════════════════════════════════════════
  console.log('\n=== 4. Color System Audit ===');

  const pagesToCheck = [
    { url: '/', name: 'Dashboard' },
    { url: '/teams', name: 'Teams' },
    { url: '/projects', name: 'Projects' },
    { url: '/marketplace', name: 'Marketplace' },
    { url: '/security', name: 'Security' },
  ];

  const summary = { purple: 0, violet: 0, indigo: 0, primary: 0, details: [] };

  for (const p of pagesToCheck) {
    await page.goto(`${BASE}${p.url}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    const colors = await page.evaluate(() => {
      const allEls = document.querySelectorAll('*');
      const found = { purple: new Set(), violet: new Set(), indigo: new Set(), primary: 0 };

      for (const el of allEls) {
        const cls = el.className;
        if (typeof cls !== 'string') continue;
        const classes = cls.split(/\s+/);
        for (const c of classes) {
          if (c.includes('purple')) found.purple.add(c);
          if (c.includes('violet')) found.violet.add(c);
          if (c.includes('indigo')) found.indigo.add(c);
          if (c.includes('primary')) found.primary++;
        }
      }

      return {
        purple: [...found.purple],
        violet: [...found.violet],
        indigo: [...found.indigo],
        primaryCount: found.primary,
      };
    });

    summary.purple += colors.purple.length;
    summary.violet += colors.violet.length;
    summary.indigo += colors.indigo.length;
    summary.primary += colors.primaryCount;

    console.log(`  ${p.name}: purple=${colors.purple.length} violet=${colors.violet.length} indigo=${colors.indigo.length} primary=${colors.primaryCount}`);
    if (colors.purple.length > 0) {
      console.log(`    Purple: ${colors.purple.join(', ')}`);
      summary.details.push(`${p.name} purple: ${colors.purple.join(', ')}`);
    }
    if (colors.violet.length > 0) {
      console.log(`    Violet: ${colors.violet.join(', ')}`);
      summary.details.push(`${p.name} violet: ${colors.violet.join(', ')}`);
    }
    if (colors.indigo.length > 0) {
      console.log(`    Indigo: ${colors.indigo.join(', ')}`);
      summary.details.push(`${p.name} indigo: ${colors.indigo.join(', ')}`);
    }
  }

  // Capture specific elements for color evidence
  await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  const sparkleBtn = page.locator('button:has-text("Generate")').first();
  if (await sparkleBtn.count() > 0) {
    await sparkleBtn.screenshot({ path: path.join(DIR, '04-generate-btn.png') });
    const cls = await sparkleBtn.getAttribute('class');
    console.log(`\n  Generate Tasks class: ${cls}`);
  }

  await page.goto(`${BASE}/marketplace`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DIR, '04-marketplace-colors.png'), fullPage: true });

  // Cloud banner
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  const cloudBanner = page.locator('[class*="violet"], [class*="cloud"], [class*="Cloud"]').first();
  if (await cloudBanner.count() > 0) {
    await cloudBanner.screenshot({ path: path.join(DIR, '04-cloud-banner.png') });
    const cls = await cloudBanner.getAttribute('class');
    console.log(`  Cloud banner class: ${cls}`);
  }

  await page.screenshot({ path: path.join(DIR, '04-dashboard-colors.png'), fullPage: true });

  await browser.close();

  // Final summary
  console.log('\n=== FINAL SUMMARY ===');
  console.log(`Total purple classes in DOM: ${summary.purple}`);
  console.log(`Total violet classes in DOM: ${summary.violet}`);
  console.log(`Total indigo classes in DOM: ${summary.indigo}`);
  console.log(`Total primary references: ${summary.primary}`);
  const clean = summary.purple + summary.violet === 0;
  console.log(`Color unification: ${clean ? 'CLEAN — no purple/violet' : 'STILL HAS PURPLE/VIOLET'}`);
  if (summary.details.length > 0) {
    console.log('Details:');
    summary.details.forEach(d => console.log(`  - ${d}`));
  }
  console.log('\nDone!');
}

run().catch(err => { console.error(err); process.exit(1); });
