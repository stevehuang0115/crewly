#!/usr/bin/env node
/**
 * UI Mobile Screenshot Capture — captures all OSS frontend pages in mobile view
 */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:8787';
const DIR = '/tmp/ui-review-mobile';
mkdirSync(DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

const pages = [
  { name: '01-dashboard', path: '/' },
  { name: '02-teams', path: '/teams' },
  { name: '03-projects', path: '/projects' },
  { name: '04-assignments', path: '/assignments' },
  { name: '05-scheduled-checkins', path: '/scheduled-checkins' },
  { name: '06-factory', path: '/factory' },
  { name: '07-marketplace', path: '/marketplace' },
  { name: '08-knowledge', path: '/knowledge' },
  { name: '09-security', path: '/security' },
  { name: '10-cost-dashboard', path: '/monitoring/costs' },
  { name: '11-settings', path: '/settings' },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const iPhone13 = devices['iPhone 13'];
  const ctx = await browser.newContext({
    ...iPhone13,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();

  for (const p of pages) {
    console.log(`📸 Mobile ${p.name}: ${p.path}`);
    try {
      await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle', timeout: 10000 });
      await sleep(2000);
      // Full page screenshot
      await page.screenshot({ path: `${DIR}/${p.name}.png`, fullPage: true });
      // Viewport-only
      await page.screenshot({ path: `${DIR}/${p.name}-viewport.png`, fullPage: false });
    } catch (e) {
      console.log(`  ⚠️ ${e.message.substring(0, 80)}`);
    }
  }

  await browser.close();
  console.log(`\n✅ Mobile screenshots saved to ${DIR}/`);
}

main().catch(console.error);
