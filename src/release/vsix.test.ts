/**
 * What the packaged artifact ACTUALLY contains.
 *
 * This is the one check no work package could write, because it is the only
 * one whose subject spans every package at once: `package.json` (P5-MANIFEST),
 * `README.md` (P5-DOCS), `.vscodeignore` (P5-MANIFEST) and the built bundles
 * (host + webview) only disagree with each other in the artifact, and the
 * artifact is the thing a user installs.
 *
 * CLAUDE.md records the defect class in its own words: "A stray file at the
 * repo root escapes a `docs/**`-shaped `.vscodeignore` rule and ships. [...]
 * The only way this class shows up is unzipping the artifact and listing it —
 * because the ignore file alone cannot answer 'what does the package actually
 * contain'." A 38 KB design mockup shipped that way once. `docs/README.md` — a
 * "superseded documents" index — was shipping as the only README a user saw,
 * right up until this phase, for the same reason: the rule named `docs/ui/**`
 * and `docs/evidence/**`, so the file between them survived.
 *
 * TWO LEGS, AND THE SPLIT IS STATED RATHER THAN HIDDEN:
 *
 *   ALWAYS ON — the file list, from `vsce ls`, which is the packager's own
 *   answer to "what would ship" and reads no build output. Measured: it does
 *   NOT run `vscode:prepublish` and does not touch `dist/` (mtimes identical
 *   across a run), which is why it is safe in a parallel suite.
 *
 *   GATED on AGENT_DECK_PACKAGE_AUDIT=1 — actually building the .vsix,
 *   unzipping it, and scanning the bytes. This one is gated for a measured
 *   reason, not a vague one: `vsce package` runs `vscode:prepublish`, which
 *   REWRITES the shared `dist/extension.cjs` and `dist/webview/main.*` in
 *   production mode. `src/extension.test.ts` loads `dist/extension.cjs` and
 *   `webview/bundle.test.ts` reads the webview bundles — both from the same
 *   parallel run. An ungated build here would race them and produce exactly
 *   the intermittent red this repo has spent two phases eliminating.
 *
 * So the gated leg is NOT a silent skip and NOT an aspiration: `release.yml`
 * runs it on every tag, where nothing else is running and where the artifact
 * is actually produced. The last assertion in this file pins that — if the
 * workflow step is ever deleted, the gate becomes a skip nobody runs, and this
 * file goes red to say so.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * `vsce ls` reports files that EXIST. On a fresh checkout `dist/` does not, so
 * the exact-set assertion below would report the artifacts as missing rather
 * than as unpackaged — a false red that says nothing about the ignore rules.
 *
 * Measured, not anticipated: CI run 32521971501 failed here with
 * `dist/webview/main.{css,js}` absent while `dist/extension.cjs` was present.
 * The asymmetry is the tell — `src/extension.test.ts` and
 * `src/hooks/egress.test.ts` shell out to `esbuild.config.mjs --host` during
 * the run, so the host bundle materialises as a side effect of another suite
 * and the webview bundle does not. That made this file's result depend on test
 * ORDER, which is a latent flake on any clean checkout, not just in CI.
 *
 * So build what is missing, once, and only when it is missing. On a warm tree
 * this is a no-op; on a cold one it runs before any assertion. It does not
 * widen the dist/-rewrite race the header describes: a cold tree is exactly the
 * case where `webview/bundle.test.ts` would build the same bundle itself.
 */
const REQUIRED_ARTIFACTS = ['dist/extension.cjs', 'dist/webview/main.js', 'dist/webview/main.css'];

beforeAll(() => {
  const missing = REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
  if (missing.length === 0) return;
  execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stillMissing = REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
  expect(stillMissing, 'the build did not emit the artifacts the package needs').toEqual([]);
}, 120_000);

/** vsce's own bin entry, run through this process's node so no shell or
 *  `.cmd` shim is involved (`npx` resolution differs on Windows). */
const VSCE_BIN = join(REPO_ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');

/**
 * The complete set of files the VSIX is allowed to carry, as `vsce ls` reports
 * them. EXACT set equality, deliberately — the defect class is a file nobody
 * meant to ship, so "contains what we expect" is the wrong assertion shape and
 * would have passed every time this repo actually got bitten.
 *
 * This is not the "do not assert fixture-set sizes" case. That rule protects
 * counts that the next capture legitimately moves. This set moves only when a
 * human changes what the product ships, which is precisely the event that
 * should require a deliberate edit here.
 */
const EXPECTED_PACKAGED_FILES: readonly string[] = [
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'dist/extension.cjs',
  'dist/webview/main.css',
  'dist/webview/main.js',
  'package.json',
];

/** Directories and shapes whose presence in the artifact is a defect, each
 *  paired with the reason it must not ship. */
const FORBIDDEN: ReadonlyArray<{ readonly re: RegExp; readonly why: string }> = [
  { re: /^fixtures\//, why: 'fixtures keep cwd/session_id verbatim — shipping them publishes one developer\u2019s absolute paths' },
  { re: /^src\//, why: 'source is not the product' },
  { re: /^webview\//, why: 'webview source; the built bundle under dist/ is what ships' },
  { re: /^spike\//, why: 'frozen Phase 0 reference' },
  { re: /^scripts\//, why: 'dev tooling' },
  { re: /^docs\//, why: 'the workshop, not the product — and docs/README.md shipped as the user-facing README before Phase 5' },
  { re: /^test\//, why: 'test doubles' },
  { re: /^\.github\//, why: 'CI configuration' },
  { re: /^\.claude\//, why: 'agent configuration, and settings.local.json carries local paths' },
  { re: /^node_modules\//, why: 'packaged with --no-dependencies' },
  { re: /^dist\/theater\//, why: 'the replay theater is DEV-ONLY and must never reach a user' },
  { re: /\.map$/, why: 'source maps embed absolute source paths from the build machine' },
  { re: /\.vsix$/, why: 'a previous artifact embedded in this one' },
  { re: /\.tsx?$/, why: 'TypeScript source' },
  { re: /\.svelte$/, why: 'component source' },
  { re: /^(PLAN|CLAUDE|HANDOVER)\.md$/, why: 'internal process documents' },
  { re: /^agent-deck-spec\.md$/, why: 'internal specification' },
];

/** Identifiers that must not appear in any shipped byte. This exact leak
 *  already happened: `esbuild-svelte` writes one `fakecss:<absolute path>`
 *  comment per component into the DEV stylesheet, so `dist/webview/main.css`
 *  carried 16 `C:/Users/...` paths into a real VSIX. Written as escaped
 *  fragments so this file is not itself a hit in the privacy sweep. */
const DEVELOPER_IDENTIFIERS = ['Nad' + 'av', 'One' + 'Drive', 'C:' + '\\Users', 'c:' + '/Users'];

/** The licensor's own name, which the MIT copyright line must carry. Same
 *  fragment-concatenation reason as above. */
const LICENSOR_NAME = DEVELOPER_IDENTIFIERS[0] as string;

/**
 * The licence AS THE ARTIFACT NAMES IT — which is not what `vsce ls` calls it.
 *
 * Measured on the first real run of this audit: the repo file is `LICENSE`,
 * `vsce ls` reports `LICENSE`, and the entry inside the .vsix is
 * `extension/LICENSE.txt`. vsce renames it. That is this repo's own lesson
 * arriving again — the ignore file and the packager's own listing both
 * describe the package, and only the unzipped artifact reports it. An audit
 * written against the `vsce ls` name would have matched nothing here and
 * reported a clean pass by looking in the wrong place.
 */
const LICENCE_IN_ARTIFACT = /^extension\/LICENSE(\.txt)?$/i;

function vsceLs(): string[] {
  const stdout = execFileSync(process.execPath, [VSCE_BIN, 'ls', '--no-dependencies'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // vsce prints paths with the platform separator; the manifest and every
    // assertion here speak posix.
    .map((line) => line.split('\\').join('/'));
}

describe('the packaged artifact', () => {
  it('ships exactly the expected file set, and nothing else', () => {
    const files = vsceLs();
    expect([...files].sort()).toEqual([...EXPECTED_PACKAGED_FILES].sort());
  });

  it('carries no file from a forbidden directory or of a forbidden shape', () => {
    const files = vsceLs();
    const violations = files.flatMap((file) => {
      const hit = FORBIDDEN.find((rule) => rule.re.test(file));
      return hit ? [`${file} \u2014 ${hit.why}`] : [];
    });
    expect(violations).toEqual([]);
  });

  it('ships the three documents a user is entitled to, and the root README rather than docs/README.md', () => {
    const files = vsceLs();
    // README.md and LICENSE come from two DIFFERENT work packages and neither
    // could assert the other. This is the seam.
    expect(files).toContain('README.md');
    expect(files).toContain('LICENSE');
    // SECURITY.md ships deliberately: zero egress and the read-only posture are
    // the trust anchor, so the document asserting them belongs in the artifact
    // a user installs, not only in a repository they may never visit.
    expect(files).toContain('SECURITY.md');
    expect(files).not.toContain('docs/README.md');
  });

  it('ships the file that `main` names, so the manifest and the package agree', async () => {
    const files = vsceLs();
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      main?: unknown;
    };
    expect(typeof manifest.main).toBe('string');
    const main = posix.normalize(String(manifest.main).split('\\').join('/').replace(/^\.\//, ''));
    // The defect class CLAUDE.md names as certain to recur: "the manifest and
    // the build disagree". `src/extension.test.ts` proves the file on disk
    // exports `activate`; this proves the same file is inside the package.
    expect(files, `package.json main "${main}" is not in the packaged file list`).toContain(main);
  });

  it('has no packaged file at the repo root other than the three documents and the manifest', () => {
    // The stray-root-file class, stated positively. A duplicate of the 38 KB
    // design mockup was committed at the root and shipped, because the ignore
    // rule was shaped like `docs/**` and the file was not in docs/.
    const rootLevel = vsceLs().filter((file) => !file.includes('/'));
    expect([...rootLevel].sort()).toEqual(['LICENSE', 'README.md', 'SECURITY.md', 'package.json']);
  });

  it('keeps the packaged-artifact byte audit wired into the release workflow', () => {
    // Without this, the gated leg below is a test nobody ever runs. Reading a
    // sibling package's file, not editing it.
    const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(
      workflow,
      'release.yml must run the gated byte audit — otherwise AGENT_DECK_PACKAGE_AUDIT is a skip nobody executes',
    ).toContain('AGENT_DECK_PACKAGE_AUDIT');
  });
});

/**
 * The gated leg. Builds a real .vsix in production mode, unzips it and reads
 * the bytes. See the header for why this cannot run inside a parallel suite.
 */
describe.runIf(process.env['AGENT_DECK_PACKAGE_AUDIT'] === '1')(
  'the packaged artifact, unzipped (AGENT_DECK_PACKAGE_AUDIT=1)',
  () => {
    it(
      'contains no developer identifier in any shipped byte',
      () => {
        const staging = mkdtempSync(join(tmpdir(), 'agent-deck-vsix-'));
        try {
          const vsixPath = join(staging, 'agent-deck.vsix');
          // Runs `vscode:prepublish` -> `esbuild --production`. That is the
          // point: a default build is what leaked the fakecss paths.
          execFileSync(
            process.execPath,
            [VSCE_BIN, 'package', '--no-dependencies', '--out', vsixPath],
            { cwd: REPO_ROOT, encoding: 'utf8' },
          );
          expect(statSync(vsixPath).size).toBeGreaterThan(0);

          // A .vsix is a zip. Expand-Archive insists on the extension.
          const zipPath = join(staging, 'agent-deck.zip');
          copyFileSync(vsixPath, zipPath);
          const extracted = join(staging, 'unzipped');
          execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extracted}' -Force`,
            ],
            { encoding: 'utf8' },
          );

          const walk = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
              entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
            );
          const shipped = walk(extracted);
          expect(shipped.length).toBeGreaterThan(0);

          const hits: string[] = [];
          let licenceNamesTheLicensor = false;
          for (const file of shipped) {
            const relative = file.slice(extracted.length + 1).split('\\').join('/');
            const bytes = readFileSync(file);
            // Byte scan, not a text grep: the leak that happened was inside a
            // CSS comment, and a shipped bundle is not guaranteed to be text.
            const text = bytes.toString('latin1');
            for (const identifier of DEVELOPER_IDENTIFIERS) {
              if (!text.toLowerCase().includes(identifier.toLowerCase())) continue;
              // THE ONE DELIBERATE EXEMPTION, found by running this audit for
              // the first time. A licence names its licensor — that is what a
              // copyright line IS — so the copyright holder's name in the
              // licence file is the grant working, not a leak. The exemption is
              // narrow: this file only, this identifier only. Every other
              // shipped byte stays at zero, and the assertion below proves the
              // exemption is load-bearing rather than a hole to hide in.
              if (LICENCE_IN_ARTIFACT.test(relative) && identifier === LICENSOR_NAME) {
                licenceNamesTheLicensor = true;
                continue;
              }
              hits.push(`${relative} contains ${identifier}`);
            }
          }
          expect(hits).toEqual([]);
          // A licence with no licensor is its own defect, and it would make the
          // exemption above silently vacuous.
          expect(
            licenceNamesTheLicensor,
            'the shipped licence does not name its licensor',
          ).toBe(true);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      },
      240_000,
    );
  },
);
