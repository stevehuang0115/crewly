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
  // 1. Chat — JWT / path / API key masking
  // ═══════════════════════════════════════════
  console.log('=== 1. CHAT MASKING ===');
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '01-chat-threads.png'), fullPage: true });

  // Click first thread with content
  const threads = page.locator('[class*="thread"], [class*="Thread"], [data-testid*="thread"]');
  const threadCount = await threads.count();
  console.log(`  Threads found: ${threadCount}`);

  // Try clicking different threads to find ones with sensitive data
  let bestThread = null;
  for (let i = 0; i < Math.min(threadCount, 5); i++) {
    await threads.nth(i).click();
    await page.waitForTimeout(1000);

    const bodyText = await page.evaluate(() => {
      const panel = document.querySelector('[class*="detail"], [class*="Detail"], [class*="right"], [class*="message"]');
      return (panel || document.body).innerText;
    });

    const jwtCount = (bodyText.match(/eyJ[A-Za-z0-9_-]{10,}/g) || []).length;
    const pathCount = (bodyText.match(/\/Users\/[^\s\]]{10,}/g) || []).length;
    const apiKeyCount = (bodyText.match(/sk-[a-zA-Z0-9]{10,}/g) || []).length;
    const maskedCount = (bodyText.match(/\[REDACTED[^\]]*\]|\*{3,}|●{3,}|\[MASKED\]|\[HIDDEN\]/gi) || []).length;
    const threadContextCount = (bodyText.match(/\[Thread context file:/g) || []).length;

    console.log(`  Thread ${i}: JWT=${jwtCount} paths=${pathCount} apiKey=${apiKeyCount} masked=${maskedCount} threadCtx=${threadContextCount}`);

    if (jwtCount > 0 || pathCount > 0 || maskedCount > 0) {
      bestThread = i;
      break;
    }
  }

  // Capture the thread with most sensitive data (or most masking)
  if (bestThread !== null) {
    await threads.nth(bestThread).click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: path.join(DIR, '01-chat-detail.png'), fullPage: true });

  // Deep scan all visible text for leaks
  const fullText = await page.evaluate(() => document.body.innerText);
  const jwtLeaks = fullText.match(/eyJ[A-Za-z0-9_-]{20,}/g) || [];
  const pathLeaks = fullText.match(/\/Users\/[^\s\]]{10,}/g) || [];
  const apiKeyLeaks = fullText.match(/sk-[a-zA-Z0-9]{20,}/g) || [];
  const maskedSegments = fullText.match(/\[REDACTED[^\]]*\]|\*{4,}|●{3,}|\[MASKED\]|\[HIDDEN\]|\[sensitive[^\]]*\]/gi) || [];
  const threadCtxLeaks = fullText.match(/\[Thread context file:[^\]]*\]/g) || [];

  console.log('\n  === LEAK SUMMARY ===');
  console.log(`  JWT tokens visible:     ${jwtLeaks.length} ${jwtLeaks.length === 0 ? '✅' : '❌'}`);
  console.log(`  File paths visible:     ${pathLeaks.length} ${pathLeaks.length === 0 ? '✅' : '❌'}`);
  console.log(`  API keys visible:       ${apiKeyLeaks.length} ${apiKeyLeaks.length === 0 ? '✅' : '❌'}`);
  console.log(`  Thread ctx metadata:    ${threadCtxLeaks.length} ${threadCtxLeaks.length === 0 ? '✅' : '❌'}`);
  console.log(`  Masked/redacted shown:  ${maskedSegments.length}`);

  if (jwtLeaks.length > 0) console.log(`  JWT samples: ${jwtLeaks.slice(0, 2).map(j => j.substring(0, 30) + '...').join(', ')}`);
  if (pathLeaks.length > 0) console.log(`  Path samples: ${pathLeaks.slice(0, 3).join(', ')}`);
  if (maskedSegments.length > 0) console.log(`  Masked samples: ${maskedSegments.slice(0, 5).join(', ')}`);

  // Check for redacted-segment test IDs
  const redactedEls = page.locator('[data-testid="redacted-segment"]');
  const redactedCount = await redactedEls.count();
  console.log(`  [data-testid="redacted-segment"] elements: ${redactedCount}`);
  if (redactedCount > 0) {
    await redactedEls.first().screenshot({ path: path.join(DIR, '01-chat-redacted-sample.png') });
    console.log('  📸 01-chat-redacted-sample.png');
  }

  // Check "Show raw output" toggle behavior
  const rawToggle = page.locator('button:has-text("raw"), button:has-text("Raw"), button:has-text("Show raw")');
  if (await rawToggle.count() > 0) {
    console.log('  "Show raw" toggle: found');
    await rawToggle.first().click();
    await page.waitForTimeout(500);
    const rawText = await page.evaluate(() => document.body.innerText);
    const rawJwt = (rawText.match(/eyJ[A-Za-z0-9_-]{20,}/g) || []).length;
    console.log(`  After "Show raw": JWT visible = ${rawJwt} ${rawJwt === 0 ? '✅ masked in raw too' : '❌ leaks in raw view'}`);
    await page.screenshot({ path: path.join(DIR, '01-chat-raw-toggle.png'), fullPage: true });
  }

  // ═══════════════════════════════════════════
  // 2. Projects/Teams cards — pin/unpin on hover
  // ═══════════════════════════════════════════
  console.log('\n=== 2. PIN/UNPIN ON HOVER ===');

  // -- Projects --
  console.log('\n  --- Projects ---');
  await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '02-projects-default.png'), fullPage: true });

  const projCard = page.locator('[data-testid*="project-card"], [class*="ProjectCard"], [class*="project-card"]').first();
  let projCardEl = projCard;
  if (await projCard.count() === 0) {
    // Fallback: find cards by structure
    projCardEl = page.locator('.rounded-2xl.border, .rounded-xl.border').first();
  }

  if (await projCardEl.count() > 0) {
    // Before hover
    await projCardEl.screenshot({ path: path.join(DIR, '02-project-card-default.png') });

    // Hover
    await projCardEl.hover();
    await page.waitForTimeout(800);
    await projCardEl.screenshot({ path: path.join(DIR, '02-project-card-hover.png') });
    await page.screenshot({ path: path.join(DIR, '02-projects-hover.png'), fullPage: true });

    // Check for pin icon appearing on hover
    const cardHTML = await projCardEl.innerHTML();
    const hasPin = cardHTML.includes('pin') || cardHTML.includes('Pin') || cardHTML.includes('📌') ||
                   cardHTML.includes('bookmark') || cardHTML.includes('Bookmark') ||
                   cardHTML.includes('star') || cardHTML.includes('Star') ||
                   cardHTML.includes('favorite') || cardHTML.includes('Favorite');
    console.log(`  Pin icon on hover: ${hasPin ? '✅ FOUND' : '❌ NOT FOUND'}`);

    // Check for any new buttons/icons that appear on hover (opacity-0 → opacity-100 pattern)
    const hoverBtns = await projCardEl.locator('button, [role="button"]').allTextContents();
    console.log(`  Buttons visible on hover: ${hoverBtns.filter(b => b.trim()).join(', ') || 'none'}`);

    // Check for SVG icons that might be pin
    const svgs = await projCardEl.locator('svg').count();
    console.log(`  SVG icons in card: ${svgs}`);

    // Look for title/aria-label with pin
    const pinBtns = projCardEl.locator('button[title*="pin" i], button[title*="Pin"], button[aria-label*="pin" i], button[aria-label*="Pin"], button[title*="favorite" i], button[title*="unpin" i]');
    const pinBtnCount = await pinBtns.count();
    console.log(`  Pin button (by title/aria): ${pinBtnCount > 0 ? '✅ FOUND' : '❌ NOT FOUND'}`);
    if (pinBtnCount > 0) {
      await pinBtns.first().screenshot({ path: path.join(DIR, '02-project-pin-btn.png') });
      console.log('  📸 02-project-pin-btn.png');
    }
  }

  // -- Teams --
  console.log('\n  --- Teams ---');
  await page.goto(`${BASE}/teams`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const teamCard = page.locator('[data-testid^="team-card-"]').first();
  if (await teamCard.count() > 0) {
    await teamCard.screenshot({ path: path.join(DIR, '02-team-card-default.png') });

    await teamCard.hover();
    await page.waitForTimeout(800);
    await teamCard.screenshot({ path: path.join(DIR, '02-team-card-hover.png') });
    await page.screenshot({ path: path.join(DIR, '02-teams-hover.png'), fullPage: true });

    const teamHTML = await teamCard.innerHTML();
    const hasTeamPin = teamHTML.includes('pin') || teamHTML.includes('Pin') ||
                       teamHTML.includes('bookmark') || teamHTML.includes('Bookmark') ||
                       teamHTML.includes('star') || teamHTML.includes('Star') ||
                       teamHTML.includes('favorite') || teamHTML.includes('Favorite');
    console.log(`  Pin icon on hover: ${hasTeamPin ? '✅ FOUND' : '❌ NOT FOUND'}`);

    const teamPinBtns = teamCard.locator('button[title*="pin" i], button[title*="Pin"], button[aria-label*="pin" i], button[title*="favorite" i], button[title*="unpin" i]');
    const teamPinCount = await teamPinBtns.count();
    console.log(`  Pin button (by title/aria): ${teamPinCount > 0 ? '✅ FOUND' : '❌ NOT FOUND'}`);
    if (teamPinCount > 0) {
      await teamPinBtns.first().screenshot({ path: path.join(DIR, '02-team-pin-btn.png') });
      console.log('  📸 02-team-pin-btn.png');
    }

    const teamHoverBtns = await teamCard.locator('button, [role="button"]').allTextContents();
    console.log(`  Buttons on hover: ${teamHoverBtns.filter(b => b.trim()).join(', ') || 'none'}`);
  }

  // ═══════════════════════════════════════════
  // 3. Nav — Pinned items in Work group
  // ═══════════════════════════════════════════
  console.log('\n=== 3. NAV PINNED ITEMS ===');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const nav = page.locator('nav').first();
  if (await nav.count() > 0) {
    await nav.screenshot({ path: path.join(DIR, '03-nav-full.png') });
    const navText = await nav.innerText();
    const navHTML = await nav.innerHTML();
    console.log('  Nav text:', navText.replace(/\n+/g, ' | '));

    // Check for PINNED section
    const hasPinnedSection = navText.includes('PINNED') || navText.includes('Pinned') || navText.includes('FAVORITES') || navText.includes('Favorites');
    console.log(`  PINNED/FAVORITES section: ${hasPinnedSection ? '✅ FOUND' : '❌ NOT FOUND'}`);

    // Check for pin icons anywhere in nav
    const pinInNav = navHTML.toLowerCase().includes('pin') || navHTML.includes('📌') ||
                     navHTML.includes('thumbtack') || navHTML.includes('MapPin') ||
                     navHTML.includes('bookmark') || navHTML.includes('star');
    console.log(`  Pin/bookmark/star in nav HTML: ${pinInNav ? '✅ FOUND' : '❌ NOT FOUND'}`);

    // Check if any project/team names appear in nav (indicating pinned items)
    const projNames = ['Business OS', 'web-visa', 'Crewly', 'SteamFun', 'China Stock'];
    const teamNames = ['Orchestrator', 'Crewly Team', 'StevesPrompt'];
    const pinnedProj = projNames.filter(n => navText.includes(n));
    const pinnedTeam = teamNames.filter(n => navText.includes(n));
    console.log(`  Project names in nav: ${pinnedProj.length > 0 ? '✅ ' + pinnedProj.join(', ') : '❌ NONE'}`);
    console.log(`  Team names in nav: ${pinnedTeam.length > 0 ? '✅ ' + pinnedTeam.join(', ') : '❌ NONE'}`);

    // Check WORK group specifically
    const workSection = navText.split('COMMUNICATE')[0] || '';
    console.log(`  WORK section content: "${workSection.replace(/\n+/g, ' | ').trim()}"`);

    // Check for any items between WORK and Dashboard that might be pinned items
    const workToFirstLink = workSection.split('Dashboard')[0] || '';
    if (workToFirstLink.trim().length > 10) {
      console.log(`  Items before Dashboard (possible pins): "${workToFirstLink.trim()}"`);
    }
  }

  await browser.close();
  console.log('\n✅ Done!');
}

run().catch(err => { console.error(err); process.exit(1); });
