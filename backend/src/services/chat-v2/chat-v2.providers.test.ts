/**
 * Tests for the agent-directory + presence providers backing /agents.
 *
 * @module services/chat-v2/chat-v2.providers.test
 */

import {
  createOssAgentDirectoryProvider,
  createOssAgentPresenceProvider,
  resolvePresenceStatus,
  type IStorageServiceLike,
} from './chat-v2.providers.js';

const sampleTeams: Awaited<ReturnType<IStorageServiceLike['getTeams']>> = [
  {
    id: 'orchestrator',
    name: 'Orchestrator Team',
    members: [
      {
        sessionName: 'crewly-orc',
        name: 'Orc',
        role: 'orchestrator',
        agentStatus: 'active',
        workingStatus: 'idle',
        avatar: ':robot:',
      },
      {
        sessionName: '',
        name: 'Ghost member with no session',
        role: 'worker',
        agentStatus: 'inactive',
        workingStatus: 'idle',
      },
    ],
  },
  {
    id: 't-marketing',
    name: 'Marketing',
    members: [
      {
        sessionName: 'crewly-marketing-ella',
        name: 'Ella',
        role: 'team-leader',
        agentStatus: 'starting',
        workingStatus: 'idle',
      },
      {
        sessionName: 'crewly-marketing-luna',
        name: 'Luna',
        role: 'worker',
        agentStatus: 'active',
        workingStatus: 'in_progress',
      },
    ],
  },
];

function makeStorageStub(
  teams: Awaited<ReturnType<IStorageServiceLike['getTeams']>>,
): IStorageServiceLike {
  return {
    async getTeams() {
      return teams;
    },
  };
}

describe('resolvePresenceStatus', () => {
  it('returns "offline" when not active and agentStatus !== starting', () => {
    expect(resolvePresenceStatus(false, 'inactive', 'idle')).toBe('offline');
    expect(resolvePresenceStatus(false, 'active', 'idle')).toBe('offline');
    expect(resolvePresenceStatus(false, 'suspended', 'in_progress')).toBe('offline');
  });

  it('returns "starting" when not active and agentStatus === starting', () => {
    expect(resolvePresenceStatus(false, 'starting', 'idle')).toBe('starting');
  });

  it('returns "busy" when active and workingStatus === in_progress', () => {
    expect(resolvePresenceStatus(true, 'active', 'in_progress')).toBe('busy');
  });

  it('returns "online" when active and idle', () => {
    expect(resolvePresenceStatus(true, 'active', 'idle')).toBe('online');
  });
});

describe('createOssAgentDirectoryProvider', () => {
  it('flattens teams + members and drops empty sessionNames', async () => {
    const provider = createOssAgentDirectoryProvider(
      makeStorageStub(sampleTeams),
      { resolveOrchestratorStatus: async () => null },
    );
    const result = await provider.getTeams();
    expect(result).toHaveLength(2);
    const orcMembers = result[0].members.map((m) => m.sessionName);
    expect(orcMembers).toEqual(['crewly-orc']);
    const marketingMembers = result[1].members.map((m) => m.sessionName);
    expect(marketingMembers).toEqual([
      'crewly-marketing-ella',
      'crewly-marketing-luna',
    ]);
  });

  it('preserves avatar / role / status fields', async () => {
    const provider = createOssAgentDirectoryProvider(
      makeStorageStub(sampleTeams),
      { resolveOrchestratorStatus: async () => null },
    );
    const result = await provider.getTeams();
    expect(result[0].members[0]).toEqual({
      sessionName: 'crewly-orc',
      name: 'Orc',
      role: 'orchestrator',
      agentStatus: 'active',
      workingStatus: 'idle',
      avatar: ':robot:',
    });
  });

  it('passes through an empty team list as-is when no orchestrator status', async () => {
    const provider = createOssAgentDirectoryProvider(makeStorageStub([]), {
      resolveOrchestratorStatus: async () => null,
    });
    expect(await provider.getTeams()).toEqual([]);
  });

  it('prepends a synthetic Orchestrator Team when status resolves', async () => {
    const provider = createOssAgentDirectoryProvider(makeStorageStub([]), {
      resolveOrchestratorStatus: async () => ({
        agentStatus: 'active',
        workingStatus: 'idle',
      }),
    });
    const result = await provider.getTeams();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'orchestrator',
      name: 'Orchestrator Team',
      members: [
        {
          sessionName: 'crewly-orc',
          name: 'Orchestrator',
          role: 'orchestrator',
          agentStatus: 'active',
          workingStatus: 'idle',
          avatar: undefined,
        },
      ],
    });
  });

  it('orchestrator team comes first when other teams exist', async () => {
    // Production-realistic fixture: storage.getTeams() filters out the
    // orchestrator directory, so only the regular team is present here.
    const provider = createOssAgentDirectoryProvider(
      makeStorageStub([sampleTeams[1]]),
      {
        resolveOrchestratorStatus: async () => ({
          agentStatus: 'inactive',
          workingStatus: 'idle',
        }),
      },
    );
    const result = await provider.getTeams();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('orchestrator');
    expect(result[1].id).toBe('t-marketing');
  });
});

describe('createOssAgentPresenceProvider', () => {
  it('returns "online" + stamped lastSeenAt for an active idle agent', async () => {
    const provider = createOssAgentPresenceProvider(makeStorageStub(sampleTeams), {
      isAgentActive: async () => true,
      now: () => 1_700_000_000,
    });
    expect(await provider.getPresence('crewly-orc')).toEqual({
      agentSession: 'crewly-orc',
      status: 'online',
      lastSeenAt: 1_700_000_000,
    });
  });

  it('returns "busy" when the member is active and workingStatus=in_progress', async () => {
    const provider = createOssAgentPresenceProvider(makeStorageStub(sampleTeams), {
      isAgentActive: async () => true,
      now: () => 1_700_000_000,
    });
    expect(await provider.getPresence('crewly-marketing-luna')).toEqual({
      agentSession: 'crewly-marketing-luna',
      status: 'busy',
      lastSeenAt: 1_700_000_000,
    });
  });

  it('returns "starting" + null lastSeenAt when not active and agentStatus=starting', async () => {
    const provider = createOssAgentPresenceProvider(makeStorageStub(sampleTeams), {
      isAgentActive: async () => false,
      now: () => 1_700_000_000,
    });
    expect(await provider.getPresence('crewly-marketing-ella')).toEqual({
      agentSession: 'crewly-marketing-ella',
      status: 'starting',
      lastSeenAt: null,
    });
  });

  it('returns "offline" with null lastSeenAt for unknown agentSession', async () => {
    const provider = createOssAgentPresenceProvider(makeStorageStub(sampleTeams), {
      isAgentActive: async () => false,
    });
    expect(await provider.getPresence('unknown-session')).toEqual({
      agentSession: 'unknown-session',
      status: 'offline',
      lastSeenAt: null,
    });
  });

  it('degrades gracefully when storage.getTeams throws', async () => {
    const brokenStorage: IStorageServiceLike = {
      async getTeams() {
        throw new Error('boom');
      },
    };
    const provider = createOssAgentPresenceProvider(brokenStorage, {
      isAgentActive: async () => false,
    });
    const result = await provider.getPresence('crewly-orc');
    expect(result.status).toBe('offline');
    expect(result.lastSeenAt).toBeNull();
  });

  it('degrades gracefully when isAgentActive throws', async () => {
    const provider = createOssAgentPresenceProvider(makeStorageStub(sampleTeams), {
      isAgentActive: async () => {
        throw new Error('liveness probe failed');
      },
    });
    const result = await provider.getPresence('crewly-orc');
    expect(result.status).toBe('offline');
    expect(result.lastSeenAt).toBeNull();
  });
});
