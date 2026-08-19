import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // `npm test` runs `vitest run` (non-watch) so CI and agents get an exit code.
    watch: false,
  },
});
