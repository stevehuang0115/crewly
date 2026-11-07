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
  reportChromeExtensionClick,
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

  it.each([
    ['checklist', 'onboarding'],
    ['browser-empty', 'empty_state'],
    ['devices-empty', 'empty_state'],
  ] as const)('%s counts as source %s: opens the store first, then POSTs keepalive', (placement, source) => {
    const order: string[] = [];
    vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('open');
      return null;
    });
    const fetchMock = vi.fn(() => {
      order.push('report');
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    openChromeExtensionStore(placement);
    expect(order).toEqual(['open', 'report']);
    expect(fetchMock).toHaveBeenCalledWith(`/api/cloud/chrome-store-click/${source}`, { method: 'POST', keepalive: true });
    vi.unstubAllGlobals();
  });

  it('a failing or throwing report never breaks the click', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    expect(() => openChromeExtensionStore('checklist')).not.toThrow();
    await Promise.resolve();
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('boom');
    }));
    expect(() => reportChromeExtensionClick('checklist')).not.toThrow();
    vi.unstubAllGlobals();
  });
});
