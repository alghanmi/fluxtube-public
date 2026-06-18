// ESLint 10 flat config. Replaces the legacy `.eslintrc.json` removed in the
// TS6/ESLint10 upgrade. Uses the official `typescript-eslint` helper which
// composes the parser + plugin and exposes preset configs.
//
// To extend with type-aware rules later, add a `languageOptions.parserOptions`
// with `project: true` and switch to `tseslint.configs.recommendedTypeChecked`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.wrangler/**',
      '**/*.config.ts',
      '**/*.config.js',
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Cloudflare Workers globals
        addEventListener: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
        AbortSignal: 'readonly',
        ExecutionContext: 'readonly',
        ScheduledController: 'readonly',
        ExportedHandler: 'readonly',
        D1Database: 'readonly',
        RequestInit: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', "error"] }],
    },
  },
);
