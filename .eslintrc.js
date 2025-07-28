module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended'
  ],
  env: {
    browser: true,
    es6: true,
    node: true
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  globals: {
    // Cloudflare Workers globals
    'KVNamespace': 'readonly',
    'DurableObjectNamespace': 'readonly', 
    'AnalyticsEngineDataset': 'readonly',
    'DurableObjectState': 'readonly',
    'WebSocketPair': 'readonly',
    'ScheduledEvent': 'readonly',
    'globalThis': 'readonly'
  },
  rules: {
    'no-unused-vars': 'off', // Disable base rule for TypeScript
    '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'prefer-const': 'error',
    'no-var': 'error',
    'no-console': 'off',
    'no-case-declarations': 'off' // Allow declarations in case blocks
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    '*.js'
  ]
};