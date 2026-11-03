import { isValidRepo, isValidPrNumber, assertValidPrTarget } from './pr-review.validation';

describe('pr-review.validation (CREW-967)', () => {
  it('accepts normal repos and PR numbers', () => {
    expect(isValidRepo('stevehuang0115/crewly')).toBe(true);
    expect(isValidRepo('a_b/c.d-e')).toBe(true);
    expect(isValidPrNumber(1)).toBe(true);
    expect(isValidPrNumber(1540)).toBe(true);
    expect(() => assertValidPrTarget('org/repo', 5)).not.toThrow();
  });

  it.each(['$(touch x)/r', 'o/$(touch x)', 'o/r`id`', 'o/r;id', 'o/r"x', "o/r'x", 'o/r x', 'o/r|id', 'o/r&id', 'o', 'o/r/extra', '../x', 'o/..', '', '/r', 'o/'])(
    'refuses repo %j',
    (repo) => {
      expect(isValidRepo(repo)).toBe(false);
    },
  );

  it.each(['42', '42; id', '$(touch x)', 0, -1, 1.5, NaN, Infinity, 2 ** 60, null, undefined, {}, [1]])('refuses prNumber %j', (n) => {
    expect(isValidPrNumber(n)).toBe(false);
  });

  it('assertValidPrTarget throws without echoing the payload', () => {
    expect(() => assertValidPrTarget('$(touch x)/r', 1)).toThrow(/Invalid repository/);
    expect(() => assertValidPrTarget('$(touch x)/r', 1)).not.toThrow(/touch/);
    expect(() => assertValidPrTarget('o/r', '1; id')).toThrow(/Invalid prNumber/);
  });
});
