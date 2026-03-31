#!/usr/bin/env node
/**
 * UI Review Screenshot Capture — captures all OSS frontend pages
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:8787';
const DIR = '/tmp/ui-review';
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
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();

  for (const p of pages) {
    console.log(`📸 ${p.name}: ${p.path}`);
    try {
      await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle', timeout: 10000 });
      await sleep(1500);
      // Full page screenshot
      await page.screenshot({ path: `${DIR}/${p.name}.png`, fullPage: true });
      // Also viewport-only for consistency check
      await page.screenshot({ path: `${DIR}/${p.name}-viewport.png`, fullPage: false });
    } catch (e) {
      console.log(`  ⚠️ ${e.message.substring(0, 80)}`);
    }
  }

  // Also capture first team detail if teams exist
  try {
    await page.goto(`${BASE}/teams`, { waitUntil: 'networkidle', timeout: 10000 });
    await sleep(1000);
    const teamLink = await page.$('a[href*="/teams/"]');
    if (teamLink) {
      await teamLink.click();
      await sleep(2000);
      await page.screenshot({ path: `${DIR}/12-team-detail.png`, fullPage: true });
      await page.screenshot({ path: `${DIR}/12-team-detail-viewport.png`, fullPage: false });
      console.log('📸 12-team-detail');
    }
  } catch (e) {
    console.log(`  ⚠️ team detail: ${e.message.substring(0, 80)}`);
  }

  // Dashboard scroll to show all cards
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 10000 });
    await sleep(1500);
    // Scroll down slowly to capture full dashboard
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
      await sleep(800);
    }
    await page.screenshot({ path: `${DIR}/01-dashboard-scrolled.png`, fullPage: true });
    console.log('📸 01-dashboard-scrolled (full page)');
  } catch (e) {
    console.log(`  ⚠️ dashboard scroll: ${e.message.substring(0, 80)}`);
  }

  await browser.close();
  console.log(`\n✅ Screenshots saved to ${DIR}/`);
}

main().catch(console.error);
