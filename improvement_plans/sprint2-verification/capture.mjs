import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const BASE = 'http://localhost:3457';
const DIR = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // 1. Teams — standardized cards
  console.log('1. Capturing Teams page...');
  await page.goto(`${BASE}/teams`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '01-teams-standardized-cards.png'), fullPage: true });

  // Try to find a team card and capture details
  const teamCard = page.locator('[data-testid="team-card"], .team-card, [class*="TeamCard"], [class*="TeamsGrid"] > div').first();
  if (await teamCard.count() > 0) {
    await teamCard.screenshot({ path: path.join(DIR, '01-teams-card-detail.png') });
    console.log('  - Team card detail captured');
  }

  // 2. Marketplace — click skill card for detail page
  console.log('2. Capturing Marketplace...');
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '02-marketplace-grid.png'), fullPage: true });

  // Click first card to see detail
  const skillCard = page.locator('[data-testid="marketplace-card"], .marketplace-card, [class*="Card"]').first();
  if (await skillCard.count() > 0) {
    await skillCard.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(DIR, '02-marketplace-detail.png'), fullPage: true });
    console.log('  - Marketplace detail captured');
  } else {
    console.log('  - No marketplace cards found to click');
  }

  // 3. Projects — AI Sparkle CTA + Completed collapsed section
  console.log('3. Capturing Projects page...');
  await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '03-projects-header-cta.png'), fullPage: true });

  // Look for AI sparkle / generate tasks button
  const sparkleBtn = page.locator('button:has-text("Generate"), button:has-text("AI"), [data-testid*="sparkle"], [data-testid*="generate"]').first();
  if (await sparkleBtn.count() > 0) {
    console.log('  - AI Sparkle CTA found');
    await sparkleBtn.screenshot({ path: path.join(DIR, '03-projects-sparkle-btn.png') });
  } else {
    console.log('  - No AI Sparkle CTA found — checking all buttons');
    const buttons = await page.locator('button').allTextContents();
    console.log('  - Page buttons:', buttons.join(', '));
  }

  // Look for collapsed Completed section
  const completedSection = page.locator('text=Completed, [data-testid*="completed"], button:has-text("Completed")').first();
  if (await completedSection.count() > 0) {
    console.log('  - Completed section found');
  }

  // 4. Dashboard — Onboarding Wizard check
  console.log('4. Capturing Dashboard...');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '04-dashboard-overview.png'), fullPage: true });

  // Check for onboarding wizard component
  const wizard = page.locator('[data-testid*="onboard"], [class*="Onboard"], [class*="wizard"], [class*="Wizard"]');
  if (await wizard.count() > 0) {
    console.log('  - Onboarding Wizard component found!');
    await wizard.first().screenshot({ path: path.join(DIR, '04-dashboard-onboarding.png') });
  } else {
    console.log('  - Onboarding Wizard not visible (likely teamCount > 0, dismissed)');
    // Check if component exists in DOM even if hidden
    const hidden = await page.evaluate(() => {
      const el = document.querySelector('[class*="Onboard"], [class*="wizard"]');
      return el ? { found: true, visible: el.offsetParent !== null } : { found: false };
    });
    console.log('  - DOM check:', JSON.stringify(hidden));
  }

  // Check for HealthBar
  const healthBar = page.locator('[data-testid*="health"], [class*="HealthBar"]');
  if (await healthBar.count() > 0) {
    await healthBar.first().screenshot({ path: path.join(DIR, '04-dashboard-healthbar.png') });
    console.log('  - HealthBar captured');
  }

  await browser.close();
  console.log('\nDone! All screenshots saved to sprint2-verification/');
}

run().catch(err => { console.error(err); process.exit(1); });
