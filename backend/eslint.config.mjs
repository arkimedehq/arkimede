// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'uploads/**', 'vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Constructor parameter types are runtime values for Nest DI (emitDecoratorMetadata).
      parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // LangChain messages, driver rows and Nest payloads are typed loosely on purpose; turning `any` into types is its
      // own piece of work, not a lint fix.
      '@typescript-eslint/no-explicit-any': 'off',
      // Optional dependencies are loaded on demand with require() (a driver, an exporter): only when configured.
      '@typescript-eslint/no-require-imports': 'off',
      // Flags `let x = fallback; try { x = … } catch { return … }`, a pattern used on purpose.
      'no-useless-assignment': 'off',
      // A variable read by a closure before its one assignment (a resolver set up first) must stay `let`.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
);
