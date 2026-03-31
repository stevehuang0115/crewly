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
  // 2a. Projects — pin on hover
  // ═══════════════════════════════════════════
  console.log('=== 2a. PROJECTS PIN ===');
  await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Find project cards by their visual structure
  const projCards = page.locator('.rounded-2xl, .rounded-xl').filter({ has: page.locator('text=Updated') });
  const projCount = await projCards.count();
  console.log(`  Project cards found: ${projCount}`);

  if (projCount > 0) {
    const card = projCards.first();
    await card.screenshot({ path: path.join(DIR, '02-project-card-default.png') });

    await card.hover();
    await page.waitForTimeout(800);
    await card.screenshot({ path: path.join(DIR, '02-project-card-hover.png') });

    const cardHTML = await card.innerHTML();
    const hasPin = cardHTML.toLowerCase().includes('pin') || cardHTML.includes('📌') || cardHTML.includes('thumbtack');
    console.log(`  Pin in card HTML: ${hasPin ? '✅' : '❌'}`);

    const pinBtn = card.locator('button[title*="pin" i], button[title*="Pin"], button[aria-label*="pin" i], button[aria-label*="unpin" i]');
    const pinCount = await pinBtn.count();
    console.log(`  Pin button: ${pinCount > 0 ? '✅ FOUND' : '❌ NOT FOUND'}`);
    if (pinCount > 0) {
      await pinBtn.first().screenshot({ path: path.join(DIR, '02-project-pin-btn.png') });
      console.log('  📸 02-project-pin-btn.png');
    }

    // List all buttons in card for debugging
    const allBtns = card.locator('button, [role="button"]');
    const btnCount = await allBtns.count();
    for (let i = 0; i < btnCount; i++) {
      const title = await allBtns.nth(i).getAttribute('title') || '';
      const aria = await allBtns.nth(i).getAttribute('aria-label') || '';
      const text = (await allBtns.nth(i).textContent())?.trim() || '';
      console.log(`  Button ${i}: title="${title}" aria="${aria}" text="${text}"`);
    }
  } else {
    // Broader search
    const allCards = page.locator('div[class*="cursor-pointer"]');
    console.log(`  Cursor-pointer cards: ${await allCards.count()}`);
    if (await allCards.count() > 0) {
      await allCards.first().hover();
      await page.waitForTimeout(800);
      await allCards.first().screenshot({ path: path.join(DIR, '02-project-card-hover.png') });
    }
  }

  // ═══════════════════════════════════════════
  // 2b. Pin a team → check nav
  // ═══════════════════════════════════════════
  console.log('\n=== 2b. PIN A TEAM → CHECK NAV ===');
  await page.goto(`${BASE}/teams`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Find and click pin button on first team card
  const teamCard = page.locator('[data-testid^="team-card-"]').first();
  if (await teamCard.count() > 0) {
    await teamCard.hover();
    await page.waitForTimeout(500);

    const pinBtn = teamCard.locator('button[title*="pin" i], button[title*="Pin"], button[aria-label*="pin" i]');
    if (await pinBtn.count() > 0) {
      const pinTitle = await pinBtn.first().getAttribute('title') || await pinBtn.first().getAttribute('aria-label') || '';
      console.log(`  Pin button title: "${pinTitle}"`);

      // Click the pin
      await pinBtn.first().click();
      await page.waitForTimeout(1500);
      console.log('  Clicked pin button');

      // Take screenshot after pinning
      await page.screenshot({ path: path.join(DIR, '02-team-after-pin.png'), fullPage: true });

      // Check nav for pinned item
      const nav = page.locator('nav').first();
      if (await nav.count() > 0) {
        const navText = await nav.innerText();
        console.log('  Nav after pin:', navText.replace(/\n+/g, ' | '));
        await nav.screenshot({ path: path.join(DIR, '03-nav-after-pin.png') });

        const hasPinned = navText.includes('PINNED') || navText.includes('Pinned') || navText.includes('Orchestrator');
        console.log(`  Pinned in nav: ${hasPinned ? '✅ FOUND' : '❌ NOT FOUND'}`);

        // Check if WORK section now has extra items
        const workSection = navText.split('COMMUNICATE')[0] || '';
        console.log(`  WORK section: "${workSection.replace(/\n+/g, ' | ').trim()}"`);
      }

      // Check the pin button state (should show "unpin" now)
      await teamCard.hover();
      await page.waitForTimeout(500);
      const unpinBtn = teamCard.locator('button[title*="unpin" i], button[title*="Unpin"], button[aria-label*="unpin" i]');
      if (await unpinBtn.count() > 0) {
        console.log('  Unpin button now visible: ✅');
        await unpinBtn.first().screenshot({ path: path.join(DIR, '02-team-unpin-btn.png') });
      }

      // Unpin to clean up
      const anyPinBtn = teamCard.locator('button[title*="pin" i], button[title*="Pin" i], button[aria-label*="pin" i]');
      if (await anyPinBtn.count() > 0) {
        await anyPinBtn.first().click();
        await page.waitForTimeout(500);
        console.log('  Unpinned (cleaned up)');
      }
    }
  }

  // ═══════════════════════════════════════════
  // 1b. Chat — closer look at masking
  // ═══════════════════════════════════════════
  console.log('\n=== 1b. CHAT CLOSER LOOK ===');
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Click a thread
  const thread = page.locator('[class*="thread"], [class*="Thread"], [data-testid*="thread"]').first();
  if (await thread.count() > 0) {
    await thread.click();
    await page.waitForTimeout(1500);
  }

  // Look for message elements and check their content
  const messages = page.locator('[class*="message"], [class*="Message"], [data-testid*="message"]');
  const msgCount = await messages.count();
  console.log(`  Message elements: ${msgCount}`);

  // Find a message with [Thread context file:] and screenshot it
  for (let i = 0; i < Math.min(msgCount, 10); i++) {
    const text = await messages.nth(i).textContent() || '';
    if (text.includes('Thread context') || text.includes('eyJ') || text.includes('/Users/')) {
      await messages.nth(i).screenshot({ path: path.join(DIR, `01-chat-msg-${i}.png`) });
      console.log(`  📸 01-chat-msg-${i}.png — contains: ${text.includes('Thread context') ? 'threadCtx' : ''} ${text.includes('eyJ') ? 'JWT' : ''} ${text.includes('/Users/') ? 'path' : ''}`);
      break;
    }
  }

  // Check if [Thread context file:] is displayed or hidden
  const threadCtxVisible = await page.evaluate(() => {
    const body = document.body.innerText;
    const threadCtx = body.match(/\[Thread context file:[^\]]*\]/g) || [];
    // Also check if they're inside elements with display:none or opacity:0
    const hiddenCtx = document.querySelectorAll('[style*="display: none"], [style*="opacity: 0"], .hidden, .sr-only');
    let hiddenTexts = [];
    hiddenCtx.forEach(el => { if (el.textContent?.includes('Thread context')) hiddenTexts.push(el.textContent.substring(0, 50)); });
    return { visibleCount: threadCtx.length, hiddenCount: hiddenTexts.length, samples: threadCtx.slice(0, 3) };
  });
  console.log(`  Thread context: ${threadCtxVisible.visibleCount} visible, ${threadCtxVisible.hiddenCount} hidden`);
  if (threadCtxVisible.samples.length > 0) {
    console.log(`  Samples: ${threadCtxVisible.samples[0].substring(0, 80)}`);
  }

  await browser.close();
  console.log('\n✅ Done!');
}

run().catch(err => { console.error(err); process.exit(1); });
