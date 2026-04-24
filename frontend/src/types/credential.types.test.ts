/**
 * Tests for Credential Types — constants and shape contracts.
 *
 * These types are mostly structural, but the Gmail-only scope preset is a
 * shared constant consumed by both frontend and orchestrator skills, so we
 * pin its contents to prevent accidental drift (e.g. adding Drive access
 * back into the "low-risk" preset).
 *
 * @module types/credential.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  GMAIL_ONLY_SCOPES,
  type GoogleScopePreset,
  type CredentialSummary,
  type StartGoogleOAuthRequest,
  type CompleteGoogleOAuthRequest,
} from './credential.types';

describe('GMAIL_ONLY_SCOPES', () => {
  it('includes the identity scopes needed to fetch the account email', () => {
    expect(GMAIL_ONLY_SCOPES).toContain('openid');
    expect(GMAIL_ONLY_SCOPES).toContain(
      'https://www.googleapis.com/auth/userinfo.email',
    );
    expect(GMAIL_ONLY_SCOPES).toContain(
      'https://www.googleapis.com/auth/userinfo.profile',
    );
  });

  it('includes gmail.modify so agents can read AND send email', () => {
    expect(GMAIL_ONLY_SCOPES).toContain(
      'https://www.googleapis.com/auth/gmail.modify',
    );
  });

  it('does NOT include broad Workspace scopes (Drive, Calendar, Photos)', () => {
    // The whole point of this preset is to avoid the "App blocked" screen on
    // personal gmail accounts — keep it narrow.
    const broadPatterns = [/drive/, /calendar/, /photos/, /documents/];
    for (const pattern of broadPatterns) {
      expect(GMAIL_ONLY_SCOPES.some((s) => pattern.test(s))).toBe(false);
    }
  });
});

describe('Type contracts (compile-time via TS + structural checks)', () => {
  it('StartGoogleOAuthRequest accepts either empty or scopes-only bodies', () => {
    const empty: StartGoogleOAuthRequest = {};
    const withScopes: StartGoogleOAuthRequest = { scopes: ['openid'] };
    expect(empty).toBeDefined();
    expect(withScopes.scopes).toHaveLength(1);
  });

  it('CompleteGoogleOAuthRequest accepts string or object credentialsJson', () => {
    const asString: CompleteGoogleOAuthRequest = {
      name: 'x',
      credentialsJson: '{"access_token":"a"}',
    };
    const asObject: CompleteGoogleOAuthRequest = {
      name: 'x',
      credentialsJson: { access_token: 'a', refresh_token: 'b' },
    };
    expect(typeof asString.credentialsJson).toBe('string');
    expect(typeof asObject.credentialsJson).toBe('object');
  });

  it('GoogleScopePreset covers all three UI options', () => {
    const presets: GoogleScopePreset[] = ['gmail-only', 'full-workspace', 'custom'];
    expect(presets).toHaveLength(3);
  });

  it('CredentialSummary OAuth shape includes scopes + accountEmail when present', () => {
    const cred: CredentialSummary = {
      id: 'c-1',
      name: 'info',
      type: 'google-oauth',
      provider: 'google',
      helper: 'gemini-cli-workspace',
      scopes: ['openid'],
      accountEmail: 'info@x.com',
      createdAt: '2026-04-23T00:00:00Z',
      updatedAt: '2026-04-23T00:00:00Z',
      status: 'active',
    };
    expect(cred.type).toBe('google-oauth');
    expect(cred.scopes).toEqual(['openid']);
  });
});
