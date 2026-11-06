/**
 * Tests for the Crewly in Chrome Web Store link.
 *
 * @module constants/chrome-extension.constants.test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CHROME_EXTENSION_INSTALL_LABEL,
  CHROME_EXTENSION_PLACEMENTS,
  CHROME_EXTENSION_STORE_URL,
  chromeExtensionUrl,
  openChromeExtensionStore,
} from './chrome-extension.constants';

describe('chrome-extension constants', () => {
  afterEach(() => vi.restoreAllMocks());

  it('points at the Crewly in Chrome Web Store listing', () => {
    expect(CHROME_EXTENSION_STORE_URL).toBe(
      'https://chromewebstore.google.com/detail/crewly-in-chrome/mekcefkcdgefjhadkcbkdpmilcaekhnc',
    );
    expect(CHROME_EXTENSION_INSTALL_LABEL).toBe('Install Crewly in Chrome');
  });

  it('has three placements, each its own utm_medium', () => {
    expect(Object.values(CHROME_EXTENSION_PLACEMENTS)).toEqual(['checklist', 'browser-empty', 'devices-empty']);
  });

  it.each(Object.values(CHROME_EXTENSION_PLACEMENTS))('%s: store URL with source, medium and campaign', (placement) => {
    expect(chromeExtensionUrl(placement)).toBe(
      `${CHROME_EXTENSION_STORE_URL}?utm_source=crewly-app&utm_medium=${placement}&utm_campaign=chrome-ext-usage`,
    );
  });

  it('opens the link in a new tab without opener or referrer', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openChromeExtensionStore('checklist');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(chromeExtensionUrl('checklist'), '_blank', 'noopener,noreferrer');
  });
});
