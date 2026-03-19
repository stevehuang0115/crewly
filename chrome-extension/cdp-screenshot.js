/**
 * Crewly Remote Browser — CDP Screenshot Module
 *
 * Provides screenshot capture using Chrome DevTools Protocol (CDP)
 * via chrome.debugger API. Falls back to chrome.tabs.captureVisibleTab
 * when the debugger is unavailable.
 *
 * Reference: Claude Chrome Extension uses the same approach
 * (chrome.debugger + CDP Page.captureScreenshot).
 */

// ── CDP Screenshot Core ──────────────────────────────────────────────────────

/**
 * Captures a screenshot using Chrome DevTools Protocol (CDP).
 * Attaches chrome.debugger, sends Page.captureScreenshot, then detaches.
 * Handles Retina displays by reporting devicePixelRatio.
 *
 * @param {number} tabId - Tab to capture
 * @returns {Promise<{base64: string, format: string, length: number, devicePixelRatio: number, method: string}>}
 * @throws {Error} If debugger attach or screenshot capture fails
 */
async function cdpCaptureScreenshot(tabId) {
  const target = { tabId };

  // Hide extension UI overlay before capture to avoid it appearing in screenshot
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'hideIndicator' });
    await new Promise(r => setTimeout(r, 50));
  } catch {
    // Content script may not be loaded — ignore
  }

  // Attach debugger with CDP protocol version 1.3
  await chrome.debugger.attach(target, '1.3');

  try {
    // Get device pixel ratio for Retina scaling awareness
    let devicePixelRatio = 1;
    try {
      const dprResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.devicePixelRatio || 1,
      });
      devicePixelRatio = dprResults?.[0]?.result || 1;
    } catch {
      // Restricted page — use default DPR
    }

    // Capture screenshot via CDP Page.captureScreenshot
    const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });

    return {
      base64: result.data,
      format: 'png',
      length: result.data.length,
      devicePixelRatio,
      method: 'cdp',
    };
  } finally {
    // Always detach debugger to avoid leaving it attached
    try {
      await chrome.debugger.detach(target);
    } catch {
      // Already detached or tab closed — ignore
    }
  }
}

/**
 * Captures a full-page screenshot using CDP Page.captureScreenshot
 * with captureBeyondViewport. No scrolling required — CDP handles it.
 *
 * @param {number} tabId - Tab to capture
 * @returns {Promise<{segments: Array, totalHeight: number, viewportHeight: number, segmentCount: number, format: string, method: string}>}
 * @throws {Error} If debugger attach or screenshot capture fails
 */
async function cdpCaptureFullPage(tabId) {
  const target = { tabId };

  // Hide extension UI overlay before capture
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'hideIndicator' });
    await new Promise(r => setTimeout(r, 50));
  } catch {
    // Content script may not be loaded — ignore
  }

  await chrome.debugger.attach(target, '1.3');

  try {
    // Get full page dimensions via CDP Layout Metrics
    const layoutMetrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const contentSize = layoutMetrics.cssContentSize || layoutMetrics.contentSize;
    const width = contentSize.width;
    const height = contentSize.height;

    // Capture full page in one shot using clip region
    const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });

    return {
      segments: [{ index: 0, scrollY: 0, base64: result.data }],
      totalHeight: height,
      viewportHeight: height,
      segmentCount: 1,
      format: 'png',
      method: 'cdp',
    };
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      // Already detached or tab closed — ignore
    }
  }
}

/**
 * Takes a screenshot using CDP, with automatic fallback to
 * chrome.tabs.captureVisibleTab if the debugger is unavailable.
 *
 * @param {number|null} tabId - Specific tab to capture (null = active tab)
 * @returns {Promise<{base64: string, format: string, length: number, method: string}>}
 */
async function screenshotWithFallback(tabId) {
  // Resolve tab ID if not provided
  if (tabId === null || tabId === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    tabId = tab.id;
  }

  // Try CDP first
  try {
    return await cdpCaptureScreenshot(tabId);
  } catch (err) {
    console.warn('[crewly] CDP screenshot failed, falling back to captureVisibleTab:', err.message);
    // Fallback to captureVisibleTab
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    return { base64, format: 'png', length: base64.length, method: 'captureVisibleTab' };
  }
}

/**
 * Takes a full-page screenshot using CDP, with automatic fallback to
 * the scroll-and-capture approach using captureVisibleTab.
 *
 * @param {object} tab - Chrome tab object (must have .id)
 * @param {function} scrollCaptureFallback - Fallback function for scroll-capture
 * @returns {Promise<{segments: Array, totalHeight: number, viewportHeight: number, segmentCount: number, format: string, method: string}>}
 */
async function fullPageScreenshotWithFallback(tab, scrollCaptureFallback) {
  try {
    return await cdpCaptureFullPage(tab.id);
  } catch (err) {
    console.warn('[crewly] CDP full page screenshot failed, falling back to scroll-capture:', err.message);
    return await scrollCaptureFallback(tab);
  }
}
