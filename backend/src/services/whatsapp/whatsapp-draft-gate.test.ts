/**
 * Tests for the WhatsApp draft send gate
 *
 * @module services/whatsapp/whatsapp-draft-gate.test
 */

import {
  isConfirmationFor,
  decideDraftSend,
  buildOwnerConfirmPrompt,
  buildRefusalMessage,
} from './whatsapp-draft-gate.js';
import { WHATSAPP_CONSTANTS } from '../../constants.js';
import type { WhatsAppDraft } from '../../types/whatsapp.types.js';

const CREATED = 1_760_000_000_000;

const draft: WhatsAppDraft = {
  id: 'd-1',
  code: 'W12',
  seq: 12,
  chatId: '4915550001@s.whatsapp.net',
  text: 'See you at 8',
  status: 'pending',
  createdAt: CREATED,
  createdBy: 'crewly-orc',
  sentAt: null,
  discardedAt: null,
  lastError: null,
};

describe('isConfirmationFor', () => {
  it.each(['发 W12', '发W12', '发送 W12', '发 12', '发 #W12', 'send W12', 'SEND w12', '确认发送 W12', '确认发 W12', '  发 W12  '])(
    'accepts %p',
    (text) => {
      expect(isConfirmationFor(text, draft)).toBe(true);
    },
  );

  it.each(['发 W13', '发 W1', '好的 发 W12', '发 W12 吧', 'W12', '发', 'send it', '不要发 W12'])('rejects %p', (text) => {
    expect(isConfirmationFor(text, draft)).toBe(false);
  });
});

describe('decideDraftSend', () => {
  const since = jest.fn<string[], [number]>();

  beforeEach(() => since.mockReset().mockReturnValue([]));

  it('allows the owner (no agent session) without looking at chat', () => {
    expect(decideDraftSend({ draft, agentSession: undefined, ownerMessagesSince: since, now: CREATED + 1 })).toEqual({
      allowed: true,
      via: 'owner',
    });
    expect(since).not.toHaveBeenCalled();
  });

  it('refuses an agent without the owner confirmation', () => {
    since.mockReturnValue(['sounds good', '发 W11']);
    expect(decideDraftSend({ draft, agentSession: 'crewly-orc', ownerMessagesSince: since, now: CREATED + 1000 })).toEqual({
      allowed: false,
      reason: 'no_confirmation',
    });
    expect(since).toHaveBeenCalledWith(CREATED);
  });

  it('allows an agent when the owner confirmed this code after the draft', () => {
    since.mockReturnValue(['ok', '发 W12']);
    expect(decideDraftSend({ draft, agentSession: 'crewly-orc', ownerMessagesSince: since, now: CREATED + 60_000 })).toEqual({
      allowed: true,
      via: 'owner_confirmation',
      confirmation: '发 W12',
    });
  });

  it('refuses an agent once the draft is older than the confirm window, even with a confirmation', () => {
    since.mockReturnValue(['发 W12']);
    const now = CREATED + WHATSAPP_CONSTANTS.DRAFT_CONFIRM_WINDOW_MS + 1;
    expect(decideDraftSend({ draft, agentSession: 'crewly-orc', ownerMessagesSince: since, now })).toEqual({
      allowed: false,
      reason: 'window_expired',
    });
  });

  it('accepts exactly at the window edge', () => {
    since.mockReturnValue(['发 W12']);
    const now = CREATED + WHATSAPP_CONSTANTS.DRAFT_CONFIRM_WINDOW_MS;
    expect(decideDraftSend({ draft, agentSession: 'crewly-orc', ownerMessagesSince: since, now }).allowed).toBe(true);
  });
});

describe('messages', () => {
  it('confirm prompt names recipient, code and the 「发 code」 reply', () => {
    const p = buildOwnerConfirmPrompt(draft, 'Ann');
    expect(p).toContain('W12');
    expect(p).toContain('Ann');
    expect(p).toContain('「发 W12」');
    expect(p).toContain('NOT sent');
  });

  it('refusal messages explain what to do', () => {
    expect(buildRefusalMessage(draft, 'no_confirmation')).toContain('「发 W12」');
    expect(buildRefusalMessage(draft, 'window_expired')).toContain('30 minutes');
  });
});
