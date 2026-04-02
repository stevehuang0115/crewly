import { formatResult, isPositive } from './utils';

describe('formatResult', () => {
  test('should format positive numbers correctly', () => {
    expect(formatResult(10)).toBe('Positive: 10');
  });

  test('should format negative numbers correctly', () => {
    expect(formatResult(-5)).toBe('Negative: -5');
  });

  test('should format zero correctly', () => {
    expect(formatResult(0)).toBe('Zero');
  });

  test('should handle a large positive number', () => {
    expect(formatResult(999999)).toBe('Positive: 999999');
  });

  test('should handle a large negative number', () => {
    expect(formatResult(-999999)).toBe('Negative: -999999');
  });
});

describe('isPositive', () => {
  test('should return true for positive numbers', () => {
    expect(isPositive(5)).toBe(true);
  });

  test('should return false for negative numbers', () => {
    expect(isPositive(-5)).toBe(false);
  });

  test('should return false for zero', () => {
    expect(isPositive(0)).toBe(false);
  });

  test('should return true for a positive decimal number', () => {
    expect(isPositive(0.1)).toBe(true);
  });
  
  test('should return false for a negative decimal number', () => {
    expect(isPositive(-0.1)).toBe(false);
  });
});
