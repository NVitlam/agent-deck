/**
 * The test infrastructure's own tests — v0.7.0, the 4.11b gate.
 *
 * ## Why a suite for a suite helper
 *
 * One gate run of three failed with `Command failed: node
 * webview/build-harness.mjs` and NOTHING else: one webview suite reported as a
 * failed SUITE, its two tests counted as SKIPPED, and no reason anywhere. Five
 * files each spawned their own esbuild with `logLevel: 'silent'` and no
 * `try`/`catch`, so a spawn that lost under parallel load produced an empty
 * stderr and `execFileSync`'s message was all anyone got. That is this
 * repository's recorded "fails to collect, reports as skipped, reads green"
 * class arriving through a subprocess.
 *
 * The fix — one `spawnBundle` that re-throws with the child's output, and
 * `logLevel: 'error'` in every build script — was itself unguarded when
 * `phase-verifier` looked at it, which is how a fix at one site of five gets
 * called done. Both halves are pinned here.
 */

import { describe, expect, it } from 'vitest';

import { spawnBundle } from './testkit.js';

/**
 * Held in a variable for the reason `testkit.ts` gives: `tsconfig.webview.json`
 * sets `types: []`, so a literal node specifier fails the webview typecheck.
 */
const FS = 'node:fs';

interface FsModule {
  readFileSync(path: string, encoding: 'utf8'): string;
}

/** Every file that spawns a bundle build. The count is pinned beside the set. */
const BUILD_SITES = [
  'webview/build-harness.mjs',
  'webview/canvas.test.ts',
  'webview/deck.test.ts',
  'webview/inspector.test.ts',
  'webview/inspector.phase4.test.ts',
];

describe('spawnBundle: a lost spawn says why', () => {
  it('returns the child stdout when the child succeeds', async () => {
    const out = await spawnBundle(['-e', 'process.stdout.write("bundled")'], 'a control');
    expect(out).toBe('bundled');
  });

  it("carries the exit code AND the child's stderr into the thrown message", async () => {
    const script = 'process.stderr.write("deliberate boom\\n"); process.exit(3)';
    await expect(spawnBundle(['-e', script], 'a deliberate failure')).rejects.toThrow(
      /a deliberate failure failed \(exit 3\).*deliberate boom/s,
    );
  });

  it('says so explicitly when the child wrote nothing at all — the case that started this', async () => {
    // The real incident's shape: a non-zero exit with an empty stderr. The
    // message must distinguish "the child was silent" from "no message was
    // looked for", because the first is a fact about the run and the second is
    // this helper failing to do its job.
    await expect(spawnBundle(['-e', 'process.exit(9)'], 'a silent failure')).rejects.toThrow(
      /a silent failure failed \(exit 9\) — the child wrote nothing to stderr/,
    );
  });

  it("no bundle build runs at esbuild's 'silent' level — all five, by file", async () => {
    /*
     * The other half of the fix, and the half a reader cannot see from
     * `spawnBundle`: a re-thrown message is only worth what the child put in it,
     * and at 'silent' esbuild puts nothing there. Asserted over the exact SET of
     * build sites with the count beside it (rule 19's shape, applied to a source
     * census): a sixth site added later fails this until it is named, which is
     * the point — the incident happened because a fix landed at one site of five.
     */
    const fs = (await import(/* @vite-ignore */ FS)) as unknown as FsModule;
    const seen: string[] = [];
    for (const path of BUILD_SITES) {
      const text = fs.readFileSync(path, 'utf8');
      expect(text, `${path} spawns no esbuild build`).toContain('logLevel:');
      expect(text, `${path} still builds at the silent level`).not.toContain("logLevel: 'silent'");
      expect(text, `${path} does not build at the error level`).toContain("logLevel: 'error'");
      seen.push(path);
    }
    expect(seen).toStrictEqual(BUILD_SITES);
    expect(seen).toHaveLength(5);
  });
});
