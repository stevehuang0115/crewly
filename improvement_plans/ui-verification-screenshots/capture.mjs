import { chromium } from 'playwright';

const BASE = 'http://localhost:8788';
const OUT = '/Users/yellowsunhy/Desktop/projects/crewly-projects/crewly/improvement_plans/ui-verification-screenshots';

const pages = [
  { name: '01-dashboard', path: '/' },
  { name: '02-chat', path: '/chat' },
  { name: '03-teams', path: '/teams' },
  { name: '04-projects', path: '/projects' },
  { name: '05-marketplace', path: '/marketplace' },
  { name: '06-security', path: '/security' },
  { name: '07-knowledge', path: '/knowledge' },
  { name: '08-settings', path: '/settings' },
  { name: '09-schedules', path: '/schedules' },
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  for (const { name, path } of pages) {
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
      console.log(`OK: ${name}`);
    } catch (e) {
      console.log(`FAIL: ${name} — ${e.message.slice(0, 120)}`);
      try {
        await page.screenshot({ path: `${OUT}/${name}-partial.png`, fullPage: false });
        console.log(`  (partial screenshot saved)`);
      } catch (_) {}
    }
  }

  await browser.close();
  console.log('Done.');
}

run().catch(e => { console.error(e); process.exit(1); });
