/**
 * Which dashboard build this backend serves (#1010 review).
 *
 * After an upgrade, a tab that is still open runs the previous bundle. The
 * new bundle can tell when that happens to it in the future: the backend
 * stamps every `/api` response with the build it serves (the hashed entry
 * script of `frontend/dist/index.html`) and sends the same on each
 * socket.io connection. A tab whose own entry script differs shows "Crewly
 * was updated — reload". Bundles from before this change ignore both; for
 * them the owner-auth 401 says "Reload this page" in plain words instead.
 *
 * @module services/core/dashboard-build
 */

import * as fs from 'fs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { OWNER_AUTH_CONSTANTS } from '../../constants.js';

/**
 * The entry script of a built `index.html`.
 *
 * @param html - index.html content
 * @returns e.g. `/assets/index-b91a9801.js`, or null for a dev / unbuilt page
 */
export function parseDashboardEntry(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype=["']module["']/i.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (src && src.includes('/assets/')) return src;
  }
  return null;
}

/**
 * Read the entry script of the dashboard this backend serves.
 *
 * @param indexHtmlPath - Path of `frontend/dist/index.html`
 * @returns The entry, or null when there is no built dashboard
 */
export function loadDashboardEntry(indexHtmlPath: string): string | null {
  try {
    return parseDashboardEntry(fs.readFileSync(indexHtmlPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Middleware stamping `/api` responses with the served build.
 *
 * @param entry - The served entry (null: stamps nothing)
 * @returns Express middleware
 */
export function dashboardBuildHeader(entry: string | null): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (entry) res.setHeader(OWNER_AUTH_CONSTANTS.BUILD_HEADER, entry);
    next();
  };
}

/**
 * The socket.io message announcing the served build.
 *
 * @param entry - The served entry
 * @returns `{ type, payload: { entry }, timestamp }`, the gateway's message shape
 */
export function dashboardBuildMessage(entry: string): { type: string; payload: { entry: string }; timestamp: string } {
  return { type: OWNER_AUTH_CONSTANTS.BUILD_EVENT, payload: { entry }, timestamp: new Date().toISOString() };
}
