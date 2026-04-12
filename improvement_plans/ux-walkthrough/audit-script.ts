/**
 * Autonomous UX Audit Script
 *
 * Uses Playwright to navigate every page of the Crewly OSS app,
 * interact with elements, and capture screenshots for review.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'http://localhost:8787';
const SCREENSHOT_DIR = path.join(__dirname);

interface Finding {
  page: string;
  severity: 'P0' | 'P1' | 'P2';
  category: string;
  issue: string;
  details: string;
}

const findings: Finding[] = [];

function record(page: string, severity: Finding['severity'], category: string, issue: string, details: string) {
  findings.push({ page, severity, category, issue, details });
  console.log(`[${severity}] ${page} — ${issue}`);
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  // Collect console errors
  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });

  // =========================================================================
  // 1. DASHBOARD
  // =========================================================================
  console.log('\n=== 1. DASHBOARD ===');
  await page.goto(`${BASE_URL}/#/`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-dashboard.png'), fullPage: true });

  // Check stat cards exist
  const statCards = await page.$$('.bg-surface-dark.p-6.rounded-lg');
  console.log(`  Stat cards found: ${statCards.length}`);

  // Check for loading states
  const hasSpinner = await page.$('.animate-spin');
  if (!hasSpinner) {
    console.log('  No loading spinner visible (data loaded or no loading state)');
  }

  // Check HealthBar
  const healthBar = await page.$('[data-testid="health-bar"]');
  console.log(`  HealthBar present: ${!!healthBar}`);

  // Hover over stat cards to check hover effects
  if (statCards.length > 0) {
    await statCards[0].hover();
    await page.waitForTimeout(300);
  }

  // Check clickability of project cards
  const projectCards = await page.$$('[data-testid^="project-card"]');
  console.log(`  Project cards: ${projectCards.length}`);

  // Check team cards
  const teamCards = await page.$$('[data-testid^="team-card"]');
  console.log(`  Team cards: ${teamCards.length}`);

  // =========================================================================
  // 2. CHAT PAGE
  // =========================================================================
  console.log('\n=== 2. CHAT ===');
  await page.goto(`${BASE_URL}/#/chat`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-chat-full.png'), fullPage: true });

  // Check thread list
  const threadPreviews = await page.$$('[data-testid="thread-preview"]');
  console.log(`  Thread previews: ${threadPreviews.length}`);

  if (threadPreviews.length > 0) {
    // Screenshot the thread list area specifically
    const sidebar = await page.$('.chat-page-sidebar');
    if (sidebar) {
      await sidebar.screenshot({ path: path.join(SCREENSHOT_DIR, '02-chat-sidebar.png') });
    }

    // Click first thread
    await threadPreviews[0].click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-chat-thread-selected.png'), fullPage: true });

    // Check thread preview card details
    for (let i = 0; i < Math.min(3, threadPreviews.length); i++) {
      const preview = threadPreviews[i];
      const title = await preview.$('.thread-preview-title');
      const time = await preview.$('.thread-preview-time');
      const body = await preview.$('.thread-preview-body');
      const footer = await preview.$('.thread-preview-footer');
      const badge = await preview.$('[data-testid="channel-badge"]');

      const titleText = title ? await title.textContent() : 'none';
      const timeText = time ? await time.textContent() : 'none';
      const bodyText = body ? await body.textContent() : 'none';
      const footerText = footer ? await footer.textContent() : 'none';
      const badgeText = badge ? await badge.textContent() : 'none';

      console.log(`  Thread ${i}: title="${titleText?.slice(0,40)}" time="${timeText}" badge="${badgeText}" footer="${footerText}"`);

      // Check body text length — is it being truncated well?
      if (bodyText && bodyText.length > 100) {
        record('Chat', 'P2', 'truncation', 'Thread preview body text may be too long', `Body text length: ${bodyText.length}`);
      }
    }

    // Try hover on thread previews — check for hover effects
    if (threadPreviews.length > 1) {
      await threadPreviews[1].hover();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-chat-thread-hover.png'), fullPage: true });

      // Check if any overflow menu appears on hover
      const overflowMenu = await page.$('.menu-trigger, [aria-label="Conversation options"]');
      if (!overflowMenu) {
        record('Chat', 'P1', 'interaction', 'No overflow menu on thread hover', 'ThreadPreview has no context actions (pin, archive, delete). ChatSidebar has MoreVertical but ThreadListPanel does not.');
      }
    }

    // Check channel filter bar
    const channelFilters = await page.$$('.channel-filter-bar button, [data-testid="channel-filter"] button');
    console.log(`  Channel filter buttons: ${channelFilters.length}`);

    // Try clicking channel filters
    for (const filter of channelFilters) {
      const filterText = await filter.textContent();
      console.log(`    Filter: "${filterText}"`);
    }
  } else {
    record('Chat', 'P1', 'empty-state', 'No threads in chat', 'Thread list is empty — check if empty state renders properly');

    // Check empty state
    const emptyState = await page.$('[data-testid="thread-list-empty"]');
    if (emptyState) {
      console.log('  Empty state displayed');
    }
  }

  // Check chat input area
  const chatInput = await page.$('[data-testid="chat-input"], textarea, input[type="text"]');
  console.log(`  Chat input found: ${!!chatInput}`);

  // =========================================================================
  // 3. TEAMS
  // =========================================================================
  console.log('\n=== 3. TEAMS ===');
  await page.goto(`${BASE_URL}/#/teams`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-teams.png'), fullPage: true });

  const teamGridCards = await page.$$('[data-testid^="team-grid-card"], .team-grid-card');
  console.log(`  Team grid cards: ${teamGridCards.length}`);

  // Try clicking a team card
  if (teamGridCards.length > 0) {
    await teamGridCards[0].click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-team-detail.png'), fullPage: true });

    // Check team member rows
    const memberRows = await page.$$('[data-testid^="member-row"], .team-member-row');
    console.log(`  Team member rows: ${memberRows.length}`);
  }

  // =========================================================================
  // 4. PROJECTS
  // =========================================================================
  console.log('\n=== 4. PROJECTS ===');
  await page.goto(`${BASE_URL}/#/projects`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-projects.png'), fullPage: true });

  const projCards = await page.$$('[data-testid^="project-card"]');
  console.log(`  Project cards: ${projCards.length}`);

  if (projCards.length > 0) {
    await projCards[0].click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-project-detail.png'), fullPage: true });
  }

  // =========================================================================
  // 5. SCHEDULES
  // =========================================================================
  console.log('\n=== 5. SCHEDULES ===');
  await page.goto(`${BASE_URL}/#/schedules`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-schedules-top.png'), fullPage: false });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-schedules-full.png'), fullPage: true });

  // Check if CronJobPanel is visible without scrolling
  const cronPanel = await page.$('text=Cron Jobs');
  if (cronPanel) {
    const cronBox = await cronPanel.boundingBox();
    if (cronBox && cronBox.y > 900) {
      record('Schedules', 'P0', 'visibility', 'CronJobPanel below the fold', `Cron Jobs section starts at y=${Math.round(cronBox.y)}px, viewport is 900px. Users must scroll to find it.`);
    }
    console.log(`  CronJobPanel y-position: ${cronBox ? Math.round(cronBox.y) : 'not found'}`);
  } else {
    console.log('  CronJobPanel text not found');
  }

  // Check tabs
  const scheduleTabs = await page.$$('button[role="tab"], .tab-button');
  console.log(`  Schedule tab buttons: ${scheduleTabs.length}`);

  // Scroll to bottom to see CronJobPanel
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-schedules-bottom.png'), fullPage: false });

  // =========================================================================
  // 6. SECURITY
  // =========================================================================
  console.log('\n=== 6. SECURITY ===');
  await page.goto(`${BASE_URL}/#/security`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06-security.png'), fullPage: true });

  // =========================================================================
  // 7. SETTINGS
  // =========================================================================
  console.log('\n=== 7. SETTINGS ===');
  await page.goto(`${BASE_URL}/#/settings`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07-settings.png'), fullPage: true });

  // Click through settings tabs
  const settingsTabs = await page.$$('[role="tab"], .settings-tab, button');
  const tabTexts: string[] = [];
  for (const tab of settingsTabs) {
    const text = await tab.textContent();
    if (text && ['General', 'API Keys', 'Cloud', 'Roles', 'Skills', 'System', 'Slack', 'Discord', 'Telegram', 'WhatsApp', 'Google Chat'].includes(text.trim())) {
      tabTexts.push(text.trim());
    }
  }
  console.log(`  Settings tabs found: ${tabTexts.join(', ')}`);

  // =========================================================================
  // 8. MARKETPLACE
  // =========================================================================
  console.log('\n=== 8. MARKETPLACE ===');
  await page.goto(`${BASE_URL}/#/marketplace`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08-marketplace.png'), fullPage: true });

  const marketplaceCards = await page.$$('[data-testid^="marketplace-card"], .marketplace-card, .skill-card');
  console.log(`  Marketplace cards: ${marketplaceCards.length}`);

  // =========================================================================
  // 9. KNOWLEDGE
  // =========================================================================
  console.log('\n=== 9. KNOWLEDGE ===');
  await page.goto(`${BASE_URL}/#/knowledge`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09-knowledge.png'), fullPage: true });

  // =========================================================================
  // 10. MOBILE RESPONSIVENESS (resize to 375px)
  // =========================================================================
  console.log('\n=== 10. MOBILE VIEW ===');
  await page.setViewportSize({ width: 375, height: 812 });

  await page.goto(`${BASE_URL}/#/`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10-mobile-dashboard.png'), fullPage: true });

  await page.goto(`${BASE_URL}/#/chat`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10-mobile-chat.png'), fullPage: true });

  await page.goto(`${BASE_URL}/#/schedules`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10-mobile-schedules.png'), fullPage: true });

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n=== CONSOLE ERRORS ===');
  for (const err of consoleErrors) {
    console.log(`  ${err}`);
  }

  console.log('\n=== FINDINGS SUMMARY ===');
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.page} | ${f.category} | ${f.issue}`);
  }

  // Write findings to JSON
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, 'findings.json'),
    JSON.stringify(findings, null, 2)
  );

  await browser.close();
  console.log('\nAudit complete. Screenshots saved to:', SCREENSHOT_DIR);
}

main().catch(console.error);
