/**
 * Validation for git ref names (branch names and start points) that arrive
 * from API callers (CREW-967).
 *
 * The rules mirror `git check-ref-format --branch` (see git-check-ref-format(1))
 * and add one of our own: a name may not start with `-`, so it can never be
 * read as an option even when it is passed as its own argv entry.
 *
 * @module utils/git-ref
 */

/** Longest ref name accepted (git itself allows more; nothing legitimate needs it). */
export const MAX_GIT_REF_LENGTH = 255;

/** Characters git forbids anywhere in a ref name: control chars, space, ~ ^ : ? * [ \ and DEL. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_REF_CHARS_RE = /[\x00-\x20\x7f~^:?*[\\]/;

/**
 * Tell whether a value is a git ref name that is safe to hand to git.
 *
 * Rejects non-strings, empty or over-long values, a leading `-`, and anything
 * `git check-ref-format` refuses: `..`, `@{`, a bare `@`, a leading, trailing or
 * doubled `/`, a path component that starts with `.` or ends with `.lock`, a
 * trailing `.`, and the forbidden characters above.
 *
 * @param name - Candidate branch name or start point
 * @returns true when the name is acceptable
 *
 * @example
 * ```typescript
 * isValidGitRefName('feature/login'); // true
 * isValidGitRefName('x$(touch /tmp/p)'); // false
 * ```
 */
export function isValidGitRefName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_GIT_REF_LENGTH) return false;
  if (name.startsWith('-')) return false;
  if (FORBIDDEN_REF_CHARS_RE.test(name)) return false;
  if (name === '@' || name.includes('@{') || name.includes('..')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return false;
  if (name.endsWith('.')) return false;
  for (const component of name.split('/')) {
    if (component.startsWith('.') || component.endsWith('.lock')) return false;
  }
  return true;
}
