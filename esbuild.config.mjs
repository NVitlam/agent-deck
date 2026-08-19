// Bundles the extension host entry point for VS Code.
//
// NOTE: `src/extension.ts` does not exist yet — Phase 3 owns the activation
// entry point. Until it lands, `npm run build` fails with a missing-entry
// error. That is expected; `npm test`, `npm run lint` and `npm run typecheck`
// do not depend on this file.
//
// VS Code loads extensions as CommonJS in a Node host, and `vscode` is
// injected by the host at runtime, so it must stay external.

import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
