/**
 * Tests for CLI license check utilities
 *
 * @module cli/utils/license-check.test
 */

// Mock chalk (ESM-only package not transformable by Jest)
jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy({}, {
		get: () => {
			const fn = (s: string) => s;
			return new Proxy(fn, { get: () => fn, apply: (_t, _this, args) => args[0] });
		},
	}),
}));

import { checkLicense, requireFeature } from './license-check.js';
import type { LicenseCheckResult, LicenseVerifyResponse } from './license-check.js';

// ========================= Helpers =========================

/**
 * Creates a mock Response with the given body and status
 */
function mockResponse(body: LicenseVerifyResponse, ok = true): Response {
	return {
		ok,
		status: ok ? 200 : 500,
		json: async () => body,
	} as Response;
}

/** Standard pro-tier response with all features */
const PRO_RESPONSE: LicenseVerifyResponse = {
	success: true,
	data: {
		valid: true,
		tier: 'pro',
		features: [
			'basic_teams',
			'premium_templates',
			'cloud_relay',
			'multi_device',
			'custom_templates',
			'priority_support',
		],
	},
};

/** Free-tier response with limited features */
const FREE_RESPONSE: LicenseVerifyResponse = {
	success: true,
	data: {
		valid: true,
		tier: 'free',
		features: ['basic_teams'],
	},
};

/** Invalid/expired license response */
const INVALID_RESPONSE: LicenseVerifyResponse = {
	success: true,
	data: {
		valid: false,
		tier: 'expired',
		features: [],
	},
};

/** Backend error response (success: false) */
const ERROR_BODY_RESPONSE: LicenseVerifyResponse = {
	success: false,
	data: {
		valid: false,
		tier: '',
		features: [],
	},
};

// ========================= Tests =========================

describe('license-check utilities', () => {
	let fetchSpy: jest.SpyInstance;

	beforeEach(() => {
		fetchSpy = jest.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	// ----- checkLicense -----

	describe('checkLicense', () => {
		it('should return allowed=true for a feature included in pro tier', async () => {
			fetchSpy.mockResolvedValue(mockResponse(PRO_RESPONSE));

			const result = await checkLicense('premium_templates');

			expect(result.allowed).toBe(true);
			expect(result.tier).toBe('pro');
			expect(result.message).toBeUndefined();
		});

		it('should return allowed=true for basic_teams on free tier', async () => {
			fetchSpy.mockResolvedValue(mockResponse(FREE_RESPONSE));

			const result = await checkLicense('basic_teams');

			expect(result.allowed).toBe(true);
			expect(result.tier).toBe('free');
		});

		it('should return allowed=false for premium feature on free tier', async () => {
			fetchSpy.mockResolvedValue(mockResponse(FREE_RESPONSE));

			const result = await checkLicense('cloud_relay');

			expect(result.allowed).toBe(false);
			expect(result.tier).toBe('free');
			expect(result.message).toContain('cloud_relay');
			expect(result.message).toContain('higher plan');
		});

		it('should default to free tier when backend is unreachable', async () => {
			fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

			const result = await checkLicense('premium_templates');

			expect(result.allowed).toBe(false);
			expect(result.tier).toBe('free');
			expect(result.message).toContain('free tier');
			expect(result.message).toContain('crewly cloud login');
		});

		it('should allow basic_teams when backend is unreachable', async () => {
			fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

			const result = await checkLicense('basic_teams');

			expect(result.allowed).toBe(true);
			expect(result.tier).toBe('free');
		});

		it('should default to free tier on HTTP error response', async () => {
			fetchSpy.mockResolvedValue({
				ok: false,
				status: 500,
			} as Response);

			const result = await checkLicense('premium_templates');

			expect(result.allowed).toBe(false);
			expect(result.tier).toBe('free');
		});

		it('should default to free tier when response success is false', async () => {
			fetchSpy.mockResolvedValue(mockResponse(ERROR_BODY_RESPONSE));

			const result = await checkLicense('premium_templates');

			expect(result.allowed).toBe(false);
			expect(result.tier).toBe('free');
		});

		it('should default to free tier when license is invalid/expired', async () => {
			fetchSpy.mockResolvedValue(mockResponse(INVALID_RESPONSE));

			const result = await checkLicense('premium_templates');

			expect(result.allowed).toBe(false);
			expect(result.tier).toBe('free');
		});

		it('should handle abort/timeout gracefully', async () => {
			fetchSpy.mockImplementation(() => new Promise((_, reject) => {
				setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 10);
			}));

			const result = await checkLicense('cloud_relay');

			expect(result.allowed).toBe(false);
			expect(result.tier).toBe('free');
		});

		it('should handle malformed JSON response gracefully', async () => {
			fetchSpy.mockResolvedValue({
				ok: true,
				json: async () => { throw new SyntaxError('Unexpected token'); },
			} as unknown as Response);

			const result = await checkLicense('premium_templates');

			expect(result.allowed).toBe(false);
			expect(result.tier).toBe('free');
		});

		it('should return correct result shape', async () => {
			fetchSpy.mockResolvedValue(mockResponse(PRO_RESPONSE));

			const result: LicenseCheckResult = await checkLicense('basic_teams');

			expect(result).toHaveProperty('allowed');
			expect(result).toHaveProperty('tier');
			expect(typeof result.allowed).toBe('boolean');
			expect(typeof result.tier).toBe('string');
		});
	});

	// ----- requireFeature -----

	describe('requireFeature', () => {
		let exitSpy: jest.SpyInstance;
		let errorSpy: jest.SpyInstance;

		beforeEach(() => {
			exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
				throw new Error('process.exit called');
			}) as never);
			errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
		});

		afterEach(() => {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it('should not exit when feature is allowed', async () => {
			fetchSpy.mockResolvedValue(mockResponse(PRO_RESPONSE));

			await requireFeature('premium_templates');

			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('should exit with code 1 when feature is not allowed', async () => {
			fetchSpy.mockResolvedValue(mockResponse(FREE_RESPONSE));

			await expect(requireFeature('cloud_relay')).rejects.toThrow('process.exit called');

			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('should print error message when feature is not allowed', async () => {
			fetchSpy.mockResolvedValue(mockResponse(FREE_RESPONSE));

			await expect(requireFeature('premium_templates')).rejects.toThrow('process.exit called');

			const output = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Feature not available');
			expect(output).toContain('crewlyai.com/pricing');
		});

		it('should exit when backend is unreachable and feature is premium', async () => {
			fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

			await expect(requireFeature('multi_device')).rejects.toThrow('process.exit called');

			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('should not exit for basic_teams even when backend is down', async () => {
			fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

			await requireFeature('basic_teams');

			expect(exitSpy).not.toHaveBeenCalled();
		});
	});
});
