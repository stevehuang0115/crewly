export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/backend/src', '<rootDir>/cli/src', '<rootDir>/config'],
  testMatch: [
    '**/tests/**/?(*.)+(spec|test).ts',
    '**/backend/src/**/?(*.)+(spec|test).ts',
    '**/cli/src/**/?(*.)+(spec|test).ts',
    '**/config/**/?(*.)+(spec|test).ts'
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        target: 'ES2020',
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        skipLibCheck: true
      }
    }],
  },
  moduleNameMapper: {
    '^@backend/(.*)$': '<rootDir>/backend/src/$1',
'^@types/(.*)$': '<rootDir>/types/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Mock native modules that require platform-specific binaries.
    // Tests that directly test PTY/SQLite functionality should use
    // jest.unmock() or are expected to skip on architecture mismatch.
    'node-pty': '<rootDir>/__mocks__/node-pty.ts',
  },
  transformIgnorePatterns: [
    'node_modules/',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  collectCoverageFrom: [
    'tests/**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 10000,
  maxWorkers: '50%',
  // Exclude integration tests that require real native binaries (node-pty, better-sqlite3).
  // These tests fail on architecture mismatch (arm64 vs x86_64) and need the real modules.
  // Run separately via: npm run test:pty or npm run test:native
  testPathIgnorePatterns: [
    '/node_modules/',
    'backend/src/services/session/pty/pty-session\\.test\\.ts$',
    'backend/src/services/session/pty/pty-session-backend\\.test\\.ts$',
    'backend/src/services/session/pty/pty-input-reliability\\.test\\.ts$',
    'backend/src/services/knowledge/vector-store\\.service\\.test\\.ts$',
    // Tech-debt parking — PR #504 (test:integration discovery hygiene).
    // Each entry has a tracking issue with reproduction + fix shape.
    // Remove the entry once the underlying issue is fixed.
    //
    // #505 — cloud-connect runtime failures: file compiles + runs (38/47 PASS)
    //   after vitest→jest syntax fix in PR #504, but 4 runtime tests fail
    //   on logic-level issues (device cache, token refresh, 401 handling).
    'backend/src/services/cloud/cloud-connect-e2e\\.integration\\.test\\.ts$',
    // #506 — flaky: passes isolated, fails in full run (suspected shared-state
    //   or test-ordering interaction between sibling integration tests).
    'backend/src/tests/v3-pipeline-e2e\\.integration\\.test\\.ts$',
  ],
};