/**
 * Dashboard Build Service Tests (#1010 review)
 *
 * @module services/dashboard-build.service.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DASHBOARD_UPDATED_EVENT, currentDashboardEntry, noteServerBuild, resetDashboardBuildForTesting } from './dashboard-build.service';

/** A document whose entry script is `src`. */
function docWith(src: string | null): Pick<Document, 'querySelectorAll'> {
  const d = document.implementation.createHTMLDocument('t');
  if (src) {
    const s = d.createElement('script');
    s.setAttribute('type', 'module');
    s.setAttribute('src', src);
    d.head.appendChild(s);
  }
  return d;
}

describe('dashboard-build.service', () => {
  beforeEach(() => resetDashboardBuildForTesting());

  it('reads this tab\'s entry script, null in dev', () => {
    expect(currentDashboardEntry(docWith('/assets/index-aaa.js'))).toBe('/assets/index-aaa.js');
    expect(currentDashboardEntry(docWith('/src/main.tsx'))).toBeNull();
    expect(currentDashboardEntry(docWith(null))).toBeNull();
  });

  it('announces a different served build exactly once', () => {
    const listener = vi.fn();
    window.addEventListener(DASHBOARD_UPDATED_EVENT, listener);
    const doc = docWith('/assets/index-aaa.js');
    expect(noteServerBuild('/assets/index-aaa.js', doc)).toBe(false);
    expect(noteServerBuild(null, doc)).toBe(false);
    expect(noteServerBuild('/assets/index-bbb.js', doc)).toBe(true);
    expect(noteServerBuild('/assets/index-ccc.js', doc)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(DASHBOARD_UPDATED_EVENT, listener);
  });

  it('never announces in dev (no built entry)', () => {
    expect(noteServerBuild('/assets/index-bbb.js', docWith('/src/main.tsx'))).toBe(false);
  });
});
