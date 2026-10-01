/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testTimeout: 60_000,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
  collectCoverage: true,
  coverageProvider: 'v8',
  coverageReporters: ['json-summary', 'text-summary', 'lcov'],
  // Plan 7: 2 points under 0.1.0's measured coverage (98.45, 98.45, 96.83, 93.14).
  coverageThreshold: {
    global: { lines: 96, statements: 96, functions: 94, branches: 91 },
  },
};
