/**
 * Tests for ContentApprovalService.
 *
 * Covers submission, approval/rejection, expiration, Slack linking,
 * stats, and formatting.
 */

import { ContentApprovalService } from './content-approval.service.js';
import {
  ContentApprovalRequest,
  CONTENT_APPROVAL_TTL_MS,
  MAX_PENDING_APPROVALS,
} from './content-approval.types.js';

// =============================================================================
// Test Helpers
// =============================================================================

const SAMPLE_SUBMISSION = {
  teamId: 'team-marketing-001',
  submittedBy: 'writer-alex',
  platform: 'Instagram',
  contentType: 'post',
  content: 'Rise and shine! Our new sourdough loaf is fresh out of the oven. Come grab yours before they sell out! #ArtisanBread #FreshBaked',
  hashtags: ['#ArtisanBread', '#FreshBaked', '#SourdoughLove'],
  visualDirection: 'Close-up photo of golden sourdough loaf on rustic wooden board',
  scheduledTime: '2026-03-25T09:00:00Z',
};

// =============================================================================
// Tests
// =============================================================================

describe('ContentApprovalService', () => {
  let service: ContentApprovalService;

  beforeEach(() => {
    ContentApprovalService.resetInstance();
    service = ContentApprovalService.getInstance();
  });

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  describe('submit', () => {
    it('creates a pending approval request', () => {
      const request = service.submit(SAMPLE_SUBMISSION);

      expect(request.id).toBeTruthy();
      expect(request.teamId).toBe('team-marketing-001');
      expect(request.submittedBy).toBe('writer-alex');
      expect(request.platform).toBe('Instagram');
      expect(request.contentType).toBe('post');
      expect(request.content).toContain('sourdough');
      expect(request.status).toBe('pending');
      expect(request.submittedAt).toBeTruthy();
      expect(request.hashtags).toHaveLength(3);
    });

    it('generates unique IDs for each submission', () => {
      const r1 = service.submit(SAMPLE_SUBMISSION);
      const r2 = service.submit(SAMPLE_SUBMISSION);
      expect(r1.id).not.toBe(r2.id);
    });

    it('throws when team exceeds max pending approvals', () => {
      // Fill up to max
      for (let i = 0; i < MAX_PENDING_APPROVALS; i++) {
        service.submit(SAMPLE_SUBMISSION);
      }

      expect(() => service.submit(SAMPLE_SUBMISSION)).toThrow('pending approvals');
    });

    it('allows submission after resolving some approvals', () => {
      // Fill to max
      const requests: ContentApprovalRequest[] = [];
      for (let i = 0; i < MAX_PENDING_APPROVALS; i++) {
        requests.push(service.submit(SAMPLE_SUBMISSION));
      }

      // Approve one
      service.approve(requests[0].id, 'owner');

      // Should now allow one more
      expect(() => service.submit(SAMPLE_SUBMISSION)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Approval / Rejection
  // ---------------------------------------------------------------------------

  describe('approve', () => {
    it('marks request as approved', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const result = service.approve(request.id, 'owner', 'Looks great!');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('approved');
      expect(result!.resolvedBy).toBe('owner');
      expect(result!.feedback).toBe('Looks great!');
      expect(result!.resolvedAt).toBeTruthy();
    });

    it('returns null for non-existent request', () => {
      expect(service.approve('non-existent', 'owner')).toBeNull();
    });

    it('does not re-approve already approved request', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      service.approve(request.id, 'owner-1');
      const result = service.approve(request.id, 'owner-2');

      expect(result!.resolvedBy).toBe('owner-1'); // Original approver kept
    });
  });

  describe('reject', () => {
    it('marks request as rejected with feedback', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const result = service.reject(request.id, 'owner', 'Too promotional, add more value content');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('rejected');
      expect(result!.feedback).toContain('Too promotional');
    });

    it('does not re-reject already rejected request', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      service.reject(request.id, 'owner-1', 'Reason 1');
      const result = service.reject(request.id, 'owner-2', 'Reason 2');

      expect(result!.feedback).toBe('Reason 1'); // Original reason kept
    });
  });

  describe('resolve', () => {
    it('accepts approve resolution', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const result = service.resolve({
        approvalId: request.id,
        status: 'approved',
        resolvedBy: 'owner',
      });
      expect(result!.status).toBe('approved');
    });

    it('accepts reject resolution', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const result = service.resolve({
        approvalId: request.id,
        status: 'rejected',
        resolvedBy: 'owner',
        feedback: 'Not on-brand',
      });
      expect(result!.status).toBe('rejected');
    });
  });

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  describe('get', () => {
    it('retrieves an existing request', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const retrieved = service.get(request.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(request.id);
    });

    it('returns null for missing request', () => {
      expect(service.get('missing')).toBeNull();
    });
  });

  describe('getPendingByTeam', () => {
    it('returns only pending requests for the team', () => {
      const r1 = service.submit(SAMPLE_SUBMISSION);
      const r2 = service.submit(SAMPLE_SUBMISSION);
      service.approve(r1.id, 'owner');

      const pending = service.getPendingByTeam('team-marketing-001');
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(r2.id);
    });

    it('does not include other teams requests', () => {
      service.submit(SAMPLE_SUBMISSION);
      service.submit({ ...SAMPLE_SUBMISSION, teamId: 'other-team' });

      const pending = service.getPendingByTeam('team-marketing-001');
      expect(pending).toHaveLength(1);
    });
  });

  describe('getAllByTeam', () => {
    it('returns all requests regardless of status', () => {
      const r1 = service.submit(SAMPLE_SUBMISSION);
      service.submit(SAMPLE_SUBMISSION);
      service.approve(r1.id, 'owner');

      const all = service.getAllByTeam('team-marketing-001');
      expect(all).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Slack Integration
  // ---------------------------------------------------------------------------

  describe('linkSlackMessage', () => {
    it('links a Slack message to an approval', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const linked = service.linkSlackMessage(request.id, 'C123456', '1711234567.123456');

      expect(linked).not.toBeNull();
      expect(linked!.slackChannelId).toBe('C123456');
      expect(linked!.slackMessageTs).toBe('1711234567.123456');
    });

    it('returns null for non-existent request', () => {
      expect(service.linkSlackMessage('missing', 'C123', '123.456')).toBeNull();
    });
  });

  describe('getBySlackMessage', () => {
    it('finds approval by Slack message coordinates', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      service.linkSlackMessage(request.id, 'C123456', '1711234567.123456');

      const found = service.getBySlackMessage('C123456', '1711234567.123456');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(request.id);
    });

    it('returns null when no match', () => {
      expect(service.getBySlackMessage('C999', '999.999')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('returns counts by status', () => {
      const r1 = service.submit(SAMPLE_SUBMISSION);
      const r2 = service.submit(SAMPLE_SUBMISSION);
      service.submit(SAMPLE_SUBMISSION);
      service.approve(r1.id, 'owner');
      service.reject(r2.id, 'owner', 'Not good');

      const stats = service.getStats('team-marketing-001');
      expect(stats.approved).toBe(1);
      expect(stats.rejected).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.expired).toBe(0);
    });

    it('returns zeroes for team with no approvals', () => {
      const stats = service.getStats('empty-team');
      expect(stats.pending).toBe(0);
      expect(stats.approved).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  describe('formatForSlack', () => {
    it('formats request as Slack message', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const formatted = service.formatForSlack(request);

      expect(formatted).toContain('Content Approval Request');
      expect(formatted).toContain('Instagram');
      expect(formatted).toContain('post');
      expect(formatted).toContain('sourdough');
      expect(formatted).toContain('#ArtisanBread');
      expect(formatted).toContain('approve');
      expect(formatted).toContain('reject');
    });

    it('includes visual direction when present', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const formatted = service.formatForSlack(request);
      expect(formatted).toContain('Visual Direction');
      expect(formatted).toContain('rustic wooden board');
    });

    it('includes scheduled time when present', () => {
      const request = service.submit(SAMPLE_SUBMISSION);
      const formatted = service.formatForSlack(request);
      expect(formatted).toContain('Scheduled');
    });

    it('omits optional fields when not present', () => {
      const minimal = service.submit({
        teamId: 'team-001',
        submittedBy: 'writer',
        platform: 'X',
        contentType: 'post',
        content: 'Hello world!',
      });
      const formatted = service.formatForSlack(minimal);
      expect(formatted).not.toContain('Visual Direction');
      expect(formatted).not.toContain('Scheduled');
      expect(formatted).not.toContain('Hashtags');
    });
  });

  // ---------------------------------------------------------------------------
  // Expiration
  // ---------------------------------------------------------------------------

  describe('expiration', () => {
    it('expires old pending approvals on query', () => {
      const request = service.submit(SAMPLE_SUBMISSION);

      // Manually backdate the submission
      const stored = service.get(request.id)!;
      (stored as { submittedAt: string }).submittedAt =
        new Date(Date.now() - CONTENT_APPROVAL_TTL_MS - 1000).toISOString();

      const pending = service.getPendingByTeam('team-marketing-001');
      expect(pending).toHaveLength(0);

      const updated = service.get(request.id);
      expect(updated!.status).toBe('expired');
    });
  });

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = ContentApprovalService.getInstance();
      const b = ContentApprovalService.getInstance();
      expect(a).toBe(b);
    });

    it('resets instance correctly', () => {
      const a = ContentApprovalService.getInstance();
      ContentApprovalService.resetInstance();
      const b = ContentApprovalService.getInstance();
      expect(a).not.toBe(b);
    });
  });
});
