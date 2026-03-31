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
  // 1. Teams — Tree View toggle
  // ═══════════════════════════════════════════
  console.log('=== 1. Teams — Tree View Toggle ===');
  await page.goto(`${BASE}/teams`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '01-teams-default.png'), fullPage: true });

  // Look for Tree View toggle
  const treeToggle = page.locator('button:has-text("Tree"), button[title*="Tree"], button[aria-label*="Tree"], button[aria-label*="tree"], [data-testid*="tree"]');
  const treeCount = await treeToggle.count();
  console.log(`  Tree toggle found: ${treeCount > 0 ? 'YES' : 'NO'} (${treeCount} matches)`);

  if (treeCount > 0) {
    await treeToggle.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(DIR, '01-teams-tree-view.png'), fullPage: true });
    console.log('  Tree view screenshot captured');
  } else {
    // Check all buttons/toggles on the page
    const allBtns = await page.locator('button').allTextContents();
    console.log('  Available buttons:', allBtns.filter(b => b.trim()).join(' | '));

    // Check for icons that might be tree/hierarchy toggle
    const toggleArea = page.locator('[class*="toggle"], [class*="Toggle"], [class*="view-switch"], [role="radiogroup"], [role="tablist"]');
    const toggleCount = await toggleArea.count();
    console.log(`  Toggle areas found: ${toggleCount}`);
    if (toggleCount > 0) {
      for (let i = 0; i < Math.min(toggleCount, 3); i++) {
        const html = await toggleArea.nth(i).innerHTML();
        console.log(`  Toggle ${i}: ${html.substring(0, 200)}`);
      }
    }

    // Check for any hierarchy-related elements
    const hierEl = page.locator('[class*="hier"], [class*="Hier"], [class*="tree"], [class*="Tree"], [data-testid*="hierarchy"]');
    console.log(`  Hierarchy elements: ${await hierEl.count()}`);
  }

  // ═══════════════════════════════════════════
  // 2. Security — Security Score Widget
  // ═══════════════════════════════════════════
  console.log('\n=== 2. Security — Score Widget ===');
  await page.goto(`${BASE}/security`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '02-security-full.png'), fullPage: true });

  // Look for score widget
  const scoreWidget = page.locator('[data-testid*="score"], [class*="Score"], [class*="score"], text=/\\d+\\/100/, text=/Security Score/i');
  const scoreCount = await scoreWidget.count();
  console.log(`  Score widget found: ${scoreCount > 0 ? 'YES' : 'NO'} (${scoreCount} matches)`);

  if (scoreCount > 0) {
    await scoreWidget.first().screenshot({ path: path.join(DIR, '02-security-score-closeup.png') });
    console.log('  Score widget closeup captured');
  } else {
    // Check page content for score-related text
    const pageText = await page.evaluate(() => document.body.innerText);
    const scoreMatch = pageText.match(/score|Score|rating|Rating|\d+\/100|\d+%/gi);
    console.log('  Score-related text:', scoreMatch?.slice(0, 10) || 'NONE');

    // Check for summary cards at top
    const topCards = page.locator('.bg-surface-dark, [class*="card"], [class*="Card"]').first();
    if (await topCards.count() > 0) {
      await topCards.screenshot({ path: path.join(DIR, '02-security-top-section.png') });
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

    const navHTML = await nav.innerHTML();
    const navText = await nav.innerText();
    console.log('  Nav text:', navText.replace(/\n+/g, ' | '));

    // Check for pin icons or favorites section
    const hasPinIcon = navHTML.includes('pin') || navHTML.includes('Pin') || navHTML.includes('star') || navHTML.includes('Star') || navHTML.includes('bookmark') || navHTML.includes('Bookmark');
    console.log(`  Pin/Star/Bookmark icons: ${hasPinIcon ? 'YES' : 'NO'}`);

    // Check for a "Favorites" or "Pinned" section
    const hasFavorites = navText.includes('Favorites') || navText.includes('Pinned') || navText.includes('FAVORITES') || navText.includes('PINNED');
    console.log(`  Favorites/Pinned section: ${hasFavorites ? 'YES' : 'NO'}`);

    // Check SVG icons in nav for pin shape
    const svgCount = await nav.locator('svg').count();
    console.log(`  SVG icons in nav: ${svgCount}`);

    // Inspect the WORK group specifically
    const workGroup = navText.split('COMMUNICATE')[0];
    console.log(`  WORK group content: ${workGroup.trim()}`);
  }

  // ═══════════════════════════════════════════
  // 4. Color System — Blue/Purple Unification
  // ═══════════════════════════════════════════
  console.log('\n=== 4. Color System Audit ===');

  // Check multiple pages for purple/violet usage
  const pagesToCheck = [
    { url: '/', name: 'Dashboard' },
    { url: '/teams', name: 'Teams' },
    { url: '/projects', name: 'Projects' },
    { url: '/marketplace', name: 'Marketplace' },
    { url: '/security', name: 'Security' },
  ];

  const colorResults = [];

  for (const p of pagesToCheck) {
    await page.goto(`${BASE}${p.url}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    const colors = await page.evaluate(() => {
      const allEls = document.querySelectorAll('*');
      const found = { purple: [], violet: [], indigo: [], primaryBlue: [] };

      for (const el of allEls) {
        const cls = el.className;
        if (typeof cls !== 'string') continue;

        if (cls.includes('purple')) found.purple.push(cls.split(' ').filter(c => c.includes('purple')).join(', '));
        if (cls.includes('violet')) found.violet.push(cls.split(' ').filter(c => c.includes('violet')).join(', '));
        if (cls.includes('indigo')) found.indigo.push(cls.split(' ').filter(c => c.includes('indigo')).join(', '));
        if (cls.includes('primary')) found.primaryBlue.push(cls.split(' ').filter(c => c.includes('primary')).join(', '));
      }

      // Also check computed colors for purple-ish hues
      const buttons = document.querySelectorAll('button, a[class*="bg-"]');
      const buttonColors = [];
      for (const btn of Array.from(buttons).slice(0, 20)) {
        const bg = getComputedStyle(btn).backgroundColor;
        const text = btn.textContent?.trim().substring(0, 30);
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          buttonColors.push({ text, bg });
        }
      }

      return {
        purple: [...new Set(found.purple)].slice(0, 5),
        violet: [...new Set(found.violet)].slice(0, 5),
        indigo: [...new Set(found.indigo)].slice(0, 5),
        primaryCount: found.primaryBlue.length,
        buttonSamples: buttonColors.slice(0, 5)
      };
    });

    colorResults.push({ page: p.name, ...colors });
    console.log(`  ${p.name}: purple=${colors.purple.length} violet=${colors.violet.length} indigo=${colors.indigo.length} primary=${colors.primaryCount}`);
    if (colors.purple.length > 0) console.log(`    Purple classes: ${colors.purple.join(' | ')}`);
    if (colors.violet.length > 0) console.log(`    Violet classes: ${colors.violet.join(' | ')}`);
    if (colors.indigo.length > 0) console.log(`    Indigo classes: ${colors.indigo.join(' | ')}`);
  }

  // Take a "Generate Tasks" button closeup on Projects page
  await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  const sparkleBtn = page.locator('button:has-text("Generate")').first();
  if (await sparkleBtn.count() > 0) {
    await sparkleBtn.screenshot({ path: path.join(DIR, '04-projects-generate-btn.png') });
    const btnClass = await sparkleBtn.getAttribute('class');
    console.log(`\n  Generate Tasks button class: ${btnClass}`);
  }

  // Capture Marketplace install button color
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  const installBtn = page.locator('button:has-text("Install"), button:has-text("Uninstall")').first();
  if (await installBtn.count() > 0) {
    await installBtn.screenshot({ path: path.join(DIR, '04-marketplace-btn.png') });
    const btnClass = await installBtn.getAttribute('class');
    console.log(`  Marketplace button class: ${btnClass}`);
  }

  // Cloud banner check
  const cloudBanner = page.locator('[class*="violet"], [class*="cloud-banner"], [class*="CloudConnection"]');
  if (await cloudBanner.count() > 0) {
    await cloudBanner.first().screenshot({ path: path.join(DIR, '04-cloud-banner.png') });
    console.log('  Cloud banner (violet) captured');
  }

  // Final full-page screenshots for color overview
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DIR, '04-dashboard-colors.png'), fullPage: true });

  await browser.close();

  // Summary
  console.log('\n=== SUMMARY ===');
  const totalPurple = colorResults.reduce((s, r) => s + r.purple.length, 0);
  const totalViolet = colorResults.reduce((s, r) => s + r.violet.length, 0);
  const totalIndigo = colorResults.reduce((s, r) => s + r.indigo.length, 0);
  console.log(`Purple classes still in DOM: ${totalPurple}`);
  console.log(`Violet classes still in DOM: ${totalViolet}`);
  console.log(`Indigo classes still in DOM: ${totalIndigo}`);
  console.log(`Color unification status: ${totalPurple + totalViolet === 0 ? 'CLEAN' : 'STILL HAS PURPLE/VIOLET'}`);

  console.log('\nDone!');
}

run().catch(err => { console.error(err); process.exit(1); });
