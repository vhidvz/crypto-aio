import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

const SDKS = [
  'ethers',
  'web3',
  'tronweb',
  'bitcoinjs-lib',
  '@solana/*',
  '@ton/*',
  '@avalabs/*',
];

export default defineConfig(
  {
    ignores: ['dist/**', 'docs/**', 'coverage/**', 'node_modules/**', '.superpowers/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../**/adapters',
                '../**/adapters/**',
                '../**/testing',
                '../**/testing/**',
              ],
              message: 'src/core must not import adapters or the testing kit',
            },
            {
              group: [...SDKS, ...SDKS.map((s) => `${s}/*`)],
              message: 'src/core must not import blockchain SDKs',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
