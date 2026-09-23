/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'docs/coverage',
  coverageProvider: 'v8',
  coverageReporters: ['json-summary', 'text', 'lcov'],
};
