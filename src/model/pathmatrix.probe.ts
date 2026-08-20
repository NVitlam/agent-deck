/**
 * Agent Deck — path-resolution matrix probe.
 *
 * **This is a test harness, not production code.** It is imported by
 * `pathmatrix.test.ts` and by nothing else; `pathmatrix.test.ts` asserts that,
 * so the day someone wires it into the extension the suite says so. It lives
 * under `src/` rather than in a scratch directory for one reason: the WSL leg
 * of the matrix has to run *this repo's real resolution code* under a real
 * Linux Node, which means the probe must be type-checked, linted and
 * bundleable exactly like the code it exercises.
 *
 * What it does: run every question the Phase 4 path matrix asks — projects
 * root resolution, slug encoding, discovery, the case-variant rules and the
 * negative control — against whatever environment it finds itself in, and
 * return the answers as data. The same probe runs in-process on Windows and,
 * bundled by esbuild, under Linux Node inside WSL. One implementation, two
 * platforms, so a difference between the legs is a real difference and not two
 * test files drifting apart.
 *
 * Grounding constraints:
 *
 *   G1  Read-only where it matters. The probe writes **only** inside a
 *       `mkdtemp` directory under the OS temp dir, and removes it in a
 *       `finally`. It never writes to a real `~/.claude`, on either platform,
 *       and the negative control proves the resolution code does not reach one
 *       either.
 *   G8  Single subject. It never enumerates a real projects root; every
 *       directory it discovers is one it just created under the temp dir.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverSessions, resolveProjectsRoot, slugifyWorkspace } from '../parser/tailer.js';
import { correlateWorkspace } from './correlate.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One row of the slug half of the matrix. Loaded from the fixture. */
export interface SlugCase {
  id: string;
  /** How the path is spelled: which OS's convention wrote it. */
  form: 'windows' | 'wslMount' | 'posix' | 'unc';
  workspacePath: string;
  /** The slug this repo's encoding must produce. Asserted, not reported. */
  expectedSlug: string;
  /**
   * `cc-capture` means CC itself wrote this slug and the committed capture
   * still holds it; `encoding-rule` means it is this repo's encoding applied
   * to that path form and nothing about CC's behaviour is being claimed.
   */
  witness: 'cc-capture' | 'encoding-rule';
  note: string;
}

export interface SlugRow {
  id: string;
  workspacePath: string;
  slug: string;
}

export interface RootRow {
  root: string;
  source: 'env' | 'home';
}

export interface DiscoveryRow {
  workspacePath: string;
  requestedSlug: string;
  /** The slug directory as spelled on disk. */
  slugOnDisk: string;
  slugMatch: string;
  sessionIds: string[];
  subagentIds: string[];
  rootSource: string;
}

export interface NegativeControlRow {
  /** The home directory both HOME and USERPROFILE were pointed at. */
  fakedHome: string;
  /** True only if resolution wrongly succeeded — the failure mode we hunt. */
  ok: boolean;
  kind: string;
  code: string;
  path: string;
  expectedPath: string;
}

export interface CaseVariantRow {
  ran: boolean;
  /** Why the leg could not run, when `ran` is false. */
  reason?: string;
  requestedSlug?: string;
  onDisk?: string[];
  outcome?: string;
  code?: string;
  slugOnDisk?: string;
}

export interface ProbeReport {
  platform: string;
  nodeVersion: string;
  pathSeparator: string;
  homedir: string;
  env: { HOME: string | null; USERPROFILE: string | null; WSL_DISTRO_NAME: string | null };
  rootFromHome: RootRow;
  rootFromOverride: RootRow;
  slugs: SlugRow[];
  tempFilesystemCaseSensitive: boolean;
  discovery: DiscoveryRow;
  negativeControl: NegativeControlRow;
  /** On-disk spelling differs from the query by case: must still match. */
  caseInsensitiveMatch: CaseVariantRow;
  /** Two case variants, neither exact: must refuse. */
  ambiguousSlug: CaseVariantRow;
  /** Exact spelling present alongside a case variant: exact must win. */
  exactBeatsCaseVariant: CaseVariantRow;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flip the case of the `n`-th letter of a slug, so a variant differs from the
 * original by case alone. Returns `undefined` when the slug has too few
 * letters, which no real slug does but a hand-made case might.
 */
export function flipNthLetterCase(slug: string, n: number): string | undefined {
  let seen = 0;
  for (let i = 0; i < slug.length; i += 1) {
    const ch = slug[i] as string;
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower === upper) continue; // not a cased letter
    if (seen === n) {
      const flipped = ch === lower ? upper : lower;
      return slug.slice(0, i) + flipped + slug.slice(i + 1);
    }
    seen += 1;
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A minimal, syntactically valid transcript. Not a fixture — a placeholder. */
const ONE_LINE = `${JSON.stringify({ type: 'user', uuid: 'probe' })}\n`;

const SESSION_ID = '4299490e-4a09-46a0-a544-7ffb0429e7e7';
const AGENT_ID = 'a1a53f42c5eca8824';

async function makeProjectTree(root: string, slug: string): Promise<void> {
  const slugDir = join(root, slug);
  const subagentsDir = join(slugDir, SESSION_ID, 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(join(slugDir, `${SESSION_ID}.jsonl`), ONE_LINE, 'utf8');
  await writeFile(join(subagentsDir, `agent-${AGENT_ID}.jsonl`), ONE_LINE, 'utf8');
}

/** The workspace path this platform would actually hand the extension host. */
export function nativeProbeWorkspace(platform: string): string {
  return platform === 'win32' ? 'C:\\Users\\Probe\\ws' : '/mnt/c/Users/Probe/ws';
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export async function runPathProbe(cases: readonly SlugCase[]): Promise<ProbeReport> {
  const temp = await mkdtemp(join(tmpdir(), 'agent-deck-pathmatrix-'));
  const savedHome = process.env['HOME'];
  const savedUserProfile = process.env['USERPROFILE'];
  // Captured BEFORE the negative control fakes the home variables: reporting
  // `homedir()` at the end would report the fake and read like a real home.
  const realHomedir = homedir();
  try {
    // --- pure resolution -------------------------------------------------
    const rootFromHome = resolveProjectsRoot({ env: {} });
    const overrideRoot = join(temp, 'override-root');
    const rootFromOverride = resolveProjectsRoot({
      env: { CLAUDE_PROJECTS_ROOT: overrideRoot },
    });
    const slugs: SlugRow[] = cases.map((c) => ({
      id: c.id,
      workspacePath: c.workspacePath,
      slug: slugifyWorkspace(c.workspacePath),
    }));

    // --- is this filesystem case-sensitive? ------------------------------
    const caseProbeDir = join(temp, 'CaseProbe');
    await mkdir(caseProbeDir, { recursive: true });
    const tempFilesystemCaseSensitive = !(await exists(join(temp, 'caseprobe')));

    // --- discovery against a synthetic tree ------------------------------
    const workspacePath = nativeProbeWorkspace(process.platform);
    const requestedSlug = slugifyWorkspace(workspacePath);
    const discoveryRoot = join(temp, 'projects-discovery');
    await makeProjectTree(discoveryRoot, requestedSlug);
    const correlation = await correlateWorkspace(workspacePath, {
      env: { CLAUDE_PROJECTS_ROOT: discoveryRoot },
    });
    if (!correlation.ok) {
      throw new Error(`probe discovery leg failed: ${correlation.failure.message}`);
    }
    const discovery: DiscoveryRow = {
      workspacePath,
      requestedSlug,
      slugOnDisk: correlation.value.slug,
      slugMatch: correlation.value.slugMatch,
      sessionIds: correlation.value.sessions.map((s) => s.sessionId),
      subagentIds: correlation.value.sessions.flatMap((s) => s.subagents.map((a) => a.agentId)),
      rootSource: correlation.value.rootSource,
    };

    // --- case variants ---------------------------------------------------
    const variantA = flipNthLetterCase(requestedSlug, 0);
    const variantB = flipNthLetterCase(requestedSlug, 1);

    let caseInsensitiveMatch: CaseVariantRow = { ran: false, reason: 'no cased letter in slug' };
    if (variantA !== undefined) {
      const root = join(temp, 'projects-caseinsensitive');
      await makeProjectTree(root, variantA);
      const result = await discoverSessions(workspacePath, {
        env: { CLAUDE_PROJECTS_ROOT: root },
      });
      caseInsensitiveMatch = {
        ran: true,
        requestedSlug,
        onDisk: [variantA],
        outcome: result.ok ? 'matched' : result.failure.kind,
        ...(result.ok ? { slugOnDisk: result.slug } : { code: result.failure.code }),
      };
    }

    let ambiguousSlug: CaseVariantRow = {
      ran: false,
      reason: tempFilesystemCaseSensitive
        ? 'slug has fewer than two cased letters'
        : 'case-insensitive filesystem cannot hold two slug directories differing only by case',
    };
    let exactBeatsCaseVariant: CaseVariantRow = { ...ambiguousSlug };
    if (tempFilesystemCaseSensitive && variantA !== undefined && variantB !== undefined) {
      const root = join(temp, 'projects-ambiguous');
      await makeProjectTree(root, variantA);
      await makeProjectTree(root, variantB);
      const result = await discoverSessions(workspacePath, {
        env: { CLAUDE_PROJECTS_ROOT: root },
      });
      ambiguousSlug = {
        ran: true,
        requestedSlug,
        onDisk: [variantA, variantB].sort(),
        outcome: result.ok ? `matched ${result.slug}` : result.failure.kind,
        ...(result.ok ? { slugOnDisk: result.slug } : { code: result.failure.code }),
      };

      const exactRoot = join(temp, 'projects-exact-wins');
      await makeProjectTree(exactRoot, variantA);
      await makeProjectTree(exactRoot, requestedSlug);
      const exactResult = await discoverSessions(workspacePath, {
        env: { CLAUDE_PROJECTS_ROOT: exactRoot },
      });
      exactBeatsCaseVariant = {
        ran: true,
        requestedSlug,
        onDisk: [variantA, requestedSlug].sort(),
        outcome: exactResult.ok
          ? exactResult.slug === requestedSlug
            ? 'exact'
            : 'caseInsensitive'
          : exactResult.failure.kind,
        ...(exactResult.ok
          ? { slugOnDisk: exactResult.slug }
          : { code: exactResult.failure.code }),
      };
    }

    // --- negative control: BOTH home variables faked ----------------------
    // os.homedir() reads USERPROFILE on Windows and HOME on POSIX. Faking one
    // of the two runs the "we never touch a real ~/.claude" check against the
    // real ~/.claude on the other platform — which has already produced one
    // confident, false pass in this repo's history.
    const fakedHome = join(temp, 'faked-home');
    await mkdir(fakedHome, { recursive: true });
    process.env['HOME'] = fakedHome;
    process.env['USERPROFILE'] = fakedHome;
    const negative = await discoverSessions(workspacePath, { env: {} });
    const negativeControl: NegativeControlRow = {
      fakedHome,
      ok: negative.ok,
      kind: negative.ok ? 'UNEXPECTED SUCCESS' : negative.failure.kind,
      code: negative.ok ? '' : negative.failure.code,
      path: negative.ok ? '' : negative.failure.path,
      expectedPath: join(fakedHome, '.claude', 'projects'),
    };

    return {
      platform: process.platform,
      nodeVersion: process.version,
      pathSeparator: join('a', 'b').slice(1, 2),
      homedir: realHomedir,
      env: {
        HOME: savedHome ?? null,
        USERPROFILE: savedUserProfile ?? null,
        WSL_DISTRO_NAME: process.env['WSL_DISTRO_NAME'] ?? null,
      },
      rootFromHome,
      rootFromOverride,
      slugs,
      tempFilesystemCaseSensitive,
      discovery,
      negativeControl,
      caseInsensitiveMatch,
      ambiguousSlug,
      exactBeatsCaseVariant,
    };
  } finally {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = savedUserProfile;
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI entry — how the WSL leg runs this
// ---------------------------------------------------------------------------

/**
 * Bundled by the test with esbuild and invoked as
 * `node <bundle> --agent-deck-path-probe <cases.json>`; prints the report as
 * JSON on stdout. The flag is deliberately distinctive: importing this module
 * from a test must never trip the entry point.
 */
const PROBE_FLAG = '--agent-deck-path-probe';

async function main(argv: readonly string[]): Promise<void> {
  const casesPath = argv[argv.indexOf(PROBE_FLAG) + 1];
  if (casesPath === undefined) throw new Error(`${PROBE_FLAG} needs a cases file path`);
  const { readFile } = await import('node:fs/promises');
  const cases = JSON.parse(await readFile(casesPath, 'utf8')) as SlugCase[];
  const report = await runPathProbe(cases);
  process.stdout.write(JSON.stringify(report, null, 2));
}

if (process.argv.includes(PROBE_FLAG)) {
  main(process.argv).catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
