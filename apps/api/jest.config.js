/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testTimeout: 60000,
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, target: 'es2022' },
    }],
  },
  moduleNameMapper: {
    '^@athosbet/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@athosbet/odds-engine$': '<rootDir>/../../packages/odds-engine/src/index.ts',
  },
};
