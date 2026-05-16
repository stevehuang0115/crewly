// ESLint v8 expects CommonJS for its config when the package.json has
// `"type": "module"`. Renamed from `.eslintrc.js` + converted to CJS
// (`module.exports = { ... }`) so Node treats this file as CJS even
// though the parent package is ESM. Issue #405.
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    'prefer-const': 'error',
    'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
  },
  env: {
    node: true,
    es6: true,
    jest: true,
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'coverage/',
    'frontend/dist/',
    '*.js',
  ],
};
