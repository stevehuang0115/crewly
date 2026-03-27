/**
 * CLI License Check Utilities
 *
 * Provides functions for verifying user license tier and feature entitlements
 * against the Crewly backend. Used by CLI commands to gate premium features.
 *
 * When the backend is unreachable, defaults to free tier (basic_teams only)
 * to ensure graceful degradation.
 *
 * @module cli/utils/license-check
 */

import chalk from 'chalk';
import { WEB_CONSTANTS } from '../../../config/constants.js';

// ========================= Constants =========================

/** Backend base URL for license verification */
const BACKEND_URL = `http://localhost:${WEB_CONSTANTS.PORTS.BACKEND}`;

/** License verification endpoint */
const LICENSE_VERIFY_ENDPOINT = '/api/cloud/license/verify';

/** Request timeout in milliseconds */
const LICENSE_CHECK_TIMEOUT_MS = 5000;

/** Features available on the free tier when backend is unreachable */
const FREE_TIER_FEATURES: readonly string[] = ['basic_teams'];

/** Free tier name */
const FREE_TIER_NAME = 'free';

// ========================= Types =========================

/**
 * Response shape from the backend license verification endpoint
 */
export interface LicenseVerifyResponse {
	success: boolean;
	data: {
		valid: boolean;
		tier: string;
		features: string[];
	};
}

/**
 * Result of a license check for a specific feature
 */
export interface LicenseCheckResult {
	/** Whether the user is allowed to use the requested feature */
	allowed: boolean;
	/** The user's current license tier (e.g. 'free', 'pro', 'enterprise') */
	tier: string;
	/** Human-readable message explaining the result (present when not allowed) */
	message?: string;
}

// ========================= Functions =========================

/**
 * Checks whether the current user's license allows access to a specific feature.
 *
 * Queries GET /api/cloud/license/verify on the local backend and inspects the
 * returned features array. If the backend is unreachable or returns an error,
 * defaults to free tier (only `basic_teams` allowed).
 *
 * @param requiredFeature - The feature identifier to check (e.g. 'premium_templates', 'cloud_relay')
 * @returns License check result with allowed status, tier, and optional message
 *
 * @example
 * ```typescript
 * const result = await checkLicense('premium_templates');
 * if (!result.allowed) {
 *   console.log(result.message);
 * }
 * ```
 */
export async function checkLicense(requiredFeature: string): Promise<LicenseCheckResult> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), LICENSE_CHECK_TIMEOUT_MS);

		const response = await fetch(`${BACKEND_URL}${LICENSE_VERIFY_ENDPOINT}`, {
			signal: controller.signal,
			headers: { 'Accept': 'application/json' },
		});
		clearTimeout(timeout);

		if (!response.ok) {
			return buildFreeTierResult(requiredFeature);
		}

		const body = (await response.json()) as LicenseVerifyResponse;

		if (!body.success || !body.data?.valid) {
			return buildFreeTierResult(requiredFeature);
		}

		const { tier, features } = body.data;
		const allowed = Array.isArray(features) && features.includes(requiredFeature);

		if (allowed) {
			return { allowed: true, tier };
		}

		return {
			allowed: false,
			tier,
			message: `Feature "${requiredFeature}" requires a higher plan. Current tier: ${tier}. Upgrade at https://crewlyai.com/pricing`,
		};
	} catch {
		return buildFreeTierResult(requiredFeature);
	}
}

/**
 * Builds a license check result assuming free tier access.
 * Used when the backend is unreachable or returns invalid data.
 *
 * @param requiredFeature - The feature that was requested
 * @returns A LicenseCheckResult defaulting to free tier
 */
function buildFreeTierResult(requiredFeature: string): LicenseCheckResult {
	const allowed = FREE_TIER_FEATURES.includes(requiredFeature);

	if (allowed) {
		return { allowed: true, tier: FREE_TIER_NAME };
	}

	return {
		allowed: false,
		tier: FREE_TIER_NAME,
		message: `Feature "${requiredFeature}" is not available on the free tier. Connect to Crewly Cloud to unlock premium features: crewly cloud login`,
	};
}

/**
 * Guards a CLI command by verifying the user has access to a required feature.
 *
 * Calls {@link checkLicense} and, if the feature is not allowed, prints a
 * user-friendly error message using chalk and exits the process with code 1.
 *
 * @param feature - The feature identifier required by the command
 * @throws Exits the process (process.exit(1)) if the feature is not allowed
 *
 * @example
 * ```typescript
 * // At the top of a premium command handler:
 * await requireFeature('premium_templates');
 * // If we reach here, the user has access
 * ```
 */
export async function requireFeature(feature: string): Promise<void> {
	const result = await checkLicense(feature);

	if (result.allowed) {
		return;
	}

	console.error('');
	console.error(chalk.red('  ✖ Feature not available'));
	console.error('');
	console.error(`  ${chalk.yellow(result.message ?? `Feature "${feature}" requires a premium license.`)}`);
	console.error('');
	console.error(`  ${chalk.gray(`Current tier: ${result.tier}`)}`);
	console.error(`  ${chalk.cyan('Upgrade → https://crewlyai.com/pricing')}`);
	console.error('');

	process.exit(1);
}
