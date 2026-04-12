import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const BASE = 'http://localhost:3457';
const DIR = path.dirname(fileURLToPath(import.meta.url));

async function screenshot(page, name, opts = {}) {
  await page.screenshot({ path: path.join(DIR, name), ...opts });
  console.log(`  📸 ${name}`);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Track color classes across all pages
  const colorLog = [];

  async function auditColors(pageName) {
    const c = await page.evaluate(() => {
      const s = { purple: new Set(), violet: new Set(), indigo: new Set(), primary: 0 };
      for (const el of document.querySelectorAll('*')) {
        const cls = el.className;
        if (typeof cls !== 'string') continue;
        for (const c of cls.split(/\s+/)) {
          if (c.includes('purple')) s.purple.add(c);
          if (c.includes('violet')) s.violet.add(c);
          if (c.includes('indigo')) s.indigo.add(c);
          if (c.includes('primary')) s.primary++;
        }
      }
      return { purple: [...s.purple], violet: [...s.violet], indigo: [...s.indigo], primary: s.primary };
    });
    colorLog.push({ page: pageName, ...c });
    const issues = [...c.purple, ...c.violet, ...c.indigo];
    console.log(`  🎨 ${pageName}: primary=${c.primary} non-primary=${issues.length > 0 ? issues.join(', ') : 'CLEAN'}`);
  }

  // ═══════════════════════════════════════════
  // 1. Navigation — 4 groups + Pinned Favorites
  // ═══════════════════════════════════════════
  console.log('\n=== 1. NAVIGATION ===');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const nav = page.locator('nav').first();
  if (await nav.count() > 0) {
    await nav.screenshot({ path: path.join(DIR, '01-nav-sidebar.png') });
    console.log('  📸 01-nav-sidebar.png');

    const navText = await nav.innerText();
    const navHTML = await nav.innerHTML();
    console.log('  Nav text:', navText.replace(/\n+/g, ' | '));

    // Check groups
    const groups = ['WORK', 'COMMUNICATE', 'TOOLS', 'SYSTEM'];
    for (const g of groups) {
      console.log(`  Group "${g}": ${navText.includes(g) ? '✅ FOUND' : '❌ MISSING'}`);
    }

    // Check pinned/favorites
    const pinTerms = ['pin', 'Pin', 'PIN', 'star', 'Star', 'favorite', 'Favorite', 'PINNED', 'FAVORITES', 'bookmark'];
    const foundPins = pinTerms.filter(t => navText.includes(t) || navHTML.includes(t));
    console.log(`  Pinned/Favorites: ${foundPins.length > 0 ? '✅ ' + foundPins.join(', ') : '❌ NOT FOUND'}`);

    // Check items per group
    const workItems = navText.split('COMMUNICATE')[0];
    const commItems = navText.includes('COMMUNICATE') ? navText.split('COMMUNICATE')[1]?.split('TOOLS')[0] : '';
    const toolItems = navText.includes('TOOLS') ? navText.split('TOOLS')[1]?.split('SYSTEM')[0] : '';
    const sysItems = navText.includes('SYSTEM') ? navText.split('SYSTEM')[1] : '';
    if (workItems) console.log(`  WORK items: ${workItems.replace(/\n+/g, ', ').trim()}`);
    if (commItems) console.log(`  COMMUNICATE items: ${commItems.replace(/\n+/g, ', ').trim()}`);
    if (toolItems) console.log(`  TOOLS items: ${toolItems.replace(/\n+/g, ', ').trim()}`);
    if (sysItems) console.log(`  SYSTEM items: ${sysItems.replace(/\n+/g, ', ').trim()}`);
  }

  // ═══════════════════════════════════════════
  // 2. Dashboard — HealthBar
  // ═══════════════════════════════════════════
  console.log('\n=== 2. DASHBOARD + HEALTHBAR ===');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await screenshot(page, '02-dashboard-full.png', { fullPage: true });

  // HealthBar
  const healthBar = page.locator('[data-testid*="health"], [class*="HealthBar"], [class*="health-bar"]').first();
  if (await healthBar.count() > 0) {
    await healthBar.screenshot({ path: path.join(DIR, '02-healthbar-closeup.png') });
    console.log('  📸 02-healthbar-closeup.png');
    const hbText = await healthBar.innerText();
    console.log(`  HealthBar: "${hbText.replace(/\n/g, ' | ')}"`);
  } else {
    // Try finding by content pattern (stats bar at top)
    const statsBar = page.locator('div:has(> span:has-text("Agents")):has(> span:has-text("Projects"))').first();
    if (await statsBar.count() > 0) {
      await statsBar.screenshot({ path: path.join(DIR, '02-healthbar-closeup.png') });
      console.log('  📸 02-healthbar-closeup.png (found by content)');
    } else {
      console.log('  HealthBar: ❌ NOT FOUND');
    }
  }
  await auditColors('Dashboard');

  // ═══════════════════════════════════════════
  // 3. Teams — Tree View + Standardized Cards
  // ═══════════════════════════════════════════
  console.log('\n=== 3. TEAMS ===');
  await page.goto(`${BASE}/teams`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await screenshot(page, '03-teams-grid.png', { fullPage: true });

  // Card closeup
  const teamCard = page.locator('[data-testid^="team-card-"]').first();
  if (await teamCard.count() > 0) {
    await teamCard.screenshot({ path: path.join(DIR, '03-teams-card-closeup.png') });
    console.log('  📸 03-teams-card-closeup.png');
  }

  // Tree View toggle
  const treeBtn = page.locator('button:has-text("Tree"), button[title*="Tree"], button[aria-label*="tree"], button[aria-label*="Tree"], [data-testid*="tree"]');
  if (await treeBtn.count() > 0) {
    console.log('  Tree toggle: ✅ FOUND');
    await treeBtn.first().click();
    await page.waitForTimeout(1500);
    await screenshot(page, '03-teams-tree.png', { fullPage: true });
  } else {
    console.log('  Tree toggle: ❌ NOT FOUND');
    const allBtns = await page.locator('button').allTextContents();
    console.log('  Buttons:', allBtns.filter(b => b.trim()).join(' | '));
  }
  await auditColors('Teams');

  // ═══════════════════════════════════════════
  // 4. Projects — AI Sparkle CTA
  // ═══════════════════════════════════════════
  console.log('\n=== 4. PROJECTS ===');
  await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await screenshot(page, '04-projects-full.png', { fullPage: true });

  const sparkle = page.locator('button:has-text("Generate")').first();
  if (await sparkle.count() > 0) {
    await sparkle.screenshot({ path: path.join(DIR, '04-sparkle-cta.png') });
    console.log('  📸 04-sparkle-cta.png');
    const cls = await sparkle.getAttribute('class') || '';
    console.log(`  Sparkle class: ${cls}`);
    const hasPurple = cls.includes('purple');
    const hasIndigo = cls.includes('indigo');
    const hasPrimary = cls.includes('primary');
    console.log(`  Color: primary=${hasPrimary} indigo=${hasIndigo}(AI accent) purple=${hasPurple}`);
  } else {
    console.log('  Sparkle CTA: ❌ NOT FOUND');
  }
  await auditColors('Projects');

  // ═══════════════════════════════════════════
  // 5. Security — Score Widget
  // ═══════════════════════════════════════════
  console.log('\n=== 5. SECURITY ===');
  await page.goto(`${BASE}/security`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await screenshot(page, '05-security-full.png', { fullPage: true });

  // Score widget
  const scoreText = page.getByText(/Security Score/i).first();
  if (await scoreText.count() > 0) {
    // Get parent container that includes the score number
    const scoreContainer = scoreText.locator('xpath=ancestor::div[position()=1 or position()=2]').last();
    try {
      await scoreContainer.screenshot({ path: path.join(DIR, '05-security-score.png') });
      console.log('  📸 05-security-score.png');
    } catch {
      // Fallback: screenshot area around the text
      const scoreArea = page.locator('[data-testid*="score"]').first();
      if (await scoreArea.count() > 0) {
        await scoreArea.screenshot({ path: path.join(DIR, '05-security-score.png') });
        console.log('  📸 05-security-score.png (by testid)');
      }
    }
    console.log('  Score widget: ✅ FOUND');
  } else {
    console.log('  Score widget: ❌ NOT FOUND');
  }
  await auditColors('Security');

  // ═══════════════════════════════════════════
  // 6. Chat — Metadata Masking
  // ═══════════════════════════════════════════
  console.log('\n=== 6. CHAT ===');
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await screenshot(page, '06-chat-full.png', { fullPage: true });

  // Click first thread to load messages
  const threadItem = page.locator('[data-testid*="thread"], [class*="thread"], [class*="Thread"]').first();
  if (await threadItem.count() > 0) {
    await threadItem.click();
    await page.waitForTimeout(1500);
    await screenshot(page, '06-chat-thread-open.png', { fullPage: true });
  }

  // Check for redacted segments
  const redacted = page.locator('[data-testid="redacted-segment"], [class*="redact"], [class*="Redact"], [class*="mask"]');
  const redactedCount = await redacted.count();
  console.log(`  Redacted segments: ${redactedCount > 0 ? `✅ ${redactedCount} found` : '⚠️ 0 found (may need thread with sensitive data)'}`);

  // Check for raw JWT patterns in visible text
  const bodyText = await page.evaluate(() => document.body.innerText);
  const jwtLeak = bodyText.match(/eyJ[A-Za-z0-9_-]{10,}/g);
  console.log(`  JWT leaks in visible text: ${jwtLeak ? `❌ ${jwtLeak.length} found` : '✅ NONE'}`);

  // Check for file path leaks
  const pathLeak = bodyText.match(/\/Users\/[^\s]{10,}/g);
  console.log(`  File path leaks: ${pathLeak ? `⚠️ ${pathLeak.length} visible` : '✅ NONE'}`);

  await auditColors('Chat');

  // ═══════════════════════════════════════════
  // 7. Marketplace — Detail Page
  // ═══════════════════════════════════════════
  console.log('\n=== 7. MARKETPLACE ===');
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await screenshot(page, '07-marketplace-grid.png', { fullPage: true });

  // Click first card
  const mkCard = page.locator('.rounded-xl.border').first();
  if (await mkCard.count() > 0) {
    await mkCard.click();
    await page.waitForTimeout(2000);
    const url = page.url();
    console.log(`  After click: ${url}`);
    if (url.includes('/marketplace/')) {
      await screenshot(page, '07-marketplace-detail.png', { fullPage: true });
      console.log('  Detail page: ✅ NAVIGATED');
    } else {
      console.log('  Detail page: ❌ Did not navigate');
      await screenshot(page, '07-marketplace-after-click.png', { fullPage: true });
    }
  }
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  await auditColors('Marketplace');

  // ═══════════════════════════════════════════
  // 8. Color System Summary
  // ═══════════════════════════════════════════
  console.log('\n=== 8. COLOR SYSTEM SUMMARY ===');
  let totalPurple = 0, totalViolet = 0, totalIndigo = 0, totalPrimary = 0;
  for (const c of colorLog) {
    totalPurple += c.purple.length;
    totalViolet += c.violet.length;
    totalIndigo += c.indigo.length;
    totalPrimary += c.primary;
  }
  console.log(`  Across ${colorLog.length} pages:`);
  console.log(`  • primary token usage:  ${totalPrimary}`);
  console.log(`  • purple classes:       ${totalPurple}`);
  console.log(`  • violet classes:       ${totalViolet}`);
  console.log(`  • indigo classes:       ${totalIndigo}`);
  console.log(`  Color unified: ${totalPurple + totalViolet === 0 ? '✅ CLEAN (no purple/violet)' : '⚠️ Still has purple/violet'}`);

  // Detail per page
  for (const c of colorLog) {
    const issues = [...c.purple, ...c.violet];
    if (issues.length > 0) {
      console.log(`  ${c.page} remaining: ${issues.join(', ')}`);
    }
    if (c.indigo.length > 0) {
      console.log(`  ${c.page} indigo (AI accent): ${c.indigo.join(', ')}`);
    }
  }

  await browser.close();
  console.log('\n✅ All done!');
}

run().catch(err => { console.error(err); process.exit(1); });
