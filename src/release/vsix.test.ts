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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  // FIVE images, not four, and `icon.png` is not one of the four.
  // `package.json` names it as the extension icon; the other four are
  // the release screenshots README.md links, re-cut on 2026-08-30 when
  // three `0.1.x` captures of a deleted renderer were retired into the
  // maintainer's private repository. `.gitignore` and `.vscodeignore`
  // carry the same five, by name, in both doors.
  'media/icon.png',
  'media/Session_Deck.png',
  'media/hero_16_agent_session.png',
  'media/Internal_Session_Tool_popup.png',
  'media/Internal_Session_Tool_popup2.png',
  'dist/extension.cjs',
  'dist/webview/main.css',
  'dist/webview/main.js',
  'package.json',
];

/**
 * The count, pinned BESIDE the set rather than instead of it — working-method
 * rule 19.
 *
 * A set comparison accidentally written against a filtered, empty or wrongly
 * named listing passes vacuously, and this repository's whole catalogue of
 * packaging defects is "the audit looked in the wrong place and reported
 * clean". The count is the cheapest thing that goes red when that happens, and
 * it is derived from nothing: writing `EXPECTED_PACKAGED_FILES.length` here
 * would make it agree with the set by construction and check nothing at all.
 */
const EXPECTED_PACKAGED_FILE_COUNT = 13;

/**
 * The same artifact, AS THE ZIP NAMES IT. Rule 19's second half.
 *
 * vsce renames on the way in, and every rename below was measured by unzipping
 * a real .vsix rather than predicted: `LICENSE` -> `extension/LICENSE.txt`,
 * `README.md` -> `extension/readme.md`, `CHANGELOG.md` ->
 * `extension/changelog.md` (lowercased, both of them), everything else under
 * `extension/`, and two entries that exist ONLY in the zip —
 * `extension.vsixmanifest` and `[Content_Types].xml`, which is why this list is
 * 15 where `vsce ls` says 13. (It was 14 against 12 until 2026-08-30: the
 * release swapped three retired screenshots for four, and the two entries
 * the zip adds are a constant, so both numbers move by exactly one.)
 *
 * `SECURITY.md` is NOT lowercased, and that asymmetry is the reason this is an
 * enumerated list and not a transformation of the one above. An audit that
 * assumed the rule and applied it uniformly would look for `extension/security.md`,
 * find nothing, and pass.
 */
const EXPECTED_ARTIFACT_ENTRIES: readonly string[] = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/LICENSE.txt',
  'extension/SECURITY.md',
  'extension/changelog.md',
  'extension/dist/extension.cjs',
  'extension/dist/webview/main.css',
  'extension/dist/webview/main.js',
  'extension/media/Internal_Session_Tool_popup.png',
  'extension/media/Internal_Session_Tool_popup2.png',
  'extension/media/Session_Deck.png',
  'extension/media/hero_16_agent_session.png',
  'extension/media/icon.png',
  'extension/package.json',
  'extension/readme.md',
];

/** Same reasoning as `EXPECTED_PACKAGED_FILE_COUNT`, on the other naming. */
const EXPECTED_ARTIFACT_ENTRY_COUNT = 15;

/**
 * THE PRIVATE SET — working-method rule 20's second door.
 *
 * `.gitignore` and `.vscodeignore` are different doors. git ignoring `lab/`
 * stops `git add -A` and stops nothing at all from packaging it, because vsce
 * walks the WORKING TREE and never consults git. Measured on this repository
 * on 2026-08-28: `lab/` — the private method repository, carrying the identity
 * set and the only unredacted captures — was correctly gitignored and would
 * have gone straight into the VSIX.
 *
 * Both namings, deliberately. `vsce ls` reports on-disk paths; the zip reports
 * `extension/`-prefixed ones. A rule written for one naming and run against the
 * other matches nothing and reports a clean pass — the exact way the licence
 * rename already caught an audit here.
 *
 * The BARE names `docs` and `spike` are not a typo for the globs above them.
 * vsce enumerates a directory junction as a single FILE entry, so `docs/**`
 * matches nothing and the bare name is what denies it. Measured: with the bare
 * name removed, `vsce ls` lists `docs`, and `vsce package` then dies EISDIR
 * inside secret scanning. See `the junction door` below.
 */
const PRIVATE_SET: ReadonlyArray<{ readonly re: RegExp; readonly what: string }> = [
  { re: /(^|\/)lab\//i, what: 'lab/ — the private repository: the identity set and the only unredacted captures' },
  { re: /(^|\/)CLAUDE\.md$/i, what: 'CLAUDE.md — the working method' },
  { re: /(^|\/)PLAN[^/]*\.md$/i, what: 'PLAN.md and any PLAN_*.md under revision — the execution contract' },
  { re: /(^|\/)HANDOVER\.md$/i, what: 'HANDOVER.md — inter-session state' },
  { re: /(^|\/)AGENTS\.md$/i, what: 'AGENTS.md — agent guidance' },
  { re: /agent-deck-spec/i, what: 'the internal specification' },
  { re: /^docs\//i, what: 'docs/ — the private evidence tree, as vsce ls names it' },
  { re: /^spike\//i, what: 'spike/ — the frozen Phase 0 reference, as vsce ls names it' },
  { re: /^extension\/docs\//i, what: 'docs/ — the private evidence tree, as the artifact names it' },
  { re: /^extension\/spike\//i, what: 'spike/ — the frozen Phase 0 reference, as the artifact names it' },
  { re: /^(extension\/)?(docs|spike)$/i, what: 'a junction enumerated as a single FILE entry — the EISDIR door' },
];

/**
 * A listing that every `PRIVATE_SET` rule must reject, so the set cannot go
 * silently vacuous.
 *
 * Rule 5: when two designs differ only in whether a test can assert anything,
 * take the one that can. A regex list is exactly the thing that stops matching
 * after an innocuous edit — this repository has shipped a selector that stopped
 * matching, a rule shaped `docs/**` that matched nothing at the root, and an
 * allow-list missing an extension. Each entry here is paired with the rule it
 * exists to prove is alive.
 */
const PRIVATE_SET_WITNESSES: readonly string[] = [
  'lab/identity.local.json',
  'CLAUDE.md',
  'PLAN.md',
  'PLAN_v0.5.0.md',
  'HANDOVER.md',
  'AGENTS.md',
  'agent-deck-spec.md',
  'docs/evidence/scrub/SCRUB-2026-08-28.md',
  'spike/run.mjs',
  'extension/docs/evidence/privacy/report.json',
  'extension/spike/run.mjs',
  'docs',
  'spike',
  'extension/docs',
];

/**
 * The sweep's identity class, run over the ARTIFACT'S ENTRY NAMES.
 *
 * `scripts/privacy-sweep.mjs` scans file CONTENT for the 45-token private list;
 * nothing scanned the file NAMES a package would ship under. The scrub of
 * 2026-08-28 found identity in five slug DIRECTORY names as well as in blobs,
 * so a path is its own leak — `lab/fixtures-raw/cc-2.1.234/projects/<real
 * slug>/...` was enumerated as packaged content by `vsce ls` during that very
 * session.
 *
 * SAME CONTRACT AS THE SWEEP, including the part that matters most: the token
 * file lives in `lab/`, which a contributor clone does not have, so its absence
 * is a REPORTED SKIP and not a silent zero (working-method rule 18, and
 * reserved decision 11 turns on exactly this distinction). This test file
 * contains no identity token; it reads them or it says it did not.
 */
type IdentityClass =
  | { readonly status: 'RUN'; readonly tokens: readonly RegExp[] }
  | { readonly status: 'SKIPPED'; readonly reason: string };

function loadIdentityClass(): IdentityClass {
  const file = join(REPO_ROOT, 'lab', 'identity.local.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { status: 'SKIPPED', reason: 'no lab/identity.local.json — contributor clone' };
  }
  // Malformed is NOT absent. Absent is a supported state with a reported
  // verdict; malformed is a broken control, and it throws here rather than
  // degrading into a skip that reads the same in the output.
  const doc = JSON.parse(raw) as { version?: unknown; tokens?: unknown };
  if (doc.version !== 1) throw new Error(`lab/identity.local.json: version is not 1`);
  if (!Array.isArray(doc.tokens) || doc.tokens.length === 0) {
    throw new Error('lab/identity.local.json: no tokens');
  }
  const tokens = (doc.tokens as { match?: unknown; flags?: unknown }[]).map((t, i) => {
    if (typeof t.match !== 'string') throw new Error(`lab/identity.local.json: token ${i} is malformed`);
    const insensitive = String(t.flags ?? 'gi').includes('i');
    return new RegExp(t.match, insensitive ? 'i' : '');
  });
  return { status: 'RUN', tokens };
}

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

  it('ships exactly twelve files, counted rather than derived', () => {
    // Rule 19. The set assertion above is the real check; this is the one that
    // goes red when the set assertion is comparing two things that are both
    // empty, both filtered, or both named in a way vsce stopped using.
    expect(EXPECTED_PACKAGED_FILES).toHaveLength(EXPECTED_PACKAGED_FILE_COUNT);
    expect(vsceLs()).toHaveLength(EXPECTED_PACKAGED_FILE_COUNT);
  });

  it('carries nothing from the private set, and every private-set rule still matches something', () => {
    // Rule 20's guard on the second door. `lab/` and the five root documents
    // are gitignored AND denied here; git's door and vsce's door are different
    // doors and only this one governs what a user installs.
    const violations = vsceLs().flatMap((file) => {
      const hit = PRIVATE_SET.find((rule) => rule.re.test(file));
      return hit ? [`${file} — ${hit.what}`] : [];
    });
    expect(violations).toEqual([]);

    // Non-vacuity: every rule above must reject at least one witness. A rule
    // that has quietly stopped matching anything reads identically to a rule
    // that is doing its job, which is how a `docs/**`-shaped rule survived a
    // stray file at the root.
    const dead = PRIVATE_SET.filter((rule) => !PRIVATE_SET_WITNESSES.some((w) => rule.re.test(w)));
    expect(
      dead.map((rule) => rule.what),
      'these private-set rules match none of their own witnesses and are guarding nothing',
    ).toEqual([]);
    // ...and symmetrically, every witness must be caught by something, so a
    // deleted rule cannot leave a shape uncovered while the list still looks full.
    const uncaught = PRIVATE_SET_WITNESSES.filter((w) => !PRIVATE_SET.some((rule) => rule.re.test(w)));
    expect(uncaught, 'these private paths would ship: no private-set rule matches them').toEqual([]);
  });

  it('names nobody in any packaged path, or reports that it could not look', () => {
    // The sweep's identity class, applied to the entry NAMES. The scrub found
    // identity in five slug directory names as well as in file content, so a
    // path is its own leak.
    const identity = loadIdentityClass();
    if (identity.status === 'SKIPPED') {
      // A reported skip, not a silent zero (rule 18). This is the CONTRIBUTOR's
      // run and it stays green: the token file is in `lab/`, which a public
      // clone does not have. The test still asserts the part that needs no
      // tokens — see below — so it is not a no-op either.
      expect(identity.reason).toContain('lab/identity.local.json');
    } else {
      const hits = vsceLs().filter((file) => identity.tokens.some((re) => re.test(file)));
      expect(hits, 'a packaged path name matches the private identity list').toEqual([]);
      expect(identity.tokens.length, 'the identity list is empty, so it looked for nothing').toBeGreaterThan(0);
    }
    // True on every clone, tokens or not: no packaged path may be absolute, and
    // no packaged path may climb out of the package.
    const shapes = vsceLs().filter((file) => /^[A-Za-z]:/.test(file) || file.startsWith('/') || file.includes('..'));
    expect(shapes, 'a packaged path is absolute or escapes the package root').toEqual([]);
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
          /** Every entry, as the ZIP names it. Rule 19's second naming. */
          const entries: string[] = [];
          for (const file of shipped) {
            const relative = file.slice(extracted.length + 1).split('\\').join('/');
            entries.push(relative);
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

          // Rule 19, on the naming only the unzipped artifact knows. This is
          // the assertion `vsce ls` structurally cannot make: it reports what
          // is on disk, and vsce renames three files and invents two more on
          // the way into the zip.
          expect([...entries].sort()).toEqual([...EXPECTED_ARTIFACT_ENTRIES].sort());
          expect(entries).toHaveLength(EXPECTED_ARTIFACT_ENTRY_COUNT);

          // Rule 20, on the same naming. `^extension/docs/` and
          // `^extension/spike/` only ever mean anything here.
          const privateInArtifact = entries.flatMap((entry) => {
            const rule = PRIVATE_SET.find((r) => r.re.test(entry));
            return rule ? [`${entry} — ${rule.what}`] : [];
          });
          expect(privateInArtifact).toEqual([]);

          // ...and the identity class over the artifact's own entry names.
          const identityClass = loadIdentityClass();
          if (identityClass.status === 'RUN') {
            const named = entries.filter((entry) => identityClass.tokens.some((re) => re.test(entry)));
            expect(named, 'an artifact entry name matches the private identity list').toEqual([]);
          }

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

/* ------------------------------------------------------------------------- *
 * THE SECOND DOOR (working-method rule 20)
 *
 * Everything above audits THIS working tree, which is the maintainer's: `lab/`
 * happens to be gitignored here, the junctions happen to exist here, and the
 * `.vscodeignore` happens to be right here. None of that is a test — it is the
 * state the tests are read in, and it is exactly the state that makes a guard
 * look alive while proving nothing.
 *
 * So these suites stage a SYNTHETIC package root in a temp directory, copy this
 * repository's real `.vscodeignore` into it verbatim as the artifact under
 * test, plant the private set inside it, and ask vsce what would ship. A
 * contributor clone with no `lab/` at all still exercises the guard, because
 * the guard's input is planted rather than found.
 *
 * They never run in `REPO_ROOT` and never touch `dist/`, so they do not race
 * the shared-build hazard the header describes.
 * ------------------------------------------------------------------------- */

/** Planted content. Distinctive enough to grep for, and it is not identity. */
const SENTINEL = 'AGENT-DECK-PRIVATE-SENTINEL';

/**
 * The minimum `.vscodeignore` that still yields a listing to compare against:
 * `dist/` denied wholesale with the three shipped artifacts re-admitted, and
 * nothing else denied at all. The CONTROL ignore file — under it, every planted
 * private path must appear, which is what proves the plant is real and that the
 * real ignore file is what removes them.
 */
const CONTROL_IGNORE = [
  'dist/**',
  '!dist/extension.cjs',
  '!dist/webview/main.js',
  '!dist/webview/main.css',
  '',
].join('\n');

/**
 * Stage a package root vsce will accept: the real manifest with `scripts`
 * stripped, the real `.vscodeignore`, and stubs for everything that ignore file
 * re-admits.
 *
 * `scripts` is stripped because `vsce package` runs `vscode:prepublish`, and in
 * a temp directory with no `node_modules` that fails for a reason this suite is
 * not about — a red that says "esbuild is missing" where the question was "what
 * would ship".
 */
function stagePackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-guard-'));
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  delete manifest['scripts'];
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2));
  copyFileSync(join(REPO_ROOT, '.vscodeignore'), join(root, '.vscodeignore'));
  writeFileSync(join(root, 'README.md'), 'stub\n');
  copyFileSync(join(REPO_ROOT, 'LICENSE'), join(root, 'LICENSE'));
  writeFileSync(join(root, 'CHANGELOG.md'), 'stub\n');
  writeFileSync(join(root, 'SECURITY.md'), 'stub\n');
  mkdirSync(join(root, 'dist', 'webview'), { recursive: true });
  writeFileSync(join(root, 'dist', 'extension.cjs'), '//stub\n');
  writeFileSync(join(root, 'dist', 'webview', 'main.js'), '//stub\n');
  writeFileSync(join(root, 'dist', 'webview', 'main.css'), '/*stub*/\n');
  mkdirSync(join(root, 'media'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'media', 'icon.png'), join(root, 'media', 'icon.png'));
  return root;
}

/** The paths a planted root carries, as `vsce ls` would name them. */
const PLANTED: readonly string[] = [
  'lab/identity.local.json',
  'CLAUDE.md',
  'PLAN.md',
  'HANDOVER.md',
  'AGENTS.md',
  'agent-deck-spec.md',
  'docs/evidence/secret.md',
  // A plain FILE named `spike`. That is the shape vsce reports a directory
  // JUNCTION as, and it is why the bare names exist beside the globs.
  'spike',
];

function plantPrivateSet(root: string): void {
  mkdirSync(join(root, 'lab'), { recursive: true });
  mkdirSync(join(root, 'docs', 'evidence'), { recursive: true });
  for (const rel of PLANTED) writeFileSync(join(root, ...rel.split('/')), `${SENTINEL}\n`);
}

function vsceLsIn(root: string): readonly string[] {
  const stdout = execFileSync(process.execPath, [VSCE_BIN, 'ls', '--no-dependencies'], {
    cwd: root,
    encoding: 'utf8',
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\\').join('/'));
}

describe('the second door: a planted private set', () => {
  it(
    'is listed by vsce when nothing denies it — the control that proves the plant is real',
    () => {
      const root = stagePackageRoot();
      try {
        plantPrivateSet(root);
        writeFileSync(join(root, '.vscodeignore'), CONTROL_IGNORE);
        const files = vsceLsIn(root);
        // Every planted path, present. If this goes red the staging is broken
        // and the assertion below it means nothing — which is the only way a
        // guard like this ever fails: by guarding an empty room.
        const missing = PLANTED.filter((rel) => !files.includes(rel));
        expect(missing, 'the plant did not take: vsce would not have shipped these anyway').toEqual(
          [],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    'ships none of it under this repository\u2019s real .vscodeignore',
    () => {
      const root = stagePackageRoot();
      try {
        plantPrivateSet(root);
        const files = vsceLsIn(root);
        // Not one of the eight.
        const shipped = PLANTED.filter((rel) => files.includes(rel));
        expect(shipped, 'the private set would be packaged').toEqual([]);
        // ...and nothing shaped like it either, which catches a path the plant
        // did not think of.
        const violations = files.flatMap((file) => {
          const rule = PRIVATE_SET.find((r) => r.re.test(file));
          return rule ? [`${file} — ${rule.what}`] : [];
        });
        expect(violations).toEqual([]);
        // The listing is a real listing. `[]` satisfies every assertion above.
        expect(files).toContain('package.json');
        expect(files).toContain('README.md');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

/**
 * THE JUNCTION DOOR, and why it needed its own suite.
 *
 * `docs/` and `spike/` in the maintainer's checkout are directory JUNCTIONS
 * into the private `lab/` repository. vsce enumerates a junction as a single
 * FILE entry, so `docs/**` and `spike/**` — correct-looking rules that read as
 * complete — match nothing at all, and the junction is packaged as content.
 * Secret scanning then reads that entry and takes EISDIR.
 *
 * Measured on 2026-08-28, both halves, and this suite is written against the
 * measurements rather than against the expectation:
 *
 *   without the bare name   vsce ls lists `docs`
 *                           vsce package -> exit 1, EISDIR, NO .vsix written
 *   with the bare name      vsce ls omits it, vsce package exits 0
 *
 * The no-partial-artifact half matters as much as the failure: the run that hit
 * this in the field looked like a success, because a STALE `dist/agent-deck.vsix`
 * from an earlier run was sitting on disk.
 *
 * Windows-only, and the skip is REPORTED rather than silent (rule 18): a
 * junction is a `cmd` builtin and has no portable equivalent.
 */
describe.skipIf(process.platform !== 'win32')(
  'the junction door (win32 only: mklink /J has no portable equivalent)',
  () => {
    /** Stage a root whose `docs` is a junction into a directory it owns. */
    const stageWithJunction = (): string => {
      const root = stagePackageRoot();
      mkdirSync(join(root, 'junction-target'), { recursive: true });
      writeFileSync(join(root, 'junction-target', 'secret.md'), `${SENTINEL}\n`);
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', join(root, 'docs'), join(root, 'junction-target')], {
        encoding: 'utf8',
      });
      return root;
    };

    it(
      'is closed by the bare name, and the glob alone would not close it',
      () => {
        const root = stageWithJunction();
        try {
          // The real ignore file, which carries `docs/**` AND a bare `docs`.
          expect(vsceLsIn(root)).not.toContain('docs');

          // The pre-fix state, reconstructed from scratch rather than by
          // editing the real file: the glob present, the bare name absent. If
          // the glob were sufficient this listing would omit `docs` too, and
          // the bare names in `.vscodeignore` would be dead weight somebody
          // would eventually delete.
          writeFileSync(join(root, '.vscodeignore'), `${CONTROL_IGNORE}docs/**\n`);
          expect(
            vsceLsIn(root),
            'the `docs/**` glob matched the junction, so the bare name is no longer load-bearing — re-measure before deleting it',
          ).toContain('docs');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      120_000,
    );

    it(
      'fails packaging loudly and writes no partial VSIX when it is left open',
      () => {
        const root = stageWithJunction();
        try {
          writeFileSync(join(root, '.vscodeignore'), `${CONTROL_IGNORE}docs/**\n`);
          const out = join(root, 'should-not-exist.vsix');
          let exitCode: number | null = null;
          let output = '';
          try {
            execFileSync(
              process.execPath,
              [VSCE_BIN, 'package', '--no-dependencies', '--out', out],
              { cwd: root, encoding: 'utf8', stdio: 'pipe' },
            );
            exitCode = 0;
          } catch (error) {
            const err = error as { status?: number; stdout?: string; stderr?: string };
            exitCode = err.status ?? -1;
            output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
          }
          // LOUD: a non-zero exit naming the syscall.
          expect(exitCode, 'packaging succeeded over a junction — re-measure this whole suite').not.toBe(0);
          expect(output).toContain('EISDIR');
          // ...and NO artifact. The field failure read as a success because a
          // stale .vsix from an earlier run was still on disk; a partial or
          // empty file here would do the same to the next person.
          expect(existsSync(out), 'a .vsix was written by a run that failed').toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      240_000,
    );
  },
);
