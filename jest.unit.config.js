import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** Check if an npm package is installed. */
function hasPackage(name) {
  try { require.resolve(name); return true; } catch { return false; }
}

export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/backend/src'],
  testMatch: [
    '**/backend/src/**/?(*.)+(spec|test).ts'
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
  },
  // Skip Cloud SDK test files when their packages are not installed (OSS mode)
  testPathIgnorePatterns: [
    '/node_modules/',
    ...(hasPackage('stripe') ? [] : ['stripe\\.service\\.test\\.ts$']),
    ...(hasPackage('@anthropic-ai/sdk') ? [] : ['cloud-task-processor\\.service\\.test\\.ts$']),
    ...(hasPackage('mongodb') ? [] : ['cloud-auth\\.service\\.test\\.ts$', 'supabase-auth\\.middleware\\.test\\.ts$', 'mongodb\\.service\\.test\\.ts$']),
  ],
  transformIgnorePatterns: [
    'node_modules/(?!(@modelcontextprotocol)/)',
  ],
  // Keep tests out of the real home: per-file CREWLY_HOME, os.homedir(), HOME
  // (same setup as jest.config.js). See tests/setup.ts.
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  collectCoverageFrom: [
    'backend/src/**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/*.test.ts'
  ],
  coverageDirectory: 'coverage-unit',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 10000,
  maxWorkers: '50%',
};
