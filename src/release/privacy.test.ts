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

import { execFileSync } from 'node:child_process';
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

interface IdentifierHit {
  path: string;
  line: number;
  needle: string;
  scope: string;
  /* `pathToken`, not `token`: a JSON key named `token` holding a 24+ character
     path made the committed report trip the sweep's own generic-secret rule,
     24 times. The detector was right; the key name was wrong. */
  pathToken: string;
}

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

interface AllowedRuleTally {
  rule: string;
  reason: string;
  hits: number;
  fileCount: number;
  files: { path: string; hits: number }[];
  distinctPathTokens: { pathToken: string; hits: number }[];
}

interface SweepLeg {
  filesScanned: number;
  bytesScanned: number;
  blobsScanned?: number;
  nulFiles: string[];
  identifier: {
    totalHits: number;
    allowed: { totalHits: number; byRule: AllowedRuleTally[] };
    unexpected: IdentifierHit[];
  };
  advisories: { path: string; line: number; rule: string; pathToken: string }[];
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
    ownProject: string;
    allowRules: { id: string; prefixes: string[]; reason: string }[];
    captureCorpora: string[];
    captureRootFiles: boolean;
    foreignValueExemptions: {
      id: string;
      paths: string[] | null;
      absolutePathValuesOnly: boolean;
      reason: string;
    }[];
    identityScanExcluded: string[];
  };
  workingTree: SweepLeg;
  history: SweepLeg | null;
  verdict: {
    unexpected: number;
    secrets: number;
    foreign: number;
    advisories: number;
    pass: boolean;
  };
  timingsMs: { workingTreeMs: number; historyMs?: number };
}

interface SweepOptions {
  root?: string;
  history?: boolean;
  stamp?: string;
}

type SweepModule = { sweep: (options?: SweepOptions) => SweepReport };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'privacy-sweep.mjs');
const EVIDENCE = path.join(REPO_ROOT, 'docs', 'evidence', 'privacy', 'report.json');

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

/** Assembled at runtime so this file is not itself a hit on the next sweep. */
const NEEDLE = ['Na', 'dav'].join('');
const SECOND_NEEDLE = ['One', 'Drive'].join('');
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
  'docs/notes.md',
] as const;

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

  // (b) the SAME identifier at a path an allow rule DOES cover.
  writeScratch(
    'fixtures/hook-events/planted-allowed.jsonl',
    `{"hook_event_name":"Stop","cwd":"C:\\\\Users\\\\${NEEDLE}\\\\${SECOND_NEEDLE}\\\\agent-deck"}\n`,
  );

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
});

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
  });

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

  it('finds no developer-identifier hit outside the enumerated allowed set', () => {
    expect(report.workingTree.identifier.unexpected).toEqual([]);
    expect(report.history?.identifier.unexpected).toEqual([]);
    expect(report.verdict.unexpected).toBe(0);
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

  it('inventories the three deliberately non-anonymous directories', () => {
    const rules = new Map(report.workingTree.identifier.allowed.byRule.map((r) => [r.rule, r]));
    for (const id of ['capture-hook-events', 'capture-cc-2.1.234', 'wire-corpus']) {
      const tally = rules.get(id);
      expect(tally, `expected allow rule ${id} to have inventoried hits`).toBeDefined();
      expect(tally?.hits ?? 0).toBeGreaterThan(0);
      expect(tally?.reason.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('finds the forward-slash paths inside the recorded wire corpus', () => {
    // The trap this exists for: `webview/wire/cc-2.1.234-session-arc.json`
    // stores backslash paths DOUBLE-ESCAPED, so `grep 'C:\Users'` returns 0
    // while forward-slash `c:/Users/...` hits sit in recorded Bash payloads.
    // Sweeping for the identifier rather than the path shape is what finds them.
    const wire = report.workingTree.identifier.allowed.byRule.find((r) => r.rule === 'wire-corpus');
    expect(wire).toBeDefined();
    const tokens = (wire?.distinctPathTokens ?? []).map((t) => t.pathToken);
    const folder = `/${SECOND_NEEDLE.toLowerCase()}/`;
    expect(tokens.some((t) => t.includes(folder))).toBe(true);
  });

  it('every allow rule carries a written reason', () => {
    for (const rule of report.config.allowRules) {
      expect(rule.reason.length, `allow rule ${rule.id} has no reason`).toBeGreaterThan(20);
      expect(rule.prefixes.length).toBeGreaterThan(0);
    }
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
    });

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
   * DoD5 - the surname is inventoried rather than invisible.
   * ---------------------------------------------------------------- */
  describe('the surname needle', () => {
    it('reaches the release-identity files that no other needle touches', () => {
      // Measured: `package.json` and `.github/workflows/release.yml` contain
      // NONE of the four pre-Phase-6 needles (0 case-insensitive matches for
      // each). Every hit attributed to these two rules therefore exists only
      // because the surname is swept - which makes this assertion a live test
      // of the needle, not of the allow rule.
      const rules = new Map(report.workingTree.identifier.allowed.byRule.map((r) => [r.rule, r]));
      const manifest = rules.get('release-identity-manifest');
      expect(manifest, 'package.json is not being inventoried at all').toBeDefined();
      expect(manifest?.files.map((f) => f.path)).toContain('package.json');
      expect(manifest?.hits ?? 0).toBeGreaterThan(0);

      const workflows = rules.get('release-workflows');
      expect(workflows, '.github/ is not being inventoried at all').toBeDefined();
      expect(workflows?.files.map((f) => f.path)).toContain('.github/workflows/release.yml');
    });

    it('finds it in the licence, where it is the copyright line working', () => {
      const licence = report.workingTree.identifier.allowed.byRule.find((r) => r.rule === 'licence');
      expect(licence?.files.map((f) => f.path)).toContain('LICENSE');
      // Two needles on one line - the given name and the surname - so a hit
      // count of 1 would mean the surname is not being swept after all.
      expect(licence?.hits ?? 0).toBeGreaterThan(1);
    });

    it('does not make the sweep script a hit on its own detector', () => {
      // The fragment convention, asserted rather than trusted. Adding the
      // surname turned the old two-way split of the email local part into a
      // hit here; the fix is a three-way split, and this is what keeps it.
      const inSweep = [
        ...report.workingTree.identifier.allowed.byRule.flatMap((r) =>
          r.files.filter((f) => f.path === 'scripts/privacy-sweep.mjs'),
        ),
        ...report.workingTree.identifier.unexpected.filter(
          (h) => h.path === 'scripts/privacy-sweep.mjs',
        ),
      ];
      expect(inSweep, 'the sweep script trips its own needles - re-split the fragments').toEqual(
        [],
      );
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2. Negative controls - a sweep that cannot fail is worthless
 * ------------------------------------------------------------------ */

describe('negative controls', () => {
  let planted: SweepReport;

  beforeAll(() => {
    planted = sweep({ root: scratch, stamp: '1970-01-01T00:00:00.000Z' });
  });

  it('the scratch root is swept by directory walk with no history leg', () => {
    expect(planted.historyScope).toBe('skipped');
    expect(planted.history).toBeNull();
    expect(planted.head).toBeNull();
  });

  it('flags a planted developer identifier outside the allowed set', () => {
    const hits = planted.workingTree.identifier.unexpected.filter(
      (h) => h.path === 'planted/leak.txt',
    );
    expect(hits.length).toBeGreaterThan(0);
  });

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

  it('classifies the same identifier as ALLOWED under a known-allowed path', () => {
    const allowedPath = 'fixtures/hook-events/planted-allowed.jsonl';
    expect(
      planted.workingTree.identifier.unexpected.some((h) => h.path === allowedPath),
    ).toBe(false);
    const rule = planted.workingTree.identifier.allowed.byRule.find(
      (r) => r.rule === 'capture-hook-events',
    );
    expect(rule?.files.some((f) => f.path === allowedPath)).toBe(true);
  });

  it('reads past 1000 NUL bytes and still finds the marker behind them', () => {
    expect(planted.workingTree.nulFiles).toContain('planted/nul-hazard.bin');
    const hits = planted.workingTree.identifier.unexpected.filter(
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

  it('flags the SAME bytes under src/ and under docs/, which Phase 5 did not', () => {
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

  it('fails the gate when anything is planted', () => {
    expect(planted.verdict.pass).toBe(false);
    expect(planted.verdict.unexpected).toBeGreaterThan(0);
    expect(planted.verdict.secrets).toBeGreaterThan(0);
    expect(planted.verdict.foreign).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The committed evidence
 * ------------------------------------------------------------------ */

describe('committed evidence', () => {
  let evidence: SweepReport;
  let fresh: SweepReport;

  beforeAll(() => {
    evidence = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as SweepReport;
    fresh = sweep({ root: REPO_ROOT, history: true, stamp: '1970-01-01T00:00:00.000Z' });
  });

  it('exists, parses, and names the tool and the commit it was taken at', () => {
    expect(evidence.tool).toBe('scripts/privacy-sweep.mjs');
    expect(evidence.head).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('recorded a passing gate', () => {
    expect(evidence.verdict).toMatchObject({
      unexpected: 0,
      secrets: 0,
      foreign: 0,
      pass: true,
    });
  });

  it('recorded both legs', () => {
    expect(evidence.historyScope).toBe('all-refs');
    expect(evidence.history).not.toBeNull();
    expect(evidence.workingTree.filesScanned).toBeGreaterThan(0);
    expect(evidence.history?.blobsScanned ?? 0).toBeGreaterThan(0);
  });

  it('carries the enumerated inventory, not just a verdict', () => {
    expect(evidence.workingTree.identifier.allowed.byRule.length).toBeGreaterThan(0);
    for (const rule of evidence.workingTree.identifier.allowed.byRule) {
      expect(rule.files.length).toBeGreaterThan(0);
      expect(rule.distinctPathTokens.length).toBeGreaterThan(0);
      expect(rule.reason.length).toBeGreaterThan(20);
    }
  });

  it('agrees with a fresh sweep on the properties that must be empty', () => {
    // Emptiness and structure only. Hit COUNTS are deliberately not compared:
    // the evidence file is itself tracked afterwards, history spans unmerged
    // sibling branches, and the next fixture harvest moves every total. A
    // pinned count here would read as a regression the first time either
    // happens.
    expect(fresh.reportVersion).toBe(evidence.reportVersion);
    expect(fresh.verdict.pass).toBe(evidence.verdict.pass);
    expect(fresh.verdict.unexpected).toBe(0);
    expect(fresh.verdict.secrets).toBe(0);
    expect(fresh.verdict.foreign).toBe(0);
    expect(fresh.config.ownProject).toBe(evidence.config.ownProject);
    expect(fresh.config.allowRules.map((r) => r.id)).toEqual(
      evidence.config.allowRules.map((r) => r.id),
    );
    expect(fresh.config.captureCorpora).toEqual(evidence.config.captureCorpora);
    expect(fresh.config.captureRootFiles).toBe(evidence.config.captureRootFiles);
    expect(fresh.config.foreignValueExemptions.map((r) => r.id)).toEqual(
      evidence.config.foreignValueExemptions.map((r) => r.id),
    );
    expect(fresh.config.identityScanExcluded).toEqual(evidence.config.identityScanExcluded);
  });

  it('the report file, and only it, is excluded from the identifier inventory', () => {
    // The report quotes every path it found, so inventorying it would make each
    // run a function of the previous one. Secrets and foreign content are still
    // scanned there. The exemption stops at the generated file - the README
    // beside it is human prose and is swept like anything else.
    expect(fresh.config.identityScanExcluded).toEqual(['docs/evidence/privacy/report.json']);
    const allFiles = [
      ...fresh.workingTree.identifier.allowed.byRule.flatMap((r) => r.files.map((f) => f.path)),
      ...fresh.workingTree.identifier.unexpected.map((h) => h.path),
    ];
    expect(allFiles).not.toContain('docs/evidence/privacy/report.json');
  });

  it('the history leg is cheap enough not to need an env gate', () => {
    // Stated as a number rather than an adjective. If this ever fails, gate the
    // history leg and update the docblock at the top of this file - do not
    // raise the bound quietly.
    expect(fresh.timingsMs.historyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(10_000);
  });
});
