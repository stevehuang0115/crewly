/**
 * Tests for agent-caller utils — who is calling an agent-facing API.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request } from 'express';

const findMemberBySessionName = jest.fn<(session: string) => Promise<unknown>>();
jest.mock('../services/core/storage.service.js', () => ({
  StorageService: { getInstance: () => ({ findMemberBySessionName }) },
}));

import { isOwnerDashboardRequest, readAgentSessionHeader, resolveAgentCaller, resolveTransitionActor } from './agent-caller.utils.js';
import { agentAuthHeaders, ownerAuthHeaders, relayAuthHeaders } from '../middleware/caller-identity.testing.js';

/** Build a request carrying only the given headers. */
const req = (headers: Record<string, string | string[]>): Request => ({ headers } as unknown as Request);

describe('readAgentSessionHeader', () => {
  it('reads X-Agent-Session, trimmed', () => {
    expect(readAgentSessionHeader(req({ 'x-agent-session': '  crewly-orc ' }))).toBe('crewly-orc');
  });

  it('accepts the legacy X-Crewly-Agent-Session header', () => {
    expect(readAgentSessionHeader(req({ 'x-crewly-agent-session': 'dev-1' }))).toBe('dev-1');
  });

  it('returns undefined for a missing or blank header', () => {
    expect(readAgentSessionHeader(req({}))).toBeUndefined();
    expect(readAgentSessionHeader(req({ 'x-agent-session': '   ' }))).toBeUndefined();
  });
});

describe('readAgentSessionHeader with an agent badge (#999)', () => {
  it('names the badge\'s session even without X-Agent-Session', () => {
    const { 'x-agent-badge': badge } = agentAuthHeaders('dev-1');
    expect(readAgentSessionHeader(req({ 'x-agent-badge': badge }))).toBe('dev-1');
  });

  it('is undefined for the owner', () => {
    expect(readAgentSessionHeader(req(ownerAuthHeaders()))).toBeUndefined();
  });
});

describe('isOwnerDashboardRequest', () => {
  it('is true for an owner credential: dashboard session, relay', () => {
    expect(isOwnerDashboardRequest(req(ownerAuthHeaders()))).toBe(true);
    expect(isOwnerDashboardRequest(req(relayAuthHeaders()))).toBe(true);
  });

  it('is false for the bare self-set X-Crewly-Caller: dashboard marker (#999)', () => {
    expect(isOwnerDashboardRequest(req({ 'x-crewly-caller': 'dashboard' }))).toBe(false);
    expect(isOwnerDashboardRequest(req({ 'x-crewly-caller': ' Dashboard ' }))).toBe(false);
  });

  it('is false for a header-less request (internal server-to-server wake)', () => {
    expect(isOwnerDashboardRequest(req({}))).toBe(false);
  });

  it('is false for any agent session, even one that also claims to be the dashboard', () => {
    expect(isOwnerDashboardRequest(req({ 'x-agent-session': 'crewly-orc' }))).toBe(false);
    expect(
      isOwnerDashboardRequest(req({ 'x-agent-session': 'crewly-orc', 'x-crewly-caller': 'dashboard' })),
    ).toBe(false);
    expect(
      isOwnerDashboardRequest(req({ 'x-crewly-agent-session': 'dev-1', 'x-crewly-caller': 'dashboard' })),
    ).toBe(false);
  });

  it('treats a request without a headers object as not the dashboard (no throw)', () => {
    const bare = {} as unknown as Request;
    expect(readAgentSessionHeader(bare)).toBeUndefined();
    expect(isOwnerDashboardRequest(bare)).toBe(false);
  });

  it('is false for any other caller value', () => {
    expect(isOwnerDashboardRequest(req({ 'x-crewly-caller': 'cli' }))).toBe(false);
  });
});

describe('resolveAgentCaller', () => {
  beforeEach(() => {
    findMemberBySessionName.mockReset();
  });

  it('returns {} for the owner (an owner credential)', async () => {
    await expect(resolveAgentCaller(req(ownerAuthHeaders()))).resolves.toEqual({});
  });

  it('marks a caller with no credential and no agent header as anonymous, not the owner (#999)', async () => {
    await expect(resolveAgentCaller(req({}))).resolves.toEqual({ anonymous: true });
  });

  it('recognises the orchestrator without a storage lookup', async () => {
    await expect(resolveAgentCaller(req({ 'x-agent-session': 'crewly-orc' }))).resolves.toEqual({
      session: 'crewly-orc',
      role: 'orchestrator',
    });
    expect(findMemberBySessionName).not.toHaveBeenCalled();
  });

  it('resolves a team member role, falling back to worker', async () => {
    findMemberBySessionName.mockResolvedValueOnce({ member: { role: 'developer' } });
    await expect(resolveAgentCaller(req({ 'x-agent-session': 'dev-1' }))).resolves.toEqual({
      session: 'dev-1',
      role: 'developer',
    });
    findMemberBySessionName.mockResolvedValueOnce(null);
    await expect(resolveAgentCaller(req({ 'x-agent-session': 'ghost' }))).resolves.toEqual({
      session: 'ghost',
      role: 'worker',
    });
  });
});

describe('resolveTransitionActor (#813)', () => {
  it('an agent session is an agent with that session', () => {
    expect(resolveTransitionActor(req({ 'x-agent-session': ' tl-sam ' }), 'test')).toEqual({ role: 'agent', session: 'tl-sam', via: 'test' });
  });

  it('the orchestrator session is the orchestrator', () => {
    expect(resolveTransitionActor(req({ 'x-agent-session': 'crewly-orc' }), 'test')).toMatchObject({ role: 'orchestrator', session: 'crewly-orc' });
  });

  it('the dashboard (owner session) is the owner', () => {
    expect(resolveTransitionActor(req(ownerAuthHeaders()), 'test')).toEqual({ role: 'owner', via: 'test' });
  });

  it('the bare dashboard marker is not the owner (#999)', () => {
    expect(resolveTransitionActor(req({ 'x-crewly-caller': 'dashboard' }), 'test')).toEqual({ role: 'agent', via: 'test' });
  });

  it('an agent session wins over the dashboard marker', () => {
    expect(resolveTransitionActor(req({ 'x-agent-session': 'dev-1', 'x-crewly-caller': 'dashboard' }), 'test').role).toBe('agent');
  });

  it('no header and no marker is an agent with no identity — never a reviewer', () => {
    const actor = resolveTransitionActor(req({}), 'test');
    expect(actor).toEqual({ role: 'agent', via: 'test' });
    expect(actor.session).toBeUndefined();
  });
});
