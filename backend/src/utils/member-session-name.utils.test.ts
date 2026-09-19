import { deriveMemberSessionName, resolveMemberSessionName } from './member-session-name.utils.js';

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
