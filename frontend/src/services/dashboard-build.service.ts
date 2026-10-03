/**
 * Dashboard Build Service (#1010 review)
 *
 * The backend stamps every `/api` response with the dashboard build it
 * serves (`X-Crewly-Dashboard-Build`: the hashed entry script) and sends the
 * same as `dashboard_build` on each socket.io connection. When that differs
 * from the bundle running in this tab, Crewly was updated under it: this
 * module raises `crewly:dashboard-updated` once, and the
 * UpdateAvailableBanner asks the owner to reload.
 *
 * @module services/dashboard-build.service
 */

/** Response header carrying the served build (mirrors OWNER_AUTH_CONSTANTS.BUILD_HEADER). */
export const DASHBOARD_BUILD_HEADER = 'X-Crewly-Dashboard-Build';

/** socket.io event carrying the served build (mirrors OWNER_AUTH_CONSTANTS.BUILD_EVENT). */
export const DASHBOARD_BUILD_EVENT = 'dashboard_build';

/** Window event raised once when the served build differs from this tab's. */
export const DASHBOARD_UPDATED_EVENT = 'crewly:dashboard-updated';

let announced = false;

/**
 * The entry script of the bundle running in this tab.
 *
 * @param doc - Document (tests)
 * @returns e.g. `/assets/index-b91a9801.js`, or null in dev (Vite serves source)
 */
export function currentDashboardEntry(doc: Pick<Document, 'querySelectorAll'> = document): string | null {
  for (const el of Array.from(doc.querySelectorAll('script[type="module"][src]'))) {
    const src = el.getAttribute('src') ?? '';
    if (!src.includes('/assets/')) continue;
    try {
      return new URL(src, window.location.origin).pathname;
    } catch {
      return src;
    }
  }
  return null;
}

/**
 * Compare a build the server reported with this tab's, and announce a
 * change once.
 *
 * @param served - The served entry (header or socket payload)
 * @param doc - Document (tests)
 * @returns True when this call announced an update
 */
export function noteServerBuild(served: string | null | undefined, doc?: Pick<Document, 'querySelectorAll'>): boolean {
  if (announced || !served) return false;
  const mine = currentDashboardEntry(doc);
  if (!mine || mine === served) return false;
  announced = true;
  try {
    window.dispatchEvent(new CustomEvent(DASHBOARD_UPDATED_EVENT, { detail: { served, mine } }));
  } catch {
    // no window (tests without DOM)
  }
  return true;
}

/**
 * Forget the announcement (tests).
 */
export function resetDashboardBuildForTesting(): void {
  announced = false;
}
