import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const BASE = 'http://localhost:3457';
const DIR = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // 1. Teams — standardized cards with initials, status badge, start/stop, last activity
  console.log('1. Teams — standardized cards');
  await page.goto(`${BASE}/teams`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '01-teams-page.png'), fullPage: true });

  // Capture individual team card detail
  const teamCard = page.locator('[data-testid^="team-card-"]').first();
  if (await teamCard.count() > 0) {
    await teamCard.screenshot({ path: path.join(DIR, '01-teams-card-closeup.png') });
    console.log('  - Card close-up captured');

    // Check for initials avatar, status badge, start/stop, last activity
    const cardHTML = await teamCard.innerHTML();
    const hasInitials = cardHTML.includes('rounded-full') || cardHTML.includes('avatar') || cardHTML.includes('initials');
    const hasStatusBadge = cardHTML.includes('Active') || cardHTML.includes('Inactive') || cardHTML.includes('badge') || cardHTML.includes('rounded-full');
    const hasStartStop = cardHTML.includes('Start') || cardHTML.includes('Stop') || cardHTML.includes('start') || cardHTML.includes('stop');
    const hasLastActivity = cardHTML.includes('Last') || cardHTML.includes('activity') || cardHTML.includes('ago');
    console.log(`  - Initials avatar: ${hasInitials ? 'YES' : 'NOT FOUND'}`);
    console.log(`  - Status badge: ${hasStatusBadge ? 'YES' : 'NOT FOUND'}`);
    console.log(`  - Start/Stop btn: ${hasStartStop ? 'YES' : 'NOT FOUND'}`);
    console.log(`  - Last activity: ${hasLastActivity ? 'YES' : 'NOT FOUND'}`);
  }

  // 2. Marketplace — click card to see detail page
  console.log('\n2. Marketplace — skill detail page');
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '02-marketplace-browse.png'), fullPage: true });

  // Click first skill card
  const skillCard = page.locator('.bg-gray-900.border.border-gray-800.rounded-xl').first();
  if (await skillCard.count() > 0) {
    const cardText = await skillCard.textContent();
    console.log(`  - Clicking card: ${cardText?.substring(0, 50)}`);
    await skillCard.click();
    await page.waitForTimeout(2000);

    // Check if navigated to detail page or modal opened
    const url = page.url();
    console.log(`  - After click URL: ${url}`);
    await page.screenshot({ path: path.join(DIR, '02-marketplace-after-click.png'), fullPage: true });

    // Check for modal or detail view
    const modal = page.locator('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="detail"], [class*="Detail"]');
    if (await modal.count() > 0) {
      console.log('  - Detail modal/view found');
      await modal.first().screenshot({ path: path.join(DIR, '02-marketplace-detail-view.png') });
    } else {
      console.log('  - No modal/detail opened. Checking if new page...');
    }
  }

  // 3. Projects — AI Sparkle CTA + Completed section
  console.log('\n3. Projects — AI Sparkle + Completed');
  await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '03-projects-full.png'), fullPage: true });

  // Find AI Sparkle button and capture close-up
  const sparkleBtn = page.locator('button:has-text("Generate"), button:has-text("AI"), button:has(svg[class*="sparkle"]), [data-testid*="sparkle"], [data-testid*="generate"]').first();
  if (await sparkleBtn.count() > 0) {
    await sparkleBtn.screenshot({ path: path.join(DIR, '03-projects-sparkle-closeup.png') });
    console.log('  - AI Sparkle CTA captured');
  }

  // Look for Completed section/collapsible
  const completedEl = page.locator('text=Completed').first();
  if (await completedEl.count() > 0) {
    console.log('  - "Completed" section found');
    // Try scrolling to it
    await completedEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(DIR, '03-projects-completed-section.png'), fullPage: true });
  } else {
    console.log('  - No "Completed" section visible');
    // Check all visible text for completed
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    if (bodyText.includes('Completed') || bodyText.includes('completed')) {
      console.log('  - "Completed" text exists in body');
    }
  }

  // 4. Dashboard — Onboarding Wizard + HealthBar
  console.log('\n4. Dashboard — Onboarding + HealthBar');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '04-dashboard-full.png'), fullPage: true });

  // HealthBar close-up
  const healthBar = page.locator('[class*="HealthBar"], [data-testid*="health"]').first();
  if (await healthBar.count() > 0) {
    await healthBar.screenshot({ path: path.join(DIR, '04-dashboard-healthbar.png') });
    console.log('  - HealthBar captured');
  } else {
    console.log('  - No HealthBar found via class');
  }

  // Onboarding wizard detection
  const onboard = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.className && typeof el.className === 'string' &&
          (el.className.toLowerCase().includes('onboard') || el.className.toLowerCase().includes('wizard'))) {
        return { found: true, class: el.className, visible: el.offsetParent !== null, text: el.textContent?.substring(0, 100) };
      }
    }
    return { found: false };
  });
  console.log(`  - Onboarding wizard: ${JSON.stringify(onboard)}`);

  // Navigation grouping check
  const nav = page.locator('nav').first();
  if (await nav.count() > 0) {
    await nav.screenshot({ path: path.join(DIR, '04-dashboard-nav.png') });
    console.log('  - Navigation sidebar captured');

    // Check for group labels
    const navText = await nav.textContent();
    const hasGroups = navText?.includes('Work') || navText?.includes('Communicate') || navText?.includes('Tools') || navText?.includes('System');
    console.log(`  - Nav grouping labels: ${hasGroups ? 'YES' : 'NOT FOUND'}`);
    console.log(`  - Nav text: ${navText?.substring(0, 200)}`);
  }

  await browser.close();
  console.log('\nDone!');
}

run().catch(err => { console.error(err); process.exit(1); });
