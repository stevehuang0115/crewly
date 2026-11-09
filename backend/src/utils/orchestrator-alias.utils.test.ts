/**
 * The orchestrator's aliases resolve to its one session name.
 *
 * @module utils/orchestrator-alias.utils.test
 */

import { ORCHESTRATOR_SESSION_NAME } from '../constants.js';
import { canonicalAgentSession, isOrchestratorSender } from './orchestrator-alias.utils.js';

describe('isOrchestratorSender', () => {
  it('knows the session name and the display names the prompt and skills use', () => {
    expect(isOrchestratorSender(ORCHESTRATOR_SESSION_NAME)).toBe(true);
    expect(isOrchestratorSender('Orchestrator')).toBe(true);
    expect(isOrchestratorSender(' orchestrator ')).toBe(true);
    expect(isOrchestratorSender('ORC')).toBe(true);
  });

  it('is false for members, the owner and nothing', () => {
    expect(isOrchestratorSender('ce-owen-ad0320ab')).toBe(false);
    expect(isOrchestratorSender('UOWNER')).toBe(false);
    expect(isOrchestratorSender('')).toBe(false);
    expect(isOrchestratorSender(undefined)).toBe(false);
    expect(isOrchestratorSender(null)).toBe(false);
  });
});

describe('canonicalAgentSession', () => {
  it('turns the display name a chat row carries into the session the queue and the deliverer know (D-952)', () => {
    expect(canonicalAgentSession('Orchestrator')).toBe(ORCHESTRATOR_SESSION_NAME);
    expect(canonicalAgentSession('orc')).toBe(ORCHESTRATOR_SESSION_NAME);
  });

  it('leaves a member session as it is', () => {
    expect(canonicalAgentSession('ce-owen-ad0320ab')).toBe('ce-owen-ad0320ab');
  });
});
