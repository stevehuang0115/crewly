/**
 * PR Review Service Tests
 *
 * Unit tests for webhook signature verification, diff analysis,
 * review verdict logic, and comment formatting.
 *
 * @module services/pr-review/pr-review.service.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  verifyWebhookSignature,
  parseDiff,
  analyzeDiff,
  determineVerdict,
  formatReviewComment,
  getReviewStatus,
  resetReviewState,
  PR_REVIEW_ACTIONS,
  type ReviewFinding,
  type ReviewResult,
  type PullRequestPayload,
} from './pr-review.service';
import crypto from 'crypto';

describe('PR Review Service', () => {
  describe('PR_REVIEW_ACTIONS', () => {
    it('should contain the supported webhook actions', () => {
      expect(PR_REVIEW_ACTIONS).toContain('opened');
      expect(PR_REVIEW_ACTIONS).toContain('synchronize');
      expect(PR_REVIEW_ACTIONS).toContain('reopened');
    });

    it('should have exactly 3 actions', () => {
      expect(PR_REVIEW_ACTIONS).toHaveLength(3);
    });
  });

  describe('verifyWebhookSignature', () => {
    const secret = 'test-webhook-secret';

    /**
     * Helper to compute a valid HMAC signature for testing.
     *
     * @param payload - Request body string
     * @param sigSecret - Webhook secret
     * @returns Valid sha256 signature string
     */
    function computeSignature(payload: string, sigSecret: string): string {
      const hmac = crypto.createHmac('sha256', sigSecret);
      hmac.update(payload);
      return `sha256=${hmac.digest('hex')}`;
    }

    it('should return true for a valid signature', () => {
      const payload = '{"action":"opened"}';
      const signature = computeSignature(payload, secret);
      expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    });

    it('should return false for an invalid signature', () => {
      const payload = '{"action":"opened"}';
      expect(verifyWebhookSignature(payload, 'sha256=invalid', secret)).toBe(false);
    });

    it('should return false when signature is empty', () => {
      expect(verifyWebhookSignature('body', '', secret)).toBe(false);
    });

    it('should return false when secret is empty', () => {
      expect(verifyWebhookSignature('body', 'sha256=abc', '')).toBe(false);
    });

    it('should return false when signature length differs from expected', () => {
      expect(verifyWebhookSignature('body', 'sha256=short', secret)).toBe(false);
    });

    it('should be resistant to timing attacks via timingSafeEqual', () => {
      const payload = '{"test":true}';
      const validSig = computeSignature(payload, secret);
      // Tamper with one character
      const tamperedSig = validSig.slice(0, -1) + (validSig.slice(-1) === 'a' ? 'b' : 'a');
      expect(verifyWebhookSignature(payload, tamperedSig, secret)).toBe(false);
    });
  });

  describe('parseDiff', () => {
    it('should parse a diff with multiple files', () => {
      const diff = [
        'diff --git a/src/service.ts b/src/service.ts',
        '--- a/src/service.ts',
        '+++ b/src/service.ts',
        '@@ -1,3 +1,4 @@',
        '+import { foo } from "bar";',
        ' export class Service {}',
        'diff --git a/src/utils.ts b/src/utils.ts',
        '--- a/src/utils.ts',
        '+++ b/src/utils.ts',
        '@@ -1,2 +1,3 @@',
        '+export const helper = () => {};',
      ].join('\n');

      const files = parseDiff(diff);
      expect(files).toHaveLength(2);
      expect(files[0].file).toBe('src/service.ts');
      expect(files[1].file).toBe('src/utils.ts');
    });

    it('should return empty array for empty diff', () => {
      expect(parseDiff('')).toEqual([]);
    });

    it('should handle single file diff', () => {
      const diff = [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1,2 @@',
        '+New line',
      ].join('\n');

      const files = parseDiff(diff);
      expect(files).toHaveLength(1);
      expect(files[0].file).toBe('README.md');
    });

    it('should handle files with spaces in path', () => {
      const diff = 'diff --git a/my file.ts b/my file.ts\n--- a/my file.ts\n+++ b/my file.ts\n';
      const files = parseDiff(diff);
      expect(files).toHaveLength(1);
      expect(files[0].file).toBe('my file.ts');
    });
  });

  describe('analyzeDiff', () => {
    /**
     * Helper to create a minimal diff with added lines.
     *
     * @param file - File path
     * @param addedLines - Lines to add (will be prefixed with +)
     * @param newFile - Whether this is a new file
     * @returns Unified diff string
     */
    function makeDiff(file: string, addedLines: string[], newFile = false): string {
      const lines = [
        `diff --git a/${file} b/${file}`,
        ...(newFile ? ['new file mode 100644'] : []),
        `--- ${newFile ? '/dev/null' : `a/${file}`}`,
        `+++ b/${file}`,
        '@@ -0,0 +1 @@',
        ...addedLines.map((l) => `+${l}`),
      ];
      return lines.join('\n');
    }

    describe('Security checks', () => {
      it('should detect hardcoded secrets', () => {
        const diff = makeDiff('src/config.ts', [
          'const apiKey = "sk-1234567890abcdef";',
        ]);
        const findings = analyzeDiff(diff);
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: 'security',
              severity: 'critical',
              message: expect.stringContaining('hardcoded secret'),
            }),
          ]),
        );
      });

      it('should detect eval usage', () => {
        const diff = makeDiff('src/handler.ts', [
          'const result = eval(userInput);',
        ]);
        const findings = analyzeDiff(diff);
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: 'security',
              severity: 'critical',
              message: expect.stringContaining('eval()'),
            }),
          ]),
        );
      });

      it('should not flag eval in test files', () => {
        const diff = makeDiff('src/handler.test.ts', [
          'const result = eval("1+1");',
        ]);
        const findings = analyzeDiff(diff);
        const evalFindings = findings.filter((f) => f.message.includes('eval'));
        expect(evalFindings).toHaveLength(0);
      });

      it('should detect SQL injection patterns', () => {
        const diff = makeDiff('src/db.ts', [
          'const query = `SELECT * FROM users WHERE id = ${userId}`;',
        ]);
        const findings = analyzeDiff(diff);
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: 'security',
              severity: 'critical',
              message: expect.stringContaining('SQL injection'),
            }),
          ]),
        );
      });
    });

    describe('Quality checks', () => {
      it('should detect console.log in production code', () => {
        const diff = makeDiff('src/service.ts', [
          'console.log("debug output");',
        ]);
        const findings = analyzeDiff(diff);
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: 'quality',
              severity: 'warning',
              message: expect.stringContaining('console.log'),
            }),
          ]),
        );
      });

      it('should not flag console.log in test files', () => {
        const diff = makeDiff('src/service.test.ts', [
          'console.log("test output");',
        ]);
        const findings = analyzeDiff(diff);
        const consoleFindings = findings.filter((f) => f.message.includes('console.log'));
        expect(consoleFindings).toHaveLength(0);
      });

      it('should not flag console.log in CLI files', () => {
        const diff = makeDiff('cli/src/index.ts', [
          'console.log("CLI output");',
        ]);
        const findings = analyzeDiff(diff);
        const consoleFindings = findings.filter((f) => f.message.includes('console.log'));
        expect(consoleFindings).toHaveLength(0);
      });
    });

    describe('Style checks', () => {
      it('should detect any type usage in TypeScript', () => {
        const diff = makeDiff('src/handler.ts', [
          'function process(data: any) {}',
        ]);
        const findings = analyzeDiff(diff);
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: 'style',
              severity: 'info',
              message: expect.stringContaining('any'),
            }),
          ]),
        );
      });

      it('should not flag any type in test files', () => {
        const diff = makeDiff('src/handler.test.ts', [
          'const mock: any = {};',
        ]);
        const findings = analyzeDiff(diff);
        const anyFindings = findings.filter((f) => f.message.includes('any'));
        expect(anyFindings).toHaveLength(0);
      });
    });

    describe('Testing checks', () => {
      it('should flag new source files without test files', () => {
        const diff = makeDiff('src/new-service.ts', ['export class NewService {}'], true);
        const findings = analyzeDiff(diff);
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: 'testing',
              severity: 'warning',
              message: expect.stringContaining('without corresponding test file'),
            }),
          ]),
        );
      });

      it('should not flag when test file is also added', () => {
        const diff = [
          makeDiff('src/new-service.ts', ['export class NewService {}'], true),
          makeDiff('src/new-service.test.ts', ['describe("NewService", () => {});'], true),
        ].join('\n');
        const findings = analyzeDiff(diff);
        const testFindings = findings.filter((f) => f.category === 'testing');
        expect(testFindings).toHaveLength(0);
      });

      it('should not flag new type definition files', () => {
        const diff = makeDiff('src/types/index.ts', ['export interface Foo {}'], true);
        const findings = analyzeDiff(diff);
        const testFindings = findings.filter((f) => f.category === 'testing');
        expect(testFindings).toHaveLength(0);
      });
    });

    it('should return empty findings for a clean diff', () => {
      const diff = makeDiff('src/clean.ts', [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ]);
      const findings = analyzeDiff(diff);
      expect(findings).toHaveLength(0);
    });
  });

  describe('determineVerdict', () => {
    it('should return approve when no findings', () => {
      expect(determineVerdict([])).toBe('approve');
    });

    it('should return request_changes when critical findings exist', () => {
      const findings: ReviewFinding[] = [
        { file: 'a.ts', severity: 'critical', category: 'security', message: 'Issue' },
      ];
      expect(determineVerdict(findings)).toBe('request_changes');
    });

    it('should return comment when only warnings exist', () => {
      const findings: ReviewFinding[] = [
        { file: 'a.ts', severity: 'warning', category: 'quality', message: 'Issue' },
      ];
      expect(determineVerdict(findings)).toBe('comment');
    });

    it('should return approve when only info findings exist', () => {
      const findings: ReviewFinding[] = [
        { file: 'a.ts', severity: 'info', category: 'style', message: 'Issue' },
      ];
      expect(determineVerdict(findings)).toBe('approve');
    });

    it('should return request_changes when both critical and warning exist', () => {
      const findings: ReviewFinding[] = [
        { file: 'a.ts', severity: 'warning', category: 'quality', message: 'Warn' },
        { file: 'b.ts', severity: 'critical', category: 'security', message: 'Critical' },
      ];
      expect(determineVerdict(findings)).toBe('request_changes');
    });
  });

  describe('formatReviewComment', () => {
    it('should format an approval with no findings', () => {
      const result: ReviewResult = {
        prNumber: 1,
        repository: 'org/repo',
        verdict: 'approve',
        summary: 'Reviewed 3 file(s) — found 0 issue(s).',
        findings: [],
        reviewedAt: '2026-03-15T00:00:00Z',
      };
      const comment = formatReviewComment(result);
      expect(comment).toContain('Approved');
      expect(comment).toContain('No issues found');
      expect(comment).toContain('Automated PR Review');
    });

    it('should group findings by severity', () => {
      const result: ReviewResult = {
        prNumber: 2,
        repository: 'org/repo',
        verdict: 'request_changes',
        summary: 'Found issues.',
        findings: [
          { file: 'a.ts', line: 10, severity: 'critical', category: 'security', message: 'Secret found' },
          { file: 'b.ts', severity: 'warning', category: 'quality', message: 'Console log' },
          { file: 'c.ts', severity: 'info', category: 'style', message: 'Any type' },
        ],
        reviewedAt: '2026-03-15T00:00:00Z',
      };
      const comment = formatReviewComment(result);
      expect(comment).toContain('### Critical Issues');
      expect(comment).toContain('### Warnings');
      expect(comment).toContain('### Info');
      expect(comment).toContain('a.ts:10');
      expect(comment).toContain('Secret found');
      expect(comment).toContain('Changes Requested');
    });

    it('should omit empty severity sections', () => {
      const result: ReviewResult = {
        prNumber: 3,
        repository: 'org/repo',
        verdict: 'comment',
        summary: 'One warning.',
        findings: [
          { file: 'a.ts', severity: 'warning', category: 'testing', message: 'No tests' },
        ],
        reviewedAt: '2026-03-15T00:00:00Z',
      };
      const comment = formatReviewComment(result);
      expect(comment).toContain('### Warnings');
      expect(comment).not.toContain('### Critical Issues');
      expect(comment).not.toContain('### Info');
    });

    it('should include the Crewly attribution', () => {
      const result: ReviewResult = {
        prNumber: 4,
        repository: 'org/repo',
        verdict: 'approve',
        summary: 'Clean.',
        findings: [
          { file: 'x.ts', severity: 'info', category: 'style', message: 'Minor' },
        ],
        reviewedAt: '2026-03-15T00:00:00Z',
      };
      const comment = formatReviewComment(result);
      expect(comment).toContain('Crewly PR Review');
    });
  });

  describe('getReviewStatus', () => {
    beforeEach(() => {
      resetReviewState();
    });

    it('should return initial status', () => {
      const status = getReviewStatus();
      expect(status.isRunning).toBe(false);
      expect(status.reviewCount).toBe(0);
      expect(status.lastReviewAt).toBeNull();
    });
  });
});
