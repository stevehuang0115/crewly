/**
 * Shared authentication utilities.
 *
 * Provides common types and helpers used across both JWT and Supabase
 * authentication middleware to eliminate duplication.
 *
 * @module services/cloud/auth/auth.utils
 */

import type { Request } from 'express';
import type { UserPlan } from '../../../constants.js';

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

/** Authenticated user info attached to the request by auth middleware. */
export interface AuthenticatedUser {
	/** User ID (from JWT or Supabase) */
	userId: string;
	/** User email */
	email: string;
	/** User plan (resolved from license or token claims) */
	plan: UserPlan;
}

/** Extended request type with authenticated user. */
export interface AuthenticatedRequest extends Request {
	/** Authenticated user data (set by auth middleware) */
	user: AuthenticatedUser;
}

// ---------------------------------------------------------------------------
// Shared Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Bearer token from an Authorization header.
 *
 * @param req - Express request
 * @returns Token string or null if no valid Bearer token found
 */
export function extractBearerToken(req: Request): string | null {
	const header = req.headers.authorization;
	if (!header || !header.startsWith('Bearer ')) return null;
	return header.slice(7);
}
