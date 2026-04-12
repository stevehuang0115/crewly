import { chromium } from 'playwright';

const BASE = 'http://localhost:8788';
const OUT = '/Users/yellowsunhy/Desktop/projects/crewly-projects/crewly/improvement_plans/ui-verification-screenshots';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  // Security - full page scroll
  await page.goto(`${BASE}/security`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/security-full.png`, fullPage: true });
  console.log('OK: security-full');

  // Settings - full page
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/settings-full.png`, fullPage: true });
  console.log('OK: settings-full');

  // Settings - scroll down
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/settings-scrolled.png`, fullPage: false });
  console.log('OK: settings-scrolled');

  // Chat - full page
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/chat-full.png`, fullPage: true });
  console.log('OK: chat-full');

  await browser.close();
  console.log('Done.');
}

run().catch(e => { console.error(e); process.exit(1); });
