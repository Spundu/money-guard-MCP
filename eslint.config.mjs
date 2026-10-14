import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat config. Type-aware linting is deliberately off to stay fast; `tsc --noEmit` (typecheck)
// covers the type-level checks, including the one JavaScript file (the PGlite worker, checkJs).
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.{js,mjs,cjs,ts,mts}'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts, and the noisy test worker that writes to the console on purpose (test/database.test.ts).
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly' } },
  },
  {
    // The README examples, written as a reader would write them, with Node's globals.
    files: ['examples/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
