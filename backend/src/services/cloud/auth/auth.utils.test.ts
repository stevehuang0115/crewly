/**
 * Tests for shared authentication utilities.
 *
 * @module services/cloud/auth/auth.utils.test
 */

import type { Request } from 'express';
import {
	extractBearerToken,
} from './auth.utils.js';

describe('auth.utils', () => {
	describe('extractBearerToken', () => {
		it('should extract token from valid Bearer header', () => {
			const req = {
				headers: { authorization: 'Bearer abc123token' },
			} as unknown as Request;

			expect(extractBearerToken(req)).toBe('abc123token');
		});

		it('should return null when no Authorization header', () => {
			const req = { headers: {} } as Request;
			expect(extractBearerToken(req)).toBeNull();
		});

		it('should return null when Authorization header is not Bearer', () => {
			const req = {
				headers: { authorization: 'Basic abc123' },
			} as unknown as Request;

			expect(extractBearerToken(req)).toBeNull();
		});

		it('should return null when Authorization header is empty', () => {
			const req = {
				headers: { authorization: '' },
			} as unknown as Request;

			expect(extractBearerToken(req)).toBeNull();
		});

		it('should handle tokens with special characters', () => {
			const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';
			const req = {
				headers: { authorization: `Bearer ${token}` },
			} as unknown as Request;

			expect(extractBearerToken(req)).toBe(token);
		});
	});

});
