// Flat config. TypeScript-aware, no type-checked rules that duplicate or
// fight `tsc --strict` (typecheck is its own script).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      'spike/**',
      'fixtures/**',
      '.claude/**',
      // The private lab checkout - a separate repository with its own lint and
      // test setup. See `.gitignore`.
      'lab/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Exported signatures must be `any`-free; flag it everywhere.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Interfaces vs type aliases: both are used deliberately here.
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      // `console` is here because the config was incomplete, not because a new
      // file needed an exemption. `scripts/privacy-sweep.mjs` is the only
      // pre-existing .mjs that prints, and it happens to use
      // `process.stdout.write`, so `no-undef` on `console` had never fired --
      // the first .mjs to use the obvious API (`docs/ui/goldens.mjs`) turned
      // `npm run lint` red on a documentation-only branch. A Node global that
      // every Node script may legitimately use belongs in the globals list.
      //
      // `Buffer` and `URL` were added 2026-09-03 for the same reason, and the
      // same way it was found: `npm run lint` was ALREADY RED at HEAD, because
      // `scripts/capture-codex.mjs` landed in a8d87ea using `Buffer.byteLength`
      // and `new URL(import.meta.url)` — two errors that had nothing to do with
      // the file and everything to do with this list. Both are Node globals any
      // script may use; the alternative was per-file disable comments, which
      // would have spread the incompleteness instead of fixing it.
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
