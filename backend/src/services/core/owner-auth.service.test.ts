/**
 * Tests for the owner-auth credentials (#999).
 */

import {
  csrfTokenFor,
  internalAgentHeaders,
  internalCredentialHeaders,
  mintAgentBadge,
  mintInternalCredential,
  mintOwnerSession,
  ownerSessionCookieName,
  resetOwnerAuthSecretForTesting,
  verifyAgentBadge,
  verifyCsrfToken,
  verifyInternalCredential,
  verifyOwnerSession,
} from './owner-auth.service.js';
import { OWNER_AUTH_CONSTANTS } from '../../constants.js';

beforeEach(() => resetOwnerAuthSecretForTesting());

describe('agent badge', () => {
  it('round-trips the session it was minted for', () => {
    const badge = mintAgentBadge('crewly-dev-sam-1a2b3c4d');
    expect(badge.startsWith(`${OWNER_AUTH_CONSTANTS.AGENT_BADGE_PREFIX}.`)).toBe(true);
    expect(verifyAgentBadge(badge)).toBe('crewly-dev-sam-1a2b3c4d');
  });

  it('is deterministic for the process lifetime', () => {
    expect(mintAgentBadge('crewly-orc')).toBe(mintAgentBadge('crewly-orc'));
  });

  it('cannot be re-pointed at another session', () => {
    const badge = mintAgentBadge('crewly-dev-sam');
    const [prefix, , sig] = badge.split('.');
    const forged = `${prefix}.${Buffer.from('crewly-orc').toString('base64url')}.${sig}`;
    expect(verifyAgentBadge(forged)).toBeNull();
  });

  it.each([undefined, null, '', 'cab1', 'cab1.x', 'nope.eA.abc', 'cab1..sig'])('rejects %p', (value) => {
    expect(verifyAgentBadge(value as string | undefined)).toBeNull();
  });

  it('stops verifying after the secret rotates (backend restart)', () => {
    const badge = mintAgentBadge('crewly-orc');
    resetOwnerAuthSecretForTesting();
    expect(verifyAgentBadge(badge)).toBeNull();
  });

  it('builds internal agent headers that verify as that session', () => {
    const headers = internalAgentHeaders('workitem-dispatch');
    expect(headers['X-Agent-Session']).toBe('workitem-dispatch');
    expect(verifyAgentBadge(headers['X-Agent-Badge'])).toBe('workitem-dispatch');
  });
});

describe('owner session', () => {
  it('verifies a fresh session and derives its CSRF token', () => {
    const s = mintOwnerSession(1_000_000);
    expect(verifyOwnerSession(s.value, 1_000_000)).toEqual({ id: s.id, issuedAt: 1000 });
    expect(s.csrfToken).toBe(csrfTokenFor(s.id));
    expect(verifyCsrfToken(s.id, s.csrfToken)).toBe(true);
  });

  it('rejects a tampered id, timestamp or MAC', () => {
    const s = mintOwnerSession();
    const [p, id, iat, sig] = s.value.split('.');
    expect(verifyOwnerSession(`${p}.${id}x.${iat}.${sig}`)).toBeNull();
    expect(verifyOwnerSession(`${p}.${id}.${Number(iat) + 1}.${sig}`)).toBeNull();
    expect(verifyOwnerSession(`${p}.${id}.${iat}.${sig}x`)).toBeNull();
    expect(verifyOwnerSession('')).toBeNull();
    expect(verifyOwnerSession(undefined)).toBeNull();
  });

  it('expires after OWNER_SESSION_MAX_AGE_S', () => {
    const s = mintOwnerSession(0);
    const justInside = OWNER_AUTH_CONSTANTS.OWNER_SESSION_MAX_AGE_S * 1000;
    expect(verifyOwnerSession(s.value, justInside)).not.toBeNull();
    expect(verifyOwnerSession(s.value, justInside + 2000)).toBeNull();
  });

  it('rejects a CSRF token of another session', () => {
    const a = mintOwnerSession();
    const b = mintOwnerSession();
    expect(verifyCsrfToken(a.id, b.csrfToken)).toBe(false);
    expect(verifyCsrfToken(a.id, '')).toBe(false);
    expect(verifyCsrfToken(a.id, undefined)).toBe(false);
  });

  it('a session is not an agent badge and vice versa', () => {
    expect(verifyAgentBadge(mintOwnerSession().value)).toBeNull();
    expect(verifyOwnerSession(mintAgentBadge('crewly-orc'))).toBeNull();
  });

  it('names the cookie after the port', () => {
    expect(ownerSessionCookieName(8787)).toBe('crewly_owner_8787');
  });
});

describe('internal credential', () => {
  it('verifies each purpose', () => {
    expect(verifyInternalCredential(mintInternalCredential('relay'))).toBe('relay');
    expect(verifyInternalCredential(mintInternalCredential('cloud'))).toBe('cloud');
  });

  it('cannot be relabelled to another purpose', () => {
    const relay = mintInternalCredential('relay');
    expect(verifyInternalCredential(relay.replace(/^relay/, 'cloud'))).toBeNull();
  });

  it.each([undefined, '', 'relay', 'relay.', 'other.abc', 'relay.abc'])('rejects %p', (value) => {
    expect(verifyInternalCredential(value)).toBeNull();
  });

  it('puts the credential in the internal header', () => {
    const headers = internalCredentialHeaders('relay');
    expect(verifyInternalCredential(headers[OWNER_AUTH_CONSTANTS.INTERNAL_HEADER])).toBe('relay');
  });
});

describe('scheduler credential (CREW-312)', () => {
  it('round-trips as the scheduler purpose', () => {
    expect(verifyInternalCredential(mintInternalCredential('scheduler'))).toBe('scheduler');
  });

  it('is a different credential from relay and cloud, and none of them verifies as another', () => {
    const [relay, cloud, scheduler] = (['relay', 'cloud', 'scheduler'] as const).map(mintInternalCredential);
    expect(new Set([relay, cloud, scheduler]).size).toBe(3);
    expect(verifyInternalCredential(relay)).toBe('relay');
    expect(verifyInternalCredential(cloud)).toBe('cloud');
    // A signature minted for one purpose cannot be re-labelled as another.
    expect(verifyInternalCredential(`scheduler.${relay.split('.')[1]}`)).toBeNull();
    expect(verifyInternalCredential(`relay.${scheduler.split('.')[1]}`)).toBeNull();
  });

  it('builds the header and stops verifying after the secret rotates (backend restart)', () => {
    const headers = internalCredentialHeaders('scheduler');
    const value = headers[OWNER_AUTH_CONSTANTS.INTERNAL_HEADER];
    expect(verifyInternalCredential(value)).toBe('scheduler');
    resetOwnerAuthSecretForTesting();
    expect(verifyInternalCredential(value)).toBeNull();
  });
});
