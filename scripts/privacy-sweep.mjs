// NO SHEBANG HERE, and it must not come back. Removing it is not tidying.
//
// This script is only ever run as `node scripts/privacy-sweep.mjs`. There is
// no `bin` entry in package.json, no other script in this directory carries
// one, and an exec bit means nothing on this project's only platform - so a
// shebang buys exactly nothing and costs the suite.
//
// Vite strips a shebang with `hashbangRE = /^#!.*\n/`
// (node_modules/vite/dist/node/chunks/config.js, used by `ssrTransform` as
// `hashbangRE.exec(code)?.[0].length ?? 0`). In JavaScript `.` does not match
// \r. With `* text=auto` in .gitattributes and core.autocrlf=true on the dev
// machine this file checks out CRLF, the regex misses, the shebang survives
// into a function-wrapped module and `src/release/privacy.test.ts` dies at
// import with "SyntaxError: Invalid or unexpected token" - which vitest
// summarises as "24 skipped", i.e. as something that looks like a pass.
//
// Measured, one identical commit, two working trees: LF copy 24/24 green,
// CRLF checkout 0 tests collected. src/release/privacy.test.ts guards this.
/**
 * Privacy sweep - Phase 5 DoD1 gate evidence.
 *
 * READ-ONLY except for the report file named by `--json`. No network, no
 * dependencies outside `node:` builtins. It never mutates the repository, and
 * it never prints a matched secret value.
 *
 * WHAT IT SWEEPS
 * --------------
 * Two corpora:
 *   1. the working tree - every TRACKED file (`git ls-files -z`), so ignored
 *      build artifacts and `node_modules` are out of scope by construction.
 *      `--untracked` adds the unstaged files under `fixtures/`, which is where
 *      the "clean PASS over an absent corpus" failure actually happens;
 *   2. full history - every blob reachable from every ref
 *      (`git rev-list --all --objects` + `git cat-file --batch`).
 *
 * Both are scanned as BYTES in Node, decoded `latin1` so one byte is one
 * character. That is deliberate: a tracked test file (`src/parser/parse.test.ts`)
 * contains real NUL bytes, and GNU grep without `-a` silently abandons such a
 * stream and returns a clean-looking, meaningless result. Scanning buffers
 * sidesteps grep's binary heuristic entirely. `latin1` is safe for the ASCII
 * needles used here because UTF-8 continuation bytes always have the high bit
 * set and can never collide with an ASCII pattern.
 *
 * WHAT "PASS" MEANS - read this before "fixing" a number
 * -----------------------------------------------------
 * THE SCOPE CHANGED ON 2026-08-28 AND THE OLD TEXT IS GONE, not softened. It
 * used to say: the `-> 0` applies to FOREIGN content and to SECRETS and NOT to
 * this developer's own absolute paths, which are in the capture corpora
 * deliberately, inventoried under written allow rules rather than driven to
 * zero. That was true for as long as the corpora carried real paths.
 *
 * They do not any more. The public-exposure scrub rewrote every captured path,
 * slug, folder name and identifier to synthetic equivalents through the
 * redaction tool, and the identity set is now a HARD-FAIL class with no allow
 * rule and no advisory tier. What made the old policy defensible was that a
 * fixture without `cwd` cannot pin the main-thread hook rule; what makes the
 * new one possible is that a fixture with a CONSISTENT SYNTHETIC `cwd` pins it
 * just as well. A join key has to be consistent, not real.
 *
 * BUCKETS
 * -------
 *   IDENTITY    a match against the private token list, anywhere, outside that
 *               list's own `exemptPaths` (the licence and the manifest, where
 *               the author's name is the correct content). Gate: must be empty.
 *               Reported as path:line plus the token's NOTE - never the matched
 *               text, because this report is committed.
 *               SKIPPED, and said so in the verdict line, when the token file
 *               is absent. That is the contributor's run and it stays green.
 *   SECRET      credential-shaped match anywhere. Gate: must be empty.
 *               Locations are printed; values never are.
 *   FOREIGN     inside the REAL-CAPTURE corpora, a `cwd` / `transcript_path` /
 *               `agent_transcript_path` / project-slug value naming a project
 *               other than agent-deck. Gate: must be empty. This is the
 *               assertion that protects other people's work.
 *
 * EXIT CODE: 0 when IDENTITY, SECRET and FOREIGN are all empty; 1 otherwise.
 *
 * USAGE
 *   node scripts/privacy-sweep.mjs [--json <path>] [--root <dir>] [--untracked]
 *                                  [--no-history] [--quiet] [--stamp <iso>]
 *                                  [--identity <path>]
 *
 *   --identity <p> read the token list from <p> instead of lab/identity.local.json.
 *                  The negative control in src/release/privacy.test.ts points it
 *                  at a throwaway file of INVENTED tokens, so the test can prove
 *                  the class fails without naming anybody.
 *
 *   --root <dir>   sweep a different tree (the test's negative controls point
 *                  it at a scratch directory). A non-git root is enumerated by
 *                  directory walk and its history leg is skipped.
 *   --untracked    ALSO read files under fixtures/ that `git ls-files` does not
 *                  list, .gitignore included. Without it a capture copied in
 *                  but never staged is invisible and the run prints a clean
 *                  PASS over a corpus it never opened - measured, see
 *                  UNTRACKED_SCAN_DIRS.
 *   --no-history   working-tree leg only. Also settable with
 *                  AGENT_DECK_SWEEP_HISTORY=0.
 *   --stamp <iso>  fix `generatedAt` instead of stamping `Date.now()`.
 *
 * DETERMINISM: same tree, same report, except for `generatedAt` and
 * `timingsMs`. Those are the only two nondeterministic keys.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * The identity class
 *
 * THIS FILE CONTAINS NO IDENTITY TOKEN, and that is the whole design.
 *
 * Through Phase 6 the needles lived here, assembled from fragments so the
 * script would not trip its own detector. Fragmenting hides a string from
 * `grep`; it does not remove it, and the scrub of 2026-08-28 is measured by a
 * `grep` from a clean clone returning ZERO. A detector that has to know the
 * secret cannot ship beside the thing it protects.
 *
 * Hashing the tokens was considered and REJECTED by the user, for a good
 * reason: a given name and a folder name are dictionary-guessable, so a public
 * list of salted hashes is an invitation rather than a control.
 *
 * So the tokens live in ONE file, in a separate PRIVATE repository, and this
 * script reads it if it is there:
 *
 *   PRESENT  -> the identity class RUNS. Any match outside the file's own
 *               `exemptPaths` is a hard failure. There is no allow rule, no
 *               inventory, and no advisory tier: a hit fails the gate.
 *   ABSENT   -> the identity class is SKIPPED, the verdict line SAYS SO, and
 *               the exit code is unaffected by the skip itself. That is the
 *               contributor's experience and it must stay green.
 *
 * Findings print `path:line` and the token's `note`. They NEVER print the
 * matched text: a report that quotes what it found is a copy of the thing it
 * is there to keep out of the repository, and this report is committed.
 * ------------------------------------------------------------------ */

/** Where the private checkout is expected, relative to the repository root. */
const IDENTITY_FILE = 'lab/identity.local.json';

/**
 * Load the identity tokens, or return a SKIPPED marker.
 *
 * A malformed or unreadable file is NOT silently treated as absent: absent is
 * a supported state with a reported verdict, malformed is a broken control and
 * says so. Working-method rule 18 - the fail-open class this repository has
 * already hit twice is a check that quietly does less than it claims.
 */
function loadIdentity(root, override = null) {
  const file = override ?? path.join(root, IDENTITY_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'SKIPPED', reason: `no ${IDENTITY_FILE}`, tokens: [], exemptPaths: [] };
  }
  const doc = JSON.parse(raw);
  if (doc.version !== 1) {
    throw new Error(`${IDENTITY_FILE}: version ${String(doc.version)} is not 1`);
  }
  if (!Array.isArray(doc.tokens) || doc.tokens.length === 0) {
    throw new Error(`${IDENTITY_FILE}: no tokens`);
  }
  const tokens = doc.tokens.map((t, i) => {
    if (typeof t.match !== 'string' || typeof t.note !== 'string' || t.note === '') {
      throw new Error(`${IDENTITY_FILE}: token ${String(i)} is malformed`);
    }
    // `g` is forced on; the file's flags say only whether the token is
    // case-sensitive. Exactly one is - see that token's note.
    const insensitive = (t.flags ?? 'gi').includes('i');
    return { re: new RegExp(t.match, insensitive ? 'gi' : 'g'), note: t.note };
  });
  return {
    status: 'RUN',
    reason: null,
    file,
    tokens,
    exemptPaths: Array.isArray(doc.exemptPaths) ? doc.exemptPaths : [],
  };
}

/** The project this repository is allowed to have captured data from. */
const OWN_PROJECT = 'agent-deck';

/**
 * FOREIGN-scan corpora - where a `cwd` / `transcript_path` / project-slug value
 * is checked against `OWN_PROJECT`.
 *
 * WHAT THIS IS AND WHAT IT IS NOT (Phase 6, carry-out 1)
 * ------------------------------------------------------
 * Through Phase 5 this was an eight-entry list of the REAL-CAPTURE directories,
 * and `inCaptureCorpus()` gated the whole FOREIGN scan on it - so a tracked file
 * anywhere else was never scanned for foreign content at all. Measured by the
 * Phase 5 verifier: byte-identical foreign content planted at
 * `src/model/leak.test.ts` and `docs/notes.md` produced ZERO gate hits while the
 * same bytes under `fixtures/hook-events/` produced 3. This repository's own
 * Phase 1 privacy leak lived largely in DOCUMENTS - exactly the class that was
 * outside the gate.
 *
 * It is now every tracked top-level directory, plus the root files. It is still
 * an INCLUSION LIST: a top-level directory that nobody adds here is still a
 * hole. That is a recorded, accepted carry-out (the user chose extension over
 * inversion at the Phase 5 gate), and the mitigation is a completeness guard in
 * `src/release/privacy.test.ts` which derives the tracked top-level set from
 * `git ls-files` and goes RED when this list stops covering it.
 *
 * Widening it means the scan now also reads the SYNTHETIC corpora, whose
 * invented roots are not captures. Those are exempted by value, with written
 * reasons, in `FOREIGN_VALUE_EXEMPTIONS` below - by value rather than by path,
 * so an exemption cannot silently blind a whole directory the way a path-shaped
 * one would.
 */
const CAPTURE_CORPORA = [
  // No '.claude/' entry: the directory was untracked before the public flip, so
  // it is out of the swept corpus by construction. The completeness guard in
  // src/release/privacy.test.ts asserts both directions - every tracked
  // top-level directory is covered, AND no enumerated prefix matches nothing -
  // and the second half is what caught this the moment the directory left.
  '.github/',
  // Editor launch configuration. Became tracked in Phase 2, because answering
  // the OpenCode kill gate needed an Extension Development Host and this repo
  // had no way to start one -- there was no .vscode/ at all. The completeness
  // guard in src/release/privacy.test.ts failed on the very next full run,
  // which is the third time it has caught a newly tracked top-level directory
  // (see 'media/' below) and the reason it exists.
  '.vscode/',
  // `docs/` and `spike/` LEFT this repository on 2026-08-28 - they are in the
  // maintainer's private repository now, and `.gitignore` anchors them so a
  // junction presenting them back at these paths cannot re-track them. They
  // are not listed here because the completeness guard in
  // `src/release/privacy.test.ts` asserts BOTH directions, and an enumerated
  // prefix matching no tracked file is the half that catches a stale entry.
  'fixtures/',
  // Marketplace assets. Added when the icon and screenshots became tracked for
  // the 0.1.0 listing; the completeness guard in src/release/privacy.test.ts
  // caught the omission on the next run, which is what it is for.
  'media/',
  'scripts/',
  'src/',
  'test/',
  'webview/',
];

/**
 * Root-level tracked files (`README.md`, `package.json`, `CLAUDE.md`, ...)
 * belong to no directory, and a prefix list cannot reach them - `''` as a
 * prefix matches everything, which would be an accident waiting to happen. They
 * are admitted by this flag instead, and the completeness guard asserts it is
 * on. The stray-file-at-the-repo-root class has already cost this repo one
 * shipped 38 KB mockup through a `docs/**`-shaped rule; the root is not a place
 * to leave unswept.
 */
const CAPTURE_ROOT_FILES = true;

/* ------------------------------------------------------------------ *
 * Secret shapes
 * ------------------------------------------------------------------ */

const SECRET_RULES = [
  { id: 'anthropic-api-key', re: new RegExp('sk' + '-ant-' + '[A-Za-z0-9_\\-]{8,}', 'g') },
  { id: 'github-token', re: new RegExp('gh' + '[pousr]_' + '[A-Za-z0-9]{16,}', 'g') },
  { id: 'github-pat', re: new RegExp('github' + '_pat_' + '[A-Za-z0-9_]{16,}', 'g') },
  { id: 'aws-access-key-id', re: new RegExp('AK' + 'IA' + '[0-9A-Z]{16}', 'g') },
  {
    id: 'private-key-block',
    re: new RegExp('-----BE' + 'GIN [A-Z ]*PRIVATE KEY-----', 'g'),
  },
  {
    id: 'authorization-bearer',
    re: new RegExp('[Aa]uthorization["\']?\\s*[:=]\\s*["\']?\\s*[Bb]earer\\s+[A-Za-z0-9._\\-]{12,}', 'g'),
  },
];

/** Generic high-entropy assignment to a credential-shaped key name. */
const GENERIC_SECRET_RE = new RegExp(
  '(?:^|[^A-Za-z0-9_])' +
    '(' +
    ['token', 'secret', 'password', 'passwd', 'api_key', 'apikey', 'access_key', 'client_secret'].join(
      '|',
    ) +
    ')' +
    '["\']?\\s*[:=]\\s*["\']([A-Za-z0-9+/_\\-]{24,})["\']',
  'gi',
);

/** Shannon entropy in bits per character. */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const GENERIC_SECRET_MIN_ENTROPY = 3.5;

/* ------------------------------------------------------------------ *
 * Foreign-content shapes
 * ------------------------------------------------------------------ */

const PROJECT_VALUE_RE = new RegExp(
  '"(cwd|transcript_path|agent_transcript_path|projectSlug|project_slug|slug)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"',
  'g',
);

/** `.claude/projects/<slug>` in any slash flavour, including JSON-escaped ones. */
const SLUG_PATH_RE = new RegExp(
  '\\.claude(?:[\\\\/]|\\\\{2,4})projects(?:[\\\\/]|\\\\{2,4})([A-Za-z0-9_.\\-]+)',
  'g',
);

/**
 * A CC project slug is the cwd with every separator replaced by `-`, so it
 * always starts with `<drive>--` on Windows or `-` on posix. Requiring that
 * shape is not cosmetic. Without it the prose `~/.claude/projects\ndirectory`
 * inside a committed transcript parses as a project named `ndirectory` and the
 * FOREIGN counter reports a leak that is really a JSON newline escape -
 * measured, it was the first run's only working-tree FOREIGN hit besides the
 * synthetic one below.
 */
const SLUG_SHAPE_RE = /^(?:[A-Za-z]--|-)/;

/**
 * Values that declare themselves synthetic are generated, not captured, and so
 * cannot be foreign content. `C:\SYNTHETIC` and `C--SYNTHETIC-PERF-not-a-harvest`
 * come from `fixtures/synthetic-perf/build-corpus.mjs`, which named them that
 * way precisely so nobody would mistake them for a harvest.
 */
const SYNTHETIC_MARKERS = ['synthetic', 'not-a-harvest'];

function isSyntheticValue(value) {
  const norm = normalisePathToken(value);
  return SYNTHETIC_MARKERS.some((m) => norm.includes(m));
}

/**
 * A captured `cwd` / `transcript_path` is ALWAYS absolute: a drive letter, a
 * separator, or `~`. Requiring that shape is the same measured lesson as
 * `SLUG_SHAPE_RE` above, one layer out.
 */
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/;

/**
 * A value that is nothing but dots, an ellipsis and whitespace is an ELISION in
 * prose, not a location: documentation and code comments elide a path rather
 * than name one. Two real hits, both surfaced by narrowing the exemption below
 * - a JSON illustration in docs/opencode-contract.md, and a comment in THIS
 * FILE. The second is the recorded "a sweep script that trips its own detector"
 * hazard arriving by a new route, and the lesson generalises: do NOT write an
 * example of a scanned key next to its value anywhere in this file. Describe
 * the shape in words instead. Every comment here obeys that.
 *
 * THE ELLIPSIS IS MATCHED AS BYTES. This scanner decodes `latin1` on purpose
 * (see the header), so U+2026 arrives as its three UTF-8 bytes rather than as
 * one character, and a class written with the code point matches nothing. That
 * is measured: the first version of this rule left the doc hit standing.
 */
const UTF8_ELLIPSIS_LATIN1 = 'â¦';
const ELISION_RE = /^[.…\s]*$/;

function isElision(value) {
  return ELISION_RE.test(value.split(UTF8_ELLIPSIS_LATIN1).join(''));
}

/** The invented project name the negative controls plant. Not a real project. */
const PLANTED_CONTROL_PROJECT = 'totally-' + 'different-project';

/**
 * Does this captured value look like REGEX SOURCE rather than data?
 *
 * WHY THIS EXISTS (Phase 0, Wave 0 - the Phase 6 DoD-1 residue).
 * `not-an-absolute-location` below used to exempt any captured value that was
 * not an absolute path. Its written justification was sound - 29 of 32 raw hits
 * were one source literal, `/"cwd":"((?:[^"\\]|\\.)*)"/`, appearing in seven
 * files that PARSE a hook payload, so the scanner captured the regex body and
 * not a path - but the RULE was far wider than the justification. "Not absolute"
 * also covers a genuine relative location, and `../some-other-project/x.jsonl`
 * names another project just as plainly as `C:\...\some-other-project` does.
 * The exemption written to discard regex bodies was silently discarding a whole
 * shape of real foreign content.
 *
 * So the exemption now needs BOTH: not an absolute path, AND positively
 * regex-shaped. The needles below are regex syntax that cannot appear in a
 * filesystem path on either platform - a non-capturing or lookaround group, a
 * character class, a shorthand class, a quantifier applied to a group, or an
 * escaped metacharacter. A path may contain `(`, `)`, `[`, `]`, `.` and `*`
 * individually; it cannot contain `(?:`, `[^`, `\\d`, `)*` or `\\.`.
 *
 * The five-shape parity control in `src/release/privacy.test.ts` is what keeps
 * this honest: four location shapes (Windows-absolute, POSIX-absolute,
 * `~`-rooted, and RELATIVE) must all be flagged, and only the regex source must
 * be exempt. Before this change the relative shape passed silently.
 */
const REGEX_SOURCE_NEEDLES = [
  '(?:', // non-capturing group
  '(?=', // lookahead
  '(?!', // negative lookahead
  '(?<', // lookbehind or named group
  '[^', // negated character class
  ')*', // quantifier on a group
  ')+',
  ')?',
  '\\d',
  '\\w',
  '\\s',
  '\\S',
  '\\.',
  '.*',
  '.+',
];

function looksLikeRegexSource(value) {
  return REGEX_SOURCE_NEEDLES.some((needle) => value.includes(needle));
}

/* ------------------------------------------------------------------ *
 * Codex shapes (v0.6.0 Phase 1)
 *
 * The Codex corpus is the third observation engine's capture, and it produces
 * exactly two captured-value shapes that name no project of ours. Both are
 * exempted BY VALUE below, and both are pinned SEGMENT BY SEGMENT rather than
 * by directory.
 *
 * That is not stylistic. The recorded failure here is a whole-directory ALLOW
 * PREFIX: it forgives every value under a path, so a genuinely foreign token
 * arriving inside that directory can never gate, and nobody finds out. These
 * two patterns leave exactly one free segment between them - the home
 * directory's user component - and a user name is not a project name. Every
 * other segment is a literal, a date, or a UUID, so there is nowhere for a
 * project name to hide, and any Codex fixture value that is NOT one of these
 * two shapes still gates.
 *
 * Fail-closed on purpose: a future harvest under a different scratch repo or a
 * relocated CODEX_HOME stops matching and the sweep goes red, which is the
 * direction that asks for a written reason instead of assuming one.
 * ------------------------------------------------------------------ */

/**
 * A home directory in any spelling this repository has measured, matched
 * against a value that `normalisePathToken` has already lowercased and
 * forward-slashed: a drive-letter path, an MSYS `/<drive>/` path, a WSL
 * `/mnt/<drive>/` path, or a posix `/home/`. `file:` URL forms occur too - the
 * Codex hook tap reports one run's cwd that way - so the scheme is optional at
 * the front.
 */
const HOME_DIR_PREFIX_SRC = '(?:file:/{0,3})?(?:/mnt/[a-z]|/[a-z]|[a-z]:)?/(?:users|home)/[^/]+';

/**
 * The scratch repository the Codex probe captures against.
 *
 * `scripts/capture-codex.mjs` REFUSES a corpus whose transcripts have any other
 * cwd (its G8 check), so every captured cwd in a Codex corpus is this one
 * location by construction. It is deliberately not `agent-deck`: observing the
 * repository that holds the observer would make the workspace-discovery rule
 * untestable. The name is pinned as a literal because the capture script takes
 * the scratch root as an argument - a corpus harvested somewhere else is a new
 * decision and should have to be written down here.
 */
const CODEX_SCRATCH_RE = new RegExp(`^${HOME_DIR_PREFIX_SRC}/codex-probe/scratch(?:/|$)`);

/**
 * A Codex rollout transcript path.
 *
 * Codex files a session under CODEX_HOME by CAPTURE DATE - year, month, day,
 * then `rollout-<timestamp>-<uuid>.jsonl`. There is no project component
 * anywhere in it, which is the opposite of Claude Code, whose transcript path
 * carries the project slug. So this shape cannot name a project at all, foreign
 * or otherwise, and every segment below is pinned to prove that claim rather
 * than assert it.
 */
const CODEX_ROLLOUT_RE = new RegExp(
  `^${HOME_DIR_PREFIX_SRC}` +
    '/\\.codex/sessions/\\d{4}/\\d{2}/\\d{2}/' +
    'rollout-\\d{4}-\\d{2}-\\d{2}t\\d{2}-\\d{2}-\\d{2}-' +
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jsonl$',
);

/**
 * FOREIGN exemptions, by VALUE - each with a written reason that says what was
 * measured.
 *
 * By value and not by path, deliberately: a path-shaped exemption blinds a
 * whole directory, which is the defect this phase is closing, not one to
 * reintroduce one level down. The single entry that IS path-scoped names one
 * exact file and one exact invented value.
 *
 * Baseline for every count below: widening `CAPTURE_CORPORA` to every tracked
 * top-level directory plus the root files, and adding NO exemption, produced
 * `foreign=32` (8 working tree + 24 history) on this repository at
 * b4f6c76. Every one of the 32 fell into the two shapes below; NONE was
 * content captured from another project.
 */
const FOREIGN_VALUE_EXEMPTIONS = [
  {
    id: 'elided-not-a-location',
    reason:
      'The captured value is an elision, not a path: only dots, an ellipsis and ' +
      'whitespace. Documentation and code comments elide a path rather than ' +
      'naming one. Two hits, both surfaced by narrowing ' +
      'regex-source-not-a-location in Phase 0 Wave 0 - a JSON illustration in ' +
      'docs/opencode-contract.md and a comment in this script. An elision ' +
      'cannot name a project, because it names nothing.',
    exempt: (value) => isElision(value),
  },
  {
    id: 'regex-source-not-a-location',
    reason:
      'The captured group is regex SOURCE, not a filesystem location. 29 of the ' +
      '32 raw hits (7 working tree, 22 history) were the identical source ' +
      'literal in seven files that parse a hook payload - scripts/capture-states.mjs, ' +
      'scripts/record-wire.mjs, src/perf/corpus.ts, webview/fixture-render.test.ts ' +
      'and three src/**/*.test.ts - each carrying a regex whose own text ' +
      'contains the key name, so the scanner captured the regex body. Renamed and ' +
      'NARROWED in Phase 0 Wave 0: it used to exempt anything that was merely not ' +
      'absolute, which also forgave a genuine RELATIVE location such as ' +
      '../another-project/x.jsonl - a whole shape of real foreign content, ' +
      'discarded by a rule written for something else. It now requires both: not ' +
      'an absolute path AND positively regex-shaped (see REGEX_SOURCE_NEEDLES). ' +
      'The five-shape parity control asserts the four location shapes are all ' +
      'flagged and only the regex source is exempt.',
    // Only the `"cwd": "..."` leg. A project SLUG is not an absolute path, and
    // that leg has its own shape gate (SLUG_SHAPE_RE).
    absolutePathValuesOnly: true,
    exempt: (value) => !ABSOLUTE_PATH_RE.test(value) && looksLikeRegexSource(value),
  },
  {
    id: 'declared-synthetic',
    reason:
      'Values that declare themselves synthetic are generated, not captured. ' +
      'C:\\SYNTHETIC and C--SYNTHETIC-PERF-not-a-harvest come from ' +
      'fixtures/synthetic-perf/build-corpus.mjs, which named them that way so ' +
      'nobody would mistake them for a harvest; webview/wire/synthetic-stress.json ' +
      'is the same generator\'s output. This rule predates the widening and is ' +
      'unchanged by it - 0 of the 32 raw hits needed it, because the identifier ' +
      'inventory reaches those files by another route.',
    exempt: (value) => isSyntheticValue(value),
  },
  {
    id: 'codex-probe-scratch-repo',
    reason:
      'The Codex corpus captures against a dedicated scratch repository, never ' +
      'against agent-deck: the workspace-discovery rule cannot be pinned by a ' +
      'fixture whose cwd is the observing repository itself, so the probe needs a ' +
      'separate subject. scripts/capture-codex.mjs enforces that - its G8 check ' +
      'refuses a corpus whose transcripts carry any other working directory - ' +
      'which is why every captured value of this shape in fixtures/codex-* is ' +
      'the same one location. Measured on fixtures/codex-0.151.0-alpha.7.2 ' +
      '(2026-09-03): 194 of the 314 raw FOREIGN hits the corpus produces are this value, 179 ' +
      'as a drive-letter path and 15 as a file: URL. It is NOT a directory ' +
      'prefix - the whole value is pinned segment by segment, home component ' +
      'aside, so a different project name under the same home still gates.',
    exempt: (value) => CODEX_SCRATCH_RE.test(normalisePathToken(value)),
  },
  {
    id: 'codex-rollout-transcript-path',
    reason:
      'A Codex rollout transcript is filed under CODEX_HOME by CAPTURE DATE - ' +
      'year, month, day, then rollout-<timestamp>-<uuid>.jsonl - and carries no ' +
      'project component anywhere. That is the opposite of Claude Code, whose ' +
      'transcript path spells the project slug, and it is why this shape cannot ' +
      'name a foreign project even in principle. The pattern pins every segment ' +
      'to a literal, a date field or a UUID field, leaving only the home ' +
      'directory user component free, so the claim is checked rather than ' +
      'asserted. Measured on fixtures/codex-0.151.0-alpha.7.2 (2026-09-03): the ' +
      'remaining 120 of the 314 raw FOREIGN hits the corpus produces, across the ' +
      'transcript_path and agent_transcript_path keys. A relocated CODEX_HOME ' +
      'stops matching and gates, which is the fail-closed direction.',
    exempt: (value) => CODEX_ROLLOUT_RE.test(normalisePathToken(value)),
  },
  {
    id: 'planted-negative-control',
    paths: ['src/release/privacy.test.ts'],
    reason:
      'The remaining 3 raw hits (1 working tree, 2 history) are the SOURCE of ' +
      'the negative controls: src/release/privacy.test.ts plants a cwd naming ' +
      'an invented project so that a sweep which cannot fail is not mistaken ' +
      'for a sweep that passed. The value exists nowhere else in the ' +
      'repository and no such project exists. Scoped to that one file and that ' +
      'one invented name - the planted COPIES, written into a scratch root ' +
      'under fixtures/, src/ and docs/, are not covered here and must still be ' +
      'flagged, which is what those controls assert.',
    exempt: (value) => normalisePathToken(value).includes(PLANTED_CONTROL_PROJECT),
  },
];

function foreignExemption(relPath, value, opts = {}) {
  for (const rule of FOREIGN_VALUE_EXEMPTIONS) {
    if (rule.absolutePathValuesOnly === true && opts.slug === true) continue;
    if (
      rule.paths !== undefined &&
      !rule.paths.some((p) => relPath === p || relPath.startsWith(p))
    ) {
      continue;
    }
    if (rule.exempt(value)) return rule;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function inCaptureCorpus(relPath) {
  if (CAPTURE_CORPORA.some((p) => relPath.startsWith(p))) return true;
  return CAPTURE_ROOT_FILES && !relPath.includes('/');
}

/** Byte offsets of every line start, so a hit index becomes a 1-based line. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function normalisePathToken(token) {
  return token.replace(/\\+/g, '/').toLowerCase();
}

/**
 * Anchors that make a token an actual filesystem path rather than prose that
 * happens to contain a slash. Without this check, a sentence naming two folder
 * names either side of a slash, and a bare project slug, both read as paths:
 * measured at 19 working-tree advisories before the check, most of them prose,
 * which is how an advisory list stops being read.
 */
function canonicalisePathToken(token) {
  return normalisePathToken(token)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/agent-a[0-9a-f]{8,}/g, 'agent-<id>')
    .replace(/[/]{2,}/g, '/');
}

/** Never print a secret. Report its shape and its ends only. */
function redactSecret(value) {
  if (value.length <= 8) return `<${value.length} chars redacted>`;
  return `${value.slice(0, 4)}...<${value.length - 8} chars redacted>...${value.slice(-4)}`;
}

/* ------------------------------------------------------------------ *
 * Scanners
 * ------------------------------------------------------------------ */

/**
 * The identity class. One finding per match, LOCATION AND NOTE ONLY.
 *
 * The finding deliberately carries no copy of the matched text and no
 * surrounding path token. The inventory this replaced recorded a canonicalised
 * path token per hit, and that report is COMMITTED - so every such record put
 * the identity back into the repository through the very file that exists to
 * keep it out. Measured at 9,203 occurrences inside
 * `docs/evidence/privacy/report.json`: the single largest concentration in the
 * tree, larger than either captured database.
 */
function scanIdentity(text, starts, relPath, identity, sink) {
  for (const token of identity.tokens) {
    token.re.lastIndex = 0;
    let m;
    while ((m = token.re.exec(text)) !== null) {
      sink({ path: relPath, line: lineOf(starts, m.index), note: token.note });
      // A token whose pattern can match the empty string would spin here. None
      // can - every one requires a literal - but the guard costs nothing and a
      // future token is not obliged to be careful.
      if (m[0].length === 0) token.re.lastIndex += 1;
    }
  }
}

function scanSecrets(text, starts, relPath, sink) {
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      sink({
        path: relPath,
        line: lineOf(starts, m.index),
        rule: rule.id,
        redacted: redactSecret(m[0]),
      });
    }
  }
  GENERIC_SECRET_RE.lastIndex = 0;
  let g;
  while ((g = GENERIC_SECRET_RE.exec(text)) !== null) {
    const value = g[2];
    if (entropy(value) < GENERIC_SECRET_MIN_ENTROPY) continue;
    sink({
      path: relPath,
      line: lineOf(starts, g.index),
      rule: `generic-high-entropy:${g[1].toLowerCase()}`,
      redacted: redactSecret(value),
    });
  }
}

/** Does this captured value name the agent-deck project? */
function namesOwnProject(value) {
  return normalisePathToken(value).includes(OWN_PROJECT);
}

function scanForeign(text, starts, relPath, sink) {
  PROJECT_VALUE_RE.lastIndex = 0;
  let m;
  while ((m = PROJECT_VALUE_RE.exec(text)) !== null) {
    const [, key, value] = m;
    if (namesOwnProject(value)) continue;
    // A `slug` KEY whose value is not slug-shaped is not a project slug. CC
    // writes a generated three-word session nickname under that key, and 15 of
    // those in one fixture were reaching this sink. Same shape argument
    // SLUG_SHAPE_RE already makes one layer down, and it belongs here rather
    // than in a value exemption: a nickname is not an exempted project, it is
    // not a project at all. A slug-shaped value naming someone else's project
    // still matches the shape and is still flagged - the parity control in
    // src/release/privacy.test.ts plants exactly that and asserts it.
    if (key === 'slug' && !SLUG_SHAPE_RE.test(value)) continue;
    if (foreignExemption(relPath, value) !== null) continue;
    sink({
      path: relPath,
      line: lineOf(starts, m.index),
      kind: `key:${key}`,
      value: canonicalisePathToken(value),
    });
  }
  SLUG_PATH_RE.lastIndex = 0;
  let s;
  while ((s = SLUG_PATH_RE.exec(text)) !== null) {
    const slug = s[1];
    if (!SLUG_SHAPE_RE.test(slug)) continue;
    if (namesOwnProject(slug)) continue;
    // A slug is not an absolute path, so `not-an-absolute-location` must not be
    // consulted here; `SLUG_SHAPE_RE` above is this leg's equivalent shape gate.
    if (foreignExemption(relPath, slug, { slug: true }) !== null) continue;
    sink({
      path: relPath,
      line: lineOf(starts, s.index),
      kind: 'projects-slug',
      value: slug.toLowerCase(),
    });
  }
}

/* ------------------------------------------------------------------ *
 * Corpus enumeration
 * ------------------------------------------------------------------ */

function git(root, args, opts = {}) {
  return spawnSync('git', ['-C', root, ...args], {
    maxBuffer: 1 << 28,
    ...opts,
  });
}

function isGitRepo(root) {
  const r = git(root, ['rev-parse', '--git-dir'], { encoding: 'utf8' });
  return r.status === 0;
}

function walkDir(root) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel === '' ? root : path.join(root, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) stack.push(childRel);
      else if (ent.isFile()) out.push(childRel);
    }
  }
  return out.sort();
}

function trackedFiles(root) {
  const r = git(root, ['ls-files', '-z'], { encoding: 'buffer' });
  if (r.status !== 0) throw new Error('git ls-files failed');
  return r.stdout
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0)
    .sort();
}

/**
 * Directories that `--untracked` also walks, on top of `git ls-files`.
 *
 * WHY THIS EXISTS (Phase 0, DoD 0.6). The working-tree leg enumerates TRACKED
 * files only. A capture copied into `fixtures/` but never `git add`ed is
 * therefore never opened, and the sweep prints `VERDICT PASS unexpected=0
 * secrets=0 foreign=0`, exit 0, over a corpus that is not there. Measured, not
 * theorised: it happened during the 2026-08-26 OpenCode recon
 * (`docs/evidence/opencode/RECON.md` B5) and the giveaway was a timing drop
 * from 1,775 ms to 387 ms, not the verdict.
 *
 * Scoped to the capture directory because that is where the failure lives - a
 * whole-tree untracked walk would read `dist/`, `.claude/`, every scratch file
 * and the developer's own junk, and a mode nobody can leave on is a mode nobody
 * runs. `.gitignore` is deliberately NOT consulted: an ignored capture is
 * exactly the thing this mode exists to find.
 */
const UNTRACKED_SCAN_DIRS = ['fixtures'];

/**
 * Files under {@link UNTRACKED_SCAN_DIRS} that `git ls-files` does not list.
 * Returns relative POSIX paths, sorted, with no duplicates against `tracked`.
 */
function untrackedScanFiles(root, tracked) {
  const known = new Set(tracked);
  const out = [];
  for (const dir of UNTRACKED_SCAN_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const rel of walkDir(abs)) {
      const full = `${dir}/${rel}`;
      if (!known.has(full)) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Every blob reachable from every ref, with the path(s) it was stored under.
 * `git cat-file --batch` is fed the whole object list at once and its output
 * is parsed as bytes, which keeps NUL-containing blobs intact.
 */
function historyBlobs(root) {
  const rev = git(root, ['rev-list', '--all', '--objects'], { encoding: 'utf8' });
  if (rev.status !== 0) throw new Error('git rev-list failed');
  const paths = new Map();
  const order = [];
  for (const line of rev.stdout.split('\n')) {
    if (line.length === 0) continue;
    const sp = line.indexOf(' ');
    const sha = sp === -1 ? line : line.slice(0, sp);
    const p = sp === -1 ? null : line.slice(sp + 1);
    if (!paths.has(sha)) {
      paths.set(sha, new Set());
      order.push(sha);
    }
    if (p !== null) paths.get(sha).add(p);
  }

  const batch = git(root, ['cat-file', '--batch', '--buffer'], {
    input: `${order.join('\n')}\n`,
    maxBuffer: 1 << 30,
  });
  if (batch.status !== 0) throw new Error('git cat-file --batch failed');

  const buf = batch.stdout;
  const blobs = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) break;
    const header = buf.toString('latin1', off, nl);
    const parts = header.split(' ');
    if (parts.length < 3) {
      // "<sha> missing" - nothing to read past the header.
      off = nl + 1;
      continue;
    }
    const [sha, type, sizeStr] = parts;
    const size = Number(sizeStr);
    const start = nl + 1;
    const end = start + size;
    if (type === 'blob') {
      blobs.push({ sha, paths: [...(paths.get(sha) ?? [])].sort(), body: buf.subarray(start, end) });
    }
    off = end + 1;
  }
  return blobs;
}

/* ------------------------------------------------------------------ *
 * Sweep
 * ------------------------------------------------------------------ */

function newLeg() {
  return {
    filesScanned: 0,
    bytesScanned: 0,
    nulFiles: [],
    identity: { hits: [], exemptHits: 0 },
    secrets: [],
    foreign: [],
  };
}

function scanUnit(leg, relPath, body, identity) {
  const text = body.toString('latin1');
  const starts = lineIndex(text);
  leg.filesScanned += 1;
  leg.bytesScanned += body.length;
  if (body.includes(0)) leg.nulFiles.push(relPath);

  if (identity.status === 'RUN') {
    // EXEMPT PATHS ARE STILL SCANNED, and only their findings are diverted.
    // Skipping the read would make `exemptHits` unknowable, and a zero there is
    // how you would find out that the licence has stopped naming its licensor -
    // the same "its ABSENCE would be its own defect" reasoning
    // `src/release/vsix.test.ts` already applies to the packaged artifact.
    const exempt = identity.exemptPaths.includes(relPath);
    scanIdentity(text, starts, relPath, identity, (hit) => {
      if (exempt) leg.identity.exemptHits += 1;
      else leg.identity.hits.push(hit);
    });
  }

  scanSecrets(text, starts, relPath, (hit) => leg.secrets.push(hit));

  if (inCaptureCorpus(relPath)) {
    scanForeign(text, starts, relPath, (hit) => leg.foreign.push(hit));
  }
}

function finaliseLeg(leg) {
  leg.nulFiles.sort();
  const byLoc = (a, b) => a.path.localeCompare(b.path) || a.line - b.line;
  // Several tokens match at one location - a full home path trips the path
  // rule, both folder-name rules and the username rule at once - so collapse to
  // one finding per location and keep the notes beside it. Without this a single
  // leaked path reads as five separate failures and the count stops meaning
  // "how many places must I fix".
  const byKey = new Map();
  for (const h of leg.identity.hits) {
    const key = `${h.path} ${String(h.line)}`;
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, { path: h.path, line: h.line, notes: [h.note] });
    else if (!seen.notes.includes(h.note)) seen.notes.push(h.note);
  }
  leg.identity.hits = [...byKey.values()];
  for (const h of leg.identity.hits) h.notes.sort();
  leg.identity.hits.sort(byLoc);
  leg.secrets.sort(byLoc);
  leg.foreign.sort(byLoc);
  return leg;
}

export function sweep(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const wantHistory = options.history !== false;
  const timings = {};
  const identity = loadIdentity(root, options.identityFile ?? null);

  const gitRepo = isGitRepo(root);
  const wantUntracked = options.untracked === true;
  const tracked = gitRepo ? trackedFiles(root) : walkDir(root);
  // A non-git root is already a directory walk, so `--untracked` adds nothing
  // there and must not double-count.
  const untracked = gitRepo && wantUntracked ? untrackedScanFiles(root, tracked) : [];
  const files = untracked.length > 0 ? [...tracked, ...untracked].sort() : tracked;

  let t0 = Date.now();
  const wt = newLeg();
  for (const rel of files) {
    let body;
    try {
      body = fs.readFileSync(path.join(root, rel));
    } catch {
      continue; // deleted between enumeration and read; nothing to scan.
    }
    scanUnit(wt, rel, body, identity);
  }
  finaliseLeg(wt);
  timings.workingTreeMs = Date.now() - t0;

  let history = null;
  if (gitRepo && wantHistory) {
    t0 = Date.now();
    const hist = newLeg();
    const blobs = historyBlobs(root);
    hist.blobsScanned = blobs.length;
    for (const blob of blobs) {
      // A blob stored at several paths is scanned once per path, so a path that
      // is exempt in one place and not in another is judged in each.
      const at = blob.paths.length > 0 ? blob.paths : [`<unnamed-blob>/${blob.sha}`];
      for (const rel of at) scanUnit(hist, rel, blob.body, identity);
    }
    finaliseLeg(hist);
    history = hist;
    timings.historyMs = Date.now() - t0;
  }

  const identityHits = wt.identity.hits.length + (history?.identity.hits.length ?? 0);
  const secrets = wt.secrets.length + (history?.secrets.length ?? 0);
  const foreign = wt.foreign.length + (history?.foreign.length ?? 0);

  const head = gitRepo
    ? git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    : null;

  return {
    tool: 'scripts/privacy-sweep.mjs',
    reportVersion: 1,
    generatedAt: options.stamp ?? new Date().toISOString(),
    head,
    historyScope: history === null ? 'skipped' : 'all-refs',
    config: {
      // WHAT the identity class did, never WHAT it looked for. `tokenCount` and
      // the notes are safe to commit; the patterns are not, and neither is the
      // path to the file that holds them.
      identity: {
        status: identity.status,
        reason: identity.reason,
        tokenCount: identity.tokens.length,
        exemptPaths: identity.exemptPaths,
      },
      ownProject: OWN_PROJECT,
      captureCorpora: CAPTURE_CORPORA,
      captureRootFiles: CAPTURE_ROOT_FILES,
      foreignValueExemptions: FOREIGN_VALUE_EXEMPTIONS.map((r) => ({
        id: r.id,
        paths: r.paths ?? null,
        absolutePathValuesOnly: r.absolutePathValuesOnly === true,
        reason: r.reason,
      })),
      secretRules: [...SECRET_RULES.map((r) => r.id), 'generic-high-entropy'],
      // Untracked mode, and WHAT it read - a boolean alone would not say
      // whether the walk found anything, which is the interesting half.
      untracked: wantUntracked,
      untrackedScanDirs: UNTRACKED_SCAN_DIRS,
      untrackedFilesScanned: untracked.length,
    },
    workingTree: wt,
    history,
    verdict: {
      identityStatus: identity.status,
      identity: identityHits,
      secrets,
      foreign,
      // A SKIPPED identity class does not fail the run and does not pass
      // judgement either: `identityHits` is 0 because nothing was looked for,
      // which is why the status travels beside the count everywhere it is
      // printed. Reading the 0 without the status is the fail-open reading.
      pass: identityHits === 0 && secrets === 0 && foreign === 0,
    },
    timingsMs: timings,
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

// `process.stdout.write`, not `console`: the eslint flat config declares only
// `process` as a global for `.mjs`, which is the convention the other scripts
// in this directory already follow.
function say(line) {
  process.stdout.write(`${line}\n`);
}

function printLeg(name, leg, status, reason) {
  if (leg === null) {
    say(`\n${name}: SKIPPED`);
    return;
  }
  const unit = name === 'history' ? `${leg.blobsScanned} blobs` : `${leg.filesScanned} files`;
  say(`\n${name}: ${unit}, ${leg.bytesScanned} bytes, ${leg.nulFiles.length} containing NUL`);
  if (status === 'RUN') {
    say(`  IDENTITY   ${leg.identity.hits.length}  (${leg.identity.exemptHits} in exempt paths)`);
    for (const h of leg.identity.hits) {
      // Location and NOTE. Never the matched text - see `scanIdentity`.
      say(`             ${h.path}:${h.line}  ${h.notes.join('; ')}`);
    }
  } else {
    say(`  IDENTITY   SKIPPED (${reason ?? 'no identity file'}) - nothing was looked for`);
  }
  say(`  SECRET     ${leg.secrets.length}`);
  for (const h of leg.secrets) {
    say(`             ${h.path}:${h.line}  ${h.rule}  ${h.redacted}`);
  }
  say(`  FOREIGN    ${leg.foreign.length}`);
  for (const h of leg.foreign) {
    say(`             ${h.path}:${h.line}  ${h.kind}  ${h.value}`);
  }
}

function parseArgs(argv) {
  const opts = { json: null, root: process.cwd(), history: true, quiet: false, stamp: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--no-history') opts.history = false;
    else if (a === '--untracked') opts.untracked = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--stamp') opts.stamp = argv[++i];
    else if (a === '--identity') opts.identityFile = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (process.env.AGENT_DECK_SWEEP_HISTORY === '0') opts.history = false;
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const report = sweep(opts);

  if (!opts.quiet) {
    const st = report.config.identity.status;
    const why = report.config.identity.reason;
    say(`privacy sweep - root HEAD ${report.head ?? '(not a git repo)'}`);
    printLeg('working tree', report.workingTree, st, why);
    printLeg('history', report.history, st, why);
    say(
      `\nVERDICT ${report.verdict.pass ? 'PASS' : 'FAIL'}  ` +
        // The identity class reports its STATUS in the verdict line, always. A
        // bare `identity=0` from a run that never opened the token file reads
        // identical to a run that swept all of history and found nothing -
        // rule 18, and the reason this line has two fields where the others
        // have one.
        `identity=${st === 'RUN' ? String(report.verdict.identity) : `SKIPPED(${String(why)})`} ` +
        `secrets=${report.verdict.secrets} foreign=${report.verdict.foreign}`,
    );
    say(
      `timings working-tree=${report.timingsMs.workingTreeMs}ms ` +
        `history=${report.timingsMs.historyMs ?? 'skipped'}ms`,
    );
  }

  if (opts.json !== null) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!opts.quiet) say(`report written to ${opts.json}`);
  }

  return report.verdict.pass ? 0 : 1;
}

// Only run the CLI when this file IS the entry point. `src/release/privacy.test.ts`
// imports `sweep` directly and must not trip the process exit code.
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
