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
  nulFiles: string[];
  identity: { hits: IdentityHit[]; exemptHits: number };
  secrets: SecretHit[];
  foreign: ForeignHit[];
}

interface SweepReport {
  tool: string;
  reportVersion: number;
  generatedAt: string;
  head: string | null;
  historyScope: 'all-refs' | 'skipped';
  config: {
    identity: {
      status: 'RUN' | 'SKIPPED';
      reason: string | null;
      tokenCount: number;
      exemptPaths: string[];
    };
    ownProject: string;
    captureCorpora: string[];
    captureRootFiles: boolean;
    foreignValueExemptions: {
      id: string;
      paths: string[] | null;
      absolutePathValuesOnly: boolean;
      reason: string;
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

  it('actually swept history, not just the working tree', () => {
    expect(report.historyScope).toBe('all-refs');
    expect(report.history).not.toBeNull();
    expect(report.history?.blobsScanned ?? 0).toBeGreaterThan(0);
    // History must cover blobs the working tree does not - otherwise "full
    // history" is just the checkout under another name.
    expect(report.history?.bytesScanned ?? 0).toBeGreaterThan(report.workingTree.bytesScanned);
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

