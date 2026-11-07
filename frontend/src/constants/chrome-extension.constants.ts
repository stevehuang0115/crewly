/**
 * Crewly in Chrome — Web Store link and install-prompt copy.
 *
 * The first-run checklist and two empty states (Browser, Cloud devices) offer
 * the extension in one click. Each placement tags the link with its own
 * `utm_medium` so Marketing can see which one brings installs
 * (ops/marketing/2026-11-chrome-ext-usage/plan.md).
 *
 * @module constants/chrome-extension.constants
 */

/** Web Store listing of Crewly in Chrome. */
export const CHROME_EXTENSION_STORE_URL =
  'https://chromewebstore.google.com/detail/crewly-in-chrome/mekcefkcdgefjhadkcbkdpmilcaekhnc';

/** Where an install link sits (the `utm_medium`). */
export const CHROME_EXTENSION_PLACEMENTS = {
  /** The optional "Connect Crewly in Chrome" step of the first-run checklist */
  CHECKLIST: 'checklist',
  /** The Browser page when no agent is using the browser */
  BROWSER_EMPTY: 'browser-empty',
  /** Settings → Cloud devices when no browser extension is connected */
  DEVICES_EMPTY: 'devices-empty',
} as const;

/** One of {@link CHROME_EXTENSION_PLACEMENTS}. */
export type ChromeExtensionPlacement = (typeof CHROME_EXTENSION_PLACEMENTS)[keyof typeof CHROME_EXTENSION_PLACEMENTS];

/** UTM parameters shared by every placement (`utm_medium` is added per placement). */
export const CHROME_EXTENSION_UTM = {
  SOURCE: 'crewly-app',
  CAMPAIGN: 'chrome-ext-usage',
} as const;

/** Label of the install button in the empty states. */
export const CHROME_EXTENSION_INSTALL_LABEL = 'Install Crewly in Chrome';

/**
 * The Web Store link for a placement, with its UTM parameters.
 *
 * @param placement - Where the link is shown (the `utm_medium`)
 * @returns Absolute URL
 *
 * @example
 * chromeExtensionUrl('checklist')
 * // https://chromewebstore.google.com/detail/crewly-in-chrome/mekcefkcdgefjhadkcbkdpmilcaekhnc?utm_source=crewly-app&utm_medium=checklist&utm_campaign=chrome-ext-usage
 */
export function chromeExtensionUrl(placement: ChromeExtensionPlacement): string {
  const params = new URLSearchParams({
    utm_source: CHROME_EXTENSION_UTM.SOURCE,
    utm_medium: placement,
    utm_campaign: CHROME_EXTENSION_UTM.CAMPAIGN,
  });
  return `${CHROME_EXTENSION_STORE_URL}?${params.toString()}`;
}

/** Which Cloud usage source each placement counts as (the backend path segment). */
export const CHROME_EXTENSION_CLICK_SOURCE: Record<ChromeExtensionPlacement, 'onboarding' | 'empty_state'> = {
  checklist: 'onboarding',
  'browser-empty': 'empty_state',
  'devices-empty': 'empty_state',
};

/**
 * Count the click in Cloud feature usage. Fire-and-forget: the backend reports
 * it to Cloud only when this machine is signed in, and every failure is
 * swallowed so the click is never delayed or broken.
 *
 * @param placement - Where the clicked link is shown
 */
export function reportChromeExtensionClick(placement: ChromeExtensionPlacement): void {
  try {
    void fetch(`/api/cloud/chrome-store-click/${CHROME_EXTENSION_CLICK_SOURCE[placement]}`, {
      method: 'POST',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Counting must never affect the click.
  }
}

/**
 * Open the Web Store listing in a new tab (no opener, no referrer), then count the click.
 *
 * @param placement - Where the link is shown
 */
export function openChromeExtensionStore(placement: ChromeExtensionPlacement): void {
  window.open(chromeExtensionUrl(placement), '_blank', 'noopener,noreferrer');
  reportChromeExtensionClick(placement);
}
