// ESLint flat-config for Alzhal.
//
// `eslint-config-next` 16 ships flat-config-ready arrays at the subpath
// exports below. We splat them in, then add ignore patterns and rule
// tweaks calibrated for this codebase.

import next from 'eslint-config-next'
import nextCwv from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

export default [
  ...next,
  ...nextCwv,
  ...nextTs,
  {
    ignores: [
      '.next/**',
      '.open-next/**',
      '.wrangler/**',
      'node_modules/**',
      'scripts/bulk-data/**',
      'scripts/chunks/**',
      'scripts/*.sql',
      '**/*.tsbuildinfo',
      'tests/fixtures/**',
      'next-env.d.ts',
    ],
  },
  {
    rules: {
      // The codebase predates strict lint and uses `any` at plenty of API
      // boundaries (D1 row shapes, Gemini SDK payloads, formidable file
      // objects). Warnings stay visible in editors without failing CI.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
      'prefer-const': 'warn',
      // Server components and route handlers don't render JSX.
      'react/no-unescaped-entities': 'off',
      // Cloudflare context binding (`@opennextjs/cloudflare`) is loaded with
      // `require()` because the module may not exist at build time on non-CF
      // environments (Next.js page-data collection runs without bindings).
      // The pattern is intentional; demote the rule to a warning.
      '@typescript-eslint/no-require-imports': 'warn',
    },
  },
]
