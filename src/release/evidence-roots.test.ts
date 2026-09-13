/**
 * ONE EVIDENCE ROOT PER RELEASE (user ruling, 2026-09-10, at the v0.7.0 Phase 5 gate).
 *
 * The private evidence tree (`lab/docs/evidence/`, reached here through `lab/`)
 * had BOTH `v0.7.0/` and `0.7.0/` holding this release's evidence: the OWN-EYES
 * signature sat in one and every gate record in the other, because DoD 5.7's
 * text named `docs/evidence/0.7.0/OWN-EYES.md` while every phase before it wrote
 * under `v0.7.0/`. A reader looking for "the v0.7.0 record" found half of it.
 * They were consolidated into `v0.7.0/` by `git mv` and `0.7.0/` keeps a
 * one-line README pointing across. This file is what stops a second root
 * appearing for a release again.
 *
 * ## The rule, exactly
 *
 *   1. Every top-level directory is VERSION-NAMED (its name carries an x.y.z)
 *      or is one of the pinned UNVERSIONED directories that already exist.
 *      A new unversioned directory — a `phase-6/` for the next release — fails:
 *      new evidence goes under `v<version>/`.
 *   2. Per version, exactly ONE directory holds evidence, and it is named
 *      `v<version>`. Any other directory for that version must be a POINTER:
 *      nothing in it but a `README.md` that links to `../v<version>/`, which
 *      must exist and hold evidence.
 *   3. Closed releases that already had two roots when this rule arrived are
 *      GRANDFATHERED with their exact set pinned, so a third cannot join them
 *      and neither can be renamed away unnoticed.
 *
 * ## What it cannot see, stated rather than implied (working-method rule 18)
 *
 * It judges NAMES. Four unversioned directories at the root hold v0.7.0-era
 * evidence — `phase-0-stats/`, `phase-0b-otel/`, `phase-0c/` and `phase-1b/`
 * (2026-09-05..07) — and a name-based rule cannot attribute them to a release.
 * They are cited by path from the spec's §L, the plan and CLAUDE.md, so they
 * were left where they are; rule 1 pins them so the set cannot grow.
 *
 * The rule itself is tested on planted listings and runs everywhere. The check
 * over the REAL tree needs the private repository, which a contributor clone
 * does not have — that half is a reported skip, never a silent pass.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EVIDENCE = join(ROOT, 'lab', 'docs', 'evidence');

/** One top-level directory, as the rule sees it. */
interface RootDir {
  name: string;
  /** Direct entries (files and directories) inside it. */
  entries: readonly string[];
  /** The text of its `README.md`, when it has one. */
  readme?: string;
}

/**
 * Unversioned directories that existed when the rule arrived. Cross-release
 * ledgers (`runner`, `privacy`, `scrub`, `ui-states`, `opencode`) and the
 * phase directories of closed plans, plus the four v0.7.0-era ones the header
 * names. Pinned as a set: it may shrink, never grow.
 *
 * GROWN ONCE, BY USER RULING (R4, 2026-09-13): `phase-0-copilot` and
 * `phase-0-cursor`, two phase-0 spikes of the same class as `phase-0b-otel` -
 * standalone feasibility captures, not the evidence of a release. They sat
 * untracked in lab and made this test the single red file of the 0.8.0 gate.
 * The rule above still stands for anything else.
 */
const UNVERSIONED: ReadonlySet<string> = new Set([
  'opencode',
  'phase-0-copilot',
  'phase-0-cursor',
  'phase-0-stats',
  'phase-0b-otel',
  'phase-0c',
  'phase-1',
  'phase-10',
  'phase-1b',
  'phase-2',
  'phase-4',
  'phase-5-5',
  'phase-8',
  'phase-9',
  'privacy',
  'runner',
  'scrub',
  'ui-states',
]);

/**
 * Closed, published releases that already had two evidence roots. Exact sets.
 * Consolidating them would move files every older document cites by path, for
 * releases that will not gain another line of evidence.
 */
const GRANDFATHERED: Readonly<Record<string, readonly string[]>> = {
  '0.5.0': ['audit-0.5.0-record', 'release-0.5.0'],
  '0.6.0': ['release-0.6.0', 'v0.6.0'],
};

const VERSION_RE = /(\d+\.\d+\.\d+)/;

function isPointer(dir: RootDir, version: string): boolean {
  return (
    dir.entries.length === 1 &&
    dir.entries[0] === 'README.md' &&
    (dir.readme ?? '').includes(`../v${version}/`)
  );
}

/** Every violation of the rule over a listing, as human-readable lines. */
function evidenceRootViolations(dirs: readonly RootDir[]): string[] {
  const violations: string[] = [];
  const byVersion = new Map<string, RootDir[]>();
  for (const dir of dirs) {
    const version = VERSION_RE.exec(dir.name)?.[1];
    if (version === undefined) {
      if (!UNVERSIONED.has(dir.name)) {
        violations.push(`${dir.name}/ is a new unversioned root — evidence goes under v<version>/`);
      }
      continue;
    }
    const list = byVersion.get(version) ?? [];
    list.push(dir);
    byVersion.set(version, list);
  }
  for (const [version, list] of byVersion) {
    const grandfathered = GRANDFATHERED[version];
    if (grandfathered !== undefined) {
      const names = list.map((d) => d.name).sort();
      if (JSON.stringify(names) !== JSON.stringify([...grandfathered].sort())) {
        violations.push(
          `${version}: grandfathered roots changed — expected ${grandfathered.join(', ')}, found ${names.join(', ')}`,
        );
      }
      continue;
    }
    const real = list.filter((d) => !isPointer(d, version));
    const canonical = `v${version}`;
    if (real.length > 1) {
      violations.push(
        `${version}: ${String(real.length)} evidence roots (${real.map((d) => `${d.name}/`).join(', ')}) — one per release, under ${canonical}/`,
      );
    }
    const pointers = list.filter((d) => isPointer(d, version));
    if (pointers.length > 0 && !real.some((d) => d.name === canonical)) {
      violations.push(`${version}: a pointer leads to ${canonical}/, which holds no evidence`);
    }
    // Pre-existing sole hotfix roots keep their names; a release that arrives
    // after this rule is named `v<version>`.
    if (real.length === 1 && real[0]?.name !== canonical && !/^hotfix-/.test(real[0]?.name ?? '')) {
      violations.push(`${version}: its root is ${real[0]?.name ?? '?'}/ — name it ${canonical}/`);
    }
  }
  return violations;
}

/** The real tree, read off disk. */
function readRoot(): RootDir[] {
  return readdirSync(EVIDENCE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const path = join(EVIDENCE, e.name);
      const entries = readdirSync(path);
      const readmePath = join(path, 'README.md');
      return {
        name: e.name,
        entries,
        ...(existsSync(readmePath) && statSync(readmePath).isFile()
          ? { readme: readFileSync(readmePath, 'utf8') }
          : {}),
      };
    });
}

describe('one evidence root per release — the rule, on planted listings', () => {
  const pointer = (version: string): RootDir => ({
    name: version,
    entries: ['README.md'],
    readme: `Moved: see [\`../v${version}/\`](../v${version}/).`,
  });
  const root = (name: string): RootDir => ({ name, entries: ['GATE.md'] });

  it('accepts one root plus a pointer to it — the v0.7.0 shape', () => {
    expect(evidenceRootViolations([root('v0.7.0'), pointer('0.7.0')])).toStrictEqual([]);
  });

  it('refuses a SECOND evidence root for the same release — the case that happened', () => {
    const found = evidenceRootViolations([root('v0.7.0'), root('0.7.0')]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('2 evidence roots');
  });

  it('refuses a "pointer" that also carries evidence, or points nowhere', () => {
    const stuffed: RootDir = { ...pointer('0.8.0'), entries: ['README.md', 'OWN-EYES.md'] };
    expect(evidenceRootViolations([root('v0.8.0'), stuffed])).toHaveLength(1);
    const wrong: RootDir = { ...pointer('0.8.0'), readme: 'see ../v0.9.0/' };
    expect(evidenceRootViolations([root('v0.8.0'), wrong])).toHaveLength(1);
    expect(evidenceRootViolations([pointer('0.8.0')])[0]).toContain('holds no evidence');
  });

  it('refuses a new unversioned root, and a release root not named v<version>', () => {
    expect(evidenceRootViolations([root('phase-6')])[0]).toContain('new unversioned root');
    expect(evidenceRootViolations([root('0.8.0')])[0]).toContain('name it v0.8.0/');
    expect(evidenceRootViolations([root('release-0.8.0')])[0]).toContain('name it v0.8.0/');
  });

  it('holds the grandfathered pairs to their exact sets — a third root is refused', () => {
    expect(
      evidenceRootViolations([root('release-0.6.0'), root('v0.6.0'), root('0.6.0')])[0],
    ).toContain('grandfathered roots changed');
    expect(evidenceRootViolations([root('release-0.6.0'), root('v0.6.0')])).toStrictEqual([]);
  });
});

describe.skipIf(!existsSync(EVIDENCE))('one evidence root per release — the REAL private tree', () => {
  it('has no violation', () => {
    expect(evidenceRootViolations(readRoot())).toStrictEqual([]);
  });

  it('is looking at the tree it claims to: the consolidated v0.7.0 root and its pointer', () => {
    // Vacuity control: a rule over an empty or wrongly located listing passes.
    const dirs = readRoot();
    expect(dirs.length).toBeGreaterThan(15);
    const pointer = dirs.find((d) => d.name === '0.7.0');
    expect(pointer?.entries).toStrictEqual(['README.md']);
    const v070 = dirs.find((d) => d.name === 'v0.7.0');
    expect(v070?.entries).toContain('OWN-EYES.md');
    expect(v070?.entries).toContain('api-probe');
    // Every pinned unversioned name still exists, so the set only ever shrinks
    // deliberately rather than going stale.
    const names = new Set(dirs.map((d) => d.name));
    for (const name of UNVERSIONED) expect(names.has(name), name).toBe(true);
  });
});
