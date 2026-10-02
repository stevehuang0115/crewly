import { REPLY_ROUTING_CONSTANTS } from '../../constants.js';
import { AgentPromptReferenceService, hasReference } from './agent-prompt-reference.service.js';

describe('AgentPromptReferenceService', () => {
  it('records the last prompt reference per agent and forgets it when stale', () => {
    let now = 1_000;
    const svc = new AgentPromptReferenceService(() => now);
    svc.note('owen', { ticket: 'TKT-187', workItemId: 'fu-1' });
    expect(svc.get('owen')).toEqual({ reference: { ticket: 'TKT-187', workItemId: 'fu-1' }, at: 1_000 });
    expect(svc.get('ella')).toBeUndefined();
    now += REPLY_ROUTING_CONSTANTS.PROMPT_REFERENCE_FRESH_MS + 1;
    expect(svc.get('owen')).toBeUndefined();
  });

  it('ignores empty references; clear() drops one', () => {
    const svc = new AgentPromptReferenceService(() => 5);
    svc.note('owen', {});
    expect(svc.get('owen')).toBeUndefined();
    svc.note('owen', { decisionId: 'D-12' });
    svc.clear('owen');
    expect(svc.get('owen')).toBeUndefined();
  });

  it('hasReference', () => {
    expect(hasReference(undefined)).toBe(false);
    expect(hasReference({})).toBe(false);
    expect(hasReference({ messageId: 'm' })).toBe(true);
  });

  it('is a resettable singleton', () => {
    const a = AgentPromptReferenceService.getInstance();
    AgentPromptReferenceService.resetInstance();
    expect(AgentPromptReferenceService.getInstance()).not.toBe(a);
  });
});
