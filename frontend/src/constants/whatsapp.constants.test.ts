/**
 * Tests for WhatsApp settings constants.
 */
import { describe, it, expect } from 'vitest';
import {
  WHATSAPP_API_BASE,
  WHATSAPP_ENDPOINTS,
  WHATSAPP_MODES,
  WHATSAPP_DEFAULT_CONNECT_MODE,
  WHATSAPP_INBOX_COPY,
} from './whatsapp.constants';

describe('whatsapp.constants', () => {
  it('builds endpoints under the API base', () => {
    expect(WHATSAPP_ENDPOINTS.STATUS).toBe(`${WHATSAPP_API_BASE}/status`);
    expect(WHATSAPP_ENDPOINTS.PENDING_DRAFTS).toBe('/api/whatsapp/drafts?status=pending');
  });

  it('encodes draft ids in send/discard paths', () => {
    expect(WHATSAPP_ENDPOINTS.draftSend('a/b')).toBe('/api/whatsapp/drafts/a%2Fb/send');
    expect(WHATSAPP_ENDPOINTS.draftDiscard('W12')).toBe('/api/whatsapp/drafts/W12/discard');
  });

  it('connects in inbox mode by default', () => {
    expect(WHATSAPP_DEFAULT_CONNECT_MODE).toBe(WHATSAPP_MODES.INBOX);
  });

  it('states the owner-confirmation and no-auto-reply promise in both languages', () => {
    expect(WHATSAPP_INBOX_COPY.ZH).toContain('发送前需要你确认');
    expect(WHATSAPP_INBOX_COPY.ZH).toContain('不会自动回复任何人');
    expect(WHATSAPP_INBOX_COPY.EN).toMatch(/never auto-replies/);
    expect(WHATSAPP_INBOX_COPY.TOS).toMatch(/linked device/);
  });
});
