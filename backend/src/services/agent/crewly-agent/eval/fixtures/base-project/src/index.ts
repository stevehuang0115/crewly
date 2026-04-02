/**
 * Entry point for the eval base project fixture.
 *
 * Provides a simple calculateTotal function used by eval tasks
 * to verify agent read/write capabilities.
 */

/**
 * Calculate the total price of items after applying a discount.
 *
 * @param prices   - array of item prices
 * @param discount - discount percentage (0-100)
 * @returns total price after discount
 *
 * @example
 * ```typescript
 * const total = calculateTotal([10, 20, 30], 10);
 * // total === 54
 * ```
 */
export function calculateTotal(prices: number[], discount: number): number {
  const subtotal = prices.reduce((sum, price) => sum + price, 0);
  const discountAmount = subtotal * (discount / 100);
  return subtotal - discountAmount;
}
