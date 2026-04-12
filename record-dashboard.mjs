#!/usr/bin/env node
/**
 * Dashboard Walkthrough Video Recorder
 *
 * Records a 45-60 second walkthrough of the Crewly AI Studio dashboard
 * for use in X/Twitter posts.
 *
 * Uses Playwright to automate Chrome and record video.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const BASE_URL = 'http://localhost:8787';
const OUTPUT_DIR = resolve('./ops/marketing/assets/images/x-thread-30days');
const OUTPUT_FILE = 'tweet1-dashboard-walkthrough-v2.webm';

mkdirSync(OUTPUT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('🎬 Starting dashboard walkthrough recording...');
  console.log(`   Output: ${OUTPUT_DIR}/${OUTPUT_FILE}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1440, height: 900 },
    },
    colorScheme: 'dark',
  });

  const page = await context.newPage();

  try {
    // ── Scene 1: Dashboard overview (5s) ────────────────────────────────────
    console.log('📍 Scene 1: Dashboard overview');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await sleep(4000);

    // Slow scroll to show full dashboard
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await sleep(2000);
    await page.evaluate(() => window.scrollBy({ top: -300, behavior: 'smooth' }));
    await sleep(2000);

    // ── Scene 2: Teams page (8s) ────────────────────────────────────────────
    console.log('📍 Scene 2: Teams page');
    await page.click('a[href="/teams"], [data-testid="nav-teams"], nav >> text=Teams');
    await sleep(3000);

    // Click on first team card if available
    const teamCards = await page.$$('[data-testid*="team"], .team-card, [class*="TeamCard"], a[href*="/teams/"]');
    if (teamCards.length > 0) {
      console.log(`   Found ${teamCards.length} team cards, clicking first...`);
      await teamCards[0].click();
      await sleep(4000);

      // Scroll to show agent details
      await page.evaluate(() => window.scrollBy({ top: 250, behavior: 'smooth' }));
      await sleep(2000);

      // Go back to teams list
      await page.goBack();
      await sleep(2000);

      // Click second team if exists
      if (teamCards.length > 1) {
        const cards2 = await page.$$('[data-testid*="team"], .team-card, [class*="TeamCard"], a[href*="/teams/"]');
        if (cards2.length > 1) {
          await cards2[1].click();
          await sleep(3000);
          await page.goBack();
          await sleep(2000);
        }
      }
    } else {
      console.log('   No team cards found, waiting on teams page...');
      await sleep(4000);
    }

    // ── Scene 3: Projects page (6s) ─────────────────────────────────────────
    console.log('📍 Scene 3: Projects page');
    await page.click('a[href="/projects"], [data-testid="nav-projects"], nav >> text=Projects');
    await sleep(4000);

    // Click first project if available
    const projectCards = await page.$$('a[href*="/projects/"]');
    if (projectCards.length > 0) {
      console.log(`   Found ${projectCards.length} projects, clicking first...`);
      await projectCards[0].click();
      await sleep(3000);
      await page.goBack();
      await sleep(2000);
    }

    // ── Scene 4: Knowledge base (4s) ────────────────────────────────────────
    console.log('📍 Scene 4: Knowledge base');
    try {
      await page.click('a[href="/knowledge"], [data-testid="nav-knowledge"], nav >> text=Knowledge');
      await sleep(4000);
    } catch {
      console.log('   Knowledge nav not found, skipping...');
    }

    // ── Scene 5: Security overview (4s) ─────────────────────────────────────
    console.log('📍 Scene 5: Security overview');
    try {
      await page.click('a[href="/security"], [data-testid="nav-security"], nav >> text=Security');
      await sleep(4000);
    } catch {
      console.log('   Security nav not found, skipping...');
    }

    // ── Scene 6: Marketplace (4s) ───────────────────────────────────────────
    console.log('📍 Scene 6: Marketplace');
    try {
      await page.click('a[href="/marketplace"], [data-testid="nav-marketplace"], nav >> text=Marketplace');
      await sleep(4000);
    } catch {
      console.log('   Marketplace nav not found, skipping...');
    }

    // ── Scene 7: Cost monitoring (4s) ───────────────────────────────────────
    console.log('📍 Scene 7: Cost monitoring');
    try {
      await page.click('a[href="/monitoring/costs"], nav >> text=Costs, nav >> text=Cost');
      await sleep(4000);
    } catch {
      console.log('   Cost monitoring nav not found, skipping...');
    }

    // ── Scene 8: Back to dashboard (3s) ─────────────────────────────────────
    console.log('📍 Scene 8: Back to dashboard');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await sleep(3000);

    console.log('✅ Recording complete!');

  } catch (err) {
    console.error('Error during recording:', err.message);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Find the recorded video and rename it
  const { readdirSync, renameSync } = await import('fs');
  const files = readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.webm'));
  if (files.length > 0) {
    // Get the most recent webm
    const latestVideo = files.sort().pop();
    const srcPath = resolve(OUTPUT_DIR, latestVideo);
    const dstPath = resolve(OUTPUT_DIR, OUTPUT_FILE);
    renameSync(srcPath, dstPath);
    console.log(`\n🎬 Video saved: ${dstPath}`);
  } else {
    console.log('⚠️  No video file found. Playwright may need headed mode for video.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
