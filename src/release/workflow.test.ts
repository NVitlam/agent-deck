/**
 * CI/release workflow assertions.
 *
 * WHAT THIS FILE DOES NOT PROVE, said first because it is the thing most likely
 * to be misread: **no assertion here proves CI passes.** Not one line of these
 * workflows has been observed running. The repository is private, no `v*` tag is
 * being pushed, and GitHub Actions cannot be executed from a local suite. What
 * is asserted is narrower and checkable: that the workflows are internally
 * consistent with `package.json`'s scripts, with the Phase 5 gate decision
 * (package-only, no publisher exists), and with the two Windows checkout hazards
 * this repo has already paid for. A green run is remote-pending.
 *
 * Defect class per assertion group:
 *
 * - **"the manifest and the build disagree."** CLAUDE.md records this class and
 *   says it will recur: the inert `.js` host bundle, the `#app` /
 *   `#agent-deck-root` seam. A workflow calling `npm run <script>` for a script
 *   `package.json` does not define fails only on the runner, days later, with a
 *   message about a missing script rather than about the workflow. Every
 *   `npm run` target referenced by any workflow is checked against the manifest.
 *   This is the most valuable assertion in the file.
 *
 * - **"a publish step appears before a publisher does."** The gate answer
 *   re-scoped Phase 5 to package-only: no Azure DevOps account, no `nvitlam`
 *   publisher, no PAT. A `vsce publish` step or a marketplace/PAT secret would
 *   be a step that cannot succeed, and it would be authored by someone who
 *   assumed the account exists. Pinned so it cannot land silently.
 *
 * - **G5 (zero egress), applied to CI.** The product fetches nothing; neither
 *   should the pipeline that builds it. No `curl`/`wget`/`Invoke-WebRequest` at
 *   a URL in any executed line.
 *
 * - **"a workflow step that cannot run."** `core.longpaths` must be set BEFORE
 *   `actions/checkout`, because checkout is the thing that fails without it -
 *   fixture paths run ~150 characters. Ordering, not presence, is the assertion.
 *
 * - **"YAML that does not parse."** No parser is used and none is installed
 *   (adding a dependency for this would itself violate the no-new-dependency
 *   rule). What is checkable without one is checked structurally: the required
 *   top-level keys at column 0, no tab anywhere (a tab is a hard YAML parse
 *   error, not a style issue), and no trailing whitespace inside a `run:` block,
 *   where it silently changes the command that executes.
 *
 * LINE ENDINGS. Every file is read and then stripped of CR before anything is
 * asserted. `.gitattributes` is `* text=auto` and `core.autocrlf` is true on
 * this machine and on Windows runners, so the working tree's line endings are a
 * checkout artifact rather than a property of the commit. A trailing-whitespace
 * assertion that did not normalise would pass here and fail on the runner - the
 * exact inversion this repo's `.gitattributes` note warns about.
 *
 * COMMENTS ARE EXCLUDED from the executed-content assertions, deliberately.
 * `release.yml` names the publish step it is NOT adding, verbatim and including
 * `VSCE_PAT`, so that whoever creates the publisher adds it in the right place
 * instead of inventing a second workflow. The prohibition is therefore on steps,
 * not on prose - and there is a paired assertion below that the forbidden
 * strings appear ONLY in comments, so the exclusion cannot be used to smuggle
 * one in.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

interface Workflow {
  /** File name, e.g. `ci.yml`. */
  name: string;
  /** Full text, CR-stripped. */
  text: string;
  /** All lines, CR-stripped, in order. */
  lines: string[];
  /** Lines whose first non-space character is not `#`, and not blank. */
  code: string[];
  /** `code` joined back together; what a reader should treat as executed. */
  codeText: string;
}

function isComment(line: string): boolean {
  return line.trim().startsWith('#');
}

function loadWorkflows(): Workflow[] {
  const names = readdirSync(WORKFLOW_DIR)
    .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
    .sort();
  return names.map((name) => {
    // CR stripped before anything else - see the LINE ENDINGS note above.
    const text = readFileSync(join(WORKFLOW_DIR, name), 'utf8').split('\r').join('');
    const lines = text.split('\n');
    const code = lines.filter((l) => l.trim() !== '' && !isComment(l));
    return { name, text, lines, code, codeText: code.join('\n') };
  });
}

function manifestScripts(): Record<string, string> {
  const raw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  const pkg: unknown = JSON.parse(raw);
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts;
  if (!scripts) throw new Error('package.json has no "scripts" block');
  return scripts;
}

/**
 * Every `npm run <script>` target on an executed line. Deliberately not
 * `npm run` inside comments: `release.yml` quotes `npm run build` in prose to
 * say what NOT to do.
 */
function npmRunTargets(wf: Workflow): string[] {
  const out: string[] = [];
  const re = /\bnpm run ([A-Za-z0-9:_-]+)/g;
  let m: RegExpExecArray | null = re.exec(wf.codeText);
  while (m !== null) {
    const target = m[1];
    if (target !== undefined) out.push(target);
    m = re.exec(wf.codeText);
  }
  return out;
}

/** Index of the first executed line matching `needle`, or -1. */
function firstCodeIndex(wf: Workflow, needle: string): number {
  return wf.lines.findIndex((l) => !isComment(l) && l.includes(needle));
}

const WORKFLOWS = loadWorkflows();
const SCRIPTS = manifestScripts();

function byName(name: string): Workflow {
  const wf = WORKFLOWS.find((w) => w.name === name);
  if (!wf) throw new Error(`no workflow ${name} in ${WORKFLOW_DIR}`);
  return wf;
}

describe('workflow files exist at all', () => {
  it('has a CI workflow and a release workflow, and finds at least those two', () => {
    expect(WORKFLOWS.map((w) => w.name)).toEqual(
      expect.arrayContaining(['ci.yml', 'release.yml']),
    );
  });

  it('every discovered workflow is non-empty', () => {
    for (const wf of WORKFLOWS) {
      expect(wf.text.length, `${wf.name} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('the manifest and the workflows agree', () => {
  // The class CLAUDE.md says will recur. A workflow that calls a script the
  // manifest does not define fails on the runner, not here, unless this runs.
  it('every npm run target referenced by a workflow exists in package.json scripts', () => {
    const defined = Object.keys(SCRIPTS);
    for (const wf of WORKFLOWS) {
      for (const target of npmRunTargets(wf)) {
        expect(
          defined,
          `${wf.name} runs "npm run ${target}" but package.json defines: ${defined.join(', ')}`,
        ).toContain(target);
      }
    }
  });

  it('at least one npm run target is actually referenced, so the check is not vacuous', () => {
    const all = WORKFLOWS.flatMap(npmRunTargets);
    expect(all.length).toBeGreaterThan(0);
  });

  it('the package script is the one that produces the VSIX path release.yml uploads', () => {
    const pkgScript = SCRIPTS['package'];
    expect(pkgScript).toBeDefined();
    expect(pkgScript).toContain('dist/agent-deck.vsix');
    expect(byName('release.yml').codeText).toContain('dist/agent-deck.vsix');
  });
});

describe('ci.yml', () => {
  const ci = byName('ci.yml');

  it('triggers on push and on pull_request', () => {
    expect(ci.codeText).toMatch(/^on:$/m);
    expect(ci.codeText).toMatch(/^ {2}push:$/m);
    expect(ci.codeText).toMatch(/^ {2}pull_request:$/m);
  });

  it('runs typecheck, lint, the test run and the build', () => {
    const targets = npmRunTargets(ci);
    expect(targets).toContain('typecheck');
    expect(targets).toContain('lint');
    expect(targets).toContain('build');
    // npx vitest run, NOT npm test: the npm shim intermittently exits 127 on
    // this project and in CI that reads as a phantom failure.
    expect(ci.codeText).toContain('npx vitest run');
    expect(targets).not.toContain('test');
  });

  it('installs with npm ci', () => {
    expect(ci.codeText).toContain('npm ci');
  });

  it('sets core.longpaths BEFORE checkout, which is the step that fails without it', () => {
    const longpaths = firstCodeIndex(ci, 'core.longpaths');
    const checkout = firstCodeIndex(ci, 'actions/checkout');
    expect(longpaths, 'ci.yml never sets core.longpaths').toBeGreaterThanOrEqual(0);
    expect(checkout, 'ci.yml never checks out').toBeGreaterThanOrEqual(0);
    expect(longpaths).toBeLessThan(checkout);
    expect(ci.codeText).toContain('git config --global core.longpaths true');
  });

  /** Every executed (non-comment) line of BOTH workflows, joined. */
  const executedText = (): string =>
    [ci, byName('release.yml')]
      .flatMap((w) => w.lines)
      .filter((l) => !isComment(l))
      .join('\n');

  it('NAMES NO PATH THE REPOSITORY DOES NOT CONTAIN', () => {
    /*
     * THE ASSERTION THAT REPLACED THE SPIKE AUDIT, and it is the general form
     * of the defect that step was.
     *
     * This test used to assert that `ci.yml` RAN `node spike/run.mjs --audit`.
     * `spike/` is gitignored (`.gitignore:71`, `/spike/`) and has not been in
     * this repository since the 2026-08-28 scrub, so the step it pinned could
     * only ever exit 1 on a runner — and the test stayed green the whole time,
     * because it read the YAML as text and never asked whether the path was
     * there. A workflow guard that pins a command naming an absent file is the
     * same class as the `includes(13)` assertion two tests below: the test
     * pinned the broken step.
     *
     * So the specific step is gone and the general property is asserted
     * instead: **every path an executed line names must resolve in a
     * checkout.** That is checkable, it would have caught this on the day the
     * scrub landed, and it catches the next one.
     *
     * Scope, stated because a path extractor that matches nothing passes
     * vacuously: repo-relative paths with a `/` and a known source extension,
     * plus bare top-level directory names the workflows actually use. Runner
     * variables, URLs and shell words are not paths and are excluded by the
     * shape. The count is asserted so an extractor that silently stops
     * matching goes red.
     */
    const EXTS = 'mjs|cjs|js|ts|json|yml|yaml|md|vsix';
    const PATH_RE = new RegExp(`(?<![\\w./-])([\\w.-]+(?:/[\\w.-]+)+\\.(?:${EXTS}))`, 'g');

    const executed = executedText();
    const named = [...new Set([...executed.matchAll(PATH_RE)].map((m) => m[1] ?? ''))]
      .filter((p) => !p.startsWith('http'))
      .sort();

    /*
     * VACUITY CONTROL, and the floor is MEASURED rather than guessed. A first
     * draft asserted `length >= 2` after filtering, and went red at 1: these
     * two workflows name exactly two file paths between them, and one of them
     * was already filtered out. The set is asserted whole instead — if the
     * extractor stops matching, or a step starts naming something new, this
     * line is what says so.
     */
    expect(named).toStrictEqual(['dist/agent-deck.vsix', 'src/release/vsix.test.ts']);

    const missing = named
      // Written by `npm run package` two steps above the step that reads it, so
      // it is absent from a checkout ON PURPOSE. Exempt from EXISTENCE only —
      // it is still in the set above, so it cannot leave unnoticed.
      .filter((p) => p !== 'dist/agent-deck.vsix')
      .filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(
      missing,
      `workflow steps name paths absent from a checkout: ${missing.join(', ')}`,
    ).toEqual([]);

    // And the specific regression by name: the audit must not come back
    // without the directory coming back with it.
    expect(executed).not.toContain('spike/');
    expect(existsSync(join(REPO_ROOT, 'spike'))).toBe(false);
  });

  it('names no gitignored directory root, which is how spike/ survived a checkout', () => {
    /*
     * The other half, and the question the previous guard never asked. A path
     * can exist in the maintainer's tree and be absent from a checkout —
     * `spike/` and `docs/` are junctions into the private repository here, so
     * "it works on my machine" is guaranteed and meaningless.
     *
     * `.gitignore` is the checkable form of "absent from a checkout", and it is
     * read from the file rather than shelling out to `git`: a test that spawns
     * a subprocess per root is the recorded "passes or fails by CPU load"
     * class, and the rules are three lines of text.
     */
    const ignoredRoots = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.replace(/\r$/, '').trim())
      .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
      .filter((l) => l.endsWith('/'))
      .map((l) => l.replace(/^\//, '').replace(/\/$/, ''));

    // Non-vacuous: `.gitignore` really does ignore the roots this repository is
    // known to keep private, so a rule list that stopped parsing goes red here
    // rather than silently exempting everything.
    expect(ignoredRoots).toContain('spike');
    expect(ignoredRoots).toContain('docs');
    expect(ignoredRoots).toContain('lab');

    const executed = executedText();
    const named = ignoredRoots.filter((root) => executed.includes(`${root}/`));
    // `dist/` is the one legitimate case: the artifact is produced in-job.
    const offenders = named.filter((root) => root !== 'dist');
    expect(
      offenders,
      `workflow steps name gitignored roots: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('asserts the checkout did not TRANSLATE, which is the only real check on .gitattributes', () => {
    // CORRECTED 2026-08-29 (audit-0.5.0-record). This test used to assert
    // `includes(13)` - it PINNED the broken guard, which is this repository's
    // most-recorded test defect wearing workflow clothes. "No byte 13 under
    // fixtures/" is a proxy that three tracked files falsify with authentic
    // captured bytes: a Windows capture whose 151 CRs are all CRLF line
    // endings, and two SQLite binaries where byte 13 is data. Every run on
    // `release/0.5.0` failed on it - 10 of 10 - so DoD 8.6 could never be met.
    //
    // The property is that the index form and the working-tree form agree.
    // Asserting the INSTRUMENT (`ls-files --eol`) and the COMPARISON keeps
    // this test from passing over a guard that merely mentions the roots.
    expect(ci.codeText).toContain('webview/wire');
    expect(ci.codeText).toMatch(/fixtures/);
    expect(ci.codeText).toContain('ls-files');
    expect(ci.codeText).toContain('--eol');
    expect(
      ci.codeText,
      'the guard must compare index form to worktree form, not count CR bytes',
    ).toContain('m[1]!==m[2]');
    expect(
      ci.codeText,
      'the byte-13 proxy is back: authentic CRs in captured fixtures will fail CI again',
    ).not.toContain('includes(13)');
  });

  it('pins no fixture-set size: the audit assertions are zeros, not counts', () => {
    // "Do not assert fixture-set sizes in tests" - a pinned RESOLVED count
    // breaks on the next harvest and reads as a regression.
    expect(ci.codeText).not.toMatch(/RESOLVED\s*\+?\s*:\s*5/);
  });

  it('runs a Node version that satisfies engines.node', () => {
    expectWorkflowNodeSatisfiesEngines(ci);
  });
});

describe('release.yml', () => {
  const release = byName('release.yml');

  it('triggers on tags matching v*', () => {
    expect(release.codeText).toMatch(/^on:$/m);
    expect(release.codeText).toMatch(/^ {2}push:$/m);
    expect(release.codeText).toMatch(/^ {4}tags:$/m);
    expect(release.codeText).toMatch(/^ {6}- 'v\*'$/m);
  });

  it('invokes the package script', () => {
    expect(npmRunTargets(release)).toContain('package');
  });

  it('uploads the VSIX as a workflow artifact and attaches it to the release', () => {
    expect(release.codeText).toContain('actions/upload-artifact');
    expect(release.codeText).toContain('gh release create');
  });

  it('takes only contents: write, nothing broader', () => {
    expect(release.codeText).toMatch(/^permissions:$/m);
    expect(release.codeText).toMatch(/^ {2}contents: write$/m);
    expect(release.codeText).not.toContain('write-all');
  });

  it('runs a Node version that satisfies engines.node', () => {
    expectWorkflowNodeSatisfiesEngines(release);
  });
});

/**
 * The manifest must not promise a Node version the dependency tree cannot run.
 *
 * MEASURED, not hypothesised. `package.json` declared `engines.node: ">=20"`,
 * the CI workflow honoured it and installed Node 20, and the first real run
 * died: `jsdom@30` pulls `undici@8`, which declares `>=22.19.0` and throws
 * `webidl.util.markAsUncloneable is not a function` on Node 20. It could not
 * surface locally — this machine runs 24.15.0, which happens to sit exactly on
 * `jsdom`'s own `^24.15.0` floor.
 *
 * The assertion this replaces was named "uses Node 20, matching engines.node"
 * and asserted only that the workflow said `20`. It never read `engines.node`.
 * Two agreeing literals with a claim in the name — the same class as the
 * manifest/build disagreement `CLAUDE.md` says will recur, which is exactly
 * what it failed to catch.
 *
 * It is a TRIPWIRE, not a semver implementation: for a disjunction it takes the
 * lowest floor across alternatives, so it would not notice a floor landing in a
 * gap between ranges (23.x, say). It catches the failure that actually
 * happened — a declared floor BELOW what a dependency demands — and it costs no
 * dependency to do it.
 */
const NODE_CRITICAL_DEPS = ['jsdom', 'undici', 'vite', 'vitest'] as const;

function lowestFloor(range: string): [number, number, number] | undefined {
  const floors = [...range.matchAll(/(\d+)\.(\d+)\.(\d+)/g)].map(
    (m) => [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number],
  );
  if (floors.length === 0) return undefined;
  return floors.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])[0];
}

function atLeast(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
}

function enginesFloor(): [number, number, number] {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const declared = manifest.engines?.node;
  expect(typeof declared, 'package.json must declare engines.node').toBe('string');
  const floor = lowestFloor(String(declared));
  expect(floor, `engines.node "${declared}" carries no x.y.z floor to compare`).toBeDefined();
  return floor as [number, number, number];
}

describe('engines.node tells the truth about what this project can run on', () => {
  it('declares a floor no lower than every critical dependency demands', () => {
    const ours = enginesFloor();
    const violations: string[] = [];
    for (const dep of NODE_CRITICAL_DEPS) {
      const pkgPath = join(REPO_ROOT, 'node_modules', dep, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        version?: string;
        engines?: { node?: string };
      };
      const range = pkg.engines?.node;
      if (!range) continue;
      const theirs = lowestFloor(range);
      if (!theirs) continue;
      if (!atLeast(ours, theirs)) {
        violations.push(
          `${dep}@${pkg.version} needs node ${range} (floor ${theirs.join('.')}), ` +
            `but engines.node floors at ${ours.join('.')}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});

function expectWorkflowNodeSatisfiesEngines(wf: { codeText: string }): void {
  const declared = /node-version:\s*'?(\d+)(?:\.(\d+))?(?:\.(\d+))?'?/.exec(wf.codeText);
  expect(declared, 'workflow must pin a node-version').not.toBeNull();
  const major = Number(declared?.[1]);
  const floor = enginesFloor();
  // A bare major such as '24' resolves to the latest 24.x, so comparing majors
  // is the honest comparison: only the major is actually pinned.
  expect(
    major >= floor[0],
    `workflow runs Node ${major}, engines.node floors at ${floor.join('.')}`,
  ).toBe(true);
}

describe('the gate decision is pinned: CI never publishes', () => {
  // WHY THIS ASSERTION EXISTS, RESTATED 2026-08-30. It used to rest on a
  // capability: no Azure DevOps account, no nvitlam publisher, no PAT, so a
  // publish step would be a step that cannot succeed. All three now exist, and
  // an assertion whose stated reason has evaporated is an assertion somebody
  // deletes - which is exactly how the CR guard in ci.yml came to be asking the
  // wrong question for ten consecutive red runs.
  //
  // The reason now is reserved decision 2: publishing to the Marketplace is the
  // user's, always and without exception. That does not expire when a publisher
  // exists; it is the whole point of it. A publish step in a workflow makes the
  // decision a push, which is the thing being refused.
  const FORBIDDEN = ['vsce publish', 'VSCE_PAT', 'AZURE_', 'marketplace.visualstudio.com'];

  it('no executed line in any workflow publishes or names a marketplace/PAT secret', () => {
    for (const wf of WORKFLOWS) {
      for (const needle of FORBIDDEN) {
        expect(wf.codeText, `${wf.name} contains an executed "${needle}"`).not.toContain(needle);
      }
    }
  });

  it('where those strings do appear, they appear only on comment lines', () => {
    // The exclusion of comments above is what makes release.yml able to name the
    // exact step to add later. This is the paired assertion that stops the
    // exclusion being a hole: every occurrence anywhere must be a comment.
    for (const wf of WORKFLOWS) {
      for (const needle of FORBIDDEN) {
        const offenders = wf.lines.filter((l) => l.includes(needle) && !isComment(l));
        expect(offenders, `${wf.name}: non-comment lines naming ${needle}`).toEqual([]);
      }
    }
  });

  it('release.yml explains the absence and names where the publish step would go', () => {
    const release = byName('release.yml');
    const comments = release.lines.filter(isComment).join('\n');
    expect(comments).toContain('vsce publish');
    expect(comments).toContain('VSCE_PAT');
    expect(comments.toLowerCase()).toContain('publisher');
  });
});

describe('G5 applied to CI: the pipeline fetches nothing', () => {
  it('no executed line curls, wgets or Invoke-WebRequests a URL', () => {
    const fetchers = /\b(curl|curl\.exe|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)\b/i;
    for (const wf of WORKFLOWS) {
      for (const line of wf.code) {
        expect(fetchers.test(line), `${wf.name}: fetches in "${line.trim()}"`).toBe(false);
      }
    }
  });

  it('no executed line contains an http(s):// URL outside an action reference', () => {
    for (const wf of WORKFLOWS) {
      for (const line of wf.code) {
        expect(/https?:\/\//.test(line), `${wf.name}: URL in "${line.trim()}"`).toBe(false);
      }
    }
  });
});

describe('every job runs on windows-latest', () => {
  it('has at least one runs-on line per workflow and all of them are windows-latest', () => {
    for (const wf of WORKFLOWS) {
      const runsOn = wf.code.filter((l) => l.includes('runs-on:'));
      expect(runsOn.length, `${wf.name} declares no runner`).toBeGreaterThan(0);
      for (const line of runsOn) {
        expect(line.trim()).toBe('runs-on: windows-latest');
      }
    }
  });

  it('declares no matrix leg, because only Windows is proven', () => {
    for (const wf of WORKFLOWS) {
      expect(wf.codeText, `${wf.name} has a matrix`).not.toContain('strategy:');
      expect(wf.codeText).not.toContain('ubuntu-latest');
      expect(wf.codeText).not.toContain('macos-latest');
    }
  });
});

describe('plausible workflow YAML, checked without a parser', () => {
  // No YAML parser is installed and none may be added (no new dependencies).
  // These are the properties checkable by scanning, and they cover the failure
  // modes that produce "workflow file is invalid" with no job ever starting.
  it('each file has name, on and jobs as top-level keys at column 0', () => {
    for (const wf of WORKFLOWS) {
      for (const key of ['name', 'on', 'jobs']) {
        const re = new RegExp(`^${key}:`, 'm');
        expect(re.test(wf.codeText), `${wf.name} has no top-level "${key}:"`).toBe(true);
      }
    }
  });

  it('contains no tab character anywhere: a tab is a hard YAML parse error', () => {
    for (const wf of WORKFLOWS) {
      const tabbed = wf.lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.includes('\t'));
      expect(tabbed.map(({ i }) => i + 1), `${wf.name} has tabs on these lines`).toEqual([]);
    }
  });

  it('has no trailing whitespace inside a run: block, which would change a command', () => {
    for (const wf of WORKFLOWS) {
      const offenders: number[] = [];
      let runIndent = -1;
      wf.lines.forEach((line, i) => {
        const indent = line.length - line.trimStart().length;
        if (/^\s*run:\s*\|/.test(line)) {
          runIndent = indent;
          return;
        }
        if (runIndent < 0) return;
        if (line.trim() === '') return;
        if (indent <= runIndent) {
          runIndent = -1;
          return;
        }
        if (/[ \t]$/.test(line)) offenders.push(i + 1);
      });
      expect(offenders, `${wf.name}: trailing whitespace in run: block`).toEqual([]);
    }
  });

  it('has no trailing whitespace on any line at all', () => {
    for (const wf of WORKFLOWS) {
      const offenders = wf.lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /[ \t]$/.test(l))
        .map(({ i }) => i + 1);
      expect(offenders, `${wf.name}: trailing whitespace`).toEqual([]);
    }
  });

  it('indents in multiples of two spaces, so the step lists nest as intended', () => {
    for (const wf of WORKFLOWS) {
      const offenders = wf.lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.trim() !== '' && !isComment(l))
        // Lines inside a block scalar are free-form; only structural lines,
        // which are the ones ending in ':' or starting a sequence item, are
        // checked.
        .filter(({ l }) => /^\s*(-\s)?[A-Za-z_][A-Za-z0-9_-]*:/.test(l))
        .filter(({ l }) => (l.length - l.trimStart().length) % 2 !== 0)
        .map(({ i }) => i + 1);
      expect(offenders, `${wf.name}: odd indentation`).toEqual([]);
    }
  });

  it('ends with exactly one trailing newline', () => {
    for (const wf of WORKFLOWS) {
      expect(wf.text.endsWith('\n'), `${wf.name} has no final newline`).toBe(true);
      expect(wf.text.endsWith('\n\n'), `${wf.name} has a blank final line`).toBe(false);
    }
  });
});
