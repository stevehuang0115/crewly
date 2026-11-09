import { execFileSync } from 'child_process';
import { isValidGitRefName, MAX_GIT_REF_LENGTH } from './git-ref.utils.js';

/** Ask real git whether it accepts the name as a branch name. */
function gitAccepts(name: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const ACCEPTED = [
  'main',
  'feature/login',
  'fix/crew-967',
  'release-1.2.3',
  'origin/main',
  'a$(touch${IFS}x)', // valid for git; harmless only because we never use a shell
  'v1.0',
];

const REFUSED = [
  '',
  '-x',
  '--upload-pack=touch /tmp/x',
  '-',
  'a b',
  'a\nb',
  'a\tb',
  'x$(touch /tmp/pwned)',
  'x`touch /tmp/pwned`',
  'a..b',
  'a~1',
  'a^',
  'a:b',
  'a?b',
  'a*b',
  'a[b',
  'a\\b',
  '@',
  'a@{u}',
  '/a',
  'a/',
  'a//b',
  'a.',
  '.hidden',
  'a/.hidden',
  'a.lock',
  'a/b.lock',
  'a\x7fb',
  'a\x00b',
];

describe('isValidGitRefName', () => {
  it.each(ACCEPTED)('accepts %j', (name) => {
    expect(isValidGitRefName(name)).toBe(true);
  });

  it.each(REFUSED)('refuses %j', (name) => {
    expect(isValidGitRefName(name)).toBe(false);
  });

  it('refuses non-strings', () => {
    for (const v of [undefined, null, 1, {}, ['main'], true]) {
      expect(isValidGitRefName(v)).toBe(false);
    }
  });

  it('refuses a name longer than the limit and accepts one at the limit', () => {
    expect(isValidGitRefName('a'.repeat(MAX_GIT_REF_LENGTH))).toBe(true);
    expect(isValidGitRefName('a'.repeat(MAX_GIT_REF_LENGTH + 1))).toBe(false);
  });

  it('agrees with git check-ref-format on every refused name except the leading-dash rule', () => {
    // Prove the table is not just our opinion: git rejects each of these too,
    // except names whose only fault is our extra leading "-" rule and the NUL
    // byte, which cannot be passed to a process argv at all.
    const examined: string[] = [];
    for (const name of REFUSED) {
      // "@" is the other deliberate extra: `--branch @` means "the current branch" to git.
      if (name === '' || name === '@' || name.startsWith('-') || name.includes('\x00')) continue;
      examined.push(name);
      expect(gitAccepts(name)).toBe(false);
    }
    expect(examined.length).toBeGreaterThan(15);
  });

  it('agrees with git check-ref-format on every accepted name', () => {
    for (const name of ACCEPTED) {
      expect(gitAccepts(name)).toBe(true);
    }
    expect(ACCEPTED.length).toBeGreaterThan(0);
  });
});
