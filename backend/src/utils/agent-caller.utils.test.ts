/**
 * Tests for agent-caller utils — who is calling an agent-facing API.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request } from 'express';

const findMemberBySessionName = jest.fn<(session: string) => Promise<unknown>>();
jest.mock('../services/core/storage.service.js', () => ({
  StorageService: { getInstance: () => ({ findMemberBySessionName }) },
}));

import { isOwnerDashboardRequest, readAgentSessionHeader, resolveAgentCaller } from './agent-caller.utils.js';

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

describe('isOwnerDashboardRequest', () => {
  it('is true for a dashboard request with no agent session', () => {
    expect(isOwnerDashboardRequest(req({ 'x-crewly-caller': 'dashboard' }))).toBe(true);
    expect(isOwnerDashboardRequest(req({ 'x-crewly-caller': ' Dashboard ' }))).toBe(true);
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

  it('returns {} for the owner (no header)', async () => {
    await expect(resolveAgentCaller(req({}))).resolves.toEqual({});
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
