/**
 * Tests for OrcDeliveryEnforcerService.
 *
 * @module services/orc/orc-delivery-enforcer.service.test
 */

import {
  OrcDeliveryEnforcerService,
  isAgentDeliveryMarker,
  parseSlackConversationId,
  type DeliveryReminderSink,
} from './orc-delivery-enforcer.service.js';

describe('OrcDeliveryEnforcerService', () => {
  let fired: Array<{ conversationId: string; text: string }>;
  let sink: DeliveryReminderSink;
  let svc: OrcDeliveryEnforcerService;

  beforeEach(() => {
    fired = [];
    sink = (params) => {
      fired.push(params);
    };
    svc = new OrcDeliveryEnforcerService({ reminderSink: sink });
  });

  afterEach(() => {
    svc.stop();
    OrcDeliveryEnforcerService.setInstance(null);
  });

  describe('markPendingDelivery', () => {
    it('records a pending delivery when an agent posts [DONE] to a slack thread', () => {
      svc.markPendingDelivery({
        conversationId: 'slack-D0AC7NF5N7L-1779555555.588569',
        agentSender: 'think-tank-sage',
        text: '[DONE] Agent think-tank-sage: Closie affiliate Phase 1 done',
      });
      const pending = svc._peekPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].agentSender).toBe('think-tank-sage');
      expect(pending[0].deliverableSummary).toContain('Phase 1 done');
    });

    it('ignores non-slack conversation ids (web chat, system, etc.)', () => {
      svc.markPendingDelivery({
        conversationId: 'web-chat-abc-123',
        agentSender: 'worker',
        text: '[DONE] done',
      });
      svc.markPendingDelivery({
        conversationId: 'system:bookkeep',
        agentSender: 'system',
        text: '[DONE] done',
      });
      expect(svc._peekPending()).toHaveLength(0);
    });

    it('ignores agent posts that aren\'t delivery markers (e.g. [IN_PROGRESS])', () => {
      svc.markPendingDelivery({
        conversationId: 'slack-D0AC-1779555555.588569',
        agentSender: 'sage',
        text: '[IN_PROGRESS] still working',
      });
      svc.markPendingDelivery({
        conversationId: 'slack-D0AC-1779555555.588569',
        agentSender: 'sage',
        text: '[STATUS REPORT] busy',
      });
      expect(svc._peekPending()).toHaveLength(0);
    });

    it('treats [COMPLETED] and [DELIVERED] equivalently to [DONE]', () => {
      svc.markPendingDelivery({
        conversationId: 'slack-D0AC-1779555555.588569',
        agentSender: 'a',
        text: '[COMPLETED] foo',
      });
      svc.markPendingDelivery({
        conversationId: 'slack-D0AC-1779555556.588570',
        agentSender: 'b',
        text: '[DELIVERED] bar',
      });
      expect(svc._peekPending()).toHaveLength(2);
    });

    it('upserts on the same thread — second [DONE] overwrites the summary', () => {
      const conv = 'slack-D0AC-1779555555.588569';
      svc.markPendingDelivery({
        conversationId: conv,
        agentSender: 'sage',
        text: '[DONE] Phase 1 done',
      });
      svc.markPendingDelivery({
        conversationId: conv,
        agentSender: 'kai',
        text: '[DONE] Phase 2 done',
      });
      const pending = svc._peekPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].agentSender).toBe('kai');
      expect(pending[0].deliverableSummary).toContain('Phase 2');
    });
  });

  describe('markDelivered', () => {
    it('clears a pending delivery when ORC replies to the matching thread', () => {
      svc.markPendingDelivery({
        conversationId: 'slack-D0AC7NF5N7L-1779555555.588569',
        agentSender: 'sage',
        text: '[DONE] done',
      });
      svc.markDelivered({ channelId: 'D0AC7NF5N7L', threadTs: '1779555555.588569' });
      expect(svc._peekPending()).toHaveLength(0);
    });

    it('does NOT clear a different thread', () => {
      svc.markPendingDelivery({
        conversationId: 'slack-D0AC-1779555555.588569',
        agentSender: 'sage',
        text: '[DONE] done',
      });
      svc.markDelivered({ channelId: 'D0AC', threadTs: '9999999999.999999' });
      expect(svc._peekPending()).toHaveLength(1);
    });

    it('is a noop on missing fields', () => {
      svc.markDelivered({ channelId: '', threadTs: '' });
      svc.markDelivered({ channelId: 'D0AC', threadTs: null });
      // No throws.
      expect(true).toBe(true);
    });
  });

  describe('tick (reminder cadence)', () => {
    const conv = 'slack-D0AC7NF5N7L-1779555555.588569';

    it('does not fire when nothing is due yet', () => {
      svc.markPendingDelivery({
        conversationId: conv,
        agentSender: 'sage',
        text: '[DONE] done',
      });
      svc.tick(Date.now() + 60 * 1000); // 1 min later — first reminder at 3 min
      expect(fired).toHaveLength(0);
    });

    it('fires the first reminder at the 3-min mark', () => {
      svc.markPendingDelivery({
        conversationId: conv,
        agentSender: 'sage',
        text: '[DONE] Phase 1 done',
      });
      svc.tick(Date.now() + 3 * 60 * 1000 + 100); // 3 min + 0.1s
      expect(fired).toHaveLength(1);
      expect(fired[0].conversationId).toBe(conv);
      expect(fired[0].text).toContain('[DELIVER_REQUIRED]');
      expect(fired[0].text).toContain('sage');
      expect(fired[0].text).toContain('Phase 1');
    });

    it('escalates through 3-min → 10-min → 30-min then gives up', () => {
      svc.markPendingDelivery({
        conversationId: conv,
        agentSender: 'sage',
        text: '[DONE] done',
      });
      const start = Date.now();
      // T+3 min — first reminder
      svc.tick(start + 3 * 60 * 1000 + 1);
      // T+13 min — second reminder (10 min after first)
      svc.tick(start + 13 * 60 * 1000 + 1);
      // T+43 min — third reminder (30 min after second)
      svc.tick(start + 43 * 60 * 1000 + 1);
      // T+44 min — budget exhausted, entry dropped, no fourth reminder
      svc.tick(start + 44 * 60 * 1000 + 1);
      expect(fired).toHaveLength(3);
      expect(svc._peekPending()).toHaveLength(0); // dropped
    });

    it('clears the timer entirely on markDelivered between reminders', () => {
      svc.markPendingDelivery({
        conversationId: conv,
        agentSender: 'sage',
        text: '[DONE] done',
      });
      // T+3 min — first reminder fires
      svc.tick(Date.now() + 3 * 60 * 1000 + 1);
      expect(fired).toHaveLength(1);
      // ORC replies — clear
      svc.markDelivered({ channelId: 'D0AC7NF5N7L', threadTs: '1779555555.588569' });
      // T+13 min — no more reminders should fire (entry gone)
      svc.tick(Date.now() + 13 * 60 * 1000 + 1);
      expect(fired).toHaveLength(1);
    });

    it('swallows sink errors — one bad reminder does not break the timer', () => {
      const badSink: DeliveryReminderSink = () => {
        throw new Error('queue down');
      };
      const s = new OrcDeliveryEnforcerService({ reminderSink: badSink });
      s.markPendingDelivery({
        conversationId: conv,
        agentSender: 'sage',
        text: '[DONE] done',
      });
      // Should not throw.
      expect(() => s.tick(Date.now() + 3 * 60 * 1000 + 1)).not.toThrow();
      // Entry's remindersFired advanced so we don't retry the same broken
      // send within the same window.
      expect(s._peekPending()[0].remindersFired).toBe(1);
    });
  });

  describe('lifecycle', () => {
    it('start() is idempotent', () => {
      svc.start();
      svc.start();
      // No throws; only one timer scheduled internally.
      svc.stop();
    });

    it('stop() is safe before start()', () => {
      expect(() => svc.stop()).not.toThrow();
    });

    it('setInstance(null) stops the previous singleton', () => {
      const a = new OrcDeliveryEnforcerService({ reminderSink: sink });
      OrcDeliveryEnforcerService.setInstance(a);
      a.start();
      OrcDeliveryEnforcerService.setInstance(null);
      expect(() => a.stop()).not.toThrow();
    });
  });
});

// =============================================================================
// Pure helpers
// =============================================================================

describe('isAgentDeliveryMarker', () => {
  it('matches the three canonical markers (case-insensitive)', () => {
    expect(isAgentDeliveryMarker('[DONE] hello')).toBe(true);
    expect(isAgentDeliveryMarker('[done] hello')).toBe(true);
    expect(isAgentDeliveryMarker('hello [COMPLETED] task X')).toBe(true);
    expect(isAgentDeliveryMarker('[Delivered] foo')).toBe(true);
  });

  it('does NOT match in-progress / status report / arbitrary text', () => {
    expect(isAgentDeliveryMarker('[IN_PROGRESS] still going')).toBe(false);
    expect(isAgentDeliveryMarker('[STATUS REPORT] busy')).toBe(false);
    expect(isAgentDeliveryMarker('just regular content')).toBe(false);
    expect(isAgentDeliveryMarker('')).toBe(false);
  });
});

describe('parseSlackConversationId', () => {
  it('parses canonical slack-{channelId}-{ts} form', () => {
    expect(parseSlackConversationId('slack-D0AC7NF5N7L-1779555555.588569')).toEqual({
      channelId: 'D0AC7NF5N7L',
      threadTs: '1779555555.588569',
    });
  });

  it('strips -msg-{ts} suffix so the key is the thread root', () => {
    expect(
      parseSlackConversationId(
        'slack-D0AC7NF5N7L-1779555555.588569-msg-1779555900.123456',
      ),
    ).toEqual({
      channelId: 'D0AC7NF5N7L',
      threadTs: '1779555555.588569',
    });
  });

  it('handles dash-instead-of-dot ts form (legacy)', () => {
    expect(parseSlackConversationId('slack-D0AC-1779555555-588569')).toEqual({
      channelId: 'D0AC',
      threadTs: '1779555555.588569',
    });
  });

  it('returns null for non-slack ids', () => {
    expect(parseSlackConversationId('web-chat-abc')).toBeNull();
    expect(parseSlackConversationId('system:bookkeep')).toBeNull();
    expect(parseSlackConversationId('')).toBeNull();
    expect(parseSlackConversationId('slack-D0AC')).toBeNull(); // no ts
  });
});
