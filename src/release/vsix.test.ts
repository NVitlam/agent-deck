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
  // PRODUCTION, and rebuilt whenever the tree is not already production.
  //
  // This audit measures what SHIPS, and what ships is always production:
  // `vscode:prepublish` runs `esbuild.config.mjs --production`, so no VSIX can
  // contain a dev bundle. Building dev here made this file's verdict depend on
  // BUILD MODE.
  //
  // Measured 2026-08-28: `esbuild-svelte` emits placeholder comments naming
  // each component's ABSOLUTE PATH - `fakecss:<abs>/webview/*.esbuild-svelte-
  // fake-css` - and only `minify` strips them. Dev `main.css` is 28,579 bytes
  // and carries the developer identity; production is 22,929 and carries none.
  // `npm run build` is the documented command and it builds DEV, so running it
  // before the suite turned `carries the deliberate identity only in the files
  // enumerated for it` RED, while a tree left warm by `vsce package` went
  // green. Same assertion, opposite answers, decided by which command ran last.
  //
  // That is the recorded "`vsce ls` reports files that EXIST, so any assertion
  // on it depends on build state" class, reached through build MODE rather than
  // build PRESENCE - which the old missing-only guard could not see, because
  // the artifacts were present and wrong rather than absent.
  //
  // The dev leak is not a shipping defect: `dist/` is gitignored and the
  // packager always passes --production. It is a defect in what this file was
  // measuring.
  const missing = REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
  const cssPath = join(REPO_ROOT, 'dist/webview/main.css');
  const devBuilt =
    missing.length === 0 && readFileSync(cssPath, 'latin1').includes('fakecss:');
  if (missing.length > 0 || devBuilt) {
    execFileSync(process.execPath, ['esbuild.config.mjs', '--production'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const stillMissing = REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
    expect(stillMissing, 'the build did not emit the artifacts the package needs').toEqual([]);
    expect(
      readFileSync(cssPath, 'latin1').includes('fakecss:'),
      '--production did not strip the esbuild-svelte fake-css placeholders',
    ).toBe(false);
  }
  // Warm the `vsce ls` cache HERE, inside the hook that already owns a 120 s
  // budget, rather than leaving the one surviving spawn to whichever test runs
  // first under vitest's 5 s default. Same reasoning as the build above: the
  // expensive, environment-sensitive step belongs in a hook with an explicit
  // budget, so no test's verdict depends on the machine's load at the moment it
  // happened to be scheduled.
  vsceLs();
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
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'media/icon.png',
  'media/screenshot-deck.png',
  'media/screenshot-inspector.png',
  'media/screenshot-topology.png',
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
  { re: /^CONTRIBUTING\.md$/, why: 'for contributors who clone the repo, not for people who install the extension' },
  { re: /^lab\//, why: 'the private checkout, which carries the UNREDACTED captures' },
];

/**
 * Shapes that must not appear in any shipped byte. This exact leak already
 * happened: `esbuild-svelte` writes one `fakecss:<absolute path>` comment per
 * component into the DEV stylesheet, so `dist/webview/main.css` carried 16
 * absolute build-machine paths into a real VSIX.
 *
 * SHAPES, NOT NAMES, since 2026-08-28. This list used to be the developer's own
 * folder names in escaped fragments; fragmenting hides a string from `grep`
 * without removing it, and no identity string exists in this repository to list
 * any more. The shapes are also the stronger assertion - they catch an absolute
 * path belonging to ANYBODY, including whoever builds the artifact next, which
 * is exactly what the `fakecss:` leak was.
 */
const FORBIDDEN_PATH_SHAPES: ReadonlyArray<{ readonly re: RegExp; readonly what: string }> = [
  { re: /[A-Za-z]:\\Users\\/, what: 'a Windows home path, backslash form' },
  { re: /[A-Za-z]:\/Users\//, what: 'a Windows home path, forward-slash form' },
  { re: /\/home\/[A-Za-z0-9_.-]+\//, what: 'a POSIX home path' },
  { re: /\/mnt\/[a-z]\/Users\//, what: 'a WSL home path' },
];

/**
 * The licensor's own name, READ FROM THE LICENCE rather than written down.
 *
 * The deliberate identity is by definition whatever the copyright line names,
 * so the licence is the source of truth and reading it makes this audit
 * stronger: a licensor change updates it automatically instead of silently
 * narrowing it, and a licence whose copyright line stops parsing fails loudly
 * here rather than passing over nothing.
 */
const LICENSOR_NAME = ((): string => {
  const licence = readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8');
  const line = /^Copyright \(c\) \d{4} (.+)$/m.exec(licence);
  if (line === null) throw new Error('LICENSE has no parseable copyright line');
  return (line[1] ?? '').trim();
})();

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

/**
 * DELIBERATE IDENTITY - a separate list, on purpose.
 *
 * The surname was in neither needle list until Phase 6, so "no developer
 * identifier in any shipped byte" meant four needles and this audit could not
 * have seen a fifth. It ships, and it is meant to: the MIT copyright line names
 * it, and it is a substring of the marketplace publisher id, which appears in
 * the manifest's `publisher` and `repository.url` fields and again in the
 * vsixmanifest vsce generates.
 *
 * It is NOT folded into `DEVELOPER_IDENTIFIERS` above. That list carries exactly
 * one exemption and its narrowness is what proves the exemption is load-bearing
 * rather than a hole; adding a needle that legitimately appears in several
 * shipped files would turn a zero-tolerance list into a list with an allow-set,
 * and the next reader would not be able to tell which kind it was. Two lists,
 * two rules: that one stays at zero, this one is an inventory of an enumerated
 * set of paths.
 *
 * DERIVED FROM THE LICENCE, like `LICENSOR_NAME` above and for the same reason.
 * Until 2026-08-28 this was a fragment-assembled literal, which hides a string
 * from `grep` without removing it.
 *
 * Words of two characters or fewer are dropped: an initial, or a "de"/"van"
 * particle, is not a distinctive token and would match half the artifact.
 */
const IDENTITY_IDENTIFIERS: readonly string[] = ((): string[] => {
  const words = LICENSOR_NAME.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) throw new Error('the copyright line names nobody');
  return words;
})();

/**
 * The shipped paths allowed to carry it, as the ARTIFACT names them - which is
 * not what `vsce ls` calls the licence. Measured and already paid for by this
 * repo: `LICENSE` on disk is `extension/LICENSE.txt` in the zip, so a rule
 * written against the on-disk name matches nothing and reports a clean pass by
 * looking in the wrong place.
 */
const IDENTITY_ALLOWED_IN_ARTIFACT: readonly RegExp[] = [
  LICENCE_IN_ARTIFACT,
  /^extension\/package\.json$/,
  // vsce generates this one; the publisher id it embeds is the whole reason a
  // marketplace listing can be attributed to anybody.
  /^extension\.vsixmanifest$/,
  // README.md on disk carries ZERO occurrences of the identity - measured. vsce
  // REWRITES relative links at package time, so `[LICENSE](LICENSE)` ships as
  // `https://github.com/dev/agent-deck/blob/HEAD/LICENSE`, and the org
  // segment carries the surname. Case-insensitive because vsce also lowercases
  // the name: `README.md` on disk becomes `extension/readme.md` in the zip, the
  // same rename it does to LICENSE -> LICENSE.txt. Only the unzipped artifact
  // knows this; the on-disk file and `vsce ls` both look clean.
  /^extension\/readme\.md$/i,
];

/**
 * ...and the paths where its ABSENCE would be its own defect, so the allow-set
 * above cannot go silently vacuous. Only the two whose bytes are known from
 * disk are required; the generated vsixmanifest is permitted, not demanded.
 */
const IDENTITY_REQUIRED_IN_ARTIFACT: ReadonlyArray<{ readonly re: RegExp; readonly what: string }> =
  [
    { re: LICENCE_IN_ARTIFACT, what: 'the shipped licence does not name its licensor' },
    { re: /^extension\/package\.json$/, what: 'the shipped manifest names no publisher' },
  ];

/** The same allow-set, as `vsce ls` and the working tree name the files. */
// README.md joined this list at 0.1.1. It carries the identity twice, both
// deliberate and both required: the marketplace badge and the listing link
// embed the publisher id `nvitlam`, which contains the surname. Before the
// listing existed the file was clean, which is why it was not enumerated here
// and why the always-on leg went red the moment the badge landed - working as
// intended.
const IDENTITY_ALLOWED_ON_DISK: readonly string[] = ['LICENSE', 'package.json'];

/**
 * `vsce ls` is a subprocess spawn, measured at 1.4-3.2 s per call. Six tests
 * below need the same listing, and that listing cannot change mid-run: the
 * `beforeAll` above has already built every artifact vsce reports on, and
 * nothing in this file writes to the tree.
 *
 * Spawning per test cost ~12-18 s of pure subprocess time and made the FIRST
 * test fail vitest's 5 s default timeout - but only sometimes. Measured both
 * ways at Phase 6: the file is green run alone, and red in the full suite,
 * because `src/perf/perf.test.ts` runs concurrently and saturates the CPU. A
 * test whose verdict depends on what else happens to be running is not a test,
 * and "re-run it and see" is not a diagnosis.
 *
 * Same family as the CLAUDE.md note that `vsce ls` reports files that EXIST,
 * so an assertion on it silently depended on test ORDER. That one was about
 * build state; this one is about wall-clock. Both come from treating an
 * expensive, environment-sensitive subprocess as though it were a pure
 * function. Cached once, at module scope, deliberately.
 */
let vsceLsCache: readonly string[] | null = null;

function vsceLs(): readonly string[] {
  if (vsceLsCache !== null) return vsceLsCache;
  const stdout = execFileSync(process.execPath, [VSCE_BIN, 'ls', '--no-dependencies'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  vsceLsCache = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // vsce prints paths with the platform separator; the manifest and every
    // assertion here speak posix.
    .map((line) => line.split('\\').join('/'));
  return vsceLsCache;
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
    expect([...rootLevel].sort()).toEqual([
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'SECURITY.md',
      'package.json',
    ]);
  });

  it('carries the deliberate identity only in the files enumerated for it', () => {
    // The always-on half of DoD5. It reads the WORKING-TREE bytes of everything
    // `vsce ls` says would ship, so it runs in every suite rather than only
    // behind AGENT_DECK_PACKAGE_AUDIT=1. It cannot see the vsixmanifest or the
    // licence rename - the gated leg below is what covers those - but it does
    // cover every file that goes in verbatim, including the built bundles.
    const files = vsceLs();
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const rel of files) {
      // CASE-SENSITIVE, and the case is the point. The Marketplace publisher id
      // is the surname's lowercase form with an `n` in front; it ships in every
      // VSIX manifest and the documented install command needs it. It is
      // deliberately NOT the same string as the copyright line's surname, and
      // folding case here would collapse the two and drag the README back onto
      // an allow-list it no longer needs to be on.
      const text = readFileSync(join(REPO_ROOT, rel)).toString('latin1');
      for (const identifier of IDENTITY_IDENTIFIERS) {
        if (!text.includes(identifier)) continue;
        if (IDENTITY_ALLOWED_ON_DISK.includes(rel)) {
          seen.add(rel);
          continue;
        }
        violations.push(`${rel} carries the deliberate identity and is not enumerated for it`);
      }
    }
    expect(violations).toEqual([]);
    // Non-vacuity, stated as the two files whose bytes say so: the copyright
    // line and the publisher field. If either stops matching, the allow-set
    // above has become a list of places nothing is, which is how an exemption
    // turns into a hole nobody notices.
    expect([...seen].sort()).toEqual([...IDENTITY_ALLOWED_ON_DISK].sort());
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
          /** Where the DELIBERATE identity was actually found, artifact-named. */
          const identitySeen: string[] = [];
          for (const file of shipped) {
            const relative = file.slice(extracted.length + 1).split('\\').join('/');
            const bytes = readFileSync(file);
            // Byte scan, not a text grep: the leak that happened was inside a
            // CSS comment, and a shipped bundle is not guaranteed to be text.
            const text = bytes.toString('latin1');
            // ZERO TOLERANCE, with no exemption at all any more. An absolute
            // path has no business in a shipped byte whoever it belongs to,
            // and since shapes replaced names there is nothing here a licence
            // could legitimately contain - a copyright line names a person,
            // not a directory. The exemption that used to live here (the
            // licensor's name inside the licence) moved to the
            // deliberate-identity pass below, where it belongs.
            for (const shape of FORBIDDEN_PATH_SHAPES) {
              if (!shape.re.test(text)) continue;
              hits.push(`${relative} contains ${shape.what}`);
            }
            // The deliberate-identity list, kept separate so the zero-tolerance
            // list above stays at zero tolerance. Same byte scan, different
            // rule: an enumerated allow-set of shipped paths rather than one
            // exemption.
            //
            // CASE-SENSITIVE - the Marketplace publisher id is the surname's
            // lowercase form and is a different string on purpose.
            for (const identifier of IDENTITY_IDENTIFIERS) {
              if (!text.includes(identifier)) continue;
              if (LICENCE_IN_ARTIFACT.test(relative) && LICENSOR_NAME.includes(identifier)) {
                licenceNamesTheLicensor = true;
              }
              if (IDENTITY_ALLOWED_IN_ARTIFACT.some((re) => re.test(relative))) {
                identitySeen.push(relative);
                continue;
              }
              hits.push(`${relative} carries the deliberate identity and is not enumerated for it`);
            }
          }
          expect(hits).toEqual([]);
          for (const required of IDENTITY_REQUIRED_IN_ARTIFACT) {
            expect(
              identitySeen.some((rel) => required.re.test(rel)),
              required.what,
            ).toBe(true);
          }
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
