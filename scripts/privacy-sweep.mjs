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
 *               list's own `exemptPaths`, where the author's name is the
 *               CORRECT content: the licence, the manifest and its lock, and
 *               - added 2026-09-05, by the user, for DoD 5.9 - the project
 *               page at `site/index.html`.
 *
 *               THE PAGE'S EXEMPTION IS NOT A WIDENING OF WHAT IS PUBLIC, and
 *               the distinction is the whole reason an exemption was taken
 *               rather than the links being lowercased to slip past a
 *               case-sensitive token. Its three hits are all the repository's
 *               own public URL - the same string `package.json`'s
 *               `repository.url` already carries under this same list, and the
 *               one `vsce` rewrites every relative README image link into
 *               inside a published VSIX. Lowercasing would have passed the
 *               check while publishing the identical fact, which is the
 *               fail-open shape working-method rule 18 exists to stop.
 *               Gate: must be empty.
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
 * The SAME scratch location, in `SessionState.projectSlug`'s encoding rather
 * than a path's.
 *
 * `src/codex/index.ts`'s `codexProjectSlug` runs the scratch repo's `cwd`
 * through `workspaceSlug` (== `slugifyWorkspace`), which collapses every `:`,
 * `\` and `/` to `-` — so `C:\Users\dev\codex-probe\scratch` becomes
 * `C--Users-dev-codex-probe-scratch`, a value `CODEX_SCRATCH_RE` above cannot
 * match: it has no `/` left to anchor on at all. This shape did not exist in
 * Phase 1's census (raw harvested JSONL carries no `projectSlug` field — it is
 * a value the ENGINE derives) and first appeared when Phase 3's wire-corpus
 * recorder embedded a live `SessionState.projectSlug` in committed evidence.
 * First seen on `webview/wire/codex-0.151.0-alpha.7.2-session-arc.json`
 * (2026-09-03), as one shape: `C--Users-dev-codex-probe-scratch` — the same
 * location `CODEX_SCRATCH_RE` already clears, spelled the other way. HOW MANY
 * of them there are is deliberately not written here any more. The run counts
 * its own occurrences, its own distinct values and the files they were in, and
 * states them in this rule's `reason` (see `measurementFor` and
 * `codexSlugPhrase`) - a census written into a comment is invalidated by the
 * next harvest and nothing reports that it has gone false.
 *
 * `[^-]+` for the user-directory component, not `.+`: the slug's separator
 * IS the character being matched around, so a loose `.+` would swallow real
 * structure a dash could carry. This narrower form is exact for the measured
 * value and fails closed on a hyphenated username, which would need a written
 * widening here rather than silently passing.
 */
const CODEX_SCRATCH_SLUG_RE = /^[a-z]--users-[^-]+-codex-probe-scratch$/;

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

/* ------------------------------------------------------------------ *
 * THE RUN'S OWN CENSUS (v0.6.0 DoD 5.0d)
 *
 * Every number a FOREIGN exemption's reason states is computed here, by the
 * run that prints it. None of them is written down.
 *
 * WHY. Five Codex figures used to stand in the prose below - a corpus total, a
 * rule's share of it twice over, and a two-way split by value spelling. All
 * five re-derived on the day they were written; all five would have gone false
 * on the next harvest, silently, inside a file no harvest touches. That is this
 * repository's most-recorded defect, and it had already been committed here
 * once by a count over a corpus that a later commit REMOVED.
 *
 * RULE 18 APPLIES TO A CENSUS. A count of zero is evidence only when something
 * says what was looked at, so the census records which Codex corpus
 * directories were SCANNED and how many files were in them, whether or not any
 * value was found in them - and a composed sentence over an absent corpus says
 * the corpus is absent instead of printing a confident 0.
 *
 * SCOPE: the WORKING TREE leg, and every composed sentence says so. The
 * history leg re-scans older copies of the same corpus once per blob per path,
 * so folding it in would count one corpus several times over and the figure
 * would move with the branch topology rather than with the data.
 * ------------------------------------------------------------------ */

/** A Codex capture corpus directory, derived from the path, never listed. */
const CODEX_CORPUS_RE = /^fixtures\/(codex-[^/]+)\//;

/** How many file names a composed sentence names before it counts instead. */
const NAMED_FILES_MAX = 3;

/** How many file names the JSON report carries as a sample. */
const SAMPLE_FILES_MAX = 4;

const codexCensus = {
  corpora: new Set(),
  corpusFiles: 0,
  corpusCandidates: 0,
  rules: new Map(),
};

/**
 * The leg being scanned right now.
 *
 * `foreignExemption` is called from deep inside `scanForeign`, which knows
 * nothing about legs; this is how the per-leg candidate count and the
 * working-tree scope of the census are kept without threading a parameter
 * through three call sites that have no other use for it.
 */
let activeLeg = null;
let censusActive = false;

function resetCodexCensus() {
  codexCensus.corpora = new Set();
  codexCensus.corpusFiles = 0;
  codexCensus.corpusCandidates = 0;
  codexCensus.rules = new Map();
}

/**
 * Record that a file inside a Codex capture corpus was READ. Called for every
 * such file, hit or no hit, because "what was looked at" is the half that
 * makes a later zero mean anything.
 */
function noteScannedFile(relPath) {
  const m = CODEX_CORPUS_RE.exec(relPath);
  if (m === null) return;
  codexCensus.corpora.add(`fixtures/${m[1]}`);
  codexCensus.corpusFiles += 1;
}

/**
 * The spelling a captured location arrived in.
 *
 * Every pattern is anchored at `^`. None can restart at every offset - the
 * 2026-09-03 quadratic, measured at 61,962 ms on a corpus whose defining
 * fixture is a single 554,122-byte line.
 */
function pathValueShape(normalised) {
  if (normalised.startsWith('file:')) return 'a file: URL';
  if (/^[a-z]:\//.test(normalised)) return 'a drive-letter path';
  if (/^\/mnt\/[a-z]\//.test(normalised)) return 'a WSL /mnt path';
  if (/^\/[a-z]\//.test(normalised)) return 'an MSYS drive path';
  if (normalised.startsWith('/')) return 'a posix path';
  return 'an unrooted value';
}

function censusRecord(ruleId, relPath, value, inCodexCorpus, key) {
  let r = codexCensus.rules.get(ruleId);
  if (r === undefined) {
    r = {
      occurrences: 0,
      inCorpus: 0,
      files: new Set(),
      values: new Set(),
      shapes: new Map(),
      corpusShapes: new Map(),
      keys: new Set(),
    };
    codexCensus.rules.set(ruleId, r);
  }
  r.occurrences += 1;
  if (inCodexCorpus) r.inCorpus += 1;
  r.files.add(relPath);
  // The DISTINCT VALUES are counted, never published. This report is
  // committed, and the identity class already learned what happens when a
  // report quotes what it found: 9,203 occurrences inside the file whose job
  // was proving the repository clean.
  const normalised = normalisePathToken(value);
  r.values.add(normalised);
  const shape = pathValueShape(normalised);
  r.shapes.set(shape, (r.shapes.get(shape) ?? 0) + 1);
  // The same split, scoped to the capture corpora. The September figure this
  // replaced was corpus-scoped ("179 as a drive-letter path and 15 as a file:
  // URL"), and the repository-wide split is a different, larger number - the
  // two are kept apart so neither sentence quietly answers the other's
  // question.
  if (inCodexCorpus) r.corpusShapes.set(shape, (r.corpusShapes.get(shape) ?? 0) + 1);
  if (key !== null && key !== undefined) r.keys.add(key);
}

/** What this run measured for one rule. Published in the report. */
function measurementFor(ruleId) {
  const r = codexCensus.rules.get(ruleId) ?? null;
  const files = r === null ? [] : [...r.files].sort();
  const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  const shapes = r === null ? [] : [...r.shapes].sort(byCount);
  const corpusShapes = r === null ? [] : [...r.corpusShapes].sort(byCount);
  return {
    scope: 'working tree',
    occurrences: r === null ? 0 : r.occurrences,
    distinctValues: r === null ? 0 : r.values.size,
    fileCount: files.length,
    sampleFiles: files.slice(0, SAMPLE_FILES_MAX),
    keys: r === null ? [] : [...r.keys].sort(),
    shapes: Object.fromEntries(shapes),
    codexCorpora: {
      present: [...codexCensus.corpora].sort(),
      filesScanned: codexCensus.corpusFiles,
      candidates: codexCensus.corpusCandidates,
      forgivenHere: r === null ? 0 : r.inCorpus,
      shapes: Object.fromEntries(corpusShapes),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Composing a reason out of what the run found.
 *
 * The prose that explains the REASONING stays in the rule. Only the
 * arithmetic is composed here, and it is appended after MEASURED_MARKER so a
 * reader - and `src/release/privacy.test.ts` - can tell the durable half from
 * the run-dependent half at a glance. The test asserts that every standalone
 * integer after that marker is one of the numbers this run derived, which is
 * what makes "computed, not quoted" checkable rather than asserted.
 * ------------------------------------------------------------------ */

const MEASURED_MARKER = 'MEASURED BY THIS RUN - ';

function count(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function joinList(items) {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function filesPhrase(m) {
  if (m.fileCount === 0) return 'in no file';
  if (m.fileCount <= NAMED_FILES_MAX) return `in ${joinList(m.sampleFiles)}`;
  return `across ${count(m.fileCount, 'file')}`;
}

function shapesOf(shapes) {
  const entries = Object.entries(shapes);
  if (entries.length === 0) return '';
  return `, ${joinList(entries.map(([shape, n]) => `${n} as ${shape}`))}`;
}

function shapesPhrase(m) {
  return shapesOf(m.shapes);
}

function capitalise(s) {
  return s.length === 0 ? s : `${s[0].toUpperCase()}${s.slice(1)}`;
}

function corporaPhrase(m) {
  const c = m.codexCorpora;
  if (c.present.length === 0) {
    return (
      'no Codex capture corpus (fixtures/codex-*) is present in this tree, so ' +
      'nothing was counted there - an absence, stated, rather than a zero ' +
      'offered as evidence'
    );
  }
  const one = c.present.length === 1;
  return (
    `the Codex capture ${one ? 'corpus' : 'corpora'} present in this tree ` +
    `${one ? 'is' : 'are'} ${joinList(c.present)} (${count(c.filesScanned, 'file')} ` +
    `scanned, ${count(c.candidates, 'capture value')} examined)`
  );
}

function repoWideSentence(m, withShapes) {
  if (m.occurrences === 0) {
    return (
      'Repository-wide in the working tree this rule forgave nothing on this ' +
      'run: there is no population here to describe, which is a statement ' +
      'about the tree and not a count offered as evidence.'
    );
  }
  return (
    `Repository-wide in the working tree it forgave ${count(m.occurrences, 'value')}` +
    `${withShapes ? shapesPhrase(m) : ''}, ${count(m.distinctValues, 'distinct value')}, ` +
    `${filesPhrase(m)}.`
  );
}

function genericMeasuredPhrase(m) {
  return `${MEASURED_MARKER}${repoWideSentence(m, false)}`;
}

function codexScratchPhrase(m) {
  const corpusHalf =
    m.codexCorpora.present.length === 0
      ? `${corporaPhrase(m)}.`
      : `${corporaPhrase(m)}; ${m.codexCorpora.forgivenHere} of those examined ` +
        `values are this one location${shapesOf(m.codexCorpora.shapes)}.`;
  return `${MEASURED_MARKER}${corpusHalf} ${repoWideSentence(m, true)}`;
}

function codexRolloutPhrase(m) {
  const corpusHalf =
    m.codexCorpora.present.length === 0
      ? `${corporaPhrase(m)}.`
      : `${corporaPhrase(m)}; ${m.codexCorpora.forgivenHere} of those examined ` +
        `values are this shape${shapesOf(m.codexCorpora.shapes)}.`;
  const keys =
    m.keys.length === 0
      ? 'No capture key produced one on this run.'
      : `It arrived under the ${joinList(m.keys)} ${m.keys.length === 1 ? 'key' : 'keys'} - ` +
        'the run reports which, rather than this file asserting them.';
  return `${MEASURED_MARKER}${corpusHalf} ${repoWideSentence(m, true)} ${keys}`;
}

function codexSlugPhrase(m) {
  const corpusHalf = capitalise(
    m.codexCorpora.present.length === 0
      ? `${corporaPhrase(m)}.`
      : `${corporaPhrase(m)}, of which ${m.codexCorpora.forgivenHere} are this ` +
        'shape - a Codex CAPTURE corpus is expected to carry none, because ' +
        'projectSlug is derived by the engine and never harvested.',
  );
  return `${MEASURED_MARKER}${repoWideSentence(m, false)} ${corpusHalf}`;
}

/**
 * FOREIGN exemptions, by VALUE - each with a written reason that says what was
 * measured.
 *
 * By value and not by path, deliberately: a path-shaped exemption blinds a
 * whole directory, which is the defect this phase is closing, not one to
 * reintroduce one level down. The single entry that IS path-scoped names one
 * exact file and one exact invented value.
 *
 * WHAT THE CLAIM IS, AND WHERE THE NUMBER LIVES NOW (corrected 2026-09-04)
 * -----------------------------------------------------------------------
 * The durable claim is qualitative: every value that reaches these rules falls
 * into one of the enumerated shapes, and NONE is content captured from another
 * project. The sweep re-checks it on every run - that is what `foreign=0` says,
 * and it is worth more than any frozen figure.
 *
 * The figure that used to stand here said the widened corpus produced
 * `foreign=32` (8 working tree + 24 history) with no exemption, "on this
 * repository at b4f6c76". BOTH HALVES had rotted by 2026-09-04: the commit no
 * longer exists (the history rewrite of that day changed every SHA on this
 * branch), and the count had moved with the corpora - three of the individual
 * reasons below cited sub-counts of that 32 which no longer re-derived either.
 * A count over a corpus is invalidated by ADDING data exactly as surely as by
 * removing it, and neither event need touch this file.
 *
 * So the counts are no longer written down. Each rule's report entry carries a
 * `forgiven` count measured on the run that produced it, `verdict` carries
 * `foreignCandidates`, and `src/release/privacy.test.ts` asserts the accounting
 * closes and that no rule has gone dead. Re-derive with
 * `node scripts/privacy-sweep.mjs --json <path>` and read the report; do not
 * quote a number from this comment, because there is deliberately none to quote.
 *
 * THAT SENTENCE WAS NOT YET TRUE OF THE THREE CODEX RULES when it was written
 * (v0.6.0 DoD 5.0d, 2026-09-04). They still carried five September figures - a
 * corpus total, a rule's share of it twice, and a split by value spelling - and
 * every one of them was of the shape the paragraph above says is forbidden.
 * They are gone. Each rule now carries a `measuredPhrase`, appended to its
 * reason after MEASURED_MARKER and composed from the run's own census; each
 * report entry carries the structured `measured` block those sentences are
 * built from. A rule with no `measuredPhrase` gets the generic one, so no
 * reason in this file states a count that the run did not just take.
 */
const FOREIGN_VALUE_EXEMPTIONS = [
  {
    id: 'elided-not-a-location',
    reason:
      'The captured value is an elision, not a path: only dots, an ellipsis and ' +
      'whitespace. Documentation and code comments elide a path rather than ' +
      'naming one. First surfaced by narrowing regex-source-not-a-location in ' +
      'Phase 0 Wave 0, at two hits - a JSON illustration in ' +
      'docs/opencode-contract.md and a comment in this script. That figure has ' +
      'since moved with the corpora and is no longer stated here; the run\'s own ' +
      'forgiven count is in this entry. An elision cannot name a project, ' +
      'because it names nothing.',
    exempt: (value) => isElision(value),
  },
  {
    id: 'regex-source-not-a-location',
    reason:
      'The captured group is regex SOURCE, not a filesystem location. When this ' +
      'rule was written it accounted for 29 of the 32 raw hits then in the ' +
      'repository, all the identical source ' +
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
      'is the same generator\'s output. This rule predates the widening and its ' +
      'PREDICATE is unchanged by it. Its recorded count is not: the text here ' +
      'used to say "0 of the 32 raw hits needed it", and on 2026-09-04 it was ' +
      'the second-busiest rule in the file. Nothing about it changed - the ' +
      'synthetic corpora grew - which is the whole reason the counts moved into ' +
      'the report and out of this prose.',
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
      'the same one location. It is NOT a directory prefix - the whole value is ' +
      'pinned segment by segment, home component aside, so a different project ' +
      'name under the same home still gates. The value arrives in more than one ' +
      'spelling and they are the same location either way: a drive-letter path, ' +
      'and a file: URL, which is how the Codex hook tap reports one run\'s ' +
      'working directory. WHERE THE ARITHMETIC WENT: this reason used to carry a ' +
      'September census of the corpus it was written against. The corpus has ' +
      'grown since, and nothing would have reported that the sentence had gone ' +
      'false, so the counts are taken from the run in progress and appear below.',
    measuredPhrase: codexScratchPhrase,
    exempt: (value) => CODEX_SCRATCH_RE.test(normalisePathToken(value)),
  },
  {
    id: 'codex-probe-scratch-repo-slug',
    reason:
      'The same scratch location as codex-probe-scratch-repo above, in ' +
      'SessionState.projectSlug\'s dash-collapsed encoding rather than a path\'s ' +
      '(src/codex/index.ts\'s codexProjectSlug runs it through workspaceSlug, which ' +
      'CODEX_SCRATCH_RE cannot match - there is no "/" left in a slug to anchor on). ' +
      'Not visible in Phase 1\'s census: raw harvested JSONL carries no projectSlug ' +
      'field at all, it is a value the ENGINE derives, so this shape first appeared ' +
      'when Phase 3\'s wire-corpus recorder embedded a live SessionState in committed ' +
      'evidence - which is also why a Codex CAPTURE corpus need not contain this shape ' +
      'at all: raw harvested JSONL has no such field, so the population lives in the ' +
      'recorded wire evidence rather than in fixtures/codex-*. The location is the ' +
      'identical one codex-probe-scratch-repo already clears. Segment-pinned the same ' +
      'way: only the user-directory component is free. Its census used to be frozen ' +
      'here as a September figure and is now taken from the run in progress.',
    measuredPhrase: codexSlugPhrase,
    exempt: (value) => CODEX_SCRATCH_SLUG_RE.test(normalisePathToken(value)),
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
      'asserted. A relocated CODEX_HOME stops matching and gates, which is the ' +
      'fail-closed direction. Its share of the corpus, and the capture keys it ' +
      'arrives under, used to be frozen here as a September census over a corpus ' +
      'that has since grown; both are now taken from the run in progress.',
    measuredPhrase: codexRolloutPhrase,
    exempt: (value) => CODEX_ROLLOUT_RE.test(normalisePathToken(value)),
  },
  {
    id: 'planted-negative-control',
    paths: ['src/release/privacy.test.ts'],
    reason:
      'The remaining raw hits - 3 of them, 1 working tree and 2 history, when ' +
      'this rule was written - are the SOURCE of ' +
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

/**
 * How many candidates each rule forgave, and how many reached the rules at all,
 * for the run in progress. Reset by `sweep()`, published in the report.
 *
 * WHY THIS IS MEASURED RATHER THAN WRITTEN DOWN. Every reason above used to
 * carry a frozen count from the run that introduced it, and three of them had
 * gone false by the time anyone checked: the corpora they were counted over had
 * grown, and one cited a commit (`b4f6c76`) that the 2026-09-04 history rewrite
 * destroyed. That is this repository's most-recorded defect - a live number in a
 * document - and adding a corpus invalidates such a number exactly as surely as
 * removing one does. A count that the tool recomputes every run cannot go stale,
 * and `src/release/privacy.test.ts` turns it into a conservation law
 * (`forgiven + gated === candidates`) plus a dead-rule guard, so an exemption
 * that has outlived its data goes RED instead of sitting there reading as
 * evidence.
 */
const foreignTally = { candidates: 0, forgiven: new Map() };

function resetForeignTally() {
  foreignTally.candidates = 0;
  foreignTally.forgiven = new Map();
}

function foreignExemption(relPath, value, opts = {}) {
  foreignTally.candidates += 1;
  // Per LEG as well as in total: the census below is working-tree scoped, so
  // its conservation law needs a working-tree denominator to close against.
  if (activeLeg !== null) activeLeg.foreignCandidates += 1;
  const inCodexCorpus = censusActive && CODEX_CORPUS_RE.test(relPath);
  if (inCodexCorpus) codexCensus.corpusCandidates += 1;
  for (const rule of FOREIGN_VALUE_EXEMPTIONS) {
    if (rule.absolutePathValuesOnly === true && opts.slug === true) continue;
    if (
      rule.paths !== undefined &&
      !rule.paths.some((p) => relPath === p || relPath.startsWith(p))
    ) {
      continue;
    }
    if (rule.exempt(value)) {
      foreignTally.forgiven.set(rule.id, (foreignTally.forgiven.get(rule.id) ?? 0) + 1);
      if (censusActive) censusRecord(rule.id, relPath, value, inCodexCorpus, opts.key ?? null);
      return rule;
    }
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
    // The KEY travels with the value so the census can report which capture
    // keys a shape actually arrived under. The rollout rule's reason used to
    // name `transcript_path` and `agent_transcript_path` as a written claim;
    // now the run says which keys it saw.
    if (foreignExemption(relPath, value, { key }) !== null) continue;
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
    if (foreignExemption(relPath, slug, { slug: true, key: 'projects-slug' }) !== null) continue;
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
    // Every value that reached the exemption rules in THIS leg. The
    // repository-wide total is in `verdict.foreignCandidates`; this is the
    // denominator the working-tree census closes against.
    foreignCandidates: 0,
    foreign: [],
  };
}

function scanUnit(leg, relPath, body, identity) {
  const text = body.toString('latin1');
  const starts = lineIndex(text);
  leg.filesScanned += 1;
  leg.bytesScanned += body.length;
  // Recorded for every file inside a Codex corpus, hit or no hit: a later
  // count of zero is evidence only when something says what was opened.
  if (censusActive) noteScannedFile(relPath);
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
  // Module-level, so a second call in the same process would otherwise add to
  // the first one's counts. `src/release/privacy.test.ts` calls sweep() several
  // times per run, which is exactly how that would have been found late.
  resetForeignTally();
  resetCodexCensus();
  activeLeg = null;
  censusActive = false;
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
  activeLeg = wt;
  censusActive = true;
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
  activeLeg = null;
  // The census is working-tree scoped and closes here. See the census header:
  // a history blob is an older copy of the same corpus, scanned once per path
  // it was ever stored at, so counting it would multiply one corpus by the
  // branch topology.
  censusActive = false;
  timings.workingTreeMs = Date.now() - t0;

  let history = null;
  if (gitRepo && wantHistory) {
    t0 = Date.now();
    const hist = newLeg();
    activeLeg = hist;
    const blobs = historyBlobs(root);
    hist.blobsScanned = blobs.length;
    for (const blob of blobs) {
      // A blob stored at several paths is scanned once per path, so a path that
      // is exempt in one place and not in another is judged in each.
      const at = blob.paths.length > 0 ? blob.paths : [`<unnamed-blob>/${blob.sha}`];
      for (const rel of at) scanUnit(hist, rel, blob.body, identity);
    }
    finaliseLeg(hist);
    activeLeg = null;
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
      // Published rather than duplicated: the test splits a reason on this to
      // separate the durable prose from the run-derived arithmetic, and a
      // marker written down in two places is a marker that drifts.
      measuredMarker: MEASURED_MARKER,
      captureCorpora: CAPTURE_CORPORA,
      captureRootFiles: CAPTURE_ROOT_FILES,
      foreignValueExemptions: FOREIGN_VALUE_EXEMPTIONS.map((r) => {
        // The reason a human reads is a statement about THIS run: the durable
        // prose, then MEASURED_MARKER, then arithmetic taken from the census.
        // Nothing after that marker is written down anywhere in this file.
        const measured = measurementFor(r.id);
        const phrase = (r.measuredPhrase ?? genericMeasuredPhrase)(measured);
        return {
          id: r.id,
          paths: r.paths ?? null,
          absolutePathValuesOnly: r.absolutePathValuesOnly === true,
          reason: `${r.reason} ${phrase}`,
          // The structured half of the same thing, so a reader - and the test -
          // can check the sentence against the numbers rather than parse prose
          // to find out what the run measured.
          measured,
          // How many candidates this rule forgave in THIS run, across both legs.
          // A rule at 0 is a rule whose written reason no longer describes any
          // data in the repository - see the note on `foreignTally`.
          forgiven: foreignTally.forgiven.get(r.id) ?? 0,
        };
      }),
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
      // Every value that reached the exemption rules at all, across both legs -
      // i.e. a foreign-shaped capture key whose value did not name this project
      // and passed the shape gates. `foreignCandidates` minus the sum of every
      // rule's `forgiven` is exactly `foreign`, which is the accounting
      // src/release/privacy.test.ts pins: a rule cannot forgive something that
      // was never counted, and nothing can be dropped between the two.
      foreignCandidates: foreignTally.candidates,
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

/**
 * What each FOREIGN exemption forgave on this run, and the sentence it composed
 * from it.
 *
 * Printed because an exemption removes a GATING hit: the count is the only
 * thing standing between "this rule protects other people's work" and "this
 * rule is a hole somebody wrote a reason on". A rule at 0 is visible here
 * without opening the JSON.
 */
function printForeignExemptions(report) {
  say(`\nFOREIGN exemptions (${report.verdict.foreignCandidates} capture values examined)`);
  for (const rule of report.config.foreignValueExemptions) {
    const marker = report.config.measuredMarker;
    const at = rule.reason.indexOf(marker);
    const measured = at === -1 ? '(no measurement)' : rule.reason.slice(at + marker.length);
    say(`  ${rule.id}  forgiven=${rule.forgiven}`);
    say(`    ${measured}`);
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
    printForeignExemptions(report);
    say(
      `\nVERDICT ${report.verdict.pass ? 'PASS' : 'FAIL'}  ` +
        // The identity class reports its STATUS in the verdict line, always. A
        // bare `identity=0` from a run that never opened the token file reads
        // identical to a run that swept all of history and found nothing -
        // rule 18, and the reason this line has two fields where the others
        // have one.
        `identity=${st === 'RUN' ? String(report.verdict.identity) : `SKIPPED(${String(why)})`} ` +
        `secrets=${report.verdict.secrets} ` +
        // Same rule, applied to FOREIGN. A bare `foreign=0` reads identical
        // whether the scan examined a hundred thousand capture values or never
        // opened a corpus at all - and "a clean PASS over an absent corpus" is
        // a failure this repository has actually had. The candidate count is
        // what was LOOKED AT, so the 0 beside it is evidence rather than an
        // assertion. It is not a gate: only the 0 is.
        // ... and the count is APPENDED rather than folded into the field, so
        // `foreign=0` still reads verbatim for anyone - or any grep - looking
        // for the documented form. The gate is the 0; the parenthesis is the
        // evidence that the 0 was earned.
        `foreign=${report.verdict.foreign} ` +
        `(${report.verdict.foreignCandidates} capture values examined)`,
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
