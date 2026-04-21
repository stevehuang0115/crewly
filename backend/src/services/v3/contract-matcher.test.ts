import { matchRule } from './contract-matcher.js';

describe('matchRule', () => {
  it('returns null for an empty request', () => {
    expect(matchRule('', ['bugfix'])).toBeNull();
    expect(matchRule('   ', ['bugfix'])).toBeNull();
  });

  it('returns null when no rule matches', () => {
    expect(matchRule('write documentation', ['bugfix', 'feature'])).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(matchRule('Urgent BUGFIX', ['bugfix'])).toBe('bugfix');
    expect(matchRule('bugfix', ['BUGFIX'])).toBe('BUGFIX');
  });

  it('matches when the rule is a substring of the request (verbose request, tight rule)', () => {
    expect(matchRule('urgent frontend bugfix in checkout', ['bugfix'])).toBe('bugfix');
  });

  it('matches when the request is a substring of the rule (tight request, verbose rule)', () => {
    expect(matchRule('bugfix', ['frontend-bugfix-priority'])).toBe('frontend-bugfix-priority');
  });

  it('returns the first matching rule when several would match', () => {
    expect(matchRule('frontend bugfix', ['bugfix', 'frontend'])).toBe('bugfix');
  });

  it('skips empty/whitespace rules', () => {
    expect(matchRule('bugfix', ['', '   ', 'bugfix'])).toBe('bugfix');
  });

  it('returns null against an empty rules list', () => {
    expect(matchRule('bugfix', [])).toBeNull();
  });

  it('trims surrounding whitespace on both sides', () => {
    expect(matchRule('  bugfix  ', ['  bugfix  '])).toBe('  bugfix  ');
  });
});
