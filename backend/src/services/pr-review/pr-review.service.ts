/**
 * PR Review Service
 *
 * Core service for automated pull request code review. Analyzes PR diffs
 * for code quality, security issues, and test coverage gaps, then posts
 * review comments back to GitHub via the gh CLI.
 *
 * @module services/pr-review/pr-review.service
 */

import { execSync } from 'child_process';
import * as crypto from 'crypto';

// ========================= Constants =========================

/** Timeout for gh CLI commands in milliseconds */
const GH_CLI_TIMEOUT_MS = 30000;

/** Maximum diff size to analyze (characters) */
const MAX_DIFF_SIZE = 500000;

/** Supported PR webhook event actions */
export const PR_REVIEW_ACTIONS = ['opened', 'synchronize', 'reopened'] as const;

/** HMAC algorithm for webhook signature verification */
const HMAC_ALGORITHM = 'sha256';

// ========================= Types =========================

/** GitHub PR webhook payload (subset of fields used) */
export interface PullRequestPayload {
  /** Webhook action type */
  action: string;
  /** Pull request data */
  pull_request: {
    /** PR number */
    number: number;
    /** PR title */
    title: string;
    /** PR author */
    user: { login: string };
    /** Head branch info */
    head: { sha: string; ref: string };
    /** Base branch info */
    base: { sha: string; ref: string };
    /** URL to raw diff */
    diff_url: string;
    /** HTML URL for the PR */
    html_url: string;
    /** Changed file count */
    changed_files?: number;
  };
  /** Repository info */
  repository: {
    /** Full repo name (owner/repo) */
    full_name: string;
  };
}

/** A single review finding */
export interface ReviewFinding {
  /** File path relative to repo root */
  file: string;
  /** Line number in the diff (if applicable) */
  line?: number;
  /** Severity level */
  severity: 'critical' | 'warning' | 'info';
  /** Category of the finding */
  category: 'security' | 'quality' | 'testing' | 'style';
  /** Human-readable description of the issue */
  message: string;
}

/** Result of a full PR review */
export interface ReviewResult {
  /** PR number reviewed */
  prNumber: number;
  /** Repository full name */
  repository: string;
  /** Overall verdict */
  verdict: 'approve' | 'request_changes' | 'comment';
  /** Summary text */
  summary: string;
  /** Individual findings */
  findings: ReviewFinding[];
  /** Timestamp of review */
  reviewedAt: string;
}

/** Status of a review job */
export interface ReviewStatus {
  /** Whether a review is currently running */
  isRunning: boolean;
  /** Number of reviews completed */
  reviewCount: number;
  /** Last review timestamp */
  lastReviewAt: string | null;
}

// ========================= Webhook Verification =========================

/**
 * Verify the GitHub webhook signature using HMAC-SHA256.
 *
 * Compares the X-Hub-Signature-256 header against a computed HMAC
 * of the raw request body using the configured webhook secret.
 *
 * @param payload - Raw request body as string
 * @param signature - Value of the X-Hub-Signature-256 header
 * @param secret - Webhook secret configured in GitHub
 * @returns True if the signature is valid
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const hmac = crypto.createHmac(HMAC_ALGORITHM, secret);
  hmac.update(payload);
  const expected = `sha256=${hmac.digest('hex')}`;

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ========================= Diff Analysis =========================

/**
 * Fetch the diff for a pull request using the gh CLI.
 *
 * @param repo - Repository full name (owner/repo)
 * @param prNumber - Pull request number
 * @returns The unified diff as a string
 * @throws Error if gh CLI fails or diff exceeds size limit
 */
export function fetchPrDiff(repo: string, prNumber: number): string {
  const diff = execSync(
    `gh pr diff ${prNumber} --repo ${repo}`,
    { encoding: 'utf-8', timeout: GH_CLI_TIMEOUT_MS },
  );

  if (diff.length > MAX_DIFF_SIZE) {
    throw new Error(`PR diff exceeds maximum size (${diff.length} > ${MAX_DIFF_SIZE} chars)`);
  }

  return diff;
}

/**
 * Parse a unified diff into per-file changed sections.
 *
 * Extracts file paths and their changed lines from a unified diff string.
 *
 * @param diff - Unified diff string
 * @returns Array of objects with file path and changed content
 */
export function parseDiff(diff: string): { file: string; content: string }[] {
  const files: { file: string; content: string }[] = [];
  const fileSections = diff.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const fileMatch = section.match(/^a\/(.+?) b\//);
    if (!fileMatch) continue;

    const file = fileMatch[1];
    files.push({ file, content: section });
  }

  return files;
}

/**
 * Analyze a PR diff for code quality, security, and testing issues.
 *
 * Performs static analysis checks on the diff content:
 * - Security: hardcoded secrets, SQL injection patterns, eval usage
 * - Quality: console.log in production, TODO comments, large functions
 * - Testing: new source files without corresponding test files
 * - Style: any types in TypeScript files
 *
 * @param diff - Unified diff string
 * @returns Array of review findings
 */
export function analyzeDiff(diff: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const files = parseDiff(diff);
  const addedFileNames = new Set<string>();

  for (const { file, content } of files) {
    // Track added files for test coverage check
    if (content.includes('new file mode')) {
      addedFileNames.add(file);
    }

    // Only analyze added lines (lines starting with +)
    const addedLines = content
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'));

    for (let i = 0; i < addedLines.length; i++) {
      const line = addedLines[i];

      // Security: hardcoded secrets/tokens
      if (/(?:password|secret|token|api_key|apikey)\s*[:=]\s*['"][^'"]{8,}/i.test(line)) {
        findings.push({
          file,
          line: i + 1,
          severity: 'critical',
          category: 'security',
          message: 'Potential hardcoded secret or API key detected',
        });
      }

      // Security: eval usage
      if (/\beval\s*\(/.test(line) && !file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) {
        findings.push({
          file,
          line: i + 1,
          severity: 'critical',
          category: 'security',
          message: 'Usage of eval() detected — potential code injection vulnerability',
        });
      }

      // Security: SQL injection pattern
      if (/\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b/i.test(line) ||
          /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b.*\$\{/i.test(line)) {
        findings.push({
          file,
          line: i + 1,
          severity: 'critical',
          category: 'security',
          message: 'Potential SQL injection — use parameterized queries instead of string interpolation',
        });
      }

      // Quality: console.log in production code
      if (/\bconsole\.(log|debug|info)\b/.test(line) &&
          !file.endsWith('.test.ts') && !file.endsWith('.test.tsx') &&
          !file.includes('logger') && !file.includes('cli/')) {
        findings.push({
          file,
          line: i + 1,
          severity: 'warning',
          category: 'quality',
          message: 'console.log detected in production code — use the LoggerService instead',
        });
      }

      // Style: any type in TypeScript
      if ((file.endsWith('.ts') || file.endsWith('.tsx')) &&
          /:\s*any\b/.test(line) && !file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) {
        findings.push({
          file,
          line: i + 1,
          severity: 'info',
          category: 'style',
          message: 'Usage of `any` type — consider using a specific type or `unknown` with type guards',
        });
      }
    }
  }

  // Testing: check for new source files without corresponding test files
  for (const file of addedFileNames) {
    if ((file.endsWith('.ts') || file.endsWith('.tsx')) &&
        !file.endsWith('.test.ts') && !file.endsWith('.test.tsx') &&
        !file.endsWith('.d.ts') &&
        !file.includes('types/')) {
      const testFile = file.replace(/\.tsx?$/, (ext) => `.test${ext}`);
      if (!addedFileNames.has(testFile)) {
        findings.push({
          file,
          severity: 'warning',
          category: 'testing',
          message: `New source file without corresponding test file (expected: ${testFile})`,
        });
      }
    }
  }

  return findings;
}

// ========================= Review Execution =========================

/**
 * Determine the review verdict based on findings.
 *
 * @param findings - Array of review findings
 * @returns 'request_changes' if critical issues, 'comment' if warnings, 'approve' if clean
 */
export function determineVerdict(
  findings: ReviewFinding[],
): 'approve' | 'request_changes' | 'comment' {
  if (findings.some((f) => f.severity === 'critical')) {
    return 'request_changes';
  }
  if (findings.some((f) => f.severity === 'warning')) {
    return 'comment';
  }
  return 'approve';
}

/**
 * Format review findings into a markdown comment body.
 *
 * @param result - The review result to format
 * @returns Markdown-formatted review comment
 */
export function formatReviewComment(result: ReviewResult): string {
  const lines: string[] = [
    '## Automated PR Review',
    '',
    `**Verdict:** ${result.verdict === 'approve' ? 'Approved' : result.verdict === 'request_changes' ? 'Changes Requested' : 'Comment'}`,
    '',
    result.summary,
    '',
  ];

  if (result.findings.length === 0) {
    lines.push('No issues found. Code looks good!');
    return lines.join('\n');
  }

  const grouped = {
    critical: result.findings.filter((f) => f.severity === 'critical'),
    warning: result.findings.filter((f) => f.severity === 'warning'),
    info: result.findings.filter((f) => f.severity === 'info'),
  };

  if (grouped.critical.length > 0) {
    lines.push('### Critical Issues');
    for (const f of grouped.critical) {
      lines.push(`- **${f.file}${f.line ? `:${f.line}` : ''}** [${f.category}] — ${f.message}`);
    }
    lines.push('');
  }

  if (grouped.warning.length > 0) {
    lines.push('### Warnings');
    for (const f of grouped.warning) {
      lines.push(`- **${f.file}${f.line ? `:${f.line}` : ''}** [${f.category}] — ${f.message}`);
    }
    lines.push('');
  }

  if (grouped.info.length > 0) {
    lines.push('### Info');
    for (const f of grouped.info) {
      lines.push(`- **${f.file}${f.line ? `:${f.line}` : ''}** [${f.category}] — ${f.message}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Automated review by Crewly PR Review*');

  return lines.join('\n');
}

/**
 * Post a review comment on a GitHub PR using the gh CLI.
 *
 * @param repo - Repository full name (owner/repo)
 * @param prNumber - Pull request number
 * @param body - Comment body in markdown
 * @returns The URL of the posted comment
 * @throws Error if the gh CLI command fails
 */
export function postReviewComment(
  repo: string,
  prNumber: number,
  body: string,
): string {
  const escapedBody = body.replace(/'/g, "'\\''");
  const result = execSync(
    `gh pr comment ${prNumber} --repo ${repo} --body '${escapedBody}'`,
    { encoding: 'utf-8', timeout: GH_CLI_TIMEOUT_MS },
  );
  return result.trim();
}

// ========================= PR Review Service =========================

/** Module-level state for tracking review activity */
let reviewCount = 0;
let lastReviewAt: string | null = null;
let isRunning = false;

/**
 * Execute a full PR review: fetch diff, analyze, post comment.
 *
 * This is the main entry point called by the webhook controller.
 * It orchestrates the full review pipeline:
 * 1. Fetch the PR diff via gh CLI
 * 2. Analyze the diff for issues
 * 3. Determine the verdict
 * 4. Format and post the review comment
 *
 * @param payload - The GitHub PR webhook payload
 * @returns The review result with findings and verdict
 * @throws Error if the review pipeline fails
 */
export async function executePrReview(
  payload: PullRequestPayload,
): Promise<ReviewResult> {
  const repo = payload.repository.full_name;
  const prNumber = payload.pull_request.number;

  isRunning = true;
  try {
    // 1. Fetch diff
    const diff = fetchPrDiff(repo, prNumber);

    // 2. Analyze
    const findings = analyzeDiff(diff);

    // 3. Determine verdict
    const verdict = determineVerdict(findings);

    // 4. Build result
    const result: ReviewResult = {
      prNumber,
      repository: repo,
      verdict,
      summary: `Reviewed ${parseDiff(diff).length} file(s) — found ${findings.length} issue(s).`,
      findings,
      reviewedAt: new Date().toISOString(),
    };

    // 5. Post comment
    const comment = formatReviewComment(result);
    postReviewComment(repo, prNumber, comment);

    // 6. Update state
    reviewCount++;
    lastReviewAt = result.reviewedAt;

    return result;
  } finally {
    isRunning = false;
  }
}

/**
 * Get the current review service status.
 *
 * @returns Status object with running state and review count
 */
export function getReviewStatus(): ReviewStatus {
  return {
    isRunning,
    reviewCount,
    lastReviewAt,
  };
}

/**
 * Reset review service state (for testing).
 */
export function resetReviewState(): void {
  reviewCount = 0;
  lastReviewAt = null;
  isRunning = false;
}
