// The README is a shipped artifact, not documentation: `.vscodeignore` keeps it
// inside the VSIX, so it is the first and often only thing a user reads. This
// file exists because every claim in it is a claim about code that can move
// underneath it, and prose does not fail a build.
//
// Defect classes each group below catches, named so a failure says what broke:
//
//   1. THE PASTE BLOCK DOES NOT PARSE. A hook block with a stray comma is a
//      user whose settings file is now broken and whose session is not. The
//      block is JSON.parse'd here; "it looks like JSON" is not a check.
//   2. THE PASTE BLOCK DRIFTS FROM THE PROVEN ONE. `.claude/settings.local.json`
//      is LIVE in this repository - its commands POST on every tool call, so it
//      is the only hook block anywhere with evidence behind it. The README's
//      block is asserted byte-identical to it, whole object and command string
//      by command string. Retyping or reformatting a working one-liner is the
//      failure this prevents.
//   3. `curl` CREEPS BACK IN. Measured: against a closed loopback port - which
//      is what the hook finds whenever Agent Deck is not running - `curl.exe`
//      burns its full connect timeout while `node -e` takes ECONNREFUSED and
//      exits 0. A "simplified" block stalls every tool call in a real session.
//   4. THE PORT AND THE MANIFEST DISAGREE. `package.json` owns the default; the
//      pasted block hard-codes a literal and cannot be told otherwise, and the
//      listener refuses to pick a different port for the user. Two agreeing
//      literals is not a contract, so the literal is read from the manifest -
//      and, since Phase 6, from `DEFAULT_HOOK_PORT` in `src/hooks/listener.ts`
//      as well. README->manifest alone is one edge of a triangle: it stays
//      green while the manifest and the code that binds the socket disagree.
//      `src/release/manifest.test.ts` binds manifest->code; the third
//      assertion here collapses all three sources to one number, so the
//      closure is asserted rather than inferred from two edges.
//   5. THE VERSION BADGE GOES STALE. This is the trap in the DoD's own wording:
//      "pinned-CC-version badge" describes the pre-Phase-4 world of one pinned
//      version, and the shipped rule is an acceptance WINDOW. The constants are
//      IMPORTED from `src/parser/fingerprint.ts` rather than written down again
//      - a test that hard-coded 2.1.234 would rot in exactly the same way the
//      README would, and would rot silently.
//   6. THE SPEC CONTRADICTS THE PRODUCT. Carry-forward G: `agent-deck-spec.md`
//      section 3 stated a single-pin version posture after the code stopped
//      implementing it. Two guards, deliberately different in scope:
//        - POSITIVE, section 3 only. The numbers a reader takes away are
//          asserted against IMPORTED constants. Scoped, because a whole-spec
//          scan for "anchor `x.y.z`" would fire on any section that mentions a
//          version for an unrelated reason.
//        - NEGATIVE, the WHOLE document, by pattern. Until Phase 6 this was
//          two exact lowercased phrases over the section-3 slice, which let a
//          REWORDED single-pin claim through, and let any wording at all
//          through if it was written in another section. The pattern list is
//          derived from what the superseded posture actually said (the spec
//          text replaced at `3024425`, plus the version-posture bullet in
//          CLAUDE.md) rather than from what a contradiction might look like.
//      WHAT THIS DOES NOT DO: it does not prove the prose cannot contradict the
//      code. Prose has unbounded ways to say a wrong thing and a regex list has
//      a finite number of ways to notice. What it does is make the cheap
//      failure - restating the old posture in slightly different words, or
//      restating it somewhere the guard was not looking - cost a red test. Read
//      it as a raised floor, not as a proof, the same way the byte-identity
//      check below is a proxy for the clean-profile test and not that test.
//   7. A DEVELOPER PATH SHIPS. `fixtures/**` is excluded from the VSIX because
//      it carries absolute paths; a README that names one leaks the same thing
//      through the front door.
//
// NOT COVERED, and deliberately: the other half of the DoD item is "hook block
// copy-paste tested on a clean profile (hooks fire first try)". That needs a
// human with a fresh Claude Code profile and a bound listener. Nothing in this
// file exercises Claude Code, so nothing here is evidence for it. Byte-identity
// with a block that IS firing is the strongest mechanical proxy available, and
// it is a proxy.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CODEX_NEVER_OPEN } from '../codex/never-open.js';
import { DEFAULT_HOOK_PORT } from '../hooks/listener.js';
import {
  OC_VERSION_WINDOW,
  PINNED_OPENCODE_VERSION,
  isOpencodeVersionAccepted,
  opencodeVersionWindow,
} from '../opencode/fingerprint.js';
import {
  PINNED_CC_VERSION,
  VERSION_WINDOW,
  isVersionAccepted,
  versionWindow,
} from '../parser/fingerprint.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Read as text with line endings normalised.
 *
 * `.gitattributes` sets `* text=auto` and `core.autocrlf=true` is set on the
 * machine that wrote these files, so a fresh clone hands the same document out
 * with CRLF. Every assertion here is about content, so normalising is honest;
 * a byte comparison would be measuring the checkout instead.
 */
function readText(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

/** One entry of a Claude Code hook group: the command and how long it may run. */
interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

/** A matcher group under one event name. */
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** `{ "hooks": { "<EventName>": HookGroup[] } }` - the shape that gets pasted. */
interface HookSettings {
  hooks: Record<string, HookGroup[]>;
}

function isHookSettings(value: unknown): value is HookSettings {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hooks' in value &&
    typeof (value as { hooks: unknown }).hooks === 'object' &&
    (value as { hooks: unknown }).hooks !== null
  );
}

/** Every command string in a hooks object, in event order. */
function commandsOf(settings: HookSettings): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [event, groups] of Object.entries(settings.hooks)) {
    out.set(
      event,
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    );
  }
  return out;
}

const README = readText('README.md');


/**
 * The four release images, in the order the page reads in.
 *
 * THESE WERE PLACEHOLDERS UNTIL 2026-08-30 and are not any more, which is why
 * this list reads differently from the one it replaced. Phase 8 shipped four
 * references - `media/deck.png`, `media/tree.png`, `media/focus.png`,
 * `media/demo.gif` - to files that did not exist, deliberately: they are
 * pictures of a running UI, which no automated step can produce, so the
 * references shipped and the BYTES were deferred to the release gate. The
 * bytes have arrived. The GIF was dropped rather than regenerated (a decision,
 * not an omission: an animation of a live UI is the one asset the gate could
 * not check the way it checked the stills), and the focus view lost its own
 * still to two of the inspector, which is the surface a reader has questions
 * about.
 *
 * So the exemption those four names carried in 'links only LOCAL images' is
 * GONE, and the existsSync check now covers every image on the page. That is
 * the whole point of the change: for two phases these four paths were the only
 * links on this page nothing verified, and a Marketplace listing rendering
 * four broken images was a shipping defect the suite could not see.
 *
 * The names carry UNDERSCORES. The captures had spaces, and a space in a
 * Markdown image path is `%20`, which the Marketplace renderer and GitHub do
 * not have to agree about. `.gitignore` and `.vscodeignore` name the same four
 * plus `media/icon.png`; the private repository keeps the space-named
 * originals and `lab/docs/evidence/release-0.5.0/MEDIA-GATE.md` is the gate
 * they passed.
 */
const RELEASE_IMAGES: readonly string[] = [
  'media/Session_Deck.png',
  'media/hero_16_agent_session.png',
  'media/Internal_Session_Tool_popup.png',
  'media/Internal_Session_Tool_popup2.png',
];

/* ------------------------------------------------------------------------- *
 * TWO ENGINES, TWO VERSION WINDOWS, ONE DOCUMENT.
 *
 * Every version guard below was written when this extension observed one
 * engine, so each of them reads a backticked `x.y.z` literal ANYWHERE in the
 * README as a Claude Code version. At v0.5.0 that stopped being true, and it
 * stopped being true in the most dangerous possible way: `1.18.22` is a
 * perfectly correct OpenCode anchor and a version the CC predicate refuses, so
 * a correct README would have gone red — and the obvious "fix" is to loosen the
 * guard that caught the blackout twice.
 *
 * So the document is REGIONED instead, with explicit markers a reader can grep:
 *
 *   <!-- engine:opencode -->  ...  <!-- /engine:opencode -->
 *
 * The CC guards run over everything outside those markers; a mirrored set runs
 * inside them against `PINNED_OPENCODE_VERSION` and `OC_VERSION_WINDOW`. An
 * HTML comment renders as nothing on the Marketplace and on GitHub.
 *
 * The markers are asserted balanced and the OC region asserted non-empty,
 * because the failure mode of a regioned guard is a region that quietly covers
 * the whole document (every CC assertion then passes over nothing) or none of
 * it (the OC assertions do). Both are checked below.
 * ------------------------------------------------------------------------- */
const OC_REGION_RE = /<!-- engine:opencode -->([\s\S]*?)<!-- \/engine:opencode -->/g;

/** The README with every OpenCode region removed: the Claude Code document. */
const README_CC = README.replace(OC_REGION_RE, '\n');

/** Only the OpenCode regions, joined: the OpenCode document. */
const README_OC = [...README.matchAll(OC_REGION_RE)].map((m) => m[1] ?? '').join('\n');

/**
 * THE SPEC IS NO LONGER IN THIS REPOSITORY, and the guards below are gated on
 * it rather than deleted.
 *
 * `agent-deck-spec.md` moved to the maintainer's private repository in the
 * 2026-08-28 split, along with `CLAUDE.md`, `PLAN.md`, `HANDOVER.md` and
 * `docs/`. The maintainer's checkout presents it at this path again through a
 * junction, so for them these guards RUN and keep binding the spec's version
 * posture to `PINNED_CC_VERSION`. For a contributor the file is absent and the
 * describes below SKIP.
 *
 * This is a FOURTH environment-conditional gate and it must be accounted for BY
 * NAME the way the other three are (`AGENT_DECK_PACKAGE_AUDIT`, the two WSL
 * gates, `LIVE_SETTINGS`). A suite that fails to collect reports as "skipped"
 * and reads green in the summary line; knowing which skips are supposed to be
 * there is the only defence this repository has ever had against that.
 */
const SPEC: string | null = existsSync(join(ROOT, 'agent-deck-spec.md'))
  ? readText('agent-deck-spec.md')
  : null;

/** Every ```json fence in the README, as raw text. */
const JSON_FENCES: string[] = [...README.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? '');

interface Manifest {
  contributes: {
    configuration: {
      properties: Record<string, { default?: unknown }>;
    };
  };
  /** Read by the VS Code floor assertion below. */
  engines?: { vscode?: string };
  /**
   * The extension icon, read by the `media/` exact-set assertion so the one
   * tracked image the README does not link is identified by the manifest that
   * requires it rather than by a literal written down twice.
   */
  icon: string;
  /**
   * What vsce rewrites the README's relative image links against when it
   * packages. See 'keeps the three preconditions the Marketplace render
   * depends on'.
   */
  repository?: { url?: string };
  /**
   * Read by the shipped-documents guard at the end of this file, to find the
   * CHANGELOG section for the release under audit. Taken from the manifest
   * rather than written down here, so bumping the version moves the guard with
   * it instead of leaving it checking a section nobody edits any more.
   */
  version: string;
}

const MANIFEST = JSON.parse(readText('package.json')) as Manifest;

/**
 * Everything git tracks under `media/`, spawned ONCE at module scope.
 *
 * Two tests below need this list and each of them used to spawn its own
 * `git ls-files`. That is this repository's recorded 'an expensive subprocess
 * called once per test is a test that passes or fails by CPU load' defect, and
 * it did exactly what the record says it does: green run alone, and
 * `Test timed out in 5000ms` in the full suite, on the first run of the gate
 * that was meant to close this work. vitest's DEFAULT test timeout is 5 s and
 * nothing here had asked for more.
 *
 * One spawn, at import time, where the collect phase's budget covers it. The
 * tests below also carry an explicit budget, so a slow machine reports a slow
 * test rather than a mystery.
 */
const TRACKED_MEDIA: readonly string[] = execFileSync('git', ['ls-files', '--', 'media'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '');
const DEFAULT_PORT = MANIFEST.contributes.configuration.properties['agentDeck.port']?.default;

/**
 * The FROZEN copy of the proven hook block, tracked so this file is hermetic.
 *
 * `.claude/` was untracked before the public flip, so the live settings file
 * exists on the author's disk and on no fresh clone. Asserting against it alone
 * made this suite pass locally and fail in CI - green for whoever wrote it, red
 * for everyone else, which is the same shape as the CRLF shebang trap.
 */
const FROZEN_SETTINGS = JSON.parse(readText('fixtures/hooks/hook-block.json')) as HookSettings;

/** The live block, when it is present. `null` on any clone that lacks it. */
const LIVE_PATH = join(ROOT, '.claude/settings.local.json');
const LIVE_SETTINGS: HookSettings | null = existsSync(LIVE_PATH)
  ? (JSON.parse(readText('.claude/settings.local.json')) as HookSettings)
  : null;

describe('README exists and ships clean', () => {
  it('is present at the repository root and is not empty', () => {
    expect(README.length).toBeGreaterThan(0);
    expect(README.trimStart().startsWith('# Agent Deck')).toBe(true);
  });

  it('names no absolute path at all, developer or otherwise', () => {
    // WRITTEN AS SHAPES, NOT AS NAMES, and the reason is that the names left.
    // This test used to list the developer's own folder names; after the
    // 2026-08-28 split no identity string exists in this repository to list, and
    // listing one would reintroduce exactly what the split removed. It would
    // also be a literal the redactor rewrote - which happened: the list became
    // `['dev', 'projects', 'C:\\Users']`, and `dev` is a substring of
    // "developer", so the assertion was one README edit away from failing for a
    // reason that had nothing to do with privacy.
    //
    // Shapes are the stronger assertion anyway: they catch an absolute path
    // belonging to ANYBODY, including the next contributor's.
    const ABSOLUTE_SHAPES = [
      /[a-z]:[\\/]users[\\/]/i,
      /\/home\/[a-z0-9_.-]+\//i,
      /\/mnt\/[a-z]\/users\//i,
    ];
    for (const shape of ABSOLUTE_SHAPES) {
      expect(shape.test(README), `README names an absolute path: ${String(shape)}`).toBe(false);
    }
    // Vacuity control: the shapes must match the thing they describe, or this
    // passes forever over a README full of home paths.
    expect(ABSOLUTE_SHAPES.some((re) => re.test('see C:\\Users\\someone\\notes'))).toBe(true);
    expect(ABSOLUTE_SHAPES.some((re) => re.test('see /home/someone/notes'))).toBe(true);
  });

  it('links to no document that left this repository in the 2026-08-28 split', () => {
    // `CLAUDE.md`, `PLAN.md`, `HANDOVER.md`, `AGENTS.md`, `agent-deck-spec.md`,
    // `docs/` and `spike/` are in the maintainer's private repository. A link to
    // one of them from the SHIPPED README is a 404 for every reader, and the
    // README is the first and often the only thing a user reads.
    // `CONTRIBUTING.md` is what replaces them for a contributor.
    const MOVED = [
      /\]\(\s*(?:\.\/)?CLAUDE\.md/i,
      /\]\(\s*(?:\.\/)?PLAN\.md/i,
      /\]\(\s*(?:\.\/)?HANDOVER\.md/i,
      /\]\(\s*(?:\.\/)?AGENTS\.md/i,
      /\]\(\s*(?:\.\/)?agent-deck-spec\.md/i,
      /\]\(\s*(?:\.\/)?docs\//i,
      /\]\(\s*(?:\.\/)?spike\//i,
    ];
    for (const link of MOVED) {
      expect(link.test(README), `README links a moved document: ${String(link)}`).toBe(false);
    }
    expect(MOVED.some((re) => re.test('see [the plan](PLAN.md) for detail'))).toBe(true);
    expect(MOVED.some((re) => re.test('see [evidence](docs/evidence/x.md)'))).toBe(true);
  });

  /**
   * THE HOW-GUARD — the README says WHAT, and points at SECURITY.md for HOW.
   *
   * The `Trust` section's job is a promise a user can act on: read-only, zero
   * egress, nothing displayed that should not be. It carried a paragraph
   * explaining the *mechanism* of the one qualification to "read-only" —
   * write-ahead logging, the index file SQLite touches beside a database, which
   * of OpenCode's files are never opened. All true, all measured, and all in
   * `SECURITY.md` §2 already. In a README it asks a reader to evaluate an
   * implementation detail in order to decide whether to trust a claim, which is
   * the opposite of what that section is for.
   *
   * So the paragraph is one sentence now, and this guard keeps it that way.
   *
   * **SCOPE, stated because a guard whose reach is guessed at is worse than
   * none.** The pattern set is the storage-mechanism vocabulary of the
   * paragraph that was removed, and nothing wider. It is deliberately NOT a
   * general "no implementation nouns" lint: the version-window section names a
   * join key and the subagent directory convention on purpose, because there
   * the mechanism IS the user-facing rule — what refuses a session. Widening
   * this to flag those would be a different decision, and it is the user's.
   *
   * Case-insensitive, and that is not cosmetic: a case-sensitive `WAL` misses
   * `Wal`/`wal`, and a `WAL` without word boundaries matches "walks back out"
   * in the focus paragraph — measured, it does.
   */
  const HOW_TERMS =
    /\bWAL\b|\bSQLite\b|\bsidecar\b|\bindex file\b|\bwrite-ahead\b|-shm\b/i;

  it('the HOW-guard: no storage mechanism in the README, only a pointer to SECURITY.md', () => {
    const hits = README.split('\n')
      .map((line, i) => ({ n: i + 1, line }))
      .filter((row) => HOW_TERMS.test(row.line));
    expect(hits.map((h) => `${String(h.n)}: ${h.line.trim()}`)).toEqual([]);

    // Vacuity controls. The pattern must catch the sentences it was built from
    // — otherwise this passes forever over a README that says anything at all.
    expect(HOW_TERMS.test('OpenCode’s session store is a database in WAL mode')).toBe(true);
    expect(HOW_TERMS.test('causes SQLite to touch its own index file beside it')).toBe(true);
    expect(HOW_TERMS.test('it writes the -shm sidecar')).toBe(true);
    // ...and must NOT catch the word it used to, before the boundaries went in.
    expect(HOW_TERMS.test('The breadcrumb walks back out')).toBe(false);
  });

  it('the qualification survives as a claim, pointing at where it is measured', () => {
    // Removing the mechanism must not remove the ADMISSION. The sentence has to
    // still say there IS a qualification and where the measurement lives, or
    // this trade would have bought tidiness by dropping a disclosure.
    const qualification = README.split('\n\n').find((p) => /qualification/i.test(p));
    expect(qualification, 'the README no longer admits any qualification').toBeDefined();
    expect(qualification ?? '').toMatch(/read-only/i);
    expect(qualification ?? '').toContain('SECURITY.md');
    // And the link is a real one, to a file that exists and carries a §2.
    expect(README).toContain('[`SECURITY.md`](SECURITY.md)');
    expect(existsSync(join(ROOT, 'SECURITY.md'))).toBe(true);
    expect(readText('SECURITY.md')).toMatch(/##\s*2\./);
  });

  it('ships a CONTRIBUTING.md that states the constraints a contributor needs', () => {
    // The constraints used to be readable in `CLAUDE.md`, which is no longer
    // here. Without this file the split would have removed a contributor's only
    // statement of the things that fail review.
    const contributing = readText('CONTRIBUTING.md');
    for (const claim of ['Read-only', 'egress', 'Refuse', 'Fixtures']) {
      expect(contributing, `CONTRIBUTING.md does not state: ${claim}`).toContain(claim);
    }
    expect(contributing).toContain('privacy-sweep.mjs');
  });

  it('links only LOCAL images, and every one of them exists on disk', () => {
    // Was: link no image at all. The marketplace page needs screenshots, so the
    // assertion moved rather than being deleted - it still covers both original
    // cases. A remote badge would fail the protocol check (an extension whose
    // headline claim is zero egress must not fetch its own README assets from a
    // third party), and a missing screenshot fails the existsSync check, which
    // is the case that would otherwise ship a broken marketplace page.
    const links = [...README.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(links.length).toBeGreaterThan(0);
    // The ONE remote image allowed, and the exemption is narrow on purpose: the
    // marketplace version badge. It renders on the marketplace listing and on
    // GitHub, both of which are pages a browser loads anyway - it is never
    // fetched by extension code, so it does not touch the zero-egress claim,
    // which is about what the extension does at runtime. Every other image
    // stays local, which is still what keeps a screenshot from silently
    // becoming a third-party request.
    const BADGE_HOST = /^https:\/\/img\.shields\.io\/visual-studio-marketplace\//;
    for (const link of links) {
      if (BADGE_HOST.test(link)) continue;
      expect(link, `remote asset in README: ${link}`).not.toMatch(/^[a-z]+:\/\//i);
      // NO EXEMPTION. Until 2026-08-30 the four release slots were skipped
      // here because their bytes were deferred; they are on disk now, so
      // every image on the page is checked by the same rule, and the release
      // images are checked twice - here for existence, below for order.
      expect(
        existsSync(join(ROOT, link)),
        `README links ${link}, which does not exist`,
      ).toBe(true);
    }
  });

  it('carries the four release images, in order, and no demo GIF', () => {
    // WHAT THIS ASSERTED BEFORE 2026-08-30, because the change is the point:
    // it asserted the four references were present and in order WHETHER OR NOT
    // THE FILES EXISTED, and it carried the exemption that let them not exist.
    // That was correct while the bytes were deferred and it is the wrong shape
    // now. Existence moved back to the sibling test above, where it covers
    // every image on the page rather than all-but-four; what stays here is the
    // thing a plain existence check still cannot see, which is ORDER, and the
    // failure mode it was written for: deleting a reference along with its
    // file passes an existence check silently.
    //
    // WHY `media/` AND NOT `docs/media/`, which is what was asked for: `docs/`
    // is a JUNCTION into the maintainer's private repository. It is gitignored
    // here (`.gitignore` `/docs/`) and denied in `.vscodeignore`, so a file at
    // `docs/media/...` reaches neither GitHub nor the VSIX, and every image
    // would render broken on the marketplace listing - which is exactly what
    // the sibling test 'links to no document that left this repository in the
    // 2026-08-28 split' already forbids for the same reason. `media/` IS
    // tracked and IS packaged.
    const inOrder = [...README.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
      .map((m) => m[1] ?? '')
      .filter((link) => RELEASE_IMAGES.includes(link));
    expect(inOrder, 'the release images are missing or out of order').toStrictEqual([
      ...RELEASE_IMAGES,
    ]);
  });

  it('links no demo GIF, and no image this release retired', () => {
    // THE GIF IS DROPPED, and with no placeholder standing in for it. It was
    // one of the four Phase 8 slots and the only one that is not a still; the
    // media gate can measure a PNG's chunks, read its pixels and sweep its
    // bytes, and an animation is the asset none of that reaches in the same
    // way. A reference to a file nobody is going to supply is a broken image
    // on the Marketplace listing page, which is what this release exists to
    // stop happening.
    //
    // The three `screenshot-*.png` names are here for the same reason from the
    // other direction: they were `0.1.x` captures of a renderer that no longer
    // exists, they are retired into the private repository's `PNG Archive/`,
    // and a reference to one is now a link to a deleted file AND a picture of
    // a deleted UI - the defect class 'the shipped documents describe the
    // shipped UI' further down this file guards in prose.
    const RETIRED = [
      'media/demo.gif',
      'media/deck.png',
      'media/tree.png',
      'media/focus.png',
      'media/screenshot-deck.png',
      'media/screenshot-topology.png',
      'media/screenshot-inspector.png',
    ];
    for (const retired of RETIRED) {
      expect(README, `README still links the retired ${retired}`).not.toContain(retired);
      expect(
        existsSync(join(ROOT, retired)),
        `${retired} is retired but still on disk`,
      ).toBe(false);
    }
    expect(README.toLowerCase()).not.toContain('.gif');
  });

  it('keeps the three preconditions the Marketplace render depends on', () => {
    // THE MARKETPLACE DOES NOT RENDER THESE IMAGES OUT OF THE VSIX, and until
    // 2026-08-30 nothing in this repository said so. vsce rewrites every
    // relative link in the packaged README into an absolute GitHub URL -
    // `media/Session_Deck.png` ships as
    // `<repository.url>/raw/HEAD/media/Session_Deck.png` - because the listing
    // page is served from Microsoft's host, where a relative path means
    // nothing. So the page fetches them from github.com, anonymously, from the
    // DEFAULT BRANCH.
    //
    // A VSIX carrying four perfect images therefore still shows four broken
    // ones unless all three of these hold at publish time. This test owns the
    // two that are properties of the repository; the third is a property of
    // the world and is named in the message so nobody has to rediscover it.
    //
    // The artifact-byte half - that the rewrite actually produced those URLs -
    // is in src/release/vsix.test.ts's gated leg, because it needs a real
    // package. Neither half is sufficient alone.

    // (1) There is a repository URL to rewrite against, and it is the GitHub
    //     form vsce builds from. Without it vsce leaves the links relative and
    //     every image on the listing is broken, silently.
    const url = String(MANIFEST.repository?.url ?? '')
      .replace(/^git\+/, '')
      .replace(/\.git$/, '');
    expect(url, 'package.json needs a github.com repository.url').toMatch(
      /^https:\/\/github\.com\/[^/]+\/[^/]+$/,
    );

    // (2) Every image the README links is TRACKED, so a push of the default
    //     branch actually puts it where the rewritten URL points. An image
    //     that exists only in the working tree passes the existence check
     //    above and 404s on the listing page.
    const tracked = TRACKED_MEDIA;
    for (const image of RELEASE_IMAGES) {
      expect(tracked, `${image} is linked but not tracked`).toContain(image);
    }

    // (3) THE THIRD PRECONDITION IS NOT CHECKABLE FROM HERE and must not be
    //     faked into looking checked: the repository has to be PUBLIC and its
    //     DEFAULT BRANCH has to carry these files, at the moment of publish.
    //     Asserting it would need a network call, which G5 forbids and which
    //     would make this suite depend on github.com being up. It is a step in
    //     the release checklist instead, and the ordering matters: flip the
    //     repository public and merge to the default branch BEFORE publishing,
    //     or the listing goes up with four broken images and stays that way
    //     until someone looks.
  }, 20_000);

  it('references every tracked image except the icon, and every reference is tracked', () => {
    // THE EXACT SET, BOTH WAYS - rule 19, applied to `media/` rather than to
    // the VSIX. A containment check passes every time this repository has
    // actually been bitten: `media/` is a folder screenshots accumulate in,
    // and the recorded case is a stray `media/Action Running.png` that shipped
    // because a deny-by-name rule lost to the next file nobody thought of.
    //
    // `media/icon.png` is the one tracked image the README does not link and
    // must not be asked to: it is the extension icon `package.json` names, not
    // a screenshot, and it is read off the manifest here rather than written
    // down so that renaming it fails in one place instead of passing here and
    // failing in `vsce package`.
    const tracked = TRACKED_MEDIA;
    const icon = String(MANIFEST.icon);
    expect(tracked).toContain(icon);
    expect([...tracked].sort()).toStrictEqual([icon, ...RELEASE_IMAGES].sort());
    // Pinned BESIDE the set, not instead of it: a set comparison written
    // against an empty listing passes vacuously, and a count is the cheapest
    // thing that goes red when it does.
    expect(tracked).toHaveLength(5);
  }, 20_000);
});

describe('the hook paste block', () => {
  it('has exactly one JSON fence carrying a `hooks` key, and every fence parses', () => {
    expect(JSON_FENCES.length).toBeGreaterThan(0);
    const parsed = JSON_FENCES.map((text) => JSON.parse(text) as unknown);
    const hookBlocks = parsed.filter(isHookSettings);
    expect(hookBlocks).toHaveLength(1);
  });

  it('is byte-identical to the frozen copy in fixtures/hooks/hook-block.json', () => {
    const block = JSON.parse(JSON_FENCES[0] ?? '') as unknown;
    expect(isHookSettings(block)).toBe(true);
    if (!isHookSettings(block)) return;

    // Whole-object equality catches matchers and timeouts too; the per-command
    // loop below exists so a failure names the event that drifted.
    expect(block.hooks).toStrictEqual(FROZEN_SETTINGS.hooks);

    const readmeCommands = commandsOf(block);
    const frozenCommands = commandsOf(FROZEN_SETTINGS);
    expect([...readmeCommands.keys()].sort()).toStrictEqual([...frozenCommands.keys()].sort());
    for (const [event, commands] of frozenCommands) {
      expect(readmeCommands.get(event), `command drift on ${event}`).toStrictEqual(commands);
    }
  });

  // Secondary, and deliberately skipped where the file is absent: the frozen
  // copy proves the README matches a block that once fired, this proves it
  // still matches the one firing right now. Only the author's machine can say
  // that, so it must never be the assertion CI depends on.
  it.skipIf(LIVE_SETTINGS === null)(
    'still matches the live block in .claude/settings.local.json, where present',
    () => {
      const block = JSON.parse(JSON_FENCES[0] ?? '') as HookSettings;
      expect(block.hooks).toStrictEqual(LIVE_SETTINGS?.hooks);
      expect(FROZEN_SETTINGS.hooks).toStrictEqual(LIVE_SETTINGS?.hooks);
    },
  );

  it('registers the six events the liveness engine is fed by', () => {
    const block = JSON.parse(JSON_FENCES[0] ?? '') as HookSettings;
    // Asserted against the live file, not a hard-coded list, and additionally
    // spelled out: a block that silently lost SubagentStart still "matches the
    // file" if the file lost it too.
    expect(Object.keys(block.hooks).sort()).toStrictEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop'].sort(),
    );
  });

  it('uses `node -e` and never curl', () => {
    const fence = JSON_FENCES[0] ?? '';
    expect(fence.toLowerCase()).not.toContain('curl');
    const block = JSON.parse(fence) as HookSettings;
    const all = [...commandsOf(block).values()].flat();
    expect(all.length).toBeGreaterThan(0);
    for (const command of all) {
      expect(command.startsWith('node -e ')).toBe(true);
    }
  });

  it('names the manifest default port, and no other port, in every command', () => {
    expect(typeof DEFAULT_PORT).toBe('number');
    const fence = JSON_FENCES[0] ?? '';
    const block = JSON.parse(fence) as HookSettings;
    const commandCount = [...commandsOf(block).values()].flat().length;

    const ports = [...fence.matchAll(/\bport\b\s*[:=]\s*(\d+)/gi)].map((m) => Number(m[1]));
    // One per command: a block that lost its port literal would otherwise pass
    // an "all mentions agree" check vacuously.
    expect(ports).toHaveLength(commandCount);
    for (const port of ports) expect(port).toBe(DEFAULT_PORT);

    // The prose tells the reader the two must agree, so the prose has to name
    // the same number.
    const prose = README.replace(/```json\n[\s\S]*?\n```/g, '');
    expect(prose).toContain(`\`${String(DEFAULT_PORT)}\``);
  });

  it('closes README -> manifest -> code on a single port literal', () => {
    // The two edges asserted separately (here and in manifest.test.ts) leave
    // the closure to transitivity, which holds only while both edges are
    // green in the same run. Collapsing all three sources to one set says the
    // thing directly, and a failure prints which source dissents.
    const fence = JSON_FENCES[0] ?? '';
    const ports = [...fence.matchAll(/\bport\b\s*[:=]\s*(\d+)/gi)].map((m) => Number(m[1]));
    expect(ports.length, 'the pasted block names no port at all').toBeGreaterThan(0);

    const sources = new Set<number>([
      ...ports,
      Number(DEFAULT_PORT),
      DEFAULT_HOOK_PORT,
    ]);
    expect(
      [...sources],
      `README ${JSON.stringify(ports)} / manifest ${String(DEFAULT_PORT)} / ` +
        `DEFAULT_HOOK_PORT ${String(DEFAULT_HOOK_PORT)} disagree`,
    ).toStrictEqual([DEFAULT_HOOK_PORT]);
  });

  it('binds only loopback', () => {
    const fence = JSON_FENCES[0] ?? '';
    expect(fence).toContain("host:'127.0.0.1'");
    expect(fence).not.toContain('0.0.0.0');
  });
});

describe('the version badge is accurate against the shipped constants', () => {
  const window = versionWindow();
  /**
   * The ends of the accepted range. The patch position is a literal `x`
   * because since 2026-08-26 there IS no patch bound - writing a number there
   * would be claiming one. See the dated amendment in agent-deck-spec.md.
   */
  const corners = (): { min: string; max: string } => {
    if (window === undefined) throw new Error('PINNED_CC_VERSION does not parse');
    return {
      min: `${String(window.major)}.${String(window.minMinor)}.x`,
      max: `${String(window.major)}.${String(window.maxMinor)}.x`,
    };
  };

  /** `anchor \`x.y.z\``, `Anchor: \`x.y.z\`` - every way this document says it. */
  const ANCHOR_RE = /\banchor(?:ed on)?:?\s+`(\d+\.\d+\.\d+)`/gi;
  const MINOR_RE = /\bminor \+\/-(\d+)/g;
  /**
   * The patch allowance that no longer exists. This is a NEGATIVE guard: a
   * `patch +/-N` claim reappearing in the README means either the constant came
   * back or the document is describing a rule the parser does not implement,
   * and both of those are the blackout's shape.
   */
  const PATCH_CLAIM_RE = /\bpatch \+\/-(\d+)/g;
  const CORNERS_RE = /`(\d+\.\d+\.x)` to `(\d+\.\d+\.x)`/g;

  it('regions the document, so a CC guard cannot silently read an OpenCode version', () => {
    // The scoping mechanism itself, asserted before anything relies on it. Its
    // failure modes are a region that covers everything (every CC assertion
    // below then passes over an empty string) and a region that covers nothing
    // (the OpenCode mirror does).
    const opens = [...README.matchAll(/<!-- engine:opencode -->/g)].length;
    const closes = [...README.matchAll(/<!-- \/engine:opencode -->/g)].length;
    expect(opens, 'unbalanced engine:opencode markers in README.md').toBe(closes);
    expect(opens).toBeGreaterThan(0);
    expect(README_OC.length, 'the OpenCode region is empty').toBeGreaterThan(0);
    expect(README_CC.length, 'the OpenCode region swallowed the document').toBeGreaterThan(
      README_OC.length,
    );
    // ...and the split actually separates the two anchors, which is the only
    // property any of this exists for.
    expect(README_CC).toContain(PINNED_CC_VERSION);
    expect(README_CC).not.toContain(PINNED_OPENCODE_VERSION);
    expect(README_OC).toContain(PINNED_OPENCODE_VERSION);
    expect(README_OC).not.toContain(PINNED_CC_VERSION);
  });

  it('states the anchor version the fingerprint actually uses', () => {
    const stated = [...README_CC.matchAll(ANCHOR_RE)].map((m) => m[1]);
    expect(stated.length).toBeGreaterThan(0);
    for (const version of stated) expect(version).toBe(PINNED_CC_VERSION);
  });

  it('states the window tolerances the fingerprint actually uses', () => {
    const minors = [...README_CC.matchAll(MINOR_RE)].map((m) => Number(m[1]));
    expect(minors.length).toBeGreaterThan(0);
    for (const minor of minors) expect(minor).toBe(VERSION_WINDOW.minor);
  });

  it('claims no patch tolerance, because there is none', () => {
    expect(VERSION_WINDOW).not.toHaveProperty('patch');
    expect([...README.matchAll(PATCH_CLAIM_RE)].map((m) => m[0])).toEqual([]);
    // Vacuity control: the pattern still matches the sentence it hunts for.
    // `lastIndex` is reset because the RegExp is /g and shared.
    PATCH_CLAIM_RE.lastIndex = 0;
    expect(PATCH_CLAIM_RE.test('major exact, minor +/-1, patch +/-5')).toBe(true);
    PATCH_CLAIM_RE.lastIndex = 0;
  });

  /**
   * F3 — the teleport caveat.
   *
   * A session Claude Code imported from another machine with `--teleport`
   * carries the imported history at a version this window does not accept, so
   * the whole session renders `unsupported` — including the part that continued
   * locally. Measured once, on 2026-08-31:
   * `docs/evidence/release-0.5.0/DRIFT-2.1.251.md` §3.4.
   *
   * **n = 1, AND THAT IS WHY THE WORDING IS GUARDED HERE.** Exactly one
   * teleported transcript existed on the machine that found it, so this
   * repository knows what its own parser does with such a file and does NOT
   * know that every teleport produces one. The release brief's decision 4 is
   * therefore "write it as *not supported*, not as a description of Claude
   * Code's behaviour", and a guard that only checked the word `--teleport` was
   * present would let the next edit turn a limit of ours into a claim about
   * somebody else's product. The chunk rule below is what pins the phrasing.
   */
  const TELEPORT_RE = /--teleport/;
  /** Bullets and blank-line-separated blocks. Blockquote lines stay together. */
  const chunksOf = (text: string): string[] => text.split(/\n(?=\s*[-*] )|\n{2,}/);

  it('states the teleport caveat, in the Claude Code region', () => {
    expect(TELEPORT_RE.test(README_CC)).toBe(true);
    // NOT in the OpenCode region: `--teleport` is a Claude Code flag, and a
    // caveat about it under the OpenCode heading would be a false claim about
    // an engine that has no such feature.
    expect(TELEPORT_RE.test(README_OC)).toBe(false);
  });

  it('phrases the caveat as OUR limit, never as a description of Claude Code', () => {
    const chunks = chunksOf(README_CC).filter((c) => TELEPORT_RE.test(c));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(
        chunk.toLowerCase().includes('not supported'),
        `a --teleport chunk does not say "not supported": ${chunk.slice(0, 160)}`,
      ).toBe(true);
    }
    // Vacuity controls, both directions: the chunker must actually separate
    // blocks, and the predicate must be capable of failing.
    const sample = '- one thing\n- a --teleport thing that says nothing\n- three';
    const found = chunksOf(sample).filter((c) => TELEPORT_RE.test(c));
    expect(found).toHaveLength(1);
    expect(found[0]?.toLowerCase().includes('not supported')).toBe(false);
  });

  it('names no version literal in the caveat, because none was measured', () => {
    // The imported records carried `1.0` on the one transcript that was seen.
    // Printing it would state a fact about Claude Code's teleport format off a
    // single observation — and `names no Claude Code version the shipped parser
    // would refuse`, below, would then have to make an exception for it.
    /*
     * SENTENCE scope, not chunk scope, and the difference is not cosmetic: the
     * compatibility blockquote legitimately carries the anchor and both window
     * corners two sentences away from the caveat. A chunk-wide check fails on a
     * correct README — measured, this assertion went red on `2.1.246` — and the
     * reflex fix would be deleting the guard rather than aiming it.
     *
     * Markdown wraps a sentence across lines, so lines are joined before
     * sentences are split. That is the same trap `the shipped documents
     * describe the shipped UI` records further down this file.
     */
    const sentences = (text: string): string[] =>
      text
        .replace(/\s+/g, ' ')
        .split(/(?<=\.)\s+(?=[A-Z*`[])/)
        .filter((s) => TELEPORT_RE.test(s));
    const caveats = chunksOf(README_CC)
      .filter((c) => TELEPORT_RE.test(c))
      .flatMap(sentences);
    expect(caveats.length).toBeGreaterThan(0);
    for (const sentence of caveats) {
      expect(
        /`\d+\.\d+(?:\.\d+)?`/.test(sentence),
        `the caveat names a version: ${sentence}`,
      ).toBe(false);
    }
    // Vacuity control: the predicate catches a version literal when there is one.
    expect(/`\d+\.\d+(?:\.\d+)?`/.test('teleport writes `1.0` records')).toBe(true);
  });

  it('states window corners derived from those tolerances', () => {
    const { min, max } = corners();
    const stated = [...README_CC.matchAll(CORNERS_RE)];
    expect(stated.length).toBeGreaterThan(0);
    for (const match of stated) {
      expect(match[1]).toBe(min);
      expect(match[2]).toBe(max);
    }
  });

  it('states the VS Code floor the manifest actually declares', () => {
    // THIS ASSERTION EXISTS BECAUSE ITS ABSENCE WAS THE DEFECT. The README
    // carried `^1.75.0` while the manifest moved to `^1.134.0` (PLAN.md's
    // Phase 5 gate amendment B4), and no test went red, because nothing bound
    // the two. A worker reading the file found it; the suite could not.
    //
    // It matters more than a documentation nit: the README ships INSIDE the
    // VSIX, and after B4 the host imports `node:sqlite` at load. A user who
    // trusts a too-low floor installs onto a host where `activate` never runs
    // — an inert extension with no error they can see, which is the same
    // "manifest and build disagree" class this repo has already shipped once.
    //
    // The manifest is READ, never repeated.
    const declared = MANIFEST.engines?.vscode;
    expect(declared, 'manifest declares no engines.vscode').toBeTruthy();
    expect(
      README.includes(`\`${String(declared)}\``),
      `README does not state the manifest's VS Code floor ${String(declared)}`,
    ).toBe(true);
    // Vacuity control: the check is capable of failing.
    expect(README.includes('`^0.0.1`')).toBe(false);
  });

  it('names no Claude Code version the shipped parser would refuse', () => {
    // A badge is only accurate if nothing NEXT to it contradicts it. Backticked
    // `x.y.z` literals are how this document names CC versions; `^1.134.0` and
    // `>=22.22.2` do not match because the backtick is not followed by a digit.
    //
    // The rule used to be "the anchor or a corner, and nothing else". It cannot
    // be that any more: the corners carry an `x` in the patch position, and the
    // document legitimately cites older releases things were MEASURED on (the
    // hook-reload note names 2.1.234). What survives the change is the thing
    // that was always the point - the README must never name a version as
    // though it worked when the shipped predicate refuses it.
    //
    // SCOPED to the Claude Code region since v0.5.0. An OpenCode anchor is a
    // correct `x.y.z` literal that this predicate refuses, so running it over
    // the whole document would make a right README red — and the reflex fix
    // would be loosening the guard that caught the blackout twice.
    const literals = [...README_CC.matchAll(/`(\d+\.\d+\.\d+)`/g)].map((m) => m[1] ?? '');
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(isVersionAccepted(literal), `README names refused version ${literal}`).toBe(true);
    }
    // ...and the anchor is one of them, so the badge is not merely silent.
    expect(literals).toContain(PINNED_CC_VERSION);
    // Vacuity control: the predicate does refuse something.
    expect(isVersionAccepted('4.4.0')).toBe(false);
  });

  it('says the window is a window, not a single supported version', () => {
    expect(README).toContain('versionChangedMidFile');
    expect(README).toContain('major exact');
  });
});

/**
 * The OpenCode token sentence, bound to what the engine actually emits.
 *
 * **This exists because the sentence was WRONG and nothing noticed.** Through
 * 0.5.0 it ended "**Burn** is present" while `burn` was omitted for OpenCode
 * exactly as `contextNow` was — both rendered as an em dash, and both committed
 * goldens carried `null` for both on every session. A user reading the README
 * would have gone looking for a figure that was not there, and the only reason
 * it was caught is that someone opened a card and compared.
 *
 * So the claim is not asserted against a literal. It is re-derived from the
 * committed goldens, which are the byte-exact record of what the engine
 * produces: if `burn` ever went back to `null`, or `contextNow` started being
 * emitted, the prose and the evidence would disagree and this goes red.
 */
describe('the README OpenCode token sentence matches what the engine emits', () => {
  /** Every session and agent node in both committed goldens. */
  const goldenNodes = (): { contextNow: unknown; burn: unknown }[] => {
    const out: { contextNow: unknown; burn: unknown }[] = [];
    const walk = (node: { contextNow: unknown; burn: unknown; children?: unknown[] }): void => {
      out.push({ contextNow: node.contextNow, burn: node.burn });
      for (const child of node.children ?? []) {
        const c = child as { node?: string };
        if (c.node === 'agent') walk(child as typeof node);
      }
    };
    for (const rel of [
      'fixtures/opencode-1.18.21/golden.json',
      'fixtures/opencode-1.18.22/golden.json',
    ]) {
      const parsed = JSON.parse(readText(rel)) as {
        sessions: { contextNow: unknown; burn: unknown; root: never }[];
      };
      for (const session of parsed.sessions) {
        out.push({ contextNow: session.contextNow, burn: session.burn });
        walk(session.root);
      }
    }
    return out;
  };

  it('the goldens show burn PRESENT and contextNow ABSENT, on every session and node', () => {
    const nodes = goldenNodes();
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.filter((n) => n.burn === null)).toEqual([]);
    expect(nodes.filter((n) => n.contextNow !== null)).toEqual([]);
  });

  it('the README says exactly that, and does not say the opposite', () => {
    // The OpenCode region only — the CC side has both figures and its own prose.
    const sentence = README_OC;
    expect(/\bburn\b[^.]{0,40}\bis present\b/i.test(sentence)).toBe(true);
    expect(/\bcontext\b[^.]{0,60}\bem dash\b/i.test(sentence)).toBe(true);
    // The exact wording that shipped wrong, in either order, must not return.
    expect(/\bcontext\b[^.]{0,40}\bis present\b/i.test(sentence)).toBe(false);
    expect(/\bburn\b[^.]{0,60}\bem dash\b/i.test(sentence)).toBe(false);
    // Vacuity control: these patterns can match the shapes they hunt for.
    expect(/\bburn\b[^.]{0,40}\bis present\b/i.test('Burn is present.')).toBe(true);
    expect(/\bburn\b[^.]{0,60}\bem dash\b/i.test('burn reads as an em dash')).toBe(true);
  });

  it('does not repeat the superseded "counts only uncached input" reason', () => {
    // True of `tokens_input` alone and false of the store, which also keeps
    // `tokens_cache_read` and `tokens_cache_write` — both now read. Stating it
    // as a limit of OpenCode was the second wrong half of the old sentence.
    expect(/only\s+uncached\s+input/i.test(README)).toBe(false);
    expect(/only\s+uncached\s+input/i.test('counts only uncached input')).toBe(true);
  });
});

/**
 * The same four assertions, mirrored onto the OpenCode region.
 *
 * Not "the CC tests with a different constant" for its own sake: the defect
 * these exist to prevent has already been paid for once on the CC side, where
 * the README carried `^1.75.0` while the manifest said `^1.134.0` and nothing
 * went red because nothing bound the two. A second engine with its own anchor,
 * its own window and its own prose is the same exposure again, and it arrives
 * in the same release as the prose.
 */
describe('the OpenCode compatibility claims are accurate against the shipped constants', () => {
  const ocWindow = opencodeVersionWindow();
  const ocCorners = (): { min: string; max: string } => {
    if (ocWindow === undefined) throw new Error('PINNED_OPENCODE_VERSION does not parse');
    return {
      min: `${String(ocWindow.major)}.${String(ocWindow.minMinor)}.x`,
      max: `${String(ocWindow.major)}.${String(ocWindow.maxMinor)}.x`,
    };
  };

  it('states the anchor the OpenCode fingerprint actually uses', () => {
    const stated = [...README_OC.matchAll(/\banchor(?:ed on)?:?\s+`(\d+\.\d+\.\d+)`/gi)].map(
      (m) => m[1],
    );
    expect(stated.length, 'the OpenCode region states no anchor').toBeGreaterThan(0);
    for (const version of stated) expect(version).toBe(PINNED_OPENCODE_VERSION);
  });

  it('states window corners derived from the shipped tolerance', () => {
    const { min, max } = ocCorners();
    const stated = [...README_OC.matchAll(/`(\d+\.\d+\.x)` to `(\d+\.\d+\.x)`/g)];
    expect(stated.length, 'the OpenCode region states no window corners').toBeGreaterThan(0);
    for (const match of stated) {
      expect(match[1]).toBe(min);
      expect(match[2]).toBe(max);
    }
  });

  it('names no OpenCode version the shipped predicate would refuse', () => {
    const literals = [...README_OC.matchAll(/`(\d+\.\d+\.\d+)`/g)].map((m) => m[1] ?? '');
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(
        isOpencodeVersionAccepted(literal),
        `README names refused OpenCode version ${literal}`,
      ).toBe(true);
    }
    expect(literals).toContain(PINNED_OPENCODE_VERSION);
    // Vacuity control: the predicate does refuse something, and it refuses on
    // the MAJOR as well as the minor, so no move of the anchor inside 1.x can
    // make this control silently pass.
    expect(isOpencodeVersionAccepted('4.4.0')).toBe(false);
  });

  it('claims no patch tolerance for OpenCode either, because there is none', () => {
    expect(OC_VERSION_WINDOW).not.toHaveProperty('patch');
    const claims = [...README_OC.matchAll(/\bpatch \+\/-(\d+)/g)].map((m) => m[0]);
    expect(claims).toEqual([]);
    // ...and it says so in words, so a reader is not left inferring it from an
    // absence. This is the sentence the CC side had to learn to write twice.
    expect(README_OC).toMatch(/patch (?:component|number) is not compared/i);
  });

  it('names the four secret-bearing tables it never reads', () => {
    // The strongest privacy claim in the OpenCode section, and the one a
    // reader is most entitled to see enumerated rather than summarised.
    for (const table of ['account', 'control_account', 'credential', 'session_share']) {
      expect(README_OC, `the OpenCode section does not name ${table}`).toContain(table);
    }
  });
});

/**
 * The two sentences the superseded posture was actually written in, lowercased.
 * Absolute: forbidden ANYWHERE in the document, with no exemption, including
 * inside a note that marks them as superseded. That bluntness is measured, not
 * stylistic - the first draft of the Phase 5 amendment quoted the old phrase in
 * its own supersession note and the guard failed it, correctly. A reader who
 * greps the spec for the old sentence must find nothing. Paraphrase it instead.
 */
const SUPERSEDED_PHRASES = ['pin to the installed cc version', 'no multi-version support'];

/**
 * Rewordings of the same posture. Each is derived from wording that was really
 * in play - the spec text replaced at `3024425` said "No multi-version support,
 * no drift fixtures, no version matrix. Pin to the installed CC version at
 * capture time", and CLAUDE.md's version-posture bullet records the old rule as
 * one pinned version and "do not build drift tolerance".
 *
 * Bounded distances (`[^.]{0,30}`) rather than `.*`, so a match stays inside one
 * sentence: an unbounded gap makes any two words anywhere in a paragraph a hit,
 * and a guard that fires on correct prose gets deleted rather than fixed.
 *
 * Non-global on purpose. A `/g` RegExp carries `lastIndex` across `.test()`
 * calls and would skip every other sentence it is asked about.
 */
const SUPERSEDED_PATTERNS: { readonly name: string; readonly re: RegExp }[] = [
  // "pinned to the installed CC version", "pins to whatever CC is installed".
  { name: 'pinned-to-installed', re: /\bpin(?:ned|ning|s)?\b[^.]{0,40}\binstalled\b/i },
  // "no multi-version support", "no multi-CC-version schema support".
  // Requires the negation: the hard-exclusions list and section 3's own note
  // that the window OVERRIDES that exclusion both name the phrase without it.
  {
    name: 'no-multi-version-support',
    re: /\bno\b[^.]{0,30}\bmulti[-\s]?(?:cc[-\s]?)?version\b[^.]{0,20}\bsupport/i,
  },
  // "a single pinned CC version", "one single supported version".
  {
    name: 'single-blessed-version',
    re: /\b(?:a\s+)?single\s+(?:pinned|supported|accepted|blessed)\s+(?:cc\s+)?version\b/i,
  },
  // "exactly one CC version", "only one version of Claude Code".
  { name: 'exactly-one-version', re: /\b(?:exactly|only)\s+one\s+(?:cc\s+|claude\s+code\s+)?version\b/i },
  // "no drift tolerance", "no drift fixtures".
  { name: 'no-drift-tolerance', re: /\bno\s+drift\s+(?:tolerance|fixtures)\b/i },
  // CLAUDE.md's record of the old instruction, verbatim in spirit.
  { name: 'do-not-build-drift', re: /\bdo\s+not\s+build\s+drift\b/i },
  // "no version matrix".
  { name: 'no-version-matrix', re: /\bno\s+version\s+matrix\b/i },
];

/**
 * A sentence that says it is superseding something is not asserting it. Without
 * this, three patterns above fire on the amendment's own note - measured on the
 * shipped file - and the only way to keep them would be to loosen them until a
 * real reworded contradiction slipped through. The exemption is deliberately
 * narrow: one sentence, and it does not extend to {@link SUPERSEDED_PHRASES}.
 */
const MARKED_SUPERSEDED = /\bsupersed(?:e|es|ed|ing)\b/i;

/**
 * Sentences, not lines. A markdown paragraph here is one very long line, so
 * line granularity would let a single "supersedes" anywhere in a paragraph
 * exempt everything else in it.
 */
function sentencesOf(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Every unexempted pattern hit, as `name: sentence`. */
function contradictionsIn(text: string): string[] {
  const found: string[] = [];
  for (const sentence of sentencesOf(text)) {
    if (MARKED_SUPERSEDED.test(sentence)) continue;
    for (const { name, re } of SUPERSEDED_PATTERNS) {
      if (re.test(sentence)) found.push(`${name}: ${sentence}`);
    }
  }
  return found;
}

/**
 * Controls for the guard itself, so "no contradictions found" cannot mean "the
 * patterns match nothing". The first two are the superseded spec text; the rest
 * are rewordings that carry the same claim in different words - exactly what
 * the old two-exact-phrases guard let through.
 */
const SUPERSEDED_CONTROLS = [
  'No multi-version support, no drift fixtures, no version matrix.',
  'Pin to the installed CC version at capture time, record it once in fixtures.',
  'The fingerprint is pinned to whichever CC version is installed.',
  'Agent Deck accepts exactly one CC version.',
  'Only one version of Claude Code is ever accepted.',
  'The parser targets a single supported version and builds no drift tolerance.',
  'Do not build drift tolerance into the fingerprint.',
];

describe.skipIf(SPEC === null)('agent-deck-spec.md restates the superseded version posture nowhere', () => {
  it('carries neither superseded sentence, anywhere in the document', () => {
    const lower = (SPEC ?? '').toLowerCase();
    for (const phrase of SUPERSEDED_PHRASES) {
      expect(lower, `agent-deck-spec.md still says "${phrase}"`).not.toContain(phrase);
    }
  });

  it('carries no reworded restatement of it, in any section', () => {
    // Whole document. The predecessor of this test read section 3 alone, so a
    // contradiction in any other section was untested rather than absent.
    expect(contradictionsIn(SPEC ?? '')).toStrictEqual([]);
  });

  it('keeps the supersession exemption to a note, not a licence', () => {
    // An exempted sentence is one that both restates the old posture and says
    // it is superseded. That is a footnote-shaped thing; a document with many
    // of them is a document routing around this guard.
    const exempted = sentencesOf(SPEC ?? '').filter(
      (sentence) =>
        MARKED_SUPERSEDED.test(sentence) &&
        SUPERSEDED_PATTERNS.some(({ re }) => re.test(sentence)),
    );
    expect(exempted.length, `sentences exempted: ${exempted.length}`).toBeLessThanOrEqual(3);
  });

  it('flags the superseded posture and rewordings of it', () => {
    // Vacuity control. Runs on strings held here, never on the spec.
    for (const control of SUPERSEDED_CONTROLS) {
      const flagged =
        contradictionsIn(control).length > 0 ||
        SUPERSEDED_PHRASES.some((phrase) => control.toLowerCase().includes(phrase));
      expect(flagged, `no guard flags: ${control}`).toBe(true);
    }
  });

  it('has no pattern that flags nothing at all', () => {
    // A pattern that matches none of the controls is either dead or was
    // loosened until it stopped meaning anything.
    for (const { name, re } of SUPERSEDED_PATTERNS) {
      expect(
        SUPERSEDED_CONTROLS.some((control) => re.test(control)),
        `pattern ${name} flags none of the controls`,
      ).toBe(true);
    }
  });
});

/**
 * The spec is amended FORWARD-ONLY: earlier sections are left as written so the
 * record of what was believed when stays readable, and a dated section at the
 * end says what the product does now. That makes the LAST dated amendment the
 * one these guards must read - pointing them at section 3 would pin the
 * document to a posture it explicitly supersedes.
 *
 * Section 3 is not left unguarded: the test below asserts the amendment names
 * it as superseded and quotes the numbers it retired, so a reader who lands on
 * the older text has a route to the newer one.
 */
describe.skipIf(SPEC === null)('the spec version-posture amendment matches the shipped constants', () => {
  const AMENDMENT_HEADING = '## Amendment 2026-08-26 — Version posture';

  /** The last dated amendment: its heading through the end of the document. */
  const amendment = ((): string => {
    // `describe.skipIf` still RUNS this callback - it marks the tests skipped,
    // it does not stop collection - so a throw here when the spec is absent
    // would be a COLLECTION failure, which vitest summarises as a skip and a
    // reader summarises as green. The recorded shape, one more time.
    if (SPEC === null) return '';
    const start = SPEC.indexOf(AMENDMENT_HEADING);
    if (start < 0) throw new Error('the dated version-posture amendment could not be located');
    return SPEC.slice(start);
  })();

  it('is the last section, so nothing later can quietly contradict it', () => {
    expect((SPEC ?? '').indexOf(AMENDMENT_HEADING)).toBe((SPEC ?? '').lastIndexOf(AMENDMENT_HEADING));
    expect(amendment.includes('\n## ')).toBe(false);
  });

  it('states the same anchor and tolerance as the shipped constants', () => {
    const anchors = [...amendment.matchAll(/\banchor(?:ed on)?:?\s+`(\d+\.\d+\.\d+)`/gi)].map(
      (m) => m[1],
    );
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(anchor).toBe(PINNED_CC_VERSION);

    const minors = [...amendment.matchAll(/\bminor \+\/-(\d+)/g)].map((m) => Number(m[1]));
    expect(minors.length).toBeGreaterThan(0);
    for (const minor of minors) expect(minor).toBe(VERSION_WINDOW.minor);
  });

  it('claims no patch tolerance and says so in words', () => {
    expect(VERSION_WINDOW).not.toHaveProperty('patch');
    // No live `patch +/-N` claim. The retired one is quoted only as history,
    // in the sentence that names it as what went wrong.
    const claims = [...amendment.matchAll(/\bpatch \+\/-(\d+)/g)].map((m) => Number(m[1]));
    for (const claim of claims) {
      expect(
        amendment.includes(`box of patch +/-${String(claim)}`),
        'a patch tolerance is stated as current rather than as history',
      ).toBe(true);
    }
    expect(amendment).toContain('patch component is not compared');
  });

  it('names the module that owns the numbers, and the mid-file refusal code', () => {
    expect(amendment).toContain('src/parser/fingerprint.ts');
    expect(amendment).toContain('versionChangedMidFile');
    expect(amendment).toContain('2026-08-26');
  });

  it('supersedes section 3 by name, and names the corpus behind the anchor', () => {
    // Without this, a reader landing on section 3 would find the retired
    // numbers with nothing pointing forward. The route has to be in the
    // document, not only in this test.
    expect(amendment).toContain('§3');
    expect(amendment.toLowerCase()).toContain('supersedes');
    expect(amendment).toContain(`fixtures/cc-${PINNED_CC_VERSION}/`);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The user-facing documents must not describe a UI that was deleted.
 * Added 2026-08-29 by `audit-0.5.0-record`, after measurement.
 *
 * WHAT WENT WRONG, because the shape of the defect is the argument for the
 * guard. Design amendment A8.1 (2026-08-29) removed the tool-dot row outright.
 * `layout.ts` lost its dot API and `webview/layout.test.ts` grew a mutation-
 * tested "exports no dot API at all" assertion, so the CODE could not regress.
 * The PROSE was not covered by anything: on the day of this audit `README.md`
 * still told users "tool calls ride each node as chronological dots", its
 * Usage section still described the `0.1.x` nucleus renderer and "tokens as
 * in / out" - a contract A6 deleted - and `CHANGELOG.md`'s `0.5.0` entry, the
 * text that documents this very release, advertised "Tool dots ride each node,
 * up to 24 per node with the remainder counted."
 *
 * Both files ship. `README.md` IS the Marketplace listing page. So the release
 * would have described three features that no longer exist to every user who
 * read it, and nothing in a 2,140-test suite would have said a word.
 *
 * A grep for `dot` cannot be the guard: this repository writes about the dots
 * deliberately and at length, in design amendments, in evidence documents and
 * in the changelog entry that explains the removal. The guard therefore keys
 * on an ASSERTIVE present-tense claim and exempts a sentence that is describing
 * the removal, which is the same exemption shape {@link MARKED_SUPERSEDED}
 * uses one section above.
 * ---------------------------------------------------------------------------
 */

/**
 * Markdown wraps one sentence across several lines, and {@link sentencesOf}
 * splits on newlines first - so a sentence that names a removed surface in one
 * line and says it was removed in the next arrives here as two fragments, the
 * exemption in one and the hit in the other. Joining wrapped lines inside a
 * paragraph is what makes the exemption reach the claim it belongs to. Blank
 * lines still separate paragraphs, so nothing runs together across a break.
 */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) =>
      // A continuation line inside a bullet is INDENTED, so a join keyed on
      // `\n(?=\S)` misses exactly the case this exists for - measured: the
      // changelog's own explanation of why the dots went still arrived in two
      // pieces. Join a newline unless what follows starts a new list item or a
      // heading, which are the two things that really are new blocks.
      block.replace(/\n[ \t]*(?![-*+][ \t]|#|\d+\.[ \t])(?=\S)/g, ' '),
    )
    .join('\n\n');
}

/**
 * A CHANGELOG is APPEND-ONLY HISTORY, and that is not a loophole - it is what
 * the document is. `0.1.0`'s entry describes a nucleus with dot arcs around it
 * because `0.1.0` had one; rewriting that to match today's UI would be
 * falsifying the record, which is the opposite of what this guard is for. So
 * the changelog is checked over the CURRENT version's section only, bounded by
 * the next `## ` heading, and the release under audit is the one whose prose
 * has to match the artifact.
 *
 * Measured while writing this: over the whole file the guard fires on the
 * `0.1.0` entry's own accurate history. Scoped, it fires on nothing.
 */
function currentChangelogEntry(text: string): string {
  const version = MANIFEST.version;
  const start = text.indexOf(`## ${version}`);
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

const CHANGELOG_TEXT = readText('CHANGELOG.md');

/** The documents a user actually reads. Both are shipped in the VSIX. */
const USER_FACING: { readonly name: string; readonly text: string }[] = [
  { name: 'README.md', text: paragraphs(README) },
  { name: `CHANGELOG.md (${MANIFEST.version} entry)`, text: paragraphs(currentChangelogEntry(CHANGELOG_TEXT)) },
];

/**
 * Present-tense claims about surfaces this product no longer has. Bounded gaps
 * (`[^.]{0,N}`) keep a match inside one sentence, for the reason the version
 * guard above states: an unbounded gap turns any two words in a paragraph into
 * a hit, and a guard that fires on correct prose gets deleted rather than fixed.
 */
const REMOVED_UI_PATTERNS: { readonly name: string; readonly re: RegExp }[] = [
  // "tool calls ride each node as dots", "tool dots ride each node".
  { name: 'dots-ride-nodes', re: /\bdots?\b[^.]{0,40}\bride\b|\bride\b[^.]{0,40}\bdots?\b/i },
  // "each tool call is a dot", "every call is drawn as a dot".
  { name: 'call-is-a-dot', re: /\b(?:each|every|a)\s+tool\s+call\s+is\s+(?:a\s+|drawn\s+as\s+a\s+)?dot\b/i },
  // "up to 24 per node with the remainder counted" - the cap, in any wording.
  { name: 'dot-cap', re: /\b(?:up\s+to\s+)?(?:24|48)\b[^.]{0,30}\bper\s+node\b/i },
  // A8.2 re-anchored the filament to the parent's bottom edge; it is no longer
  // drawn from a dot, and a call whose dot was capped away drew nothing.
  { name: 'filament-from-dot', re: /\bfilament\b[^.]{0,60}\bdot\b/i },
  // The 0.1.x interior: a nucleus with a constellation of calls around it.
  { name: 'nucleus', re: /\bnucleus\b/i },
  // A6 removed `AgentNode.tokens`; the drawer reads `context` and `burn`.
  { name: 'tokens-in-out', re: /\btokens\b[^.]{0,20}\bas\b[^.]{0,10}\bin\s*\/\s*out\b/i },
  // Deck cells stopped being blobs when the tree landed.
  { name: 'session-blobs', re: /\bone\s+blob\s+each\b|\bcloud\s+of\s+blobs\b/i },
  // A9.1: nothing is elided anywhere, so no document may promise truncation.
  { name: 'label-elision', re: /\blabels?\b[^.]{0,40}\btruncated\s+(?:with|to)\s+(?:an?\s+)?(?:ellipsis|…)/i },
];

/**
 * A sentence saying a thing was REMOVED is not claiming the thing exists. The
 * changelog has to be able to explain what went and why - that is most of its
 * job - and the design amendments are quoted in evidence documents verbatim.
 */
const DESCRIBES_REMOVAL =
  /\b(?:remov(?:e|ed|es|al)|delet(?:e|ed)|gone|no longer|used to|earlier build|rather than|instead of|not drawn|supersed(?:e|es|ed|ing))\b|\bno\s+tool\s+dots\b/i;

/** Every unexempted hit, as `name: sentence`. */
function removedUiClaimsIn(text: string): string[] {
  const found: string[] = [];
  for (const sentence of sentencesOf(text)) {
    if (DESCRIBES_REMOVAL.test(sentence)) continue;
    for (const { name, re } of REMOVED_UI_PATTERNS) {
      if (re.test(sentence)) found.push(`${name}: ${sentence}`);
    }
  }
  return found;
}

/**
 * Vacuity controls: the exact sentences that were shipping on `release/0.5.0`
 * when this audit measured them, plus rewordings. Held here as strings; the
 * guard is never run against them in production.
 */
const REMOVED_UI_CONTROLS = [
  'Tool calls ride each node as chronological dots.',
  'Tool dots ride each node, up to 24 per node with the remainder counted.',
  'The main agent is the nucleus, each tool call is a dot placed in chronological order around it.',
  'A subagent hangs off a filament drawn from the exact tool-call dot that spawned it.',
  'Per agent it lists status, tokens as in / out, duration and spawn depth.',
  'Every Claude Code session on the machine, one blob each.',
];

describe('the shipped documents describe the shipped UI', () => {
  it('claims no surface that was deleted, in README or CHANGELOG', () => {
    for (const { name, text } of USER_FACING) {
      expect(removedUiClaimsIn(text), `${name} describes a deleted surface`).toStrictEqual([]);
    }
  });

  it('flags every sentence that was really shipping when this was written', () => {
    // Not vacuous, and the controls are not invented: the first five are
    // verbatim from README.md and CHANGELOG.md as measured on 2026-08-29.
    for (const control of REMOVED_UI_CONTROLS) {
      expect(removedUiClaimsIn(control).length, `no pattern flags: ${control}`).toBeGreaterThan(0);
    }
  });

  it('has no pattern that flags nothing at all', () => {
    for (const { name, re } of REMOVED_UI_PATTERNS) {
      const live = REMOVED_UI_CONTROLS.some((control) => re.test(control));
      const selfTested = ['dot-cap', 'label-elision'].includes(name);
      expect(live || selfTested, `pattern ${name} flags none of the controls`).toBe(true);
    }
  });

  it('exempts a removal note without exempting a claim', () => {
    // The changelog explains the dots at length. That must pass. A bare
    // present-tense claim in the same words must not.
    expect(
      removedUiClaimsIn('An earlier build rode a row of dots on each node, one per tool call.'),
    ).toStrictEqual([]);
    expect(
      removedUiClaimsIn('Tool dots ride each node, up to 24 per node.').length,
    ).toBeGreaterThan(0);
  });

  it('keeps the removal exemption to notes, not a licence', () => {
    // Same reasoning as the supersession exemption above: an exempted sentence
    // is one that both names a removed surface and says it was removed. A
    // document with many of them is routing around this guard.
    for (const { name, text } of USER_FACING) {
      const exempted = sentencesOf(text).filter(
        (sentence) =>
          DESCRIBES_REMOVAL.test(sentence) &&
          REMOVED_UI_PATTERNS.some(({ re }) => re.test(sentence)),
      );
      expect(exempted.length, `${name} exempts ${exempted.length} sentences`).toBeLessThanOrEqual(8);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * DoD 4.4 — SECURITY.md's Codex claims are BOUND to the code, not restated
 * -------------------------------------------------------------------------- */

/*
 * WHY THIS EXISTS.
 *
 * `SECURITY.md` now states what the Codex engine reads and what it never opens.
 * The never-opened list is the half that will decay: it is a promise about
 * SECURITY, it is spelled out in prose, and the code's copy lives somewhere
 * else entirely (`src/codex/never-open.ts`). This repository has already
 * shipped a release whose README advertised three DELETED features, covered by
 * nothing — a grep for the relevant words across this file returned zero. The
 * fix then was to bind the prose to the components' own labels, and this is the
 * same move for a security claim.
 *
 * EXACT SET, BOTH WAYS, COUNT PINNED BESIDE IT (rule 19). A containment would
 * pass while the document quietly dropped `auth.json`, which is the one entry
 * whose absence would matter most.
 */
describe("DoD 4.4 — SECURITY.md states the Codex engine's reads and its never-opened list", () => {
  const SECURITY = readText('SECURITY.md');

  /** The never-opened entries SECURITY.md spells, taken from its own table. */
  function documentedNeverOpen(): string[] {
    const start = SECURITY.indexOf('#### G10');
    expect(start, 'SECURITY.md must carry a G10 never-opened section').toBeGreaterThan(-1);
    // To the NEXT heading, not to the next blank line: the section opens with
    // a paragraph, so a blank-line boundary ends it before the table it is
    // here to read. The vacuity control below caught exactly that.
    const after = SECURITY.slice(start + 1);
    const end = after.search(/\r?\n#{2,4} /);
    const section = end === -1 ? after : after.slice(0, end);
    // Every backticked token inside the section's table rows.
    return [...section.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1] as string)
      .filter((name) => /^[.*A-Za-z0-9_/-]+$/.test(name) && name !== 'src/codex/never-open.ts');
  }

  it('spells EXACTLY the list the code enforces — both ways, count pinned', () => {
    const documented = [...new Set(documentedNeverOpen())].sort();
    const enforced = [...CODEX_NEVER_OPEN].sort();

    expect(documented).toStrictEqual(enforced);
    // Beside the set, never instead of it: a set comparison written against an
    // accidentally-empty extraction passes vacuously, and this goes red first.
    expect(documented).toHaveLength(enforced.length);
    expect(enforced.length).toBeGreaterThan(0);
  });

  it('vacuity control: the extractor really does find the entries', () => {
    // Without this, the test above would pass on a SECURITY.md whose G10
    // section had been emptied — [] === [] is not the claim being made.
    const documented = documentedNeverOpen();
    expect(documented.length).toBeGreaterThanOrEqual(CODEX_NEVER_OPEN.length);
    expect(documented).toContain('auth.json');
  });

  it('states the four things DoD 4.4 names, each by a phrase that is checkable', () => {
    // Deliberately NOT a word count and NOT a "mentions Codex" grep: each row
    // is a claim a reader could act on, and a document that lost one should go
    // red rather than stay green on having the right topic.
    const claims: readonly [string, RegExp][] = [
      ['what the engine reads', /rollout-\*\.jsonl/],
      ['the sessions walk is discovered, not composed', /never composes a path from a clock/i],
      ['the lock files are not opened', /never opened/i],
      ['it does not read Codex config', /Neither `hooks\.json` nor `config\.toml` is opened/],
      ['no second socket', /no second port/i],
      ['the manual trust step', /trust/i],
      ['the hook cost against a closed port', /\b89 ms\b/],
      ['the curl comparison', /curl\.exe/],
    ];
    for (const [what, re] of claims) {
      expect(re.test(SECURITY), `SECURITY.md no longer states: ${what}`).toBe(true);
    }
  });

  it('the hook-cost figures are a measurement, not an adjective', () => {
    // DoD 4.4's own words: "numbers, not adjectives". The timings are NOT
    // re-measured here — a wall-clock assertion in a suite is a test that
    // passes or fails by CPU load, which this repository has already paid for
    // twice. What is pinned is that numbers with units are present on both
    // sides of the comparison.
    const section = SECURITY.slice(SECURITY.indexOf('## 5.'));
    const timings = [...section.matchAll(/\b([\d,]+) ms\b/g)].map((m) => m[1] as string);
    expect(timings.length, 'the hook-cost table lost its numbers').toBeGreaterThanOrEqual(6);
    // Both engines' costs are stated, and they are not the same number.
    expect(new Set(timings).size).toBeGreaterThan(1);
  });
});
