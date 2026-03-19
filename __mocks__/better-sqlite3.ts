/**
 * Manual mock for better-sqlite3 native module.
 *
 * Provides a fake Database class so test suites that transitively
 * import better-sqlite3 don't fail with native-binary architecture
 * mismatches (arm64 vs x86_64).
 *
 * @module __mocks__/better-sqlite3
 */

/**
 * Mock prepared statement.
 */
class MockStatement {
  run = jest.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 });
  get = jest.fn().mockReturnValue(null);
  all = jest.fn().mockReturnValue([]);
  pluck = jest.fn().mockReturnThis();
  bind = jest.fn().mockReturnThis();
  finalize = jest.fn();
}

/**
 * Mock database instance.
 *
 * @param _filename - Database path (ignored in mock)
 * @param _options - Database options (ignored in mock)
 * @returns Mock Database object
 */
function Database(_filename?: string, _options?: Record<string, unknown>): Record<string, unknown> {
  return {
    prepare: jest.fn(() => new MockStatement()),
    exec: jest.fn(),
    pragma: jest.fn().mockReturnValue([]),
    close: jest.fn(),
    loadExtension: jest.fn(),
    transaction: jest.fn((fn: (...args: unknown[]) => unknown) => fn),
    inTransaction: false,
  };
}

export = Database;
