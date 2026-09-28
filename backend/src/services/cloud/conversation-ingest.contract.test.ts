/**
 * Tests for the conversation ingest wire contract helpers.
 */

import {
  CONVERSATION_INGEST_PATH,
  CONVERSATION_SOURCES,
  INSTANCE_ID_PATTERN,
  isOneOf,
  parseIngestErrorCode,
  parseIngestResponse,
} from './conversation-ingest.contract.js';
import { CONVERSATION_LOG_CONSTANTS } from '../../constants.js';

describe('conversation ingest contract', () => {
  it('targets the auth service route', () => {
    expect(CONVERSATION_INGEST_PATH).toBe('/api/cloud/conversations/ingest');
  });

  it('uses the same source vocabulary as the local log', () => {
    expect([...CONVERSATION_SOURCES]).toEqual([...CONVERSATION_LOG_CONSTANTS.SOURCES]);
  });

  it('accepts device ids as instance ids', () => {
    expect(INSTANCE_ID_PATTERN.test('3f0c1a2b-uuid.mac-mini')).toBe(true);
    expect(INSTANCE_ID_PATTERN.test('bad id/with space')).toBe(false);
  });

  describe('parseIngestResponse', () => {
    it('reads the flat 200 body', () => {
      expect(
        parseIngestResponse({
          success: true,
          ackedThroughLocalSeq: 18233,
          accepted: 48,
          duplicates: 1,
          updated: 1,
          deleted: 0,
          filtered: 0,
          expired: 0,
          rejected: 0,
          capped: false,
          retentionDays: 90,
        }),
      ).toEqual({
        ackedThroughLocalSeq: 18233,
        accepted: 48,
        duplicates: 1,
        updated: 1,
        deleted: 0,
        filtered: 0,
        expired: 0,
        rejected: 0,
        capped: false,
        retentionDays: 90,
      });
    });

    it('also reads a { success, data } envelope and tolerates junk', () => {
      expect(parseIngestResponse({ success: true, data: { ackedThroughLocalSeq: 3, retentionDays: 7 } })).toMatchObject({
        ackedThroughLocalSeq: 3,
        retentionDays: 7,
      });
      expect(parseIngestResponse(null)).toMatchObject({ ackedThroughLocalSeq: null, accepted: 0, retentionDays: null, capped: false });
    });
  });

  describe('parseIngestErrorCode', () => {
    it('reads code, error.code, or a bare known error string', () => {
      expect(parseIngestErrorCode({ success: false, code: 'sync_disabled', error: 'off' })).toBe('sync_disabled');
      expect(parseIngestErrorCode({ error: { code: 'invalid_batch' } })).toBe('invalid_batch');
      expect(parseIngestErrorCode({ error: 'conversations_key_missing' })).toBe('conversations_key_missing');
      expect(parseIngestErrorCode({ error: 'Not found' })).toBeNull();
      expect(parseIngestErrorCode('x')).toBeNull();
    });
  });

  it('isOneOf narrows to enum values', () => {
    expect(isOneOf(CONVERSATION_SOURCES, 'slack')).toBe(true);
    expect(isOneOf(CONVERSATION_SOURCES, 'fax')).toBe(false);
    expect(isOneOf(CONVERSATION_SOURCES, 3)).toBe(false);
  });
});
