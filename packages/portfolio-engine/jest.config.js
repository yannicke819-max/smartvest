/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@smartvest/shared-types$': '<rootDir>/../shared-types/src/index.ts',
    '^@smartvest/domain$': '<rootDir>/../domain/src/index.ts',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
};
