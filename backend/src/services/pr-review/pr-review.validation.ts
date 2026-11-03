/**
 * PR review input validation.
 *
 * The repo and PR number reach the `gh` CLI from an HTTP body or a webhook
 * payload, so they are checked here before anything is run (CREW-967).
 *
 * @module services/pr-review/pr-review.validation
 */

/** `owner/name` — GitHub's own character set, no shell metacharacters. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Whether a value is a plain `owner/repo` full name.
 *
 * @param repo - Raw value from a request body or webhook payload
 * @returns True for `owner/repo` made of letters, digits, `_`, `.` and `-` only
 */
export function isValidRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && repo.length <= 200 && REPO_RE.test(repo) && !repo.split('/').some((p) => p === '.' || p === '..');
}

/**
 * Whether a value is a positive integer PR number (a real number, not a string).
 *
 * @param prNumber - Raw value from a request body or webhook payload
 * @returns True for a positive safe integer
 */
export function isValidPrNumber(prNumber: unknown): prNumber is number {
  return typeof prNumber === 'number' && Number.isSafeInteger(prNumber) && prNumber > 0;
}

/**
 * Throws unless the repo and PR number are safe to hand to `gh`.
 *
 * @param repo - Repository full name
 * @param prNumber - Pull request number
 * @throws Error naming the rejected field (the value is not echoed)
 */
export function assertValidPrTarget(repo: unknown, prNumber: unknown): void {
  if (!isValidRepo(repo)) throw new Error('Invalid repository: expected owner/repo');
  if (!isValidPrNumber(prNumber)) throw new Error('Invalid prNumber: expected a positive integer');
}
