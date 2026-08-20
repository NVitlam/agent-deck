/**
 * Phase 4 — the path-resolution matrix.
 *
 * DoD item: "`~/.claude` resolution verified: Windows native + (WSL or
 * documented gap); slug encoding differences tested". The gap escape was taken
 * off the table at the phase gate, so this file runs two legs:
 *
 *   1. **Native.** The probe, bundled and executed as a child process of the
 *      host platform, plus fixture-driven slug cases and the pure
 *      slug-selection rules. Every test in this leg runs on every machine —
 *      nothing here can skip. A child process, not an in-process call,
 *      because the negative control has to fake `HOME`/`USERPROFILE` and a
 *      vitest worker thread only owns a *copy* of `process.env` while
 *      `os.homedir()` reads the real one. Measured: faking them in-process
 *      left resolution pointing at the machine's real projects root, where it
 *      failed with `projectSlugNotFound` — a green control that had proved
 *      nothing.
 *   2. **WSL.** The *same* probe, bundled by esbuild and executed by a real
 *      Linux Node inside the WSL distro, so `$HOME/.claude` resolution, posix
 *      path joining and a case-sensitive filesystem are measured rather than
 *      simulated.
 *
 * The WSL leg needs a Linux Node, which is not part of any checkout, so it
 * skips when one is absent — loudly, with the reason and the command that
 * fixes it, and `AGENT_DECK_REQUIRE_WSL=1` turns absence into a failure for
 * anyone verifying the DoD. What the leg would otherwise prove is not lost
 * when it skips: the recorded measurement in
 * `fixtures/synthetic-path-matrix/wsl-environment.measured.json` is asserted
 * against this repo's live encoding by tests that always run, and the live leg
 * re-measures the same facts and refuses to disagree with the record.
 *
 * Nothing here writes inside the repo, inside `fixtures/`, or inside any real
 * `~/.claude` — on either platform. The negative control proves the last one
 * with BOTH `HOME` and `USERPROFILE` faked, because `os.homedir()` reads
 * `USERPROFILE` on Windows and faking only `HOME` has already produced one
 * green, false pass in this repo's history.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  discoverSessions,
  resolveProjectsRoot,
  selectSlugDirectory,
  slugifyWorkspace,
} from '../parser/tailer.js';
import { normalizeSlug, sameWorkspace, workspaceSlug } from './correlate.js';
import { flipNthLetterCase, nativeProbeWorkspace } from './pathmatrix.probe.js';
import type { ProbeReport, SlugCase } from './pathmatrix.probe.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MATRIX_DIR = join(REPO_ROOT, 'fixtures', 'synthetic-path-matrix');
const CAPTURE_ROOT = join(REPO_ROOT, 'fixtures', 'cc-2.1.234', 'projects');

const SLUG_CASES = JSON.parse(
  await readFile(join(MATRIX_DIR, 'slug-cases.json'), 'utf8'),
) as SlugCase[];

interface MeasuredWslEnvironment {
  provenance: string;
  measuredAt: string;
  wsl: {
    distro: string;
    defaultVersion: number;
    kernel: string;
    home: string;
    claudeDirectoryPresent: boolean;
    linuxNodeOnPath: boolean;
    wslpath: {
      windowsWorkspace: string;
      wslMountForm: string;
      linuxHome: string;
      windowsFormOfLinuxHome: string;
    };
  };
  slugs: { windows: string; wslMount: string; identical: boolean };
  probeLinux: {
    platform: string;
    pathSeparator: string;
    homedir: string;
    rootFromHome: { root: string; source: string };
    tempFilesystemCaseSensitive: boolean;
    discoveryWorkspace: string;
    discoverySlug: string;
    negativeControlKind: string;
    negativeControlCode: string;
    caseInsensitiveOutcome: string;
    ambiguousOutcome: string;
    ambiguousCode: string;
    exactBeatsCaseVariantOutcome: string;
  };
}

const MEASURED = JSON.parse(
  await readFile(join(MATRIX_DIR, 'wsl-environment.measured.json'), 'utf8'),
) as MeasuredWslEnvironment;

function caseById(id: string): SlugCase {
  const found = SLUG_CASES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no slug case '${id}' in slug-cases.json`);
  return found;
}

// ---------------------------------------------------------------------------
// Leg 1a — slug encoding, every case in the fixture
// ---------------------------------------------------------------------------

describe('slug encoding matrix (fixture-driven, runs on every platform)', () => {
  for (const slugCase of SLUG_CASES) {
    it(`${slugCase.id} (${slugCase.form}): ${slugCase.workspacePath}`, () => {
      expect(slugifyWorkspace(slugCase.workspacePath)).toBe(slugCase.expectedSlug);
      // The correlator must not have a second encoding.
      expect(workspaceSlug(slugCase.workspacePath)).toBe(slugCase.expectedSlug);
    });
  }

  it('the one CC-witnessed case equals the slug directory the committed capture actually has', async () => {
    const witnessed = SLUG_CASES.filter((c) => c.witness === 'cc-capture');
    expect(witnessed.length).toBeGreaterThan(0);
    const onDisk = (await readdir(CAPTURE_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const c of witnessed) {
      expect(onDisk).toContain(c.expectedSlug);
      expect(slugifyWorkspace(c.workspacePath)).toBe(c.expectedSlug);
    }
  });

  it('slug encoding is platform-independent: it is string substitution, not path joining', () => {
    // The same input must slug identically no matter which OS runs this file;
    // the WSL leg asserts the same table under Linux Node.
    for (const slugCase of SLUG_CASES) {
      expect(slugifyWorkspace(slugCase.workspacePath)).toBe(slugCase.expectedSlug);
    }
  });
});

// ---------------------------------------------------------------------------
// Leg 1b — the WSL/Windows divergence, which is the finding
// ---------------------------------------------------------------------------

describe('one workspace, two spellings: Windows vs WSL', () => {
  const windows = caseById('windows-drive-lower');
  const wslMount = caseById('wsl-mount-of-windows-workspace');

  it('produces two DIFFERENT slugs for the same physical directory', () => {
    const winSlug = slugifyWorkspace(windows.workspacePath);
    const wslSlug = slugifyWorkspace(wslMount.workspacePath);
    expect(winSlug).toBe('c--Users-dev-projects-agent-deck');
    expect(wslSlug).toBe('-mnt-c-Users-dev-projects-agent-deck');
    expect(winSlug).not.toBe(wslSlug);
  });

  it('and they are NOT case variants: no normalisation makes them equal', () => {
    expect(normalizeSlug(slugifyWorkspace(windows.workspacePath))).not.toBe(
      normalizeSlug(slugifyWorkspace(wslMount.workspacePath)),
    );
    expect(sameWorkspace(windows.workspacePath, wslMount.workspacePath)).toBe(false);
  });

  it('the drive-letter variants ARE case variants, and still correlate', () => {
    const lower = caseById('windows-drive-lower').workspacePath;
    const upper = caseById('windows-drive-upper').workspacePath;
    expect(slugifyWorkspace(lower)).not.toBe(slugifyWorkspace(upper));
    expect(sameWorkspace(lower, upper)).toBe(true);
  });

  it('the two WSL mount spellings differ only by case', () => {
    const a = '/mnt/c/Users/dev/ws';
    const b = caseById('wsl-mount-uppercase-drive').workspacePath;
    expect(slugifyWorkspace(a)).not.toBe(slugifyWorkspace(b));
    expect(sameWorkspace(a, b)).toBe(true);
  });

  it('the UNC spelling of a Linux-side workspace is a third, distinct slug', () => {
    const unc = caseById('unc-wsl-localhost').workspacePath;
    const posix = caseById('wsl-linux-home').workspacePath;
    expect(slugifyWorkspace(unc)).not.toBe(slugifyWorkspace(posix));
    expect(sameWorkspace(unc, posix)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Leg 1c — projects root resolution
// ---------------------------------------------------------------------------

describe('projects root resolution', () => {
  it('CLAUDE_PROJECTS_ROOT replaces the home location entirely, on any platform', () => {
    const resolved = resolveProjectsRoot({
      env: { CLAUDE_PROJECTS_ROOT: join(tmpdir(), 'fixture-root') },
      homedir: () => join(tmpdir(), 'home'),
    });
    expect(resolved.source).toBe('env');
    expect(resolved.root).toBe(join(tmpdir(), 'fixture-root'));
  });

  it('joins the home location with the HOST platform separator, which is why the Linux root is measured and not simulated', () => {
    const resolved = resolveProjectsRoot({ env: {}, homedir: () => join(tmpdir(), 'home') });
    expect(resolved.source).toBe('home');
    expect(resolved.root).toBe(join(tmpdir(), 'home', '.claude', 'projects'));
    if (process.platform === 'win32') {
      expect(resolveProjectsRoot({ env: {}, homedir: () => 'C:\\Users\\dev' }).root).toBe(
        'C:\\Users\\dev\\.claude\\projects',
      );
    } else {
      expect(resolveProjectsRoot({ env: {}, homedir: () => '/home/dev' }).root).toBe(
        '/home/dev/.claude/projects',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Leg 1d — slug selection, including the branch this filesystem cannot produce
// ---------------------------------------------------------------------------

describe('selectSlugDirectory (pure: every branch runs on every platform)', () => {
  const want = 'c--Users-dev-ws';

  it('picks the exact spelling', () => {
    expect(selectSlugDirectory(['other', want], want)).toEqual({ kind: 'exact', name: want });
  });

  it('picks a lone case variant and reports that the spelling differed', () => {
    const variant = 'C--Users-dev-ws';
    expect(selectSlugDirectory(['other', variant], want)).toEqual({
      kind: 'caseInsensitive',
      name: variant,
    });
  });

  it('prefers the exact spelling over a case variant, so two variants are never a coin toss', () => {
    expect(selectSlugDirectory(['C--Users-dev-ws', want], want)).toEqual({
      kind: 'exact',
      name: want,
    });
  });

  it('REFUSES when two case variants exist and neither is exact', () => {
    const selection = selectSlugDirectory(['C--Users-dev-WS', 'C--Users-dev-ws'], want);
    expect(selection).toEqual({
      kind: 'ambiguous',
      candidates: ['C--Users-dev-WS', 'C--Users-dev-ws'],
    });
  });

  it('reports none when nothing matches', () => {
    expect(selectSlugDirectory(['-home-dev-ws'], want)).toEqual({ kind: 'none' });
  });

  it('flipNthLetterCase makes variants that differ by case alone', () => {
    expect(flipNthLetterCase('-mnt-c-Users-ws', 0)).toBe('-Mnt-c-Users-ws');
    expect(flipNthLetterCase('-mnt-c-Users-ws', 1)).toBe('-mNt-c-Users-ws');
    expect(flipNthLetterCase('-mnt-c-Users-ws', 0)?.toLowerCase()).toBe('-mnt-c-users-ws');
    expect(flipNthLetterCase('----', 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Leg 1e — negative control through the injected seam, plus the reason the
// env-faked form of it has to run in a child process
// ---------------------------------------------------------------------------

describe('negative control: no CLAUDE_PROJECTS_ROOT and no ~/.claude', () => {
  it('fails ENOENT at the injected home and never falls back to the real one', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-deck-negctl-'));
    const fakedHome = join(temp, 'home');
    await mkdir(fakedHome, { recursive: true });
    try {
      const result = await discoverSessions(nativeProbeWorkspace(process.platform), {
        env: {},
        homedir: () => fakedHome,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe('projectsRootNotFound');
      expect(result.failure.code).toBe('ENOENT');
      expect(result.failure.path).toBe(join(fakedHome, '.claude', 'projects'));
      expect(result.failure.path).not.toBe(join(homedir(), '.claude', 'projects'));
      // G1: the refusal created nothing under the faked home.
      expect(await readdir(fakedHome)).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('PINS WHY THE ENV-FAKED CONTROL RUNS IN A CHILD PROCESS: env writes here do not move os.homedir()', () => {
    // Measured, not assumed. Under the pinned `threads` pool each worker gets a
    // COPY of process.env, while os.homedir() goes through libuv to the real
    // process environment. A negative control that fakes HOME/USERPROFILE in
    // this process therefore proves nothing — worse, resolution then reads the
    // machine's real projects root and can fail for an unrelated reason that
    // still looks like a pass. Measured on 2026-08-20: it returned
    // `projectSlugNotFound` from the REAL ~/.claude/projects, not
    // `projectsRootNotFound` from the fake.
    //
    // If this test ever fails, the pool changed and env-faked controls became
    // live again — which is information, not noise.
    const fakedHome = join(tmpdir(), 'agent-deck-not-the-home');
    const savedHome = process.env['HOME'];
    const savedUserProfile = process.env['USERPROFILE'];
    try {
      process.env['HOME'] = fakedHome;
      process.env['USERPROFILE'] = fakedHome;
      expect(homedir()).not.toBe(fakedHome);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = savedUserProfile;
    }
  });
});

// ---------------------------------------------------------------------------
// The probe, bundled once and executed as a child process on each platform
// ---------------------------------------------------------------------------

let BUNDLE_DIR: string;
let BUNDLE: string;
const CASES_PATH = join(MATRIX_DIR, 'slug-cases.json');

/** Bundle the probe so a Node process — either platform's — can execute it. */
async function bundleProbe(outDir: string): Promise<string> {
  const outfile = join(outDir, 'pathmatrix.probe.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./pathmatrix.probe.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return outfile;
}

beforeAll(async () => {
  BUNDLE_DIR = await mkdtemp(join(tmpdir(), 'agent-deck-pathmatrix-bundle-'));
  BUNDLE = await bundleProbe(BUNDLE_DIR);
}, 120_000);

afterAll(async () => {
  await rm(BUNDLE_DIR, { recursive: true, force: true });
});

/** Run the probe in a native child process, optionally with a faked home. */
function runNativeProbe(envOverrides: Record<string, string> = {}): ProbeReport {
  const stdout = execFileSync(
    process.execPath,
    [BUNDLE, '--agent-deck-path-probe', CASES_PATH],
    {
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as ProbeReport;
}

describe('native leg: the same probe the WSL leg runs, in a child process', () => {
  it('resolves, discovers, matches case variants and refuses without a root', () => {
    const report = runNativeProbe();

    expect(report.platform).toBe(process.platform);
    expect(report.homedir).toBe(homedir());
    expect(report.rootFromHome).toEqual({
      root: join(homedir(), '.claude', 'projects'),
      source: 'home',
    });
    expect(report.rootFromOverride.source).toBe('env');
    expect(report.pathSeparator).toBe(process.platform === 'win32' ? '\\' : '/');

    for (const slugCase of SLUG_CASES) {
      const row = report.slugs.find((s) => s.id === slugCase.id);
      expect(row?.slug, slugCase.id).toBe(slugCase.expectedSlug);
    }

    expect(report.discovery.workspacePath).toBe(nativeProbeWorkspace(process.platform));
    expect(report.discovery.slugMatch).toBe('exact');
    expect(report.discovery.rootSource).toBe('env');
    expect(report.discovery.sessionIds).toEqual(['4299490e-4a09-46a0-a544-7ffb0429e7e7']);
    expect(report.discovery.subagentIds).toEqual(['a1a53f42c5eca8824']);

    expect(report.caseInsensitiveMatch.ran).toBe(true);
    expect(report.caseInsensitiveMatch.outcome).toBe('matched');
    expect(report.caseInsensitiveMatch.slugOnDisk).toBe(report.caseInsensitiveMatch.onDisk?.[0]);
    expect(report.caseInsensitiveMatch.slugOnDisk).not.toBe(report.discovery.requestedSlug);

    // The child process has a real environment, so the probe's own negative
    // control (it fakes BOTH home variables internally) is live here.
    expect(report.negativeControl.ok).toBe(false);
    expect(report.negativeControl.kind).toBe('projectsRootNotFound');
    expect(report.negativeControl.code).toBe('ENOENT');
    expect(report.negativeControl.path).toBe(report.negativeControl.expectedPath);
    expect(report.negativeControl.path).not.toBe(join(homedir(), '.claude', 'projects'));

    if (process.platform === 'win32') {
      // NTFS cannot hold two directories differing only by case, so the
      // ambiguity refusal has no end-to-end leg here. Its logic is covered on
      // every platform by the selectSlugDirectory tests above, and end-to-end
      // by the WSL leg below.
      expect(report.tempFilesystemCaseSensitive).toBe(false);
      expect(report.ambiguousSlug.ran).toBe(false);
      expect(report.ambiguousSlug.reason).toContain('case-insensitive filesystem');
    } else {
      expect(report.tempFilesystemCaseSensitive).toBe(true);
      expect(report.ambiguousSlug.outcome).toBe('ambiguousSlug');
      expect(report.ambiguousSlug.code).toBe('EAMBIGUOUS');
      expect(report.exactBeatsCaseVariant.outcome).toBe('exact');
    }
  });

  it('with BOTH HOME and USERPROFILE faked, the projects root moves to the fake and resolution fails ENOENT there', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-deck-negctl-child-'));
    try {
      const report = runNativeProbe({ HOME: temp, USERPROFILE: temp });

      expect(report.homedir).toBe(temp);
      expect(report.rootFromHome).toEqual({
        root: join(temp, '.claude', 'projects'),
        source: 'home',
      });
      expect(report.negativeControl.kind).toBe('projectsRootNotFound');
      expect(report.negativeControl.code).toBe('ENOENT');
      // G1: nothing was created under the faked home, and the real one was
      // never the path that got looked at.
      expect(report.rootFromHome.root).not.toBe(join(homedir(), '.claude', 'projects'));
      expect(await readdir(temp)).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('with ONLY HOME faked, Windows does NOT move — the trap that produced a false pass in this repo', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-deck-homeonly-'));
    try {
      const report = runNativeProbe({ HOME: temp });
      if (process.platform === 'win32') {
        // os.homedir() reads USERPROFILE here: the fake is ignored and the
        // control would have run against the machine's real ~/.claude.
        expect(report.homedir).toBe(homedir());
        expect(report.homedir).not.toBe(temp);
      } else {
        expect(report.homedir).toBe(temp);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Leg 2 — WSL
// ---------------------------------------------------------------------------

interface WslAvailability {
  usable: boolean;
  reason: string;
  linuxNode?: string;
}

const LINUX_NODE_CANDIDATES = [
  // A distro-installed Node, if the machine ever grows one.
  'node',
  // The unpacked tarball this leg was measured against. Ubuntu 24.04 ships no
  // Node, and nothing in a checkout provides one, which is why this leg
  // announces its skip instead of quietly reporting coverage.
  '$HOME/.local/opt/node-v24.19.0-linux-x64/bin/node',
];

/**
 * Run a command inside the default distro.
 *
 * `--exec`, not `--`: with `--` wsl.exe hands the joined command line to bash,
 * which re-splits it, so an argument containing a space or a parenthesis
 * arrives as several words and the call fails in a way that reads like "WSL is
 * broken". `--exec` passes the argv through. Measured both ways.
 */
function wsl(args: readonly string[]): string {
  return execFileSync('wsl.exe', ['--exec', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

/**
 * Windows paths reach `wslpath` with their backslashes stripped — measured:
 * `wslpath -u C:\Users\dev\projects` receives `C:Usersdevprojects`. Forward
 * slashes survive and `wslpath` accepts them, so the argument is converted and
 * the assertion stays on the fixture's literal backslash spelling.
 */
function forWslpath(windowsPath: string): string {
  return windowsPath.replace(/\\/g, '/');
}

function detectWsl(): WslAvailability {
  if (process.platform !== 'win32') {
    return { usable: false, reason: `host platform is ${process.platform}, not win32` };
  }
  try {
    wsl(['true']);
  } catch (error) {
    return { usable: false, reason: `wsl.exe is not usable: ${String(error).split('\n')[0]}` };
  }
  const override = process.env['AGENT_DECK_WSL_NODE'];
  for (const candidate of override === undefined ? LINUX_NODE_CANDIDATES : [override]) {
    try {
      // `command -v` resolves PATH entries and expands $HOME; the result is an
      // absolute path we can exec without a shell.
      const resolved = wsl(['sh', '-c', `command -v "${candidate}"`]);
      if (resolved === '') continue;
      // WSL's PATH includes the Windows one, so a candidate can resolve to a
      // Windows binary through interop. Only a Linux Node counts as the leg.
      const platform = wsl([resolved, '-e', 'process.stdout.write(process.platform)']);
      if (platform === 'linux') return { usable: true, reason: '', linuxNode: resolved };
    } catch {
      // try the next candidate
    }
  }
  return {
    usable: false,
    reason:
      'WSL is present but has no Linux Node. Restore it with:\n' +
      "  wsl.exe -- bash -lc 'mkdir -p ~/.local/opt && cd ~/.local/opt && " +
      'curl -sSLO https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz && ' +
      "tar xf node-v24.19.0-linux-x64.tar.xz'\n" +
      '  or point AGENT_DECK_WSL_NODE at any Linux node binary.',
  };
}

const WSL = detectWsl();

if (!WSL.usable) {
  // Loud, once, with the reason. A silent skip reports as coverage.
  process.stderr.write(
    `\n[pathmatrix] WSL LEG SKIPPED — ${WSL.reason}\n` +
      '[pathmatrix] Set AGENT_DECK_REQUIRE_WSL=1 to make this a failure instead.\n\n',
  );
}

describe('WSL availability', () => {
  it('is either usable, or explicitly not required', () => {
    if (process.env['AGENT_DECK_REQUIRE_WSL'] === '1') {
      expect(WSL.usable, `AGENT_DECK_REQUIRE_WSL=1 but: ${WSL.reason}`).toBe(true);
    } else if (WSL.usable) {
      expect(WSL.linuxNode).toMatch(/node/);
    } else {
      // A skip with no stated reason is the failure mode this guards against.
      expect(WSL.reason.length).toBeGreaterThan(20);
    }
  });
});

describe.skipIf(!WSL.usable)('WSL leg: this repo\u2019s resolution code under real Linux Node', () => {
  it(
    'resolves $HOME/.claude/projects, encodes the same slugs, and refuses an ambiguous slug on a case-sensitive filesystem',
    () => {
      const linuxNode = WSL.linuxNode as string;
      const claudeBefore = wsl([
        'sh',
        '-c',
        'test -d "$HOME/.claude" && echo present || echo absent',
      ]);

      {
        const bundleLinux = wsl(['wslpath', '-u', forWslpath(BUNDLE)]);
        const casesLinux = wsl(['wslpath', '-u', forWslpath(CASES_PATH)]);

        const raw = wsl([linuxNode, bundleLinux, '--agent-deck-path-probe', casesLinux]);
        const report = JSON.parse(raw) as ProbeReport;

        // --- environment ------------------------------------------------
        expect(report.platform).toBe('linux');
        expect(report.pathSeparator).toBe('/');
        expect(report.env.WSL_DISTRO_NAME).toBe(MEASURED.wsl.distro);
        expect(report.homedir).toBe(MEASURED.wsl.home);
        expect(report.rootFromHome).toEqual({
          root: `${MEASURED.wsl.home}/.claude/projects`,
          source: 'home',
        });
        expect(report.rootFromOverride.source).toBe('env');

        // --- slug encoding is identical to the Windows leg ---------------
        for (const slugCase of SLUG_CASES) {
          const row = report.slugs.find((s) => s.id === slugCase.id);
          expect(row?.slug, slugCase.id).toBe(slugCase.expectedSlug);
        }

        // --- discovery under posix paths ---------------------------------
        expect(report.discovery.workspacePath).toBe('/mnt/c/Users/Probe/ws');
        expect(report.discovery.requestedSlug).toBe('-mnt-c-Users-Probe-ws');
        expect(report.discovery.slugMatch).toBe('exact');
        expect(report.discovery.sessionIds).toEqual(['4299490e-4a09-46a0-a544-7ffb0429e7e7']);
        expect(report.discovery.subagentIds).toEqual(['a1a53f42c5eca8824']);

        // --- case-sensitive filesystem behaviour -------------------------
        expect(report.tempFilesystemCaseSensitive).toBe(true);
        expect(report.caseInsensitiveMatch.outcome).toBe('matched');
        expect(report.ambiguousSlug.ran).toBe(true);
        expect(report.ambiguousSlug.outcome).toBe('ambiguousSlug');
        expect(report.ambiguousSlug.code).toBe('EAMBIGUOUS');
        expect(report.ambiguousSlug.onDisk?.length).toBe(2);
        expect(report.exactBeatsCaseVariant.outcome).toBe('exact');

        // --- negative control, inside WSL --------------------------------
        expect(report.negativeControl.ok).toBe(false);
        expect(report.negativeControl.kind).toBe('projectsRootNotFound');
        expect(report.negativeControl.code).toBe('ENOENT');
        expect(report.negativeControl.path).toBe(report.negativeControl.expectedPath);
        expect(report.negativeControl.path.startsWith('/tmp/')).toBe(true);

        // --- the recorded measurement still holds ------------------------
        expect(report.platform).toBe(MEASURED.probeLinux.platform);
        expect(report.rootFromHome.root).toBe(MEASURED.probeLinux.rootFromHome.root);
        expect(report.ambiguousSlug.outcome).toBe(MEASURED.probeLinux.ambiguousOutcome);

        // --- G1: WSL's own ~/.claude is exactly as we found it -----------
        const claudeAfter = wsl([
          'sh',
          '-c',
          'test -d "$HOME/.claude" && echo present || echo absent',
        ]);
        expect(claudeAfter).toBe(claudeBefore);
        expect(claudeAfter).toBe(MEASURED.wsl.claudeDirectoryPresent ? 'present' : 'absent');
      }
    },
    180_000,
  );

  it('wslpath still reports the mount translation the fixture recorded', () => {
    const { windowsWorkspace, wslMountForm, linuxHome, windowsFormOfLinuxHome } =
      MEASURED.wsl.wslpath;
    expect(wsl(['wslpath', '-u', forWslpath(windowsWorkspace)])).toBe(wslMountForm);
    expect(wsl(['wslpath', '-w', linuxHome])).toBe(windowsFormOfLinuxHome);
    expect(wsl(['sh', '-c', 'echo "$HOME"'])).toBe(MEASURED.wsl.home);
  });
});

// ---------------------------------------------------------------------------
// The recorded measurement — asserted whether or not WSL is reachable
// ---------------------------------------------------------------------------

describe('recorded WSL measurement (runs with or without WSL)', () => {
  it('records what it is: measured, not synthetic', () => {
    expect(MEASURED.provenance).toMatch(/MEASURED/);
    expect(MEASURED.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('agrees with this repo\u2019s live encoding for both spellings of the workspace', () => {
    expect(slugifyWorkspace(MEASURED.wsl.wslpath.windowsWorkspace)).toBe(MEASURED.slugs.windows);
    expect(slugifyWorkspace(MEASURED.wsl.wslpath.wslMountForm)).toBe(MEASURED.slugs.wslMount);
    expect(MEASURED.slugs.windows === MEASURED.slugs.wslMount).toBe(MEASURED.slugs.identical);
    expect(MEASURED.slugs.identical).toBe(false);
  });

  it('records the Linux projects root as $HOME/.claude/projects', () => {
    expect(MEASURED.probeLinux.rootFromHome).toEqual({
      root: `${MEASURED.wsl.home}/.claude/projects`,
      source: 'home',
    });
    expect(MEASURED.probeLinux.platform).toBe('linux');
    expect(MEASURED.probeLinux.pathSeparator).toBe('/');
    expect(MEASURED.probeLinux.tempFilesystemCaseSensitive).toBe(true);
    expect(MEASURED.probeLinux.ambiguousOutcome).toBe('ambiguousSlug');
    expect(MEASURED.probeLinux.ambiguousCode).toBe('EAMBIGUOUS');
    expect(MEASURED.probeLinux.exactBeatsCaseVariantOutcome).toBe('exact');
    expect(MEASURED.probeLinux.negativeControlKind).toBe('projectsRootNotFound');
    expect(MEASURED.probeLinux.negativeControlCode).toBe('ENOENT');
  });

  it('records that no Claude Code has ever run inside this WSL, so the Linux slug is OUR encoding and not a CC witness', () => {
    // The honest boundary of the WSL leg: CC never wrote a projects tree in
    // the distro, so nothing here claims CC-on-Linux was observed.
    expect(MEASURED.wsl.claudeDirectoryPresent).toBe(false);
    const posixCases = SLUG_CASES.filter((c) => c.form === 'posix' || c.form === 'wslMount');
    expect(posixCases.length).toBeGreaterThan(0);
    for (const c of posixCases) {
      expect(c.witness).toBe('encoding-rule');
    }
  });
});

// ---------------------------------------------------------------------------
// The probe is a harness, not production
// ---------------------------------------------------------------------------

describe('pathmatrix.probe.ts', () => {
  it('is imported by this test and by nothing that ships', async () => {
    const importers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name === 'pathmatrix.probe.ts' || entry.name === 'pathmatrix.test.ts') continue;
        const text = await readFile(full, 'utf8');
        if (text.includes('pathmatrix.probe')) importers.push(full);
      }
    };
    await walk(join(REPO_ROOT, 'src'));
    await walk(join(REPO_ROOT, 'webview'));
    expect(importers).toEqual([]);
  });
});
