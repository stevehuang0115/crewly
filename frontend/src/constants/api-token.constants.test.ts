/**
 * API Token Constants Tests
 *
 * @module constants/api-token.constants.test
 */

import { describe, it, expect } from 'vitest';
import {
  API_TOKEN_STORAGE_KEY,
  API_TOKEN_HEADER,
  API_TOKEN_COOKIE,
  API_TOKEN_QUERY_PARAM,
  API_TOKEN_AUTH_SCHEME,
  API_TOKEN_UNAUTHORIZED_ERROR,
  API_TOKEN_REQUIRED_EVENT,
  API_TOKEN_URL_EXCLUDED_PREFIX,
} from './api-token.constants';

describe('api-token.constants', () => {
  it('matches the backend wire names', () => {
    expect(API_TOKEN_STORAGE_KEY).toBe('crewly_api_token');
    expect(API_TOKEN_HEADER.toLowerCase()).toBe('x-crewly-token');
    expect(API_TOKEN_COOKIE).toBe('crewly_token');
    expect(API_TOKEN_QUERY_PARAM).toBe('token');
    expect(API_TOKEN_AUTH_SCHEME).toBe('Crewly-Token');
    expect(API_TOKEN_UNAUTHORIZED_ERROR).toBe('unauthorized');
  });

  it('keeps the cloud OAuth callback path out of token consumption', () => {
    expect('/auth/callback'.startsWith(API_TOKEN_URL_EXCLUDED_PREFIX)).toBe(true);
    expect('/teams'.startsWith(API_TOKEN_URL_EXCLUDED_PREFIX)).toBe(false);
  });

  it('uses a namespaced DOM event name', () => {
    expect(API_TOKEN_REQUIRED_EVENT).toMatch(/^crewly:/);
  });
});
