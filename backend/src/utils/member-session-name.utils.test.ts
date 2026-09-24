import { deriveMemberSessionName, resolveMemberSessionName, memberAgentId } from './member-session-name.utils.js';

describe('deriveMemberSessionName', () => {
  it('matches the team controller formula', () => {
    expect(deriveMemberSessionName('Think Tank', 'Sage', 'c1d2e3f4-0000-4000-8000-000000000000')).toBe('think-tank-sage-c1d2e3f4');
  });
});

describe('resolveMemberSessionName', () => {
  it('keeps a stored session name and derives one for an idle member', () => {
    expect(resolveMemberSessionName('Think Tank', { sessionName: 'think-tank-kai-75d30ac6', name: 'Kai', id: '75d30ac6-x' })).toBe('think-tank-kai-75d30ac6');
    expect(resolveMemberSessionName('Think Tank', { sessionName: '', name: 'Sage', id: 'c1d2e3f4-x' })).toBe('think-tank-sage-c1d2e3f4');
  });
});

describe('memberAgentId (permanent agent id)', () => {
  it('prefers the stored id, so a rename does not move the agent', () => {
    expect(memberAgentId('Crewly Marketing', { agentId: 'crewly-marketing-self-watch-scribe-45506487', name: 'Dana', id: '45506487-1b63' })).toBe(
      'crewly-marketing-self-watch-scribe-45506487',
    );
  });

  it('falls back to the running session, then the derived name', () => {
    expect(memberAgentId('Think Tank', { sessionName: 'think-tank-atlas-b4e166f6', name: 'Atlas 2', id: 'b4e166f6-2b85' })).toBe('think-tank-atlas-b4e166f6');
    expect(memberAgentId('Think Tank', { sessionName: '', name: 'Sage', id: 'c1d2e3f4-aaaa' })).toBe('think-tank-sage-c1d2e3f4');
  });

  it('resolveMemberSessionName uses the agent id when the member is not running', () => {
    expect(resolveMemberSessionName('Crewly Marketing', { sessionName: '', agentId: 'mkt-dana-45506487', name: 'Dana Renamed', id: '45506487-1b63' })).toBe('mkt-dana-45506487');
  });
});
