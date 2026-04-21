/**
 * Unit tests for ServiceContractGate.
 */

import { ServiceContractGate } from './service-contract-gate.service.js';
import type { Team } from '../../types/index.js';
import type { ServiceContract } from '../../types/team-template.types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTeam(id: string, contract?: ServiceContract): Team {
  return {
    id,
    name: `team-${id}`,
    members: [],
    projectIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serviceContract: contract,
  };
}

const engineeringContract: ServiceContract = {
  accepts: ['frontend bugfix', 'mid-size product feature', 'API change'],
  avoids: ['production DBA changes', 'security incident response'],
  expectedOutput: ['PR', 'test coverage report'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServiceContractGate', () => {
  let gate: ServiceContractGate;

  beforeEach(() => {
    gate = new ServiceContractGate();
  });

  describe('bypass rules', () => {
    it('accepts same-team requests without consulting the contract', () => {
      // Team has no contract, but caller is from the same team.
      const team = makeTeam('eng');
      const decision = gate.check({
        fromTeamId: 'eng',
        toTeam: team,
        requestType: 'anything goes',
      });
      expect(decision.outcome).toBe('accept');
      if (decision.outcome === 'accept') {
        expect(decision.matchedRule).toBe('<internal>');
      }
    });

    it('rejects when the target team cannot be resolved', () => {
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: undefined,
        requestType: 'anything',
      });
      expect(decision.outcome).toBe('reject');
      if (decision.outcome === 'reject') {
        expect(decision.reason).toBe('missing_target');
      }
    });
  });

  describe('contract presence', () => {
    it('rejects when target has no contract at all', () => {
      const team = makeTeam('eng');
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: team,
        requestType: 'frontend bugfix',
      });
      expect(decision.outcome).toBe('reject');
      if (decision.outcome === 'reject') {
        expect(decision.reason).toBe('no_contract');
        expect(decision.message).toContain('team-eng');
      }
    });

    it('rejects when contract exists but accepts[] is empty', () => {
      const team = makeTeam('eng', {
        accepts: [],
        avoids: [],
        expectedOutput: [],
      });
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: team,
        requestType: 'anything',
      });
      expect(decision.outcome).toBe('reject');
      if (decision.outcome === 'reject') {
        expect(decision.reason).toBe('empty_contract');
      }
    });
  });

  describe('matching', () => {
    const eng = makeTeam('eng', engineeringContract);

    it('accepts when request matches an accepts phrase exactly', () => {
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: eng,
        requestType: 'frontend bugfix',
      });
      expect(decision.outcome).toBe('accept');
      if (decision.outcome === 'accept') {
        expect(decision.matchedRule).toBe('frontend bugfix');
      }
    });

    it('accepts when request is a superset of an accepts phrase (substring)', () => {
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: eng,
        requestType: 'urgent frontend bugfix in checkout flow',
      });
      expect(decision.outcome).toBe('accept');
      if (decision.outcome === 'accept') {
        expect(decision.matchedRule).toBe('frontend bugfix');
      }
    });

    it('matches case-insensitively', () => {
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: eng,
        requestType: 'Mid-Size PRODUCT Feature',
      });
      expect(decision.outcome).toBe('accept');
    });

    it('rejects when request matches an avoids phrase', () => {
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: eng,
        requestType: 'production DBA changes needed for migration',
      });
      expect(decision.outcome).toBe('reject');
      if (decision.outcome === 'reject') {
        expect(decision.reason).toBe('in_avoids');
        expect(decision.matchedRule).toBe('production DBA changes');
      }
    });

    it('fails closed: avoids wins when a request matches both accepts and avoids', () => {
      const team = makeTeam('eng', {
        accepts: ['frontend bugfix'],
        avoids: ['production frontend bugfix'], // more specific, more dangerous
        expectedOutput: [],
      });
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: team,
        requestType: 'production frontend bugfix',
      });
      expect(decision.outcome).toBe('reject');
      if (decision.outcome === 'reject') {
        expect(decision.reason).toBe('in_avoids');
      }
    });

    it('rejects with no_match when the request fits neither list', () => {
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: eng,
        requestType: 'write a poem',
      });
      expect(decision.outcome).toBe('reject');
      if (decision.outcome === 'reject') {
        expect(decision.reason).toBe('no_match');
        expect(decision.message).toContain('frontend bugfix');
      }
    });

    it('ignores empty and whitespace-only rules', () => {
      const team = makeTeam('eng', {
        accepts: ['', '   ', 'real rule'],
        avoids: ['', '  '],
        expectedOutput: [],
      });
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: team,
        requestType: 'real rule',
      });
      expect(decision.outcome).toBe('accept');
      if (decision.outcome === 'accept') {
        expect(decision.matchedRule).toBe('real rule');
      }
    });

    it('rejects an empty request type with a dedicated reason (not confused with no_match)', () => {
      const team = makeTeam('eng', {
        accepts: ['anything'],
        avoids: [],
        expectedOutput: [],
      });
      const decision = gate.check({
        fromTeamId: 'marketing',
        toTeam: team,
        requestType: '   ',
      });
      expect(decision.outcome).toBe('reject');
      if (decision.outcome === 'reject') {
        expect(decision.reason).toBe('missing_request_type');
      }
    });
  });

  describe('caller identity', () => {
    it('treats requests without a fromTeamId as external (contract still applies)', () => {
      const eng = makeTeam('eng', engineeringContract);
      const decision = gate.check({
        toTeam: eng,
        requestType: 'frontend bugfix',
      });
      expect(decision.outcome).toBe('accept');
    });

    it('does not bypass the contract when fromTeamId matches a non-existent team', () => {
      const eng = makeTeam('eng', engineeringContract);
      const decision = gate.check({
        fromTeamId: 'ghost',
        toTeam: eng,
        requestType: 'production DBA changes',
      });
      expect(decision.outcome).toBe('reject');
      if (decision.outcome === 'reject') {
        expect(decision.reason).toBe('in_avoids');
      }
    });
  });
});
