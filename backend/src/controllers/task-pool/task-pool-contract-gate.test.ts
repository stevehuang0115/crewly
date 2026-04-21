/**
 * Focused tests for the ServiceContract gate wiring inside the Task Pool
 * controller. We exercise the exported `maybeEnforceContract` helper
 * directly — the rest of the controller (addToPool, projection, validator)
 * is covered separately.
 */

import { maybeEnforceContract } from './task-pool.controller.js';
import { StorageService } from '../../services/core/storage.service.js';
import type { Team } from '../../types/index.js';

jest.mock('../../services/core/storage.service.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTeam(id: string, accepts: string[] = [], avoids: string[] = []): Team {
  return {
    id,
    name: `team-${id}`,
    members: [],
    projectIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serviceContract: {
      accepts,
      avoids,
      expectedOutput: [],
    },
  };
}

function installTeams(teams: Team[]): void {
  (StorageService.getInstance as unknown as jest.Mock).mockReturnValue({
    getTeams: jest.fn().mockResolvedValue(teams),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('maybeEnforceContract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips the gate when the body has no cross-team hints', async () => {
    // No fromTeamId / toTeamId → legacy body, pass through.
    const result = await maybeEnforceContract({
      type: 'delegate',
      title: 'Something',
    });
    expect(result).toBeNull();
  });

  it('skips the gate when from === to (internal work)', async () => {
    installTeams([makeTeam('eng', ['frontend bugfix'])]);
    const result = await maybeEnforceContract({
      fromTeamId: 'eng',
      toTeamId: 'eng',
      title: 'Something weird not on contract',
    });
    expect(result).toBeNull();
  });

  it('accepts when requestType matches target contract', async () => {
    installTeams([makeTeam('eng', ['frontend bugfix'])]);
    const result = await maybeEnforceContract({
      fromTeamId: 'marketing',
      toTeamId: 'eng',
      title: 'urgent frontend bugfix in checkout flow',
    });
    expect(result).toBeNull();
  });

  it('rejects with 403 when target avoids the request', async () => {
    installTeams([makeTeam('eng', ['frontend bugfix'], ['production DBA changes'])]);
    const result = await maybeEnforceContract({
      fromTeamId: 'marketing',
      toTeamId: 'eng',
      title: 'production DBA changes needed',
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(result!.payload.success).toBe(false);
    const gate = result!.payload.gate as Record<string, unknown>;
    expect(gate.outcome).toBe('reject');
    expect(gate.reason).toBe('in_avoids');
  });

  it('rejects when the request fits neither accepts nor avoids', async () => {
    installTeams([makeTeam('eng', ['frontend bugfix'])]);
    const result = await maybeEnforceContract({
      fromTeamId: 'marketing',
      toTeamId: 'eng',
      title: 'write a poem',
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const gate = result!.payload.gate as Record<string, unknown>;
    expect(gate.reason).toBe('no_match');
  });

  it('rejects when the target team cannot be resolved', async () => {
    installTeams([]);
    const result = await maybeEnforceContract({
      fromTeamId: 'marketing',
      toTeamId: 'missing',
      title: 'frontend bugfix',
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const gate = result!.payload.gate as Record<string, unknown>;
    expect(gate.reason).toBe('missing_target');
  });

  it('reads teamIds and requestType from metadata block', async () => {
    installTeams([makeTeam('eng', ['frontend bugfix'])]);
    const result = await maybeEnforceContract({
      type: 'delegate',
      title: 'Opaque title',
      metadata: {
        fromTeamId: 'marketing',
        toTeamId: 'eng',
        requestType: 'frontend bugfix',
      },
    });
    expect(result).toBeNull();
  });

  it('bypasses the gate when forceCrossTeam is true', async () => {
    installTeams([makeTeam('eng', ['frontend bugfix'], ['production DBA changes'])]);
    const result = await maybeEnforceContract({
      fromTeamId: 'marketing',
      toTeamId: 'eng',
      title: 'production DBA changes needed',
      forceCrossTeam: true,
    });
    expect(result).toBeNull();
  });

  it('falls back to title when requestType is not provided', async () => {
    installTeams([makeTeam('eng', ['API change'])]);
    const result = await maybeEnforceContract({
      fromTeamId: 'marketing',
      toTeamId: 'eng',
      // Intentionally no requestType — title should be used
      title: 'need an API change for the new dashboard',
    });
    expect(result).toBeNull();
  });
});
