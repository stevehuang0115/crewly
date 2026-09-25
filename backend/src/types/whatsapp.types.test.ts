/**
 * Tests for WhatsApp types and utility functions
 *
 * @module types/whatsapp.types.test
 */

import { isContactAllowed, isWhatsAppMode, WhatsAppConfig } from './whatsapp.types.js';

describe('WhatsApp Types', () => {
  describe('isContactAllowed', () => {
    it('should allow all contacts when allowedContacts is empty', () => {
      const config: WhatsAppConfig = { allowedContacts: [] };
      expect(isContactAllowed('1234567890@s.whatsapp.net', config)).toBe(true);
    });

    it('should allow all contacts when allowedContacts is undefined', () => {
      const config: WhatsAppConfig = {};
      expect(isContactAllowed('1234567890@s.whatsapp.net', config)).toBe(true);
    });

    it('should allow a contact in the allowed list (JID format)', () => {
      const config: WhatsAppConfig = {
        allowedContacts: ['1234567890'],
      };
      expect(isContactAllowed('1234567890@s.whatsapp.net', config)).toBe(true);
    });

    it('should allow a contact with + prefix in allowed list', () => {
      const config: WhatsAppConfig = {
        allowedContacts: ['+1234567890'],
      };
      expect(isContactAllowed('1234567890@s.whatsapp.net', config)).toBe(true);
    });

    it('should reject a contact not in the allowed list', () => {
      const config: WhatsAppConfig = {
        allowedContacts: ['1111111111'],
      };
      expect(isContactAllowed('9999999999@s.whatsapp.net', config)).toBe(false);
    });

    it('should handle contacts with JID suffix in allowed list', () => {
      const config: WhatsAppConfig = {
        allowedContacts: ['1234567890@s.whatsapp.net'],
      };
      expect(isContactAllowed('1234567890@s.whatsapp.net', config)).toBe(true);
    });

    it('should handle plain phone number input without JID suffix', () => {
      const config: WhatsAppConfig = {
        allowedContacts: ['1234567890'],
      };
      expect(isContactAllowed('1234567890', config)).toBe(true);
    });
  });

  describe('isWhatsAppMode', () => {
    it('accepts the two modes', () => {
      expect(isWhatsAppMode('inbox')).toBe(true);
      expect(isWhatsAppMode('assistant')).toBe(true);
    });

    it('rejects anything else', () => {
      expect(isWhatsAppMode('Inbox')).toBe(false);
      expect(isWhatsAppMode('')).toBe(false);
      expect(isWhatsAppMode(undefined)).toBe(false);
      expect(isWhatsAppMode(1)).toBe(false);
    });
  });
});
