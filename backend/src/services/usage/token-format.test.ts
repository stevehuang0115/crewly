import { compactTokens, formatTokens, parseTokenAmount, usdToTokens } from './token-format.js';

describe('token formatting', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [12_400, '12.4K'],
    [12_400_000, '12.4M'],
    [20_000_000, '20M'],
    [123_400_000, '123M'],
    [1_200_000_000, '1.2B'],
  ])('compactTokens(%d) = %s', (n, text) => {
    expect(compactTokens(n)).toBe(text);
  });

  it('formatTokens adds the unit', () => {
    expect(formatTokens(12_400_000)).toBe('12.4M tokens');
  });
});

describe('parseTokenAmount', () => {
  it.each([
    ['20M', 20_000_000],
    ['20m tokens', 20_000_000],
    ['500k', 500_000],
    ['1.5b', 1_500_000_000],
    ['2,000,000', 2_000_000],
    ['2000万', 20_000_000],
    ['1亿', 100_000_000],
    [5_000_000, 5_000_000],
  ])('%s → %d', (text, n) => {
    expect(parseTokenAmount(text)).toBe(n);
  });

  it.each(['', 'lots', '-5', '$5', 0, -1, null, undefined, NaN])('rejects %p', (v) => {
    expect(parseTokenAmount(v)).toBeNull();
  });
});

describe('usdToTokens', () => {
  it('uses the documented migration rate (1M tokens per $1), whole thousands', () => {
    expect(usdToTokens(20)).toBe(20_000_000);
    expect(usdToTokens(2.5)).toBe(2_500_000);
    expect(usdToTokens(0.0001)).toBe(1000);
  });
});
