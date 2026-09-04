/**
 * Phase 5 DoD1 - privacy verification.
 *
 * WHAT THIS SUITE COVERS LIVE, AND WHAT IT DOES NOT
 * -------------------------------------------------
 * BOTH legs run live here: the working tree AND full history. Measured on this
 * machine at the time of writing, the history leg costs about half a second
 * (`timingsMs.historyMs`), which is nowhere near the threshold that would
 * justify hiding it behind an env gate, so it is not gated and the committed
 * evidence is not a stand-in for it. If that ever changes, gate it explicitly
 * and say so here - a suite that silently skips history while the DoD says
 * "full-history sweep" is worse than no suite.
 *
 * The NUMBER that enforces that lives in `src/perf/sweep-history.test.ts`,
 * moved there on 2026-08-27 because a wall-clock budget running beside the
 * whole suite measures the machine. Same limit, isolated project. This file
 * keeps every assertion about what the sweep finds.
 *
 * The history leg walks every blob reachable from EVERY REF, which in this
 * repository includes sibling worker branches that are not merged yet. Its
 * totals therefore move as a phase progresses. That is why nothing below pins
 * a hit COUNT: the assertions are emptiness and structure. (Same repo law that
 * forbids pinning fixture-set sizes - the next harvest breaks the number and it
 * reads as a regression.)
 *
 * A COLLECTION FAILURE HERE LOOKS LIKE A PASS, SO SUITE 0 EXISTS
 * --------------------------------------------------------------
 * If the dynamic import of the sweep script throws, vitest's summary line
 * reads "24 skipped", which at a glance is not distinguishable from green.
 * That happened for real: a shebang on line 1 of `scripts/privacy-sweep.mjs`
 * is stripped by vite only when the file has LF endings, so an LF working
 * copy ran 24/24 while the identical commit checked out CRLF collected zero
 * tests. The import is therefore caught, not thrown, and suite 0 below
 * depends on nothing so that it still runs and still fails when that breaks.
 *
 * WHAT "PASS" MEANS HERE
 * ----------------------
 * The DoD's `-> 0` is on FOREIGN content and SECRETS. It is NOT on this
 * developer's own absolute paths, which are present in the capture corpora
 * deliberately. Those are inventoried, not zeroed. If a change to fixtures
 * would be needed to make a counter reach zero, the counter is being read
 * wrong.
 *
 * SCRATCH SPACE: the negative controls build a throwaway tree under
 * `os.tmpdir()` via `mkdtempSync` and delete it in `afterAll`. Nothing is
 * written inside the repository (G1), and in particular the planted
 * credential-shaped string never touches a tracked path.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* ------------------------------------------------------------------ *
 * The report shape this suite relies on. Deliberately partial: it names
 * only what is asserted, so a field added to the sweep does not have to
 * be mirrored here.
 * ------------------------------------------------------------------ */

interface SecretHit {
  path: string;
  line: number;
  rule: string;
  redacted: string;
}

interface ForeignHit {
  path: string;
  line: number;
  kind: string;
  value: string;
}

/**
 * An identity finding: WHERE, and which token notes matched there.
 *
 * There is deliberately no field for the matched text. This report is
 * committed, so a finding that quoted what it found would put the identity back
 * into the repository through the file whose job is keeping it out - and that
 * is not hypothetical: the inventory this replaced recorded a canonicalised
 * path token per hit, and `docs/evidence/privacy/report.json` ended up holding
 * 9,203 identity occurrences, more than either captured database.
 */
interface IdentityHit {
  path: string;
  line: number;
  notes: string[];
}

interface SweepLeg {
  filesScanned: number;
  bytesScanned: number;
  blobsScanned?: number;
  /**
   * HISTORY ONLY. Distinct blob ids this leg scanned that the CHECKOUT does
   * not hold - the number that says whether history was really swept, and the
   * one the byte comparison it replaced could never be.
   */
  blobsNotInWorkingTree?: number;
  nulFiles: string[];
  identity: { hits: IdentityHit[]; exemptHits: number };
  secrets: SecretHit[];
  /** Every value that reached the exemption rules in THIS leg. */
  foreignCandidates: number;
  foreign: ForeignHit[];
}

/**
 * What the run itself measured for one exemption (v0.6.0 DoD 5.0d).
 *
 * Working-tree scoped, and the sweep says so in `scope`: the history leg
 * re-scans older copies of the same corpus once per blob per path, so a census
 * folding it in would count one corpus several times over and move with the
 * branch topology rather than with the data.
 */
interface Measured {
  scope: string;
  occurrences: number;
  distinctValues: number;
  fileCount: number;
  sampleFiles: string[];
  keys: string[];
  shapes: Record<string, number>;
  codexCorpora: {
    present: string[];
    filesScanned: number;
    candidates: number;
    forgivenHere: number;
    shapes: Record<string, number>;
  };
}

interface SweepReport {
  tool: string;
  reportVersion: number;
  generatedAt: string;
  head: string | null;
  historyScope: 'all-refs' | 'skipped';
  /**
   * True when this clone was made with `--depth`, i.e. its history is a stub.
   *
   * Reported by the sweep rather than inferred from a count here, because
   * "few blobs" and "no history" are different diagnoses and only git can
   * tell them apart.
   */
  shallow: boolean;
  config: {
    identity: {
      status: 'RUN' | 'SKIPPED';
      reason: string | null;
      tokenCount: number;
      exemptPaths: string[];
    };
    ownProject: string;
    /** Separates a reason's durable prose from the run-derived arithmetic. */
    measuredMarker: string;
    captureCorpora: string[];
    captureRootFiles: boolean;
    foreignValueExemptions: {
      id: string;
      paths: string[] | null;
      absolutePathValuesOnly: boolean;
      reason: string;
      /** What THIS run measured, and what the tail of `reason` is built from. */
      measured: Measured;
      /** Candidates this rule forgave in the run that produced this report. */
      forgiven: number;
    }[];
    untracked: boolean;
    untrackedScanDirs: string[];
    untrackedFilesScanned: number;
  };
  workingTree: SweepLeg;
  history: SweepLeg | null;
  verdict: {
    identityStatus: 'RUN' | 'SKIPPED';
    identity: number;
    secrets: number;
    foreign: number;
    /** Every value that reached the exemption rules, across both legs. */
    foreignCandidates: number;
    pass: boolean;
  };
  timingsMs: { workingTreeMs: number; historyMs?: number };
}

interface SweepOptions {
  root?: string;
  history?: boolean;
  stamp?: string;
  untracked?: boolean;
  /** Point the identity class at a throwaway token file. Negative controls only. */
  identityFile?: string;
}

type SweepModule = { sweep: (options?: SweepOptions) => SweepReport };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'privacy-sweep.mjs');

/* The sweep is a `.mjs` script with no type declarations. A dynamic import with
   a computed specifier keeps `tsc` out of the resolution business and lets the
   cast above carry the types, which is cleaner than a `@ts-expect-error` that
   silently stops suppressing anything the day a declaration appears. */
let sweep: SweepModule['sweep'];

/**
 * Why the import below is caught rather than left to throw: a throw in the
 * file-level `beforeAll` is a COLLECTION failure, and vitest's summary line
 * then reads "24 skipped" - which at a glance is indistinguishable from a
 * pass. That is exactly how a shebang in the sweep script reached a merged
 * commit with a green report attached to it. Recording the error instead lets
 * the guard suite below actually RUN and FAIL, naming the cause.
 */
let sweepLoadError: unknown = null;

/**
 * INVENTED IDENTITY, and every character of it is fiction.
 *
 * These are not the developer's name split into fragments, which is what stood
 * here through Phase 6. Fragmenting hides a string from `grep`; it does not
 * remove it, and the scrub of 2026-08-28 is measured by a `grep` from a clean
 * clone returning zero. The negative controls below write these tokens into a
 * THROWAWAY identity file in a temp directory and point the sweep at it with
 * `--identity`, so the class can be proved to fail without this repository ever
 * containing a real token.
 *
 * `Zaphod` has two heads and no relationship to anybody; `X:` is not a drive
 * letter Windows assigns by default.
 */
const NEEDLE = 'Zaphod';
const SECOND_NEEDLE = 'BeebleBrox';

/**
 * The throwaway token file the negative controls hand to `--identity`.
 *
 * Written per-test into a temp directory and never into this repository. The
 * shape is the real one, so the controls exercise the same loader the real file
 * goes through - which is the difference between testing the class and testing
 * a mock of it.
 */
function inventedIdentityFile(dir: string, exemptPaths: string[] = []): string {
  const file = path.join(dir, 'invented-identity.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: 1,
        exemptPaths,
        dbColumns: [],
        tokens: [
          { match: NEEDLE, replace: 'nobody', note: 'an invented given name' },
          { match: SECOND_NEEDLE, replace: 'nobody', note: 'an invented surname' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return file;
}
/** Credential-shaped, not a credential: no such key was ever issued. */
const PLANTED_SECRET = ['sk', '-ant-', 'api03', '-', 'ZmFrZVBsYW50ZWROb3RSZWFs'].join('');
/** A marker that only a scanner which read PAST a NUL run can find. */
const NUL_MARKER = `${NEEDLE}-past-the-nul-bytes`;

/**
 * ONE foreign-content plant, written BYTE-IDENTICALLY to three paths.
 *
 * The point of the identity is that the only variable between the three
 * controls is the DIRECTORY. Through Phase 5 that variable decided the verdict:
 * `CAPTURE_CORPORA` was an eight-entry list of the real-capture directories and
 * `inCaptureCorpus()` gated the whole FOREIGN scan on it, so this exact payload
 * scored 3 hits under `fixtures/hook-events/` and ZERO under `src/` and
 * `docs/`. That is not a hypothetical: it is what the Phase 5 verifier
 * measured, and this repository's own Phase 1 privacy leak lived largely in
 * documents.
 *
 * `src/model/leak.test.ts` is chosen deliberately: the `tests-and-testdata`
 * allow rule covers it for IDENTIFIERS, which makes it the strongest possible
 * demonstration that the FOREIGN gate is a separate axis - an allow rule
 * forgives a developer path, it must never forgive another project's content.
 */
const FOREIGN_PLANT =
  '{"hook_event_name":"Stop","cwd":"C:\\\\Users\\\\someone\\\\src\\\\totally-different-project"}\n';

/** Where that one payload is planted. Same bytes, three directories. */
const FOREIGN_PLANT_PATHS = [
  'fixtures/hook-events/planted-foreign.jsonl',
  'src/model/leak.test.ts',
  // A ROOT file, and it used to be `docs/notes.md`. `docs/` left this
  // repository on 2026-08-28, so the old plant landed outside the swept corpus
  // and this control quietly started asserting the opposite of what it means.
  // The PROPERTY is unchanged and is the whole point of the trio: prose is
  // swept, not only code. Prose now lives in the root files (README,
  // CONTRIBUTING, SECURITY, CHANGELOG), admitted by `CAPTURE_ROOT_FILES` rather
  // than by a directory prefix - which is the leg a prefix list cannot reach,
  // and the one that shipped a 38 KB mockup the last time nobody tested it.
  'NOTES.md',
] as const;

/**
 * WAVE 0 - the five-shape parity control.
 *
 * `regex-source-not-a-location` (formerly `not-an-absolute-location`) exempts a
 * captured value that is not a filesystem location. Its justification is real:
 * 29 of 32 raw hits were one regex literal whose own source spells the key
 * name. But the RULE used to be "not absolute", which is far wider than the
 * justification, and a RELATIVE path names another project every bit as plainly
 * as an absolute one does. So an entire shape of genuine foreign content was
 * being discarded by a rule written for something else, silently, with a
 * written reason attached that did not cover it.
 *
 * Parity means: every shape that IS a location must be flagged, whichever
 * syntax it is written in, and only the non-location may be exempt. Four of the
 * five below are locations. One is not. `expectFlagged` is the whole assertion.
 *
 * Each plant lives in its own file so a single miss cannot hide behind a
 * neighbour's hit, and every path is inside a capture corpus so the FOREIGN
 * scan reaches it.
 */
const PARITY_PROJECT = ['totally-', 'different-project'].join('');
const PARITY_SHAPES = [
  {
    id: 'windows-absolute',
    file: 'fixtures/hook-events/parity-windows.jsonl',
    value: `C:\\\\Users\\\\someone\\\\src\\\\${PARITY_PROJECT}`,
    expectFlagged: true,
    why: 'a drive-letter path naming another project',
  },
  {
    id: 'posix-absolute',
    file: 'fixtures/hook-events/parity-posix.jsonl',
    value: `/home/someone/src/${PARITY_PROJECT}`,
    expectFlagged: true,
    why: 'the same location in posix syntax; the old rule caught this one too',
  },
  {
    id: 'tilde-rooted',
    file: 'fixtures/hook-events/parity-tilde.jsonl',
    value: `~/src/${PARITY_PROJECT}`,
    expectFlagged: true,
    why: 'a home-rooted path; also caught by the old rule',
  },
  {
    id: 'relative',
    file: 'fixtures/hook-events/parity-relative.jsonl',
    value: `../${PARITY_PROJECT}/sessions`,
    expectFlagged: true,
    why: 'THE HOLE. Not absolute, so the old rule exempted it - a real foreign location, waved through',
  },
  {
    id: 'regex-source',
    file: 'fixtures/hook-events/parity-regex.jsonl',
    value: '((?:[^"]|.)*)',
    expectFlagged: false,
    why: 'the only non-location of the five: regex source, which is what the exemption is FOR',
  },
] as const;

/**
 * A hook-event line carrying `value` as its captured location.
 *
 * The key is ASSEMBLED rather than written out, for the same reason the needles
 * at the top of this file are: the sweep reads this file's own bytes, and a
 * source line holding the scanned key next to a value IS a hit. Writing the
 * template literal out plainly cost two self-inflicted FOREIGN hits before this
 * comment existed. `scripts/privacy-sweep.mjs` carries the same warning about
 * its own comments; the rule generalises to every file the sweep reads.
 */
const CWD_KEY = ['"cwd"', ':', '"'].join('');

function parityLine(value: string): string {
  return `{"hook_event_name":"Stop",${CWD_KEY}${value}"}\n`;
}

/**
 * CODEX CONTROL (v0.6.0 Phase 1, widened Phase 3) - the three Codex FOREIGN
 * exemptions, proved non-vacuous.
 *
 * `fixtures/codex-*` produces two captured-value shapes that name no project:
 * the probe's scratch repository, which `scripts/capture-codex.mjs` enforces
 * with a G8 refusal, and a Codex rollout transcript path, which is filed under
 * CODEX_HOME by capture DATE and carries no project component at all. Phase 3
 * added a third: the SAME scratch location in `SessionState.projectSlug`'s
 * dash-collapsed encoding, which first appeared when the wire-corpus recorder
 * embedded a live `SessionState` in committed evidence (raw harvested JSONL
 * carries no `projectSlug` field at all - it is a value the ENGINE derives).
 * All three are exempted by VALUE in `scripts/privacy-sweep.mjs`.
 *
 * The recorded failure mode for exactly this situation is a whole-directory
 * ALLOW PREFIX: the two `capture-opencode-*` rules forgave every value under a
 * path, so foreign content reaching those files could never gate and nobody
 * would find out. An exemption is only safe if something proves what it does
 * NOT forgive, so the six rows below come in three pairs - the exempt shape,
 * and the nearest thing to it that must still gate. The near misses share the
 * home directory, and one of them is rollout-shaped in every segment but one.
 *
 * The keys are ASSEMBLED, like `CWD_KEY` above and for the same reason: the
 * sweep reads this file's own bytes, and a source line holding a scanned key
 * beside a location IS a hit.
 */
const TRANSCRIPT_KEY = ['"transcript_path"', ':', '"'].join('');
const PROJECT_SLUG_KEY = ['"projectSlug"', ':', '"'].join('');
const CODEX_HOME = 'C:\\\\Users\\\\dev';
// The same home directory, in slug form: `slugifyWorkspace` collapses every
// `:`, `\` and `/` to `-`, so there is no backslash-doubling dance here - a
// slug is not JSON-escaped path syntax, it is already flat text.
const CODEX_HOME_SLUG = 'C--Users-dev';
const CODEX_ROLLOUT_TAIL =
  '.codex\\\\sessions\\\\2026\\\\09\\\\03\\\\' +
  'rollout-2026-09-03T00-54-10-01a0641d-8281-7703-97fa-5a829bb77563.jsonl';
const CODEX_SHAPES = [
  {
    id: 'codex-scratch-repo',
    file: 'fixtures/codex-control/exempt-scratch.jsonl',
    key: CWD_KEY,
    value: `${CODEX_HOME}\\\\codex-probe\\\\scratch`,
    expectFlagged: false,
    why: 'the probe scratch repo: the one cwd capture-codex.mjs permits, and not a project of ours',
  },
  {
    id: 'codex-rollout-path',
    file: 'fixtures/codex-control/exempt-rollout.jsonl',
    key: TRANSCRIPT_KEY,
    value: `${CODEX_HOME}\\\\${CODEX_ROLLOUT_TAIL}`,
    expectFlagged: false,
    why: 'a rollout filed by date under CODEX_HOME: date and UUID only, no project component',
  },
  {
    id: 'codex-scratch-repo-slug',
    file: 'fixtures/codex-control/exempt-scratch-slug.jsonl',
    key: PROJECT_SLUG_KEY,
    value: `${CODEX_HOME_SLUG}-codex-probe-scratch`,
    expectFlagged: false,
    why: "the same scratch repo, in projectSlug's dash-collapsed form rather than a path's",
  },
  {
    id: 'codex-sibling-of-scratch',
    file: 'fixtures/codex-control/gates-sibling.jsonl',
    key: CWD_KEY,
    value: `${CODEX_HOME}\\\\codex-probe\\\\${PARITY_PROJECT}`,
    expectFlagged: true,
    why: 'THE NEAR MISS. Same home, same parent directory, different project - a prefix rule forgives it',
  },
  {
    id: 'codex-rollout-with-project-segment',
    file: 'fixtures/codex-control/gates-rollout.jsonl',
    key: TRANSCRIPT_KEY,
    value: `${CODEX_HOME}\\\\${PARITY_PROJECT}\\\\${CODEX_ROLLOUT_TAIL}`,
    expectFlagged: true,
    why: 'rollout-shaped in every segment but one, and that one names another project',
  },
  {
    id: 'codex-sibling-of-scratch-slug',
    file: 'fixtures/codex-control/gates-sibling-slug.jsonl',
    key: PROJECT_SLUG_KEY,
    value: `${CODEX_HOME_SLUG}-codex-probe-${PARITY_PROJECT}`,
    expectFlagged: true,
    why: 'THE NEAR MISS in slug form. Same home, same parent, different project - a prefix rule forgives it',
  },
] as const;

function codexLine(key: string, value: string): string {
  return `{"hook_event_name":"Stop",${key}${value}"}\n`;
}

let scratch = '';

function writeScratch(rel: string, body: string | Buffer): void {
  const abs = path.join(scratch, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

beforeAll(async () => {
  try {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as SweepModule;
    sweep = mod.sweep;
  } catch (error: unknown) {
    sweepLoadError = error;
  }

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-privacy-'));

  // (a) planted developer identifier at a path NO allow rule covers.
  writeScratch('planted/leak.txt', `owner path: C:\\Users\\${NEEDLE}\\${SECOND_NEEDLE}\\notes.txt\n`);

  // (a) planted credential shape, also outside the allowed set.
  writeScratch('planted/config.env', `ANTHROPIC_API_KEY=${PLANTED_SECRET}\n`);

  // (b) the SAME identity in a path the throwaway token file marks EXEMPT.
  //     There is no allow rule any more - a hit fails the gate wherever it is -
  //     so the only thing that can divert a finding is the exempt list the
  //     token file itself carries, and this is the control for it.
  writeScratch('LICENSE', `MIT License\n\nCopyright (c) 2026 ${NEEDLE} ${SECOND_NEEDLE}\n`);

  // (c) the NUL hazard: 1000 NUL BYTES, written as an escape and never as a
  //     raw control character in source, then the marker behind them. GNU grep
  //     without `-a` abandons this stream and reports nothing.
  writeScratch(
    'planted/nul-hazard.bin',
    Buffer.concat([
      Buffer.from('leading text\n', 'latin1'),
      Buffer.alloc(1000, 0x00),
      Buffer.from(`${NUL_MARKER}\n`, 'latin1'),
    ]),
  );

  // (d) foreign content: the SAME bytes at three paths, one inside the old
  //     eight-entry corpus list and two outside it.
  for (const rel of FOREIGN_PLANT_PATHS) writeScratch(rel, FOREIGN_PLANT);

  // (e) a value that is JSON-shaped like a cwd but is not a location: the
  //     regex literal that seven real source files carry in order to PARSE a
  //     hook payload. Widening the corpora to src/ and scripts/ made the
  //     scanner capture the regex body itself - 29 of the 32 raw hits. The
  //     exemption is by value, so this file must produce no FOREIGN hit while
  //     the plants above still do.
  writeScratch(
    'src/parser/regex-literal.ts',
    'const match = /"cwd":"((?:[^"\\\\]|\\\\.)*)"/.exec(text);\n',
  );

  // (f) Wave 0: the five shapes, one file each.
  for (const shape of PARITY_SHAPES) writeScratch(shape.file, parityLine(shape.value));

  // (g) v0.6.0 Phase 1 (widened Phase 3): the three Codex exemptions and their
  //     nearest near misses, one file each so a single miss cannot hide behind
  //     a neighbour's hit.
  for (const shape of CODEX_SHAPES) writeScratch(shape.file, codexLine(shape.key, shape.value));
}, 120_000);

afterAll(() => {
  if (scratch !== '') fs.rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 0. The sweep script has to be loadable at all
 *
 * This suite calls nothing and depends on no fixture, so it still runs
 * when the import above failed - and then it fails, loudly, instead of
 * letting the whole file report as skipped.
 * ------------------------------------------------------------------ */

describe('the sweep script loads under the vitest module runner', () => {
  it('carries no shebang, which vite strips with a newline-sensitive regex', () => {
    // vite: `hashbangRE = /^#!.*\n/`. `.` does not match \r, so with
    // `* text=auto` plus core.autocrlf=true a CRLF checkout keeps the shebang,
    // it survives into the function-wrapped module, and this file dies at
    // import. Reading the bytes rather than importing is the point: this
    // assertion has to survive the failure it is about.
    const firstTwo = fs.readFileSync(SCRIPT).subarray(0, 2).toString('latin1');
    expect(firstTwo).not.toBe(`${'#'}${'!'}`);
  });

  it('imported, and exported a callable sweep', () => {
    expect(sweepLoadError).toBeNull();
    expect(typeof sweep).toBe('function');
  });
});

/* ------------------------------------------------------------------ *
 * 1. The real repository
 * ------------------------------------------------------------------ */

describe('privacy sweep against this repository', () => {
  let report: SweepReport;

  beforeAll(() => {
    report = sweep({ root: REPO_ROOT, history: true, stamp: '1970-01-01T00:00:00.000Z' });
  }, 120_000);

  it('finds no credential-shaped strings in the working tree or in history', () => {
    expect(report.workingTree.secrets).toEqual([]);
    expect(report.history?.secrets).toEqual([]);
    expect(report.verdict.secrets).toBe(0);
  });

  it('finds no content captured from a project other than agent-deck', () => {
    expect(report.workingTree.foreign).toEqual([]);
    expect(report.history?.foreign).toEqual([]);
    expect(report.verdict.foreign).toBe(0);
  });

  it('finds no identity outside the exempt paths, in the tree or in history', () => {
    // SKIPPED here is a real state, not a failure: a contributor has no identity
    // file and this run tells them so rather than pretending. What is NOT
    // acceptable is a silent skip, which is why the status is asserted beside
    // the count in both directions - `identity=0` from a class that never ran
    // reads identical to `identity=0` from one that swept everything, and that
    // is the fail-open reading rule 18 exists to stop.
    if (report.config.identity.status === 'SKIPPED') {
      expect(report.verdict.identityStatus).toBe('SKIPPED');
      expect(report.config.identity.reason).toMatch(/identity\.local\.json/);
      expect(report.config.identity.tokenCount).toBe(0);
      return;
    }
    expect(report.workingTree.identity.hits).toEqual([]);
    expect(report.history?.identity.hits).toEqual([]);
    expect(report.verdict.identity).toBe(0);
  });

  it('still finds the deliberate identity in the licence and the manifest', () => {
    // The exempt paths are the one place the name is SUPPOSED to be, and their
    // ABSENCE would be its own defect: a licence that stopped naming its
    // licensor, or a manifest that stopped naming its publisher, is a broken
    // release that would look like a clean sweep. So exempt paths are scanned
    // and only their findings are diverted - the count is the evidence the scan
    // reached them.
    if (report.config.identity.status === 'SKIPPED') return;
    expect(report.config.identity.exemptPaths).toContain('LICENSE');
    expect(report.config.identity.exemptPaths).toContain('package.json');
    expect(report.workingTree.identity.exemptHits).toBeGreaterThan(0);
  });

  it('never records the matched text, only where it was and what note it is', () => {
    // The report is COMMITTED. The inventory this replaced recorded a
    // canonicalised path token per hit, and the result was 9,203 identity
    // occurrences inside `docs/evidence/privacy/report.json` - the largest
    // single concentration in the tree, larger than either captured database.
    // The file whose job was proving the repository clean was the worst
    // offender in it. So a finding carries `path`, `line` and `notes`, and this
    // pins the SHAPE rather than trusting the intent.
    const legs = [report.workingTree, report.history].filter((l) => l !== null);
    for (const leg of legs) {
      for (const hit of leg.identity.hits) {
        expect(Object.keys(hit).sort()).toEqual(['line', 'notes', 'path']);
      }
    }
  });

  it('passes the gate', () => {
    expect(report.verdict.pass).toBe(true);
  });

  /*
   * WHAT THIS ASSERTED UNTIL 2026-09-05, AND WHY IT WAS WRONG.
   *
   * It compared BYTES: `history.bytesScanned > workingTree.bytesScanned`. The
   * intent was right and is unchanged - "full history" must not be the
   * checkout under another name - but the two numbers are not comparable, and
   * for two independent reasons:
   *
   *   1. THE WORKING TREE COUNTS PATHS; HISTORY COUNTS DISTINCT BLOBS. Two
   *      paths holding identical content are two files on disk and ONE object
   *      in git. `site/media/` exists precisely because it is byte-identical to
   *      `media/` - `site.test.ts` asserts that by sha256 - so the moment the
   *      site landed, the working tree gained 2,275,306 bytes that history
   *      counts once. Nine blobs in this repository sit at more than one path;
   *      the four screenshots are the large ones, and eleven synthetic-layout
   *      fixtures share five blobs between them.
   *   2. THE WORKING TREE READS FILES FROM DISK; HISTORY READS BLOBS. On a
   *      CRLF checkout a text file is LARGER on disk than the blob it came
   *      from, so the comparison also moves with the platform.
   *
   * It passed for years because a full clone's history holds thousands of old
   * blobs and the total swamped both effects. It was measuring the SIZE of the
   * history, not its EXISTENCE.
   *
   * MEASURED, on run 32521971501's successor and reproduced locally by cloning
   * this repository with `--depth 1`:
   *
   *   full clone     history 1359 blobs / 93,845,220 B   worktree 53,795,318 B  -> passed
   *   shallow clone  history  413 blobs / 51,361,391 B   worktree 53,795,988 B  -> FAILED
   *
   * The shallow figures are byte-for-byte the ones CI reported. So the trigger
   * was a SHALLOW CLONE and the mechanism was the dedup above: on a depth-1
   * clone history is exactly the checkout's own blobs, deduped, which is
   * necessarily smaller than the same content summed per path.
   *
   * The assertion now says what it means, and says it about OBJECT IDENTITY
   * rather than about size.
   */
  it('actually swept history, not just the working tree', () => {
    expect(report.historyScope).toBe('all-refs');
    expect(report.history).not.toBeNull();
    expect(report.history?.blobsScanned ?? 0).toBeGreaterThan(0);

    // THE POINT: at least one blob that the checkout does not hold. Such a blob
    // can only have come from an older commit, so it is proof that history was
    // walked - and unlike a byte total it cannot be inflated by a duplicate
    // path or by a line ending.
    expect(
      report.history?.blobsNotInWorkingTree ?? 0,
      'history scanned no blob the checkout does not already hold, so the history leg ' +
        'is the checkout under another name',
    ).toBeGreaterThan(0);
  });

  it('fails loudly on a shallow clone rather than reporting a clean nothing', () => {
    // A depth-1 clone sweeps one commit and prints VERDICT PASS - a clean
    // result from a corpus that is not there, which is the fail-open class
    // working-method rule 18 exists for. The assertion above already catches
    // it (`blobsNotInWorkingTree` is 0 on such a clone, measured), but it
    // catches it as a symptom. This names the cause, so a reader of a red CI
    // log is told what to change rather than left to infer it.
    expect(
      report.shallow,
      'this is a SHALLOW clone: the history leg swept one commit. Set ' +
        '`fetch-depth: 0` on actions/checkout in the workflow that runs this suite ' +
        '- see .github/workflows/ci.yml, which carries it and the reason.',
    ).toBe(false);
  });

  it('read through the tracked file that contains real NUL bytes', () => {
    // `src/parser/parse.test.ts` carries deliberate NUL fuzz input. If the
    // scanner had grep's binary heuristic this list would be empty and every
    // count above would be a clean-looking lie.
    expect(report.workingTree.nulFiles).toContain('src/parser/parse.test.ts');
    const nulFile = fs.readFileSync(path.join(REPO_ROOT, 'src', 'parser', 'parse.test.ts'));
    expect(nulFile.includes(0)).toBe(true);
  });

  it('every FOREIGN exemption carries a written reason', () => {
    // An exemption without a reason is a hole with a name on it. Same bar as
    // the allow rules, because an exemption removes a GATING hit, not an
    // inventory line.
    expect(report.config.foreignValueExemptions.length).toBeGreaterThan(0);
    for (const rule of report.config.foreignValueExemptions) {
      expect(
        rule.reason.length,
        `foreign exemption ${rule.id} has no reason`,
      ).toBeGreaterThan(20);
    }
  });

  /* ---------------------------------------------------------------- *
   * v0.6.0 Phase 4 (DoD 4.5) - `foreign=0` is only evidence when
   * something says what was looked at.
   *
   * `verdict.foreign === 0` is the gate, and on its own it reads exactly
   * the same whether the scan examined every capture value in the
   * repository or never opened a corpus at all. That second case is not
   * hypothetical here: "a clean PASS over an absent corpus" is the
   * measured failure that `--untracked` exists for, and the same shape
   * reached this suite once as a `beforeAll` timeout reporting as
   * "15 skipped" with a clean-looking tests line.
   *
   * So the run publishes what it examined, and these three assertions
   * close the accounting over it. Note what they deliberately do NOT do:
   * pin a count. Every count that was ever written into this file's prose
   * has gone stale - one of them cited a commit the 2026-09-04 history
   * rewrite destroyed - because a census over a corpus is invalidated by
   * ADDING data as surely as by removing it. These are conservation laws
   * and non-emptiness, which survive both.
   * ---------------------------------------------------------------- */
  describe('the FOREIGN accounting closes, so the zero is earned', () => {
    it('examined capture values at all - the zero is not over an empty scan', () => {
      // The vacuity control for the two assertions below, and the reason it is
      // first: `forgiven + gated === candidates` holds trivially at 0 + 0 === 0.
      // A conservation law over an empty population conserves nothing.
      expect(report.verdict.foreignCandidates).toBeGreaterThan(0);
    });

    it('every examined value was either forgiven by a named rule or gated', () => {
      const forgiven = report.config.foreignValueExemptions.reduce(
        (n, r) => n + r.forgiven,
        0,
      );
      // Nothing is dropped between the two, and no rule can report forgiving
      // something that never reached it. A value that vanished from both sides
      // is a foreign capture nobody would ever hear about.
      expect(forgiven + report.verdict.foreign).toBe(report.verdict.foreignCandidates);
    });

    it('no enumerated exemption has gone dead, forgiving nothing at all', () => {
      // A rule at 0 is a rule whose written reason no longer describes any data
      // in this repository - the exemption equivalent of the completeness
      // guard's "no enumerated prefix matches nothing" half, and the half that
      // catches a stale entry rather than a missing one. It matters more for an
      // exemption than for a corpus prefix: a rule kept past its data is a hole
      // held open on the strength of a reason that has stopped being checkable,
      // and it reads as active protection.
      const dead = report.config.foreignValueExemptions
        .filter((r) => r.forgiven === 0)
        .map((r) => r.id);
      expect(dead, 'these exemptions forgave nothing; is the data still here?').toEqual(
        [],
      );
    });
  });

  /* ---------------------------------------------------------------- *
   * DoD2 - the completeness guard.
   *
   * The FOREIGN corpora list is an INCLUSION list and stays one; that was
   * decided at the Phase 5 gate. An inclusion list's failure mode is silence:
   * a new tracked top-level directory is simply never scanned and nothing
   * says so. This is the thing that says so.
   *
   * The expected set is DERIVED from `git ls-files` at test time and no count
   * is written down anywhere - this repo's standing rule against pinning
   * fixture-set sizes applies exactly here, and a hard-coded 9 would read as a
   * regression the first time a directory is legitimately added.
   * ---------------------------------------------------------------- */
  describe('the FOREIGN corpora enumeration is complete', () => {
    let trackedPaths: string[] = [];
    let topLevelDirs: string[] = [];
    let rootFileCount = 0;

    beforeAll(() => {
      trackedPaths = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      })
        .split('\0')
        .filter((p) => p.length > 0);
      const dirs = new Set<string>();
      for (const p of trackedPaths) {
        const slash = p.indexOf('/');
        if (slash === -1) rootFileCount += 1;
        else dirs.add(`${p.slice(0, slash)}/`);
      }
      topLevelDirs = [...dirs].sort();
    }, 120_000);

    it('read a non-empty tracked file list, so the assertions below mean something', () => {
      // A guard on the guard: `git ls-files` returning nothing would make every
      // "uncovered set is empty" assertion below vacuously green. Same class as
      // `actions/checkout` defaulting to fetch-depth 1 and handing the sweep a
      // history that was not there.
      expect(trackedPaths.length).toBeGreaterThan(0);
      expect(topLevelDirs.length).toBeGreaterThan(0);
      expect(rootFileCount).toBeGreaterThan(0);
    });

    it('covers every tracked top-level directory', () => {
      const corpora = report.config.captureCorpora;
      // Covered means: some enumerated prefix is a prefix of the directory, so
      // EVERY file under it is scanned. A longer entry such as `docs/evidence/`
      // would cover part of `docs/` and is deliberately not accepted here -
      // partial coverage is the hole, not the fix.
      const uncovered = topLevelDirs.filter((d) => !corpora.some((c) => d.startsWith(c)));
      expect(
        uncovered,
        'these tracked top-level directories are outside the FOREIGN gate - add them to CAPTURE_CORPORA',
      ).toEqual([]);
    });

    it('covers the repository root, which no prefix can reach', () => {
      // `''` as a prefix would match everything, so root files are admitted by
      // a flag instead. The stray-file-at-the-root class has already shipped a
      // 38 KB mockup out of this repo once.
      expect(report.config.captureRootFiles).toBe(true);
    });

    it('carries no enumerated prefix that matches nothing', () => {
      // The other direction: a typo'd or stale entry silently covers nothing
      // and looks like coverage in the report.
      const dead = report.config.captureCorpora.filter(
        (c) => !trackedPaths.some((p) => p.startsWith(c)),
      );
      expect(dead, 'these enumerated corpora match no tracked file').toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- *
   * The sweep script holds no token of its own.
   * ---------------------------------------------------------------- */
  describe('the sweep script is not a copy of what it looks for', () => {
    it('contains no identity token, by the token list itself', () => {
      // The strongest available form of this assertion: run the real class over
      // the real script. Through Phase 6 the needles lived inside it, assembled
      // from fragments, and the test that stood here asserted only that the
      // FRAGMENTS did not accidentally re-form. That is a weaker claim than
      // "the file does not contain the thing", and it was the weaker claim
      // precisely because the stronger one was false.
      if (report.config.identity.status === 'SKIPPED') return;
      const inSweep = report.workingTree.identity.hits.filter(
        (h) => h.path === 'scripts/privacy-sweep.mjs',
      );
      expect(inSweep, 'the sweep script contains an identity token').toEqual([]);
    });

    it('names the token file it looks for, and nothing from inside it', () => {
      const source = fs.readFileSync(SCRIPT, 'utf8');
      expect(source).toContain('lab/identity.local.json');
      // The config it publishes carries counts and notes, never patterns: the
      // report is committed, and a committed list of what to grep for is the
      // same leak by a longer route.
      const serialised = JSON.stringify(report.config.identity);
      expect(serialised).not.toContain('"match"');
      expect(serialised).not.toContain('"replace"');
    });
  });

  /* ---------------------------------------------------------------- *
   * v0.6.0 Phase 4 (DoD 4.5) - no scan pattern may restart at every
   * offset.
   *
   * THE MEASUREMENT THIS EXISTS FOR. On 2026-09-03, the first time a
   * Codex corpus was committed, this sweep went from ~3 s to 169 s. The
   * cause was ONE pattern of the shape `[wide class]* LITERAL ...`: a
   * starred character class with nothing anchoring it, so the engine
   * restarts at every offset and re-expands the star. Over the corpus's
   * defining fixture - a single line of about 554 KB, because Codex
   * stores tool output whole and inline - that is ~3e11 steps. It cost
   * 61,962 ms and matched NOTHING. A lookbehind pinning the leading run
   * boundary took it to 6 ms.
   *
   * How it presented is why the check is here rather than in a perf
   * file: the suite did not report a slow test, it reported "15 skipped"
   * with a clean-looking tests line, because a `beforeAll` had blown its
   * budget. Adding DATA silently disabled tests.
   *
   * The census over the other patterns found none of this shape, so it
   * was one pattern and not a systemic flaw - and the recorded
   * conclusion was that THE CENSUS IS THE THING TO REPEAT, not the
   * number to remember. This is that census, run against the source
   * rather than the clock, so it cannot measure the machine and cannot
   * flake.
   *
   * SCOPE, stated because a check that skips an input must say so: this
   * covers the patterns the sweep OWNS. It cannot cover the identity
   * tokens, which are compiled from a file in a private repository that
   * a contributor's checkout does not have - and that is exactly where
   * the 2026-09-03 pattern lived. The one `new RegExp` site fed from
   * that file is identified below rather than quietly counted as clean.
   * ---------------------------------------------------------------- */
  describe('no scan pattern can restart at every offset (the 2026-09-03 quadratic)', () => {
    /** The leading fragment of every pattern the script defines. */
    interface PatternSite {
      kind: 'new RegExp' | 'literal';
      /** Where in the file, so a failure names something findable. */
      line: number;
      /**
       * The first string fragment of the pattern source, or `null` when the
       * argument is not a literal at all - which is the identity-token case.
       */
      lead: string | null;
    }

    let sites: PatternSite[] = [];
    let source = '';

    beforeAll(() => {
      source = fs.readFileSync(SCRIPT, 'utf8');
      const lineAt = (i: number): number => source.slice(0, i).split('\n').length;
      const found: PatternSite[] = [];

      // (a) `new RegExp(` sites. Only the FIRST fragment of the first argument
      //     is read, because a pattern's leading element is always in it -
      //     which is the only position the recorded defect can occupy.
      const ctor = /new RegExp\(\s*/g;
      let m: RegExpExecArray | null;
      while ((m = ctor.exec(source)) !== null) {
        const at = m.index + m[0].length;
        const rest = source.slice(at, at + 400);
        const quote = rest[0];
        if (quote !== "'" && quote !== '"' && quote !== '`') {
          found.push({ kind: 'new RegExp', line: lineAt(m.index), lead: null });
          continue;
        }
        let lead = '';
        for (let i = 1; i < rest.length; i += 1) {
          const c = rest[i];
          if (c === '\\') {
            lead += c + rest[i + 1];
            i += 1;
            continue;
          }
          if (c === quote) break;
          lead += c;
        }
        found.push({ kind: 'new RegExp', line: lineAt(m.index), lead });
      }

      // (b) Regex LITERALS, at the two places this file puts them: a top-level
      //     `const NAME = /.../` and a rule's `re: /.../`.
      const literal =
        /(?:^const [A-Z0-9_]+ = |\bre: )\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/[gimsuy]*/gm;
      let l: RegExpExecArray | null;
      while ((l = literal.exec(source)) !== null) {
        found.push({ kind: 'literal', line: lineAt(l.index), lead: l[1] ?? null });
      }

      sites = found;
    });

    /**
     * True when a pattern source begins with an element that can match the
     * empty string or an unbounded run WITHOUT a preceding anchor - the shape
     * that makes the engine restart at every offset.
     */
    const restartsAtEveryOffset = (lead: string): boolean => {
      // A `^` anchor settles it: there is exactly one place to start.
      if (lead.startsWith('^')) return false;
      // Otherwise read the first element and the quantifier that follows it.
      let i = 0;
      if (lead[0] === '\\') i = 2;
      else if (lead[0] === '[') {
        let depth = 0;
        for (; i < lead.length; i += 1) {
          if (lead[i] === '\\') i += 1;
          else if (lead[i] === '[') depth += 1;
          else if (lead[i] === ']') {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
        }
      } else if (lead[0] === '(') {
        let depth = 0;
        for (; i < lead.length; i += 1) {
          if (lead[i] === '\\') i += 1;
          else if (lead[i] === '(') depth += 1;
          else if (lead[i] === ')') {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
        }
      } else i = 1;
      const after = lead.slice(i);
      // `*` and `+` are unbounded; `{n,}` with no upper bound is the same shape
      // spelled longhand. `?` is bounded and `{n,m}` is bounded, so neither can
      // produce the blow-up.
      return /^(?:\*|\+|\{\d+,\})/.test(after);
    };

    it('found the pattern sites at all, so the census is not over an empty set', () => {
      // Without this the two assertions below pass vacuously the moment the
      // extractor stops matching - and a source-scraping extractor is exactly
      // the kind of thing that silently stops matching after a refactor.
      expect(sites.length).toBeGreaterThan(10);
      expect(sites.filter((s) => s.kind === 'new RegExp').length).toBeGreaterThan(5);
      expect(sites.filter((s) => s.kind === 'literal').length).toBeGreaterThan(2);
    });

    it('no pattern the sweep OWNS begins with an unanchored open-ended quantifier', () => {
      const bad = sites
        .filter((s) => s.lead !== null && restartsAtEveryOffset(s.lead))
        .map((s) => `${String(s.line)}: ${String(s.lead).slice(0, 60)}`);
      expect(bad, 'these patterns go quadratic on a long line').toEqual([]);
    });

    it('is a control, not a tautology: the predicate really does flag the shape', () => {
      // The 2026-09-03 pattern's shape, and the fix that was applied to it.
      expect(restartsAtEveryOffset('[A-Za-z0-9_]*foo')).toBe(true);
      expect(restartsAtEveryOffset('.*foo')).toBe(true);
      expect(restartsAtEveryOffset('(?:a|b)+foo')).toBe(true);
      expect(restartsAtEveryOffset('[A-Za-z]{2,}foo')).toBe(true);
      expect(restartsAtEveryOffset('(?<![A-Za-z0-9_])[A-Za-z0-9_]*foo')).toBe(false);
      // And the shapes this file really uses, which must NOT be flagged.
      expect(restartsAtEveryOffset('^(?:[A-Za-z]--|-)')).toBe(false);
      expect(restartsAtEveryOffset('(?:^|[^A-Za-z0-9_])')).toBe(false);
      expect(restartsAtEveryOffset('[Aa]uthorization')).toBe(false);
      expect(restartsAtEveryOffset('\\.claude')).toBe(false);
    });

    it('names the one pattern the sweep does not own, rather than counting it clean', () => {
      // Rule 18: a check that skips an input says so. This is the site that
      // compiles a token from the private identity file - the very place the
      // 2026-09-03 pattern lived - and no assertion in a public checkout can
      // reach the pattern it compiles.
      const unreadable = sites.filter((s) => s.lead === null);
      expect(unreadable).toHaveLength(1);
      expect(source.slice(0, source.length)).toContain('new RegExp(t.match');
    });

    it('the one fragment with a leading optional group is only ever used after ^', () => {
      // HOME_DIR_PREFIX_SRC opens with `(?:file:/{0,3})?`, which can match the
      // empty string. Anchored it is harmless and every use is anchored; spliced
      // into a pattern unanchored it would be this defect exactly. Checked here
      // because the extractor above only reads a site's FIRST fragment and so
      // sees `^` rather than what follows it.
      //
      // AND THE FILTER BELOW IS WRITTEN THE WAY IT IS BECAUSE THE OBVIOUS ONE
      // WAS WRONG. The first draft excluded any occurrence on a line beginning
      // `const `, meaning to skip the definition - which also skipped
      // `const CODEX_SCRATCH_RE = new RegExp(...)`, one of the two real uses.
      // Removing that use's `^` left this test GREEN. A filter that names the
      // one thing it is excluding cannot do that, so it names it.
      const uses = [...source.matchAll(/HOME_DIR_PREFIX_SRC/g)];
      const declaration = uses.filter(
        (u) =>
          source.slice(source.lastIndexOf('\n', u.index) + 1, u.index) ===
          'const ',
      );
      expect(declaration, 'the fragment is declared exactly once').toHaveLength(1);
      const spliced = uses.filter((u) => !declaration.includes(u));
      // The set is pinned by count beside the assertion over it (rule 19): a
      // splice site that stops being found is a splice site that stops being
      // checked, and the count is the cheapest thing that goes red for it.
      expect(spliced, 'HOME_DIR_PREFIX_SRC splice sites').toHaveLength(2);
      for (const u of spliced) {
        expect(
          source.slice(u.index - 3, u.index),
          `HOME_DIR_PREFIX_SRC spliced without a leading ^ at line ${String(
            source.slice(0, u.index).split('\n').length,
          )}`,
        ).toBe('^${');
      }
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2. Negative controls - a sweep that cannot fail is worthless
 * ------------------------------------------------------------------ */

describe('negative controls', () => {
  let planted: SweepReport;
  /** The same scratch tree swept with NO token file at all. */
  let unarmed: SweepReport;

  beforeAll(() => {
    planted = sweep({
      root: scratch,
      stamp: '1970-01-01T00:00:00.000Z',
      identityFile: inventedIdentityFile(scratch, ['LICENSE']),
    });
    unarmed = sweep({
      root: scratch,
      stamp: '1970-01-01T00:00:00.000Z',
      identityFile: path.join(scratch, 'there-is-no-such-file.json'),
    });
  }, 120_000);

  it('the scratch root is swept by directory walk with no history leg', () => {
    expect(planted.historyScope).toBe('skipped');
    expect(planted.history).toBeNull();
    expect(planted.head).toBeNull();
  });

  it('flags a planted identity and fails the gate on it', () => {
    expect(planted.config.identity.status).toBe('RUN');
    expect(planted.config.identity.tokenCount).toBe(2);
    const hits = planted.workingTree.identity.hits.filter((h) => h.path === 'planted/leak.txt');
    expect(hits.length).toBeGreaterThan(0);
    expect(planted.verdict.identity).toBeGreaterThan(0);
    expect(planted.verdict.pass).toBe(false);
  });

  it('reports the token NOTE and never the token itself', () => {
    const hits = planted.workingTree.identity.hits.filter((h) => h.path === 'planted/leak.txt');
    expect(hits[0]?.notes.join(' ')).toContain('invented');
    // The whole serialised leg, not just one finding: a leak through `config`,
    // through a path, or through a note would be just as published.
    const serialised = JSON.stringify({
      workingTree: planted.workingTree.identity,
      config: planted.config.identity,
      verdict: planted.verdict,
    });
    expect(serialised).not.toContain(NEEDLE);
    expect(serialised).not.toContain(SECOND_NEEDLE);
  });

  it('SKIPS the class with no token file, says so, and does not fail on the skip', () => {
    // The contributor's run, over a tree that DOES contain the planted identity.
    // Same bytes, same paths - only the token file is missing. The count goes to
    // zero because nothing was looked for, and the status is the only thing that
    // distinguishes this from a clean sweep.
    expect(unarmed.config.identity.status).toBe('SKIPPED');
    expect(unarmed.config.identity.reason).toContain('identity.local.json');
    expect(unarmed.config.identity.tokenCount).toBe(0);
    expect(unarmed.verdict.identityStatus).toBe('SKIPPED');
    expect(unarmed.verdict.identity).toBe(0);
    expect(unarmed.workingTree.identity.hits).toEqual([]);
    // And the skip alone does not change the verdict: this tree still fails, on
    // the planted secret and the planted foreign content, exactly as it does for
    // the armed run.
    expect(unarmed.verdict.secrets).toBeGreaterThan(0);
    expect(unarmed.verdict.foreign).toBeGreaterThan(0);
  });

  it('the verdict LINE carries the status, not just the JSON', () => {
    // The JSON is for tests; the line is what a human reads and what CI logs.
    // `identity=0` printed by a class that never ran is the fail-open reading,
    // so the printed form must be `SKIPPED(...)` and never a number.
    const armed = spawnSync(
      process.execPath,
      [SCRIPT, '--root', scratch, '--identity', inventedIdentityFile(scratch, ['LICENSE'])],
      { encoding: 'utf8' },
    );
    expect(armed.stdout).toMatch(/identity=[0-9]+ /);
    const skipped = spawnSync(
      process.execPath,
      [SCRIPT, '--root', scratch, '--identity', path.join(scratch, 'nope.json')],
      { encoding: 'utf8' },
    );
    expect(skipped.stdout).toContain('identity=SKIPPED(');
    expect(skipped.stdout).not.toMatch(/identity=[0-9]/);
  }, 60_000);

  it('flags a planted credential shape', () => {
    const hits = planted.workingTree.secrets.filter((h) => h.path === 'planted/config.env');
    expect(hits.length).toBe(1);
    expect(hits[0]?.rule).toBe('anthropic-api-key');
  });

  it('never prints the matched secret value', () => {
    const serialised = JSON.stringify(planted);
    expect(serialised).not.toContain(PLANTED_SECRET);
    // ...but it does say where to look and roughly what it was.
    expect(serialised).toContain('chars redacted');
  });

  it('diverts the SAME identity under an exempt path, and still reads it', () => {
    // Identical bytes, two paths, one of them in the token file's own
    // `exemptPaths`. The exempt one must not be a finding AND must not be
    // invisible: a licence that has stopped naming its licensor is a broken
    // release that would read as a clean sweep, so the count is what proves the
    // scan reached it.
    expect(planted.workingTree.identity.hits.some((h) => h.path === 'LICENSE')).toBe(false);
    expect(planted.workingTree.identity.exemptHits).toBeGreaterThan(0);
    expect(planted.config.identity.exemptPaths).toEqual(['LICENSE']);
  });

  it('reads past 1000 NUL bytes and still finds the marker behind them', () => {
    expect(planted.workingTree.nulFiles).toContain('planted/nul-hazard.bin');
    const hits = planted.workingTree.identity.hits.filter(
      (h) => h.path === 'planted/nul-hazard.bin',
    );
    expect(hits.length).toBeGreaterThan(0);
    // The marker sits AFTER the NUL run, so its line number proves the scanner
    // did not stop at the first NUL.
    expect(hits[0]?.line).toBeGreaterThan(1);
  });

  it('flags a capture-corpus cwd naming a different project as FOREIGN', () => {
    const hits = planted.workingTree.foreign.filter(
      (h) => h.path === 'fixtures/hook-events/planted-foreign.jsonl',
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.kind).toBe('key:cwd');
    expect(hits[0]?.value).toContain('totally-different-project');
  });

  it('flags the SAME bytes under fixtures/, src/ and a root file alike', () => {
    // The carry-out this closes, stated as the measurement that found it: with
    // the eight-entry corpus list these two paths produced ZERO hits while the
    // fixtures path above produced 3, from byte-identical content. Asserting
    // each path by name rather than a total, because a total would go green if
    // one of them regressed and the other doubled.
    for (const rel of FOREIGN_PLANT_PATHS) {
      const hits = planted.workingTree.foreign.filter((h) => h.path === rel);
      expect(hits.length, `no FOREIGN hit for the plant at ${rel}`).toBeGreaterThan(0);
      expect(hits[0]?.kind).toBe('key:cwd');
      expect(hits[0]?.value).toContain('totally-different-project');
    }
    // The plant under src/ is covered by the `tests-and-testdata` ALLOW rule,
    // which is about identifiers. It must not have forgiven the content.
    expect(
      planted.workingTree.foreign.some((h) => h.path === 'src/model/leak.test.ts'),
    ).toBe(true);
  });

  it('does not flag a regex literal that merely spells the key name', () => {
    // The `not-an-absolute-location` exemption, controlled. Widening the
    // corpora made the scanner capture this regex's own body as if it were a
    // cwd value; 29 of the 32 raw hits were this one literal in seven files.
    expect(planted.workingTree.foreign.filter((h) => h.path === 'src/parser/regex-literal.ts')).toEqual(
      [],
    );
  });

  describe('Wave 0: five shapes, one rule, no shape forgiven for its syntax', () => {
    it.each(PARITY_SHAPES)('$id -> flagged=$expectFlagged ($why)', (shape) => {
      const hits = planted.workingTree.foreign.filter((h) => h.path === shape.file);
      expect(hits.length > 0, `${shape.id}: ${shape.why}`).toBe(shape.expectFlagged);
    });

    it('flags every location shape and exempts only the non-location', () => {
      // Stated once more as a set, so a future edit that flips two shapes in
      // opposite directions cannot pass the per-shape assertions above by
      // accident. Parity is the property; the rows are the evidence.
      const flagged = PARITY_SHAPES.filter(
        (s) => planted.workingTree.foreign.some((h) => h.path === s.file),
      ).map((s) => s.id);
      expect([...flagged].sort()).toEqual(
        [...PARITY_SHAPES.filter((s) => s.expectFlagged).map((s) => s.id)].sort(),
      );
      expect(flagged).toHaveLength(4);
    });

    it('is a control, not a tautology: four of the five really are locations', () => {
      // If someone "fixes" a failure by setting expectFlagged to false, this
      // fails instead. The count is the contract.
      expect(PARITY_SHAPES.filter((s) => s.expectFlagged)).toHaveLength(4);
      expect(PARITY_SHAPES.filter((s) => !s.expectFlagged)).toHaveLength(1);
      expect(new Set(PARITY_SHAPES.map((s) => s.file)).size).toBe(PARITY_SHAPES.length);
    });

    it('names the narrowed exemption, so a rename cannot orphan this control', () => {
      const ids = planted.config.foreignValueExemptions.map((r) => r.id);
      expect(ids).toContain('regex-source-not-a-location');
      expect(ids).not.toContain('not-an-absolute-location');
    });
  });

  describe('v0.6.0 Phase 1 (widened Phase 3): the Codex exemptions forgive three shapes and nothing else', () => {
    it.each(CODEX_SHAPES)('$id -> flagged=$expectFlagged ($why)', (shape) => {
      const hits = planted.workingTree.foreign.filter((h) => h.path === shape.file);
      expect(hits.length > 0, `${shape.id}: ${shape.why}`).toBe(shape.expectFlagged);
    });

    it('is a control, not a tautology: three exempt, three gating, six distinct files', () => {
      // Without this, "fixing" a red row by flipping expectFlagged passes.
      expect(CODEX_SHAPES.filter((s) => s.expectFlagged)).toHaveLength(3);
      expect(CODEX_SHAPES.filter((s) => !s.expectFlagged)).toHaveLength(3);
      expect(new Set(CODEX_SHAPES.map((s) => s.file)).size).toBe(CODEX_SHAPES.length);
      // And the pairing is the point: each gating row shares the exempt row's
      // home directory, so a rule written as a directory prefix cannot pass.
      // Two families of value (path-shaped, slug-shaped) share no common
      // substring, so each is checked against its own home-directory spelling.
      const home = (s: (typeof CODEX_SHAPES)[number]): boolean =>
        s.key === PROJECT_SLUG_KEY
          ? s.value.startsWith(CODEX_HOME_SLUG)
          : s.value.startsWith(CODEX_HOME);
      expect(CODEX_SHAPES.every(home)).toBe(true);
    });

    it('names all three exemptions, so a rename cannot orphan this control', () => {
      const ids = planted.config.foreignValueExemptions.map((r) => r.id);
      expect(ids).toContain('codex-probe-scratch-repo');
      expect(ids).toContain('codex-rollout-transcript-path');
      expect(ids).toContain('codex-probe-scratch-repo-slug');
    });

    it('no Codex exemption is scoped to a path, which is what makes each a value rule', () => {
      // A `paths` entry on any would reintroduce the whole-directory ALLOW
      // PREFIX shape the two `capture-opencode-*` rules had - the recorded
      // reason foreign content inside those corpora could never gate.
      const codex = planted.config.foreignValueExemptions.filter((r) =>
        r.id.startsWith('codex-'),
      );
      expect(codex).toHaveLength(3);
      for (const rule of codex) {
        expect(rule.paths, `${rule.id} is path-scoped`).toBeNull();
      }
    });
  });

  it('fails the gate when anything is planted', () => {
    expect(planted.verdict.pass).toBe(false);
    expect(planted.verdict.identity).toBeGreaterThan(0);
    expect(planted.verdict.secrets).toBeGreaterThan(0);
    expect(planted.verdict.foreign).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2b. DoD 0.6 - the untracked blind spot, documented rather than hidden
 *
 * The working-tree leg enumerates `git ls-files`. A capture copied into
 * `fixtures/` and never staged is therefore never opened, and the sweep
 * prints a clean PASS over a corpus that is not there. That is not a
 * hypothetical: it happened during the 2026-08-26 OpenCode recon, and the
 * only visible symptom was the run getting FASTER.
 *
 * This control asserts BOTH halves - `--untracked` finds the planted file,
 * and the default mode does not. The second assertion is the point: the
 * blind spot is recorded as a measured property of the default mode, not
 * quietly patched over.
 *
 * It builds a throwaway git repository under the OS temp directory rather
 * than planting inside this one. Same reason every other control here uses
 * a scratch root: a test that writes into `fixtures/` to prove a point
 * about `fixtures/` can fail dirty, and this suite must never leave the
 * repository modified.
 * ------------------------------------------------------------------ */

describe('untracked mode', () => {
  let repo = '';
  let tracked: SweepReport;
  let withUntracked: SweepReport;

  const PLANTED_UNTRACKED = 'fixtures/synthetic-untracked/planted-capture.jsonl';

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-untracked-'));
    const run = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    };
    run('init', '-q');
    run('config', 'user.email', 'control@example.invalid');
    run('config', 'user.name', 'control');

    // A tracked, innocuous file, so the repo has a commit and `git ls-files`
    // returns something. A control over an empty enumeration proves nothing.
    fs.mkdirSync(path.join(repo, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'fixtures', 'tracked.txt'), 'nothing to see\n');
    run('add', 'fixtures/tracked.txt');
    run('commit', '-qm', 'control baseline');

    // ...and the planted capture: gitignored, so it is untracked by
    // construction and cannot be staged by accident.
    fs.writeFileSync(path.join(repo, '.gitignore'), 'fixtures/synthetic-untracked/\n');
    const planted = path.join(repo, 'fixtures', 'synthetic-untracked');
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(
      path.join(planted, 'planted-capture.jsonl'),
      parityLine(`C:\\\\Users\\\\${NEEDLE}\\\\src\\\\${PARITY_PROJECT}`) +
        `ANTHROPIC_API_KEY=${PLANTED_SECRET}\n`,
    );

    tracked = sweep({ root: repo, history: false, stamp: '1970-01-01T00:00:00.000Z' });
    withUntracked = sweep({
      root: repo,
      history: false,
      untracked: true,
      stamp: '1970-01-01T00:00:00.000Z',
    });
  }, 120_000);

  afterAll(() => {
    if (repo !== '') fs.rmSync(repo, { recursive: true, force: true });
  });

  it('the scratch repo is a real git repo whose planted file is untracked', () => {
    // Guard on the guard. If `git init` silently failed, the sweep would fall
    // back to a directory walk, BOTH modes would find the plant, and the
    // "absent in default mode" assertion below would fail for the wrong reason.
    const listed = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.length > 0);
    expect(listed).toEqual(['fixtures/tracked.txt']);
    expect(fs.existsSync(path.join(repo, PLANTED_UNTRACKED))).toBe(true);
  });

  it('DEFAULT mode never opens the untracked capture - the blind spot, measured', () => {
    expect(tracked.config.untracked).toBe(false);
    expect(tracked.config.untrackedFilesScanned).toBe(0);
    expect(tracked.workingTree.foreign).toEqual([]);
    expect(tracked.workingTree.secrets).toEqual([]);
    expect(tracked.verdict.pass).toBe(true);
    // The shape of the failure: a PASS whose file count says why.
    expect(tracked.workingTree.filesScanned).toBe(1);
  });

  it('--untracked reads it, and fails the gate on what is inside', () => {
    expect(withUntracked.config.untracked).toBe(true);
    expect(withUntracked.config.untrackedScanDirs).toContain('fixtures');
    expect(withUntracked.config.untrackedFilesScanned).toBeGreaterThan(0);
    expect(withUntracked.workingTree.filesScanned).toBeGreaterThan(
      tracked.workingTree.filesScanned,
    );

    expect(withUntracked.workingTree.foreign.map((h) => h.path)).toContain(PLANTED_UNTRACKED);
    expect(withUntracked.workingTree.secrets.map((h) => h.path)).toContain(PLANTED_UNTRACKED);
    expect(withUntracked.verdict.pass).toBe(false);
  });

  it('gitignore does not hide a capture from --untracked', () => {
    // The planted file is ignored. An implementation that consulted
    // `.gitignore` would reproduce the exact blind spot this mode exists to
    // close, and would still pass every assertion above except this one.
    const ignored = execFileSync(
      'git',
      ['-C', repo, 'check-ignore', '-q', PLANTED_UNTRACKED],
      { stdio: 'pipe' },
    );
    expect(ignored).toBeDefined();
    expect(withUntracked.workingTree.foreign.some((h) => h.path === PLANTED_UNTRACKED)).toBe(true);
  });

  it('scans nothing extra when there is nothing extra, and never double-counts', () => {
    // A file already tracked must not be read twice just because the walk
    // reaches it. Both legs see fixtures/tracked.txt; it appears once.
    const dup = withUntracked.workingTree.filesScanned - tracked.workingTree.filesScanned;
    expect(dup).toBe(withUntracked.config.untrackedFilesScanned);
  });
});

/* ------------------------------------------------------------------ *
 * 3. v0.6.0 DoD 5.0d - an exemption's reason describes THIS run
 *
 * Five figures used to be frozen into the three Codex exemption reasons: a
 * corpus total, a rule's share of it twice over, and a two-way split of one of
 * those shares by value spelling. All five re-derived on the day they were
 * written. All five would have gone false on the next harvest, silently, in a
 * file no harvest touches - and this repository has already had the other
 * version of that accident, a count invalidated by a corpus somebody REMOVED
 * in an unrelated commit.
 *
 * The counts are now composed by the run. What follows is what makes that
 * checkable rather than merely claimed:
 *
 *   - every standalone integer after the marker is one of the numbers the run
 *     derived, so hard-coding a September literal back into the sentence goes
 *     red even though the sentence still reads perfectly;
 *   - the SAME rule reports different numbers over two different trees, which
 *     no constant can do;
 *   - one published count is re-derived here from `git ls-files`, by different
 *     code, so a census that stopped counting would be caught rather than
 *     believed;
 *   - and over a tree with no Codex corpus at all the sentence SAYS the corpus
 *     is absent and prints no number, because rule 18 applies to a census too:
 *     a zero is evidence only when something says what was looked at.
 *
 * None of these asserts a count. A count written here would be the same defect
 * one file to the left.
 * ------------------------------------------------------------------ */

const CODEX_RULE_IDS = [
  'codex-probe-scratch-repo',
  'codex-probe-scratch-repo-slug',
  'codex-rollout-transcript-path',
] as const;

/**
 * Standalone integers only.
 *
 * A corpus directory name is full of digits that are not counts -
 * `fixtures/codex-0.151.0-alpha.7.2` alone contributes five digit runs - so a
 * naive `\d+` would let a hard-coded literal hide among them, or fail on a
 * sentence that is perfectly correct. A count is a digit run touching neither
 * a word character, a dot nor a hyphen on either side.
 */
function standaloneIntegers(text: string): string[] {
  return [...text.matchAll(/(?<![\w.-])\d+(?![\w.-])/g)].map((m) => m[0]);
}

/** Every number the run derived for one rule, as the sentence would spell it. */
function derivedNumbers(m: Measured): Set<string> {
  const out = new Set<string>();
  for (const n of [
    m.occurrences,
    m.distinctValues,
    m.fileCount,
    m.codexCorpora.filesScanned,
    m.codexCorpora.candidates,
    m.codexCorpora.forgivenHere,
  ]) {
    out.add(String(n));
  }
  for (const n of Object.values(m.shapes)) out.add(String(n));
  for (const n of Object.values(m.codexCorpora.shapes)) out.add(String(n));
  return out;
}

function ruleOf(report: SweepReport, id: string): SweepReport['config']['foreignValueExemptions'][number] {
  const rule = report.config.foreignValueExemptions.find((r) => r.id === id);
  if (rule === undefined) throw new Error(`no such exemption: ${id}`);
  return rule;
}

/** The run-derived tail of a reason: everything after the published marker. */
function measuredSentence(report: SweepReport, id: string): string {
  const rule = ruleOf(report, id);
  const at = rule.reason.indexOf(report.config.measuredMarker);
  if (at === -1) throw new Error(`exemption ${id} states no measurement`);
  return rule.reason.slice(at + report.config.measuredMarker.length);
}

describe('the exemption reasons are composed from the run, not written down', () => {
  /** This repository, working-tree leg only: the census is working-tree scoped. */
  let real: SweepReport;
  /** The planted scratch tree, which carries one file per Codex shape. */
  let plantedTree: SweepReport;
  /** A tree with no Codex data in it at all. */
  let bare: SweepReport;
  let bareRoot = '';
  /** Tracked files under a Codex corpus, counted here rather than by the sweep. */
  let codexCorpusFiles: string[] = [];

  beforeAll(() => {
    real = sweep({ root: REPO_ROOT, history: false, stamp: '1970-01-01T00:00:00.000Z' });
    plantedTree = sweep({ root: scratch, stamp: '1970-01-01T00:00:00.000Z' });
    bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-no-codex-'));
    fs.writeFileSync(path.join(bareRoot, 'README.md'), 'a tree with no capture in it\n');
    bare = sweep({ root: bareRoot, stamp: '1970-01-01T00:00:00.000Z' });

    codexCorpusFiles = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\0')
      .filter((p) => /^fixtures\/codex-[^/]+\//.test(p));
  }, 120_000);

  afterAll(() => {
    if (bareRoot !== '') fs.rmSync(bareRoot, { recursive: true, force: true });
  });

  it('every exemption states a measurement, after its durable prose', () => {
    // The marker is published by the sweep, not written down twice: a literal
    // repeated on both sides of a boundary is the silent-seam class this
    // repository already shipped once between the host and the webview.
    expect(real.config.measuredMarker.length).toBeGreaterThan(0);
    expect(real.config.foreignValueExemptions.length).toBeGreaterThan(0);
    for (const rule of real.config.foreignValueExemptions) {
      const at = rule.reason.indexOf(real.config.measuredMarker);
      expect(at, `${rule.id} states no measurement`).toBeGreaterThan(0);
      expect(measuredSentence(real, rule.id).length, rule.id).toBeGreaterThan(20);
    }
  });

  it('every number a reason states is a number this run derived', () => {
    // THE ASSERTION THAT CATCHES A LITERAL. A September figure written back
    // into the prose still reads correctly and still describes the corpus it
    // was taken over; what it cannot do is be one of the numbers this run just
    // counted. Note it is a positive check on each printed integer, not a
    // "nothing unexpected" counter - a counter of what is missing is satisfied
    // by an empty sentence.
    for (const rule of real.config.foreignValueExemptions) {
      const sentence = measuredSentence(real, rule.id);
      const printed = standaloneIntegers(sentence);
      const derived = derivedNumbers(rule.measured);
      expect(printed.length, `${rule.id} prints no count at all`).toBeGreaterThan(0);
      for (const n of printed) {
        expect(
          derived.has(n),
          `${rule.id} states ${n}, which this run did not derive: ${sentence}`,
        ).toBe(true);
      }
    }
  });

  it('the run measured a live population for every rule, per rule and positively', () => {
    // Per-subject and positive: a total over all rules would be satisfied by
    // one busy rule carrying six dead ones, which is exactly the state the
    // dead-rule guard exists to find.
    for (const rule of real.config.foreignValueExemptions) {
      expect(rule.measured.occurrences, `${rule.id} forgave nothing`).toBeGreaterThan(0);
      expect(rule.measured.distinctValues, `${rule.id} has no distinct value`).toBeGreaterThan(0);
      expect(rule.measured.fileCount, `${rule.id} names no file`).toBeGreaterThan(0);
      expect(rule.measured.scope).toBe('working tree');
    }
  });

  it('re-derives the census denominator from git, by different code', () => {
    // The published `filesScanned` is what the sweep OPENED inside a Codex
    // corpus. Recomputed here from `git ls-files` so that a census which
    // stopped counting - or was replaced by a constant - disagrees with a
    // second reader instead of being taken at its word.
    expect(codexCorpusFiles.length).toBeGreaterThan(0);
    // The corpus half of the census is run-wide, so any rule carries it.
    const corpora = ruleOf(real, 'codex-probe-scratch-repo').measured.codexCorpora;
    expect(corpora.filesScanned).toBe(codexCorpusFiles.length);
    expect(corpora.present.length).toBeGreaterThan(0);
    for (const dir of corpora.present) {
      expect(fs.existsSync(path.join(REPO_ROOT, dir)), `${dir} does not exist`).toBe(true);
      expect(codexCorpusFiles.some((p) => p.startsWith(`${dir}/`))).toBe(true);
    }
    expect(corpora.candidates).toBeGreaterThan(0);
  });

  it('the working-tree accounting closes over the census, not just over the run', () => {
    // `forgiven` in the report spans both legs; `measured.occurrences` is the
    // working-tree half. This is the conservation law for that half, and the
    // vacuity control is the assertion above it: candidates are non-zero.
    const forgiven = real.config.foreignValueExemptions.reduce(
      (n, r) => n + r.measured.occurrences,
      0,
    );
    expect(real.workingTree.foreignCandidates).toBeGreaterThan(0);
    expect(forgiven + real.workingTree.foreign.length).toBe(real.workingTree.foreignCandidates);
  });

  it('the SAME rule reports different numbers over a different tree', () => {
    // A constant cannot be right in both runs, which is what "computed" means
    // operationally. The planted tree carries exactly one file per Codex
    // shape; this repository carries a corpus.
    for (const id of CODEX_RULE_IDS) {
      const here = ruleOf(real, id).measured;
      const there = ruleOf(plantedTree, id).measured;
      expect(there.occurrences, `${id} found nothing in the planted tree`).toBeGreaterThan(0);
      expect(here.occurrences, `${id} did not move between two trees`).not.toBe(
        there.occurrences,
      );
      expect(measuredSentence(real, id)).not.toBe(measuredSentence(plantedTree, id));
      // And each sentence's numbers belong to ITS OWN run.
      for (const n of standaloneIntegers(measuredSentence(plantedTree, id))) {
        expect(
          derivedNumbers(there).has(n),
          `${id} states ${n} over the planted tree, which that run did not derive`,
        ).toBe(true);
      }
    }
  });

  it('names the capture keys a shape arrived under, rather than asserting them', () => {
    // The rollout reason used to name `transcript_path` and
    // `agent_transcript_path` as a written claim. The run says which keys it
    // saw; a harvest that starts reporting a third one changes the sentence.
    const keys = ruleOf(real, 'codex-rollout-transcript-path').measured.keys;
    expect(keys.length).toBeGreaterThan(0);
    const sentence = measuredSentence(real, 'codex-rollout-transcript-path');
    for (const key of keys) expect(sentence).toContain(key);
  });

  it('states the ABSENCE of a Codex corpus rather than printing a confident zero', () => {
    // Rule 18 applied to a census. Over a tree with no Codex data the honest
    // report is "there is no corpus here", not "0 of 0" - a zero reads as a
    // measurement, and this repository has had a clean PASS over an absent
    // corpus for real.
    for (const id of CODEX_RULE_IDS) {
      const m = ruleOf(bare, id).measured;
      expect(m.codexCorpora.present, id).toEqual([]);
      const sentence = measuredSentence(bare, id);
      // Lowercased on the way in: the slug rule starts a sentence with this
      // clause and the other two embed it mid-sentence, so the capital is a
      // property of the position rather than of the claim.
      expect(sentence.toLowerCase(), id).toContain(
        'no codex capture corpus (fixtures/codex-*) is present',
      );
      // No number is printed at all, so no zero can be read as evidence.
      expect(standaloneIntegers(sentence), `${id}: ${sentence}`).toEqual([]);
      expect(sentence).not.toBe(measuredSentence(real, id));
    }
  });

  it('still GATES: deriving a count did not turn an exemption into an advisory', () => {
    // The point of the whole file. The three near misses share the exempt
    // shapes' home directory and must still be FOREIGN, and the planted tree
    // must still fail.
    expect(plantedTree.verdict.pass).toBe(false);
    expect(plantedTree.verdict.foreign).toBeGreaterThan(0);
    for (const shape of CODEX_SHAPES.filter((s) => s.expectFlagged)) {
      expect(
        plantedTree.workingTree.foreign.some((h) => h.path === shape.file),
        `${shape.id} stopped gating`,
      ).toBe(true);
    }
    // And identity stays a hard failure (G8) - the class that never had a
    // count in it and must not acquire an exemption by proximity.
    expect(bare.verdict.identityStatus).toBe('SKIPPED');
  });
});

