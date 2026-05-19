/**
 * Unit tests for CapabilityInference.
 *
 * @module services/memory/capability-inference.test
 */

import {
  TOOL_TO_CAPABILITIES,
  inferCapabilities,
  readWorkItemHints,
  defaultCapabilityInference,
} from './capability-inference.js';

describe('capability-inference', () => {
  describe('TOOL_TO_CAPABILITIES table', () => {
    it('every value uses the <category>:<resource> shape', () => {
      for (const [tool, caps] of Object.entries(TOOL_TO_CAPABILITIES)) {
        for (const c of caps) {
          expect(c.includes(':')).toBe(true);
          expect(c.split(':').filter(Boolean).length).toBeGreaterThanOrEqual(2);
        }
        expect(caps.length).toBeGreaterThan(0);
      }
    });

    it('Gmail tools always co-emit oauth:gmail', () => {
      expect(TOOL_TO_CAPABILITIES['read_email_oauth']).toContain('oauth:gmail');
      expect(TOOL_TO_CAPABILITIES['send_email_oauth']).toContain('oauth:gmail');
    });

    it('Calendar tools always co-emit oauth:calendar', () => {
      expect(TOOL_TO_CAPABILITIES['read_calendar_oauth']).toContain('oauth:calendar');
      expect(TOOL_TO_CAPABILITIES['create_calendar_event']).toContain('oauth:calendar');
    });
  });

  describe('inferCapabilities', () => {
    it('returns the mapped capability set for a known tool', () => {
      const caps = inferCapabilities(['read_email_oauth']);
      expect(caps.sort()).toEqual(['gmail:read', 'oauth:gmail'].sort());
    });

    it('dedupes when multiple tools map to overlapping capabilities', () => {
      const caps = inferCapabilities(['read_email_oauth', 'send_email_oauth']);
      // gmail:read + gmail:send + oauth:gmail — oauth:gmail once
      expect(caps.filter((c) => c === 'oauth:gmail')).toHaveLength(1);
      expect(caps.sort()).toEqual(['gmail:read', 'gmail:send', 'oauth:gmail'].sort());
    });

    it('returns [] for an unknown tool', () => {
      expect(inferCapabilities(['some_made_up_tool'])).toEqual([]);
    });

    it('returns [] for empty input', () => {
      expect(inferCapabilities([])).toEqual([]);
    });

    it('merges WorkItem metadata.requires hints', () => {
      const wi = { metadata: { requires: ['plaid:read', 'oauth:plaid'] } };
      const caps = inferCapabilities(['edit_file'], wi);
      expect(caps).toContain('code:edit');
      expect(caps).toContain('plaid:read');
      expect(caps).toContain('oauth:plaid');
    });

    it('rejects malformed requires entries (no colon, non-string)', () => {
      const wi = {
        metadata: {
          requires: ['valid:cap', 'no-colon-here', 42, null, 'another:valid'],
        },
      };
      const caps = inferCapabilities([], wi);
      expect(caps.sort()).toEqual(['another:valid', 'valid:cap'].sort());
    });

    it('handles a WorkItem with no metadata', () => {
      expect(inferCapabilities(['read_email_oauth'], {})).toEqual(
        expect.arrayContaining(['gmail:read', 'oauth:gmail']),
      );
    });
  });

  describe('readWorkItemHints', () => {
    it('returns [] when metadata is absent', () => {
      expect(readWorkItemHints({})).toEqual([]);
    });

    it('returns [] when metadata.requires is missing', () => {
      expect(readWorkItemHints({ metadata: {} })).toEqual([]);
    });

    it('returns only valid <cat>:<res> strings', () => {
      const result = readWorkItemHints({
        metadata: { requires: ['x:y', 'invalid', 'a:b'] },
      });
      expect(result.sort()).toEqual(['a:b', 'x:y'].sort());
    });
  });

  describe('defaultCapabilityInference', () => {
    it('exposes the static infer function as the .infer method', () => {
      expect(defaultCapabilityInference.infer(['edit_file'])).toEqual(['code:edit']);
    });
  });
});
