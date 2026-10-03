/**
 * CrewlyApiClient Tests — identity headers (#999).
 *
 * @module services/agent/crewly-agent/api-client.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CrewlyApiClient } from './api-client.js';

describe('CrewlyApiClient identity headers', () => {
  const original = process.env.CREWLY_AGENT_BADGE;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { ok: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.CREWLY_AGENT_BADGE;
    else process.env.CREWLY_AGENT_BADGE = original;
  });

  /** Headers of the n-th fetch call. */
  function headersOf(call = 0): Record<string, string> {
    return (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
  }

  it('sends the agent badge from the environment with the session', async () => {
    process.env.CREWLY_AGENT_BADGE = 'cab1.Y3Jld2x5LW9yYw.sig';
    await new CrewlyApiClient('http://127.0.0.1:9', 'crewly-orc').get('/teams');
    expect(headersOf()).toMatchObject({ 'X-Agent-Session': 'crewly-orc', 'X-Agent-Badge': 'cab1.Y3Jld2x5LW9yYw.sig' });
  });

  it('sends no badge header when the harness gave none', async () => {
    delete process.env.CREWLY_AGENT_BADGE;
    await new CrewlyApiClient('http://127.0.0.1:9', 'crewly-orc').post('/x', {});
    expect(headersOf()).not.toHaveProperty('X-Agent-Badge');
    expect(headersOf()['X-Agent-Session']).toBe('crewly-orc');
  });
});
