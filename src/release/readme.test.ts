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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SIDEBAR_MENU } from '../sidebar/menu.js';
import { LOOP_MIN, SPIKE_TOKENS } from '../stats/constants.js';
import { costOfSeries, parsePricing } from '../stats/pricing.js';
import type { StatsRecord } from '../stats/schema.js';

import {
  CODEX_VERSION_WINDOW,
  PINNED_CODEX_VERSION,
  codexVersionWindow,
  isCodexVersionAccepted,
} from '../codex/fingerprint.js';
import { CODEX_NEVER_OPEN } from '../codex/never-open.js';
import { DEFAULT_HOOK_PORT, TELEMETRY_PATHS } from '../hooks/listener.js';
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

/**
 * One entry of a hook group: the command and how long it may run.
 *
 * `commandWindows` is Codex's second key. The Claude Code block does not carry
 * it and the Codex block carries it on every entry, which is why it is optional
 * here and asserted PRESENT, per entry, in the Codex block's own test rather
 * than by this type.
 */
interface HookCommand {
  type: string;
  command: string;
  commandWindows?: string;
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

/**
 * EVERY command string, `commandWindows` included, in event order.
 *
 * {@link commandsOf} reads `command` alone, which is the whole block for Claude
 * Code and HALF of it for Codex. A `curl`, a wrong port or a non-loopback host
 * in the Windows half of a Codex entry would be invisible to the older helper —
 * and the Windows half is the one that runs on the platform this was captured
 * on.
 */
function commandStringsOf(settings: HookSettings): string[] {
  return Object.values(settings.hooks).flatMap((groups) =>
    groups.flatMap((group) =>
      group.hooks.flatMap((hook) =>
        hook.commandWindows === undefined ? [hook.command] : [hook.command, hook.commandWindows],
      ),
    ),
  );
}

const README = readText('README.md');


/**
 * The five release assets, in the order the page reads in.
 *
 * FIVE SINCE v0.6.0 (DoD 5.8/5.8.1), AND THE NEW ONE IS THE ANIMATION THIS
 * LIST'S OWN COMMENT SAYS WAS DROPPED. Both things are true and the history
 * matters, so it is written down rather than tidied away: `media/demo.gif` was
 * a reference to a file nobody ever supplied and it was deleted at v0.5.0 with
 * no replacement. `media/agent-deck-hero.gif` is a different asset with a
 * different name - it exists, it is tracked, and it is the page's hero. The
 * v0.5.0 name stays on the RETIRED list below, so re-linking the file that was
 * never delivered is still red.
 *
 * IT IS DENIED IN `.vscodeignore` AND THAT IS DELIBERATE, not an oversight this
 * test should be widened to cover. 4.6 MB of animation inside every install
 * buys a user nothing: the Marketplace listing does not render images out of
 * the VSIX at all - vsce rewrites the link into an absolute
 * `<repository.url>/raw/HEAD/media/agent-deck-hero.gif` and the page fetches it
 * from github.com. So the GIF has to be REFERENCED and TRACKED, which is what
 * the tests below assert, and it does not have to ship. `.vscodeignore` is not
 * this file's to assert about; `src/release/vsix.test.ts` owns the packaged
 * set.
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
  'media/agent-deck-hero.gif',
  'media/Session_Deck.png',
  'media/hero_26_agent_session.png',
  'media/Internal_Session_Tool_popup.png',
  'media/Internal_Session_Tool_popup2.png',
  // SIX SINCE v0.7.0 (DoD 5.5b): the sidebar, linked from the install section.
  // Committed as a placeholder the user replaces with a capture; the
  // package-audit leg of `vsix.test.ts` refuses to package the placeholder.
  'media/sidebar.png',
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

/**
 * THE SAME MECHANISM, A THIRD TIME, FOR CODEX (v0.6.0 DoD 5.1).
 *
 * Codex's anchor is `0.151.0-alpha.7.2`. Unregioned it would reach the CC
 * guards as a version literal, and `0.150.x` to `0.152.x` would reach
 * `CORNERS_RE`, which asserts every stated corner equals the CLAUDE CODE
 * window's - so a correct README would go red and the cheap way back to green
 * would be loosening the guard that caught the blackout twice. Exactly the
 * hazard the OpenCode marker comment describes, arriving on schedule.
 */
const CODEX_REGION_RE = /<!-- engine:codex -->([\s\S]*?)<!-- \/engine:codex -->/g;

/** The README with every OpenCode AND Codex region removed: the CC document. */
const README_CC = README.replace(OC_REGION_RE, '\n').replace(CODEX_REGION_RE, '\n');

/** Only the OpenCode regions, joined: the OpenCode document. */
const README_OC = [...README.matchAll(OC_REGION_RE)].map((m) => m[1] ?? '').join('\n');

/** Only the Codex regions, joined: the Codex document. */
const README_CODEX = [...README.matchAll(CODEX_REGION_RE)].map((m) => m[1] ?? '').join('\n');

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

/**
 * THERE ARE TWO HOOK BLOCKS NOW, AND AN INDEX IS THE WRONG WAY TO TELL THEM
 * APART.
 *
 * Until v0.6.0 every assertion below read `JSON_FENCES[0]`, which was exact
 * while there was one fence and becomes a silent hazard the moment there are
 * two: reordering the document, or adding a third fence above them, would make
 * the Claude Code assertions run against the Codex block and stay green on the
 * parts the two have in common.
 *
 * So a block is identified by the SECTION IT IS PRINTED UNDER, which is what a
 * user goes by. That is deliberately independent of its content: identifying it
 * by "the fence that matches the frozen copy" would make the byte-identity
 * assertion below a tautology - it would be asserting that the block equal to
 * the frozen copy is equal to the frozen copy.
 */
const CC_HOOK_HEADING = '## Install the hook (one manual paste)';
const CODEX_HOOK_HEADING = '## Install the Codex hook (one manual paste)';

/**
 * One `## ` section's body: the heading through the next `## `.
 *
 * Throws on a heading that is absent or repeated rather than returning an empty
 * string, because both of those would make every assertion over the result pass
 * vacuously - which is this repository's most-recorded defect class and is
 * exactly what a section-scoped guard is exposed to.
 */
function sectionText(heading: string): string {
  const start = README.indexOf(heading);
  if (start < 0) throw new Error(`README has no section: ${heading}`);
  if (README.indexOf(heading, start + 1) >= 0) {
    throw new Error(`README repeats the section heading: ${heading}`);
  }
  const rest = README.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

/** The ```json fences printed under one `## ` heading, to the next `## `. */
function jsonFencesUnder(heading: string): string[] {
  return [...sectionText(heading).matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? '');
}

/** The Claude Code paste block, as printed. */
const CC_FENCE = jsonFencesUnder(CC_HOOK_HEADING)[0] ?? '';
/** The Codex paste block, as printed. */
const CODEX_FENCE = jsonFencesUnder(CODEX_HOOK_HEADING)[0] ?? '';

interface Manifest {
  contributes: {
    configuration: {
      properties: Record<string, { default?: unknown }>;
    };
  };
  /** Read by the VS Code and Node floor assertions below. */
  engines?: { vscode?: string; node?: string };
  /**
   * The extension icon, read by the `media/` exact-set assertion so the one
   * tracked image the README does not link is identified by the manifest that
   * requires it rather than by a literal written down twice.
   */
  icon: string;
  /**
   * The product's name. Read by the shipped-documents guard so the CHANGELOG
   * is bound to it rather than repeating it - a second copy is what went
   * stale, twice, in the release that changed the name.
   */
  displayName?: string;
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

/**
 * The FROZEN copy of the Codex block (v0.6.0 DoD 5.1).
 *
 * Byte-identical to the block installed at `~/.codex/hooks.json` on the machine
 * that captured this project's Codex hook corpus - so, exactly like the Claude
 * Code copy, it is a block with evidence behind it rather than one that was
 * typed out to look right. There is no live-file cross-check for it here: the
 * Codex file lives outside the repository, unlike `.claude/settings.local.json`,
 * so the frozen copy is the whole of what CI can hold.
 */
const FROZEN_CODEX_SETTINGS = JSON.parse(
  readText('fixtures/hooks/codex-hook-block.json'),
) as HookSettings;

/**
 * The six Codex events, IN ORDER, taken from the frozen copy rather than
 * written down again.
 *
 * Order is asserted because six is a decision, not an accident: each event is a
 * separate trust prompt for the user, so a seventh appearing silently costs
 * them a click and costs this document its claim.
 */
const CODEX_EVENTS: readonly string[] = Object.keys(FROZEN_CODEX_SETTINGS.hooks);

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

  it('shows no control-surface drift: `control` still occurs on exactly three lines', () => {
    // v0.6.0 DoD 5.1's last clause, verbatim: "`grep -c "control" README.md`
    // unchanged from v0.5.0 (no control-surface drift)". MEASURED at the
    // `v0.5.0` tag and at the phase head before this section was written: 3.
    //
    // WHY A WORD COUNT IS THE RIGHT SHAPE HERE, since it looks like the crudest
    // possible assertion. A third engine is the moment a read-only observer is
    // most likely to grow a verb: the Codex section had to describe hooks, a
    // trust step and a restart, and every one of those is a sentence away from
    // telling a user what Agent Deck can do TO Codex. `grep -c` cannot read
    // meaning, but this document's three occurrences are a fixed, known set -
    // a paste block you control, OpenCode's `control_account` table, and the
    // "No control surface" exclusion - so a fourth is a new claim about acting
    // on something, and a reviewer is cheaper than a released one.
    //
    // Line granularity, not occurrence granularity, because that is what
    // `grep -c` counts and the DoD names the command.
    const lines = README.split('\n')
      .map((line, i) => ({ n: i + 1, line }))
      .filter((row) => row.line.includes('control'));
    expect(
      lines.map((h) => `${String(h.n)}: ${h.line.trim()}`),
      'the README grew or lost a `control` line - see DoD 5.1',
    ).toHaveLength(3);

    // The count alone could stay at 3 while the EXCLUSION was deleted and a
    // control-surface claim took its place, so the promise itself is pinned.
    expect(README).toContain('**No control surface.**');
    // Vacuity control: the counter can see a fourth one.
    expect('a\ncontrol\nb'.split('\n').filter((l) => l.includes('control'))).toHaveLength(1);
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

  it('carries the six release assets, in order', () => {
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

  it('links no image this release retired, and exactly one GIF: the hero', () => {
    // THE v0.5.0 GIF WAS DROPPED, and with no placeholder standing in for it.
    // It was one of the four Phase 8 slots and the only one that is not a
    // still; the media gate can measure a PNG's chunks, read its pixels and
    // sweep its bytes, and an animation is the asset none of that reaches in
    // the same way. A reference to a file nobody is going to supply is a broken
    // image on the Marketplace listing page, which is what that release existed
    // to stop happening.
    //
    // v0.6.0 SUPPLIES ONE. `media/agent-deck-hero.gif` is on disk, tracked, and
    // linked - so the blanket `not.toContain('.gif')` that used to close this
    // test would now be forbidding the asset rather than the absence. It is
    // replaced by the assertion that was always the real one: the page links
    // EXACTLY ONE `.gif`, and it is that file. A second animation appearing, or
    // the retired name coming back, is still red.
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

    // Exactly one animation on the page, and it is the hero. Both halves
    // matter: the count stops a second GIF arriving unnoticed, and naming the
    // file stops the count being satisfied by the wrong one.
    const gifs = [...README.matchAll(/!\[[^\]]*\]\(([^)]+\.gif)\)/gi)].map((m) => m[1] ?? '');
    expect(gifs).toStrictEqual(['media/agent-deck-hero.gif']);
    // Not merely linked: TRACKED, so the absolute URL vsce rewrites the link
    // into resolves on the listing page. The GIF does not ship inside the VSIX
    // - see the note on RELEASE_IMAGES - so tracking is the only thing that
    // puts those bytes where the Marketplace looks for them.
    expect(TRACKED_MEDIA).toContain('media/agent-deck-hero.gif');
    // Vacuity control: the link pattern really does find a `.gif` reference.
    expect([...'![x](media/a.gif)'.matchAll(/!\[[^\]]*\]\(([^)]+\.gif)\)/gi)]).toHaveLength(1);
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
    // v0.7.0 Phase 4 (DoD 4.6b): the activity-bar icon is the SECOND manifest
    // reference under `media/`, read off `contributes.viewsContainers` for the
    // reason `icon` is read off `icon`, and it is not a screenshot either.
    const activityIcon = String(
      (MANIFEST as { contributes?: { viewsContainers?: { activitybar?: { icon?: unknown }[] } } })
        .contributes?.viewsContainers?.activitybar?.[0]?.icon,
    );
    expect(activityIcon).toBe('media/activity-icon.svg');
    expect(tracked).toContain(activityIcon);
    expect([...tracked].sort()).toStrictEqual([icon, activityIcon, ...RELEASE_IMAGES].sort());
    // Pinned BESIDE the set, not instead of it: a set comparison written
    // against an empty listing passes vacuously, and a count is the cheapest
    // thing that goes red when it does.
    //
    // SIX SINCE v0.6.0 (DoD 5.8.1): the icon, the four stills and the hero GIF.
    // SEVEN SINCE v0.7.0 (DoD 4.6b): plus the activity-bar icon.
    // EIGHT SINCE v0.7.0 DoD 5.5b: plus the sidebar screenshot.
    // Amended, never relaxed - this is still equality both ways with the count
    // beside it, and the reason is unchanged from the v0.5.0 comment above.
    expect(tracked).toHaveLength(8);
  }, 20_000);
});

describe('the hook paste block', () => {
  it('has exactly two JSON fences carrying a `hooks` key, one per engine section', () => {
    // AMENDED AT v0.6.0, NOT RELAXED. This said `toHaveLength(1)` while there
    // was one hook block, which was exact. With two, a count alone stops being
    // enough - it would pass over two copies of the same block, or over the
    // Codex block printed twice - so the count is kept AND every hook-carrying
    // fence is required to be one of the two named sections' blocks.
    expect(JSON_FENCES.length).toBeGreaterThan(0);
    const parsed = JSON_FENCES.map((text) => JSON.parse(text) as unknown);
    const hookBlocks = parsed.filter(isHookSettings);
    expect(hookBlocks).toHaveLength(2);

    // Each section prints exactly one, and the two are not the same text: an
    // unaccounted-for third fence, or a section that lost its block, fails here
    // rather than silently shifting which block the assertions below read.
    expect(jsonFencesUnder(CC_HOOK_HEADING)).toHaveLength(1);
    expect(jsonFencesUnder(CODEX_HOOK_HEADING)).toHaveLength(1);
    expect([...JSON_FENCES].filter((f) => f === CC_FENCE || f === CODEX_FENCE)).toHaveLength(2);
    expect(CC_FENCE).not.toBe(CODEX_FENCE);
  });

  it('is byte-identical to the frozen copy in fixtures/hooks/hook-block.json', () => {
    const block = JSON.parse(CC_FENCE) as unknown;
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
      const block = JSON.parse(CC_FENCE) as HookSettings;
      expect(block.hooks).toStrictEqual(LIVE_SETTINGS?.hooks);
      expect(FROZEN_SETTINGS.hooks).toStrictEqual(LIVE_SETTINGS?.hooks);
    },
  );

  it('registers the six events the liveness engine is fed by', () => {
    const block = JSON.parse(CC_FENCE) as HookSettings;
    // Asserted against the live file, not a hard-coded list, and additionally
    // spelled out: a block that silently lost SubagentStart still "matches the
    // file" if the file lost it too.
    expect(Object.keys(block.hooks).sort()).toStrictEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop'].sort(),
    );
  });

  it('uses `node -e` and never curl, in BOTH blocks', () => {
    // Both, and every command string in each: `commandStringsOf` reads
    // `commandWindows` too, so a `curl` smuggled into the Windows half of a
    // Codex entry is caught. `commandsOf` alone would not see it.
    for (const [name, fence] of [
      ['Claude Code', CC_FENCE],
      ['Codex', CODEX_FENCE],
    ] as const) {
      expect(fence.toLowerCase(), `${name}: curl in the paste block`).not.toContain('curl');
      const block = JSON.parse(fence) as HookSettings;
      const all = commandStringsOf(block);
      expect(all.length, `${name}: no commands at all`).toBeGreaterThan(0);
      for (const command of all) {
        expect(command.startsWith('node -e '), `${name}: not a node -e command`).toBe(true);
      }
    }
  });

  it('names the manifest default port, and no other port, in every command', () => {
    expect(typeof DEFAULT_PORT).toBe('number');
    // BOTH fences, because both blocks POST to the one listener. A Codex block
    // naming a different port would be a user whose Codex liveness is silent
    // for a reason no message on screen could explain.
    const fence = `${CC_FENCE}\n${CODEX_FENCE}`;
    const commandCount =
      commandStringsOf(JSON.parse(CC_FENCE) as HookSettings).length +
      commandStringsOf(JSON.parse(CODEX_FENCE) as HookSettings).length;

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
    const fence = `${CC_FENCE}\n${CODEX_FENCE}`;
    const ports = [...fence.matchAll(/\bport\b\s*[:=]\s*(\d+)/gi)].map((m) => Number(m[1]));
    expect(ports.length, 'the pasted blocks name no port at all').toBeGreaterThan(0);

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

  it('binds only loopback, in both blocks', () => {
    for (const [name, fence] of [
      ['Claude Code', CC_FENCE],
      ['Codex', CODEX_FENCE],
    ] as const) {
      expect(fence, `${name}: not loopback`).toContain("host:'127.0.0.1'");
      expect(fence, `${name}: names 0.0.0.0`).not.toContain('0.0.0.0');
    }
  });

  /* ----------------------------------------------------------------------- *
   * THE CODEX BLOCK — v0.6.0 DoD 5.1
   *
   * Same treatment as the Claude Code block above and for the same reason: the
   * frozen copy is byte-identical to the block installed at
   * `~/.codex/hooks.json` on the machine whose Codex hook corpus this project
   * captured, so retyping or "simplifying" a one-liner that is known to fire is
   * what these assertions cost.
   *
   * TWO THINGS ARE DIFFERENT AND BOTH ARE ASSERTED. Every Codex entry carries
   * `commandWindows` as well as `command`, and the six events are asserted IN
   * ORDER as well as by name - the count is a decision (six events, six trust
   * prompts) and a seventh arriving quietly is exactly what a frozen copy is
   * for.
   * ----------------------------------------------------------------------- */

  it('the Codex block is byte-identical to fixtures/hooks/codex-hook-block.json', () => {
    const block = JSON.parse(CODEX_FENCE) as unknown;
    expect(isHookSettings(block)).toBe(true);
    if (!isHookSettings(block)) return;

    expect(block.hooks).toStrictEqual(FROZEN_CODEX_SETTINGS.hooks);

    // Per-event, so a failure names the event that drifted rather than printing
    // two 7 KB objects side by side.
    const readmeCommands = commandsOf(block);
    const frozenCommands = commandsOf(FROZEN_CODEX_SETTINGS);
    expect([...readmeCommands.keys()]).toStrictEqual([...frozenCommands.keys()]);
    for (const [event, commands] of frozenCommands) {
      expect(readmeCommands.get(event), `command drift on ${event}`).toStrictEqual(commands);
    }

    // And it is NOT the Claude Code block: they are different files with
    // different shapes, and a copy-paste of the wrong one would satisfy a
    // "parses and has six events" check.
    expect(block.hooks).not.toStrictEqual(FROZEN_SETTINGS.hooks);
  });

  it('the Codex block registers exactly six events, in the frozen order', () => {
    const block = JSON.parse(CODEX_FENCE) as HookSettings;
    expect(Object.keys(block.hooks)).toStrictEqual([...CODEX_EVENTS]);
    // Spelled out as well as derived, for the reason the Claude Code sibling
    // gives: a block that silently lost SubagentStart still "matches the frozen
    // copy" if the frozen copy lost it too.
    expect(CODEX_EVENTS).toStrictEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'SubagentStart',
      'SubagentStop',
      'Stop',
    ]);
    // The README's prose names the same six, so a reader counting trust prompts
    // is counting the right thing.
    for (const event of CODEX_EVENTS) {
      expect(README_CODEX, `the Codex section does not name ${event}`).toContain(`\`${event}\``);
    }
  });

  it('every Codex entry carries BOTH `command` and `commandWindows`', () => {
    const block = JSON.parse(CODEX_FENCE) as HookSettings;
    const entries = Object.values(block.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks),
    );
    expect(entries).toHaveLength(CODEX_EVENTS.length);
    for (const entry of entries) {
      expect(typeof entry.command).toBe('string');
      expect(typeof entry.commandWindows, 'a Codex entry has no commandWindows').toBe('string');
    }
    // Two strings per entry, which is what makes `commandStringsOf` twice the
    // size of `commandsOf` here - the property the port test leans on.
    expect(commandStringsOf(block)).toHaveLength(entries.length * 2);
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

  it('regions the Codex document too, on the same mechanism', () => {
    // The third engine, added at v0.6.0. Without this the Codex anchor and its
    // corners reach the CC guards, which assert every stated corner equals the
    // CLAUDE CODE window's - a correct README, red.
    const opens = [...README.matchAll(/<!-- engine:codex -->/g)].length;
    const closes = [...README.matchAll(/<!-- \/engine:codex -->/g)].length;
    expect(opens, 'unbalanced engine:codex markers in README.md').toBe(closes);
    expect(opens).toBeGreaterThan(0);
    expect(README_CODEX.length, 'the Codex region is empty').toBeGreaterThan(0);
    expect(README_CC.length, 'the Codex region swallowed the document').toBeGreaterThan(
      README_CODEX.length,
    );

    // Three anchors, three regions, no leakage in any direction.
    expect(README_CODEX).toContain(PINNED_CODEX_VERSION);
    expect(README_CC).not.toContain(PINNED_CODEX_VERSION);
    expect(README_OC).not.toContain(PINNED_CODEX_VERSION);
    expect(README_CODEX).not.toContain(PINNED_CC_VERSION);
    expect(README_CODEX).not.toContain(PINNED_OPENCODE_VERSION);
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

  it('states the Node floor the manifest actually declares', () => {
    // THE SIBLING DEFECT, FOUND THE SAME WAY AND ONE RELEASE LATER. The
    // Requirements list said `>=20` while `package.json` declared `>=22.22.2`,
    // and nothing bound them — the identical gap this file's VS Code assertion
    // above exists to close, on the other engines key.
    //
    // `>=20` was not an arbitrary number either: it is the floor `engines.node`
    // ITSELF carried until CI proved it false (`workflow.test.ts`'s
    // 'engines.node tells the truth about what this project can run on' — the
    // manifest said `>=20`, `actions/setup-node` honoured it, and the suite
    // died on jsdom). The manifest was corrected; the README kept the number.
    //
    // WHY IT MATTERS THOUGH THE HOOK IS ONLY A ONE-LINER. The line is about the
    // reader's OWN `node` on `PATH`, not about the extension host, so a reader
    // could reasonably conclude the two numbers describe different things and
    // that one of them is stale. Naming the manifest's floor makes the page say
    // one thing, and it is the measured one.
    //
    // The manifest is READ, never repeated — same rule as the sibling.
    const declared = MANIFEST.engines?.node;
    expect(declared, 'manifest declares no engines.node').toBeTruthy();
    expect(
      README.includes(`\`${String(declared)}\``),
      `README does not state the manifest's Node floor ${String(declared)}`,
    ).toBe(true);
    // Vacuity controls, both directions: the check can fail, and the number it
    // is now bound to is not the one that was wrong.
    expect(README.includes('`>=0.0.1`')).toBe(false);
    expect(README.includes('`>=20`'), 'the README still carries the stale Node floor').toBe(false);
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

/* -------------------------------------------------------------------------- *
 * v0.6.0 DoD 5.1 — "Also observes Codex"
 *
 * The item, verbatim: an "Also observes Codex" section in the OpenCode
 * section's shape; the paste block asserted by CI against a frozen copy; the
 * version window stated per G9; "no App Server, no socket to Codex" stated;
 * `grep -c "control" README.md` unchanged from v0.5.0.
 *
 * The paste block half is in `the hook paste block` above, beside the Claude
 * Code one. The `control` count is in `README exists and ships clean`, beside
 * the other whole-document guards. What is here is the section itself.
 * -------------------------------------------------------------------------- */

/** Everything after the heading, whitespace-flattened: markdown wraps. */
const CODEX_SECTION = sectionText('## Also observes Codex');
const CODEX_FLAT = CODEX_SECTION.replace(/\s+/g, ' ');
const OC_SECTION = sectionText('## Also observes OpenCode');
const CODEX_HOOK_SECTION = sectionText(CODEX_HOOK_HEADING);
const CC_HOOK_SECTION = sectionText(CC_HOOK_HEADING);

describe('the README carries an "Also observes Codex" section in the OpenCode section\'s shape', () => {
  it('is written to the same six-part shape, and the shape is read off the OpenCode section', () => {
    // NOT a list of sentences somebody thought a Codex section should have.
    // Each probe is asserted against the OPENCODE section first, which is what
    // "in the OpenCode section's shape" means and what makes the probe itself
    // non-vacuous: a pattern that stopped matching anything would fail on the
    // section it was derived from before it ever reached the new one.
    const SHAPE: readonly (readonly [string, RegExp])[] = [
      ['says which engine wrote a cell', /\bglyph\b/i],
      ['names the engine chips', /\bchips\b/i],
      ['says nothing has to be configured', /Nothing is configured/],
      ['enumerates what is never read, by name rather than by filter', /by name rather than by filter/],
      ['states an anchor', /\banchor\b/i],
      ['says what refuses, and that a refusal is not a half-built tree', /renders `unsupported`/],
    ];
    for (const [what, re] of SHAPE) {
      expect(re.test(OC_SECTION), `the OpenCode section no longer: ${what}`).toBe(true);
      expect(re.test(CODEX_SECTION), `the Codex section does not: ${what}`).toBe(true);
    }
  });

  it('sits beside the OpenCode section rather than somewhere else in the page', () => {
    // Adjacency, asserted because the two sections answer the same question
    // about different engines and a reader who found one should not have to
    // hunt for the other. Nothing between them but the region markers.
    const between = README.slice(
      README.indexOf('## Also observes OpenCode'),
      README.indexOf('## Also observes Codex'),
    );
    expect(between.length).toBeGreaterThan(0);
    expect(between.match(/\n## /g) ?? [], 'another section came between them').toHaveLength(0);
  });

  it('names the five things under the Codex root that are never opened', () => {
    // The OpenCode mirror of this names four tables. Codex's list is the G10
    // exclusion list, and `auth.json` is the entry whose absence would matter
    // most - so it is enumerated in the document, not summarised.
    for (const name of [
      'auth.json',
      '.sandbox-secrets/',
      'installation_id',
      'cap_sid',
      'models_cache.json',
    ]) {
      expect(CODEX_SECTION, `the Codex section does not name ${name}`).toContain(name);
    }
    // ...and the section points at where the list is enumerated in full, the
    // same way the Trust section points at SECURITY.md rather than restating a
    // mechanism.
    expect(CODEX_SECTION).toContain('[`SECURITY.md`](SECURITY.md)');
  });

  it('states the product boundary DoD 5.1 names: no App Server, no socket to Codex', () => {
    // Codex ships an App Server. This product will never connect to it, and
    // that is a boundary rather than an omission - the sentence has to say so,
    // because a reader cannot tell the two apart from silence.
    expect(CODEX_FLAT).toContain('No socket to Codex.');
    expect(CODEX_FLAT).toContain('No App Server');
    expect(CODEX_FLAT).toMatch(/no second port/i);
    expect(CODEX_FLAT).toMatch(/app-server proxy/i);
    // The positive half: one listener, shared, which is why there is no second
    // port to talk about.
    expect(CODEX_FLAT).toMatch(/same\*? loopback listener/i);
    // And the whole-document claim stays consistent with it: the Trust section
    // still promises exactly one LISTENING socket.
    //
    // RE-WORDED IN v0.7.1: this pinned "The only socket it opens is an HTTP
    // listener", which stopped being true in 0.7.0, when a second window began
    // connecting to the first (the follower relay). The phase verifier found
    // the sentence re-committed in 0.7.1's rewrite of that paragraph. The pin
    // now holds the true pair: one socket listened on, one connection made,
    // both to the loopback address.
    expect(README).toContain('The only socket it listens on is an HTTP listener');
    expect(README).toContain('The only connection it makes is a second VS Code window reaching that same listener');
    expect(README).not.toContain('The only socket it opens is an HTTP listener');
  });

  it('states that neither of Codex\'s own config files is read or written', () => {
    // G1 for a third engine, and the half a user is most likely to doubt: the
    // extension tells them to edit `hooks.json`, so it has to be explicit that
    // it does not go near it afterwards.
    expect(CODEX_FLAT).toMatch(/Neither `hooks\.json` nor `config\.toml` is opened/);
  });
});

describe('the Codex compatibility claims are accurate against the shipped constants', () => {
  const cxWindow = codexVersionWindow();
  const cxCorners = (): { min: string; max: string } => {
    if (cxWindow === undefined) throw new Error('PINNED_CODEX_VERSION does not parse');
    return {
      min: `${String(cxWindow.major)}.${String(cxWindow.minMinor)}.x`,
      max: `${String(cxWindow.major)}.${String(cxWindow.maxMinor)}.x`,
    };
  };

  /**
   * A Codex version literal. The CC and OpenCode patterns are `x.y.z` and would
   * match NOTHING here: the anchor carries a prerelease tag, so the character
   * after `0.151.0` is a `-` rather than the closing backtick. A guard that
   * silently matched nothing would be the vacuous-assertion class in its purest
   * form, so the tail is part of the pattern and the count is asserted below.
   */
  const CODEX_LITERAL_RE = /`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`/g;

  it('states the anchor the Codex fingerprint actually uses', () => {
    const stated = [
      ...README_CODEX.matchAll(/\banchor(?:ed on)?:?\s+`([0-9A-Za-z.-]+)`/gi),
    ].map((m) => m[1]);
    expect(stated.length, 'the Codex region states no anchor').toBeGreaterThan(0);
    for (const version of stated) expect(version).toBe(PINNED_CODEX_VERSION);
  });

  it('states window corners derived from the shipped tolerance', () => {
    const { min, max } = cxCorners();
    const stated = [...README_CODEX.matchAll(/`(\d+\.\d+\.x)` to `(\d+\.\d+\.x)`/g)];
    expect(stated.length, 'the Codex region states no window corners').toBeGreaterThan(0);
    for (const match of stated) {
      expect(match[1]).toBe(min);
      expect(match[2]).toBe(max);
    }
    // Derived, never written down twice: the corners come from the shipped
    // minor tolerance, so moving it moves what the README is required to say.
    expect(cxWindow?.maxMinor).toBe((cxWindow?.minMinor ?? 0) + 2 * CODEX_VERSION_WINDOW.minor);
  });

  it('names no Codex version the shipped predicate would refuse', () => {
    const literals = [...README_CODEX.matchAll(CODEX_LITERAL_RE)].map((m) => m[1] ?? '');
    expect(literals.length, 'the Codex region names no version at all').toBeGreaterThan(0);
    for (const literal of literals) {
      expect(
        isCodexVersionAccepted(literal),
        `README names refused Codex version ${literal}`,
      ).toBe(true);
    }
    expect(literals).toContain(PINNED_CODEX_VERSION);
    // Vacuity controls, both directions. The pattern must reach a prerelease
    // literal at all - the CC pattern does not - and the predicate must refuse
    // something, on the major as well as the minor.
    expect([...'`0.151.0-alpha.7.2`'.matchAll(CODEX_LITERAL_RE)].map((m) => m[1])).toStrictEqual([
      PINNED_CODEX_VERSION,
    ]);
    expect(isCodexVersionAccepted('4.4.0')).toBe(false);
  });

  it('states the G9 posture in words: patch AND prerelease uncompared, structure refuses', () => {
    // G9, verbatim: "Major exact, minor +/-1, patch and prerelease tags not
    // compared. Structure refuses, not the number. The anchor moves only by
    // harvesting a new corpus." All four clauses, because the prerelease half
    // is new with this engine and is the half a reader would otherwise assume
    // works like the other two.
    expect(CODEX_FLAT).toMatch(/Major must match/i);
    expect(CODEX_FLAT).toMatch(/minor may be one step either way/i);
    expect(CODEX_FLAT).toMatch(/neither the patch component nor the prerelease tag is compared/i);
    expect(CODEX_FLAT).toMatch(/What refuses a session is the \*\*structure\*\*/);
    expect(CODEX_FLAT).toMatch(/anchor moves one way only/i);
    expect(CODEX_FLAT).toMatch(/harvesting a corpus/i);
    // No patch tolerance is CLAIMED anywhere in the region, on the CC pattern,
    // because there is no patch tolerance to claim.
    expect(CODEX_VERSION_WINDOW).not.toHaveProperty('patch');
    expect([...README_CODEX.matchAll(/\bpatch \+\/-(\d+)/g)].map((m) => m[0])).toEqual([]);
  });

  it('states the minor tolerance the Codex fingerprint actually uses', () => {
    const minors = [...README_CODEX.matchAll(/one step either way/g)];
    expect(minors.length).toBeGreaterThan(0);
    // "one step" is the prose form of the constant, so the constant is what it
    // is checked against rather than the other way round.
    expect(CODEX_VERSION_WINDOW.minor).toBe(1);
  });

  it('states the anchor is read from the corpus, never from what a binary reports', () => {
    // The recorded trap this sentence exists for: OpenCode self-updated
    // `1.18.22` -> `1.18.23` mid-measurement while its store still held rows
    // written by two other versions. Spec C9 states the rule for Codex before
    // it could be re-learned, and the README states it for the reader.
    expect(CODEX_FLAT).toContain('session_meta.payload.cli_version');
    expect(CODEX_FLAT).toMatch(/never from what a binary reports/i);
  });
});

describe('the README tells a Codex user how to install the hook, and what will go wrong', () => {
  it('offers ~/.codex/hooks.json and nothing else', () => {
    // One location, deliberately. Repo-local hook discovery has been reported
    // broken on some Codex releases, so offering it would be offering a paste
    // that looks installed and never fires.
    expect(CODEX_HOOK_SECTION).toContain('`~/.codex/hooks.json`');
    expect(
      /project'?s own/i.test(CODEX_HOOK_SECTION),
      'the Codex section offers a repo-local hook file',
    ).toBe(false);
    // Vacuity control: the phrase is real, and the Claude Code section - which
    // DOES offer a repo-local file - is where it lives.
    expect(/project'?s own/i.test(CC_HOOK_SECTION)).toBe(true);
  });

  it('says a restart is needed, and says it is different from Claude Code', () => {
    // MEASURED, and the opposite of the Claude Code note two sections up, which
    // says settings are re-read per invocation. Getting this wrong costs a user
    // a silent deck and no way to tell why.
    const flat = CODEX_HOOK_SECTION.replace(/\s+/g, ' ');
    expect(flat).toMatch(/\*\*Restart Codex\.\*\*/);
    expect(flat).toMatch(/opposite of Claude Code/i);
    // The Claude Code section still says the other thing, so the contrast the
    // Codex text draws is a real one rather than a stale memory.
    expect(CC_HOOK_SECTION).toMatch(/No Claude Code restart is needed/);
  });

  it('makes the trust step a numbered instruction, and says there are six of them', () => {
    // Codex will not run a hook command until a human trusts it, and editing
    // `hooks.json` invalidates the entries for the events touched - after which
    // the hook stops firing SILENTLY. A user who sees nothing happen has to be
    // able to find out why from this page.
    const steps = [...CODEX_HOOK_SECTION.matchAll(/^(\d)\. /gm)].map((m) => m[1]);
    expect(steps, 'the trust step is not a numbered instruction').toStrictEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    const flat = CODEX_HOOK_SECTION.replace(/\s+/g, ' ');
    expect(flat).toMatch(/Trust the hook when Codex asks/i);
    // SIX trust entries from ONE command, which is the part nobody would guess.
    expect(flat).toMatch(/six[^.]{0,60}trust entries/i);
    expect(String(CODEX_EVENTS.length)).toBe('6');
    // ...and the silent-failure consequence, in the same list.
    expect(flat).toMatch(/invalidates the trust entry/i);
    expect(flat).toMatch(/stop firing \*\*silently\*\*/i);
  });

  it('says both command keys are given, and why the block is a frozen copy', () => {
    const flat = CODEX_HOOK_SECTION.replace(/\s+/g, ' ');
    expect(flat).toContain('`command`');
    expect(flat).toContain('`commandWindows`');
    expect(flat).toMatch(/byte-for-byte copy/i);
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

/**
 * THE SHIPPED DOCUMENTS CALL THE PRODUCT WHAT THE MANIFEST CALLS IT.
 *
 * Both of these were found by a `phase-verifier` round at the 0.6.0 gate, in a
 * release whose whole point was the rename, and neither had a test:
 *
 *   1. `CHANGELOG.md`'s masthead read "All notable changes to Agent Deck for
 *      Claude Code are documented here" - the OLD `displayName`, used as the
 *      current product name, in the release that replaced it.
 *   2. The 0.6.0 entry QUOTED the new name with an ASCII hyphen while
 *      `package.json` carries U+2014. `manifest.test.ts` asserts that dash by
 *      code point precisely because "a hyphen here would be a different name
 *      that looks the same in a diff" - and the changelog printed the hyphen.
 *
 * This file ships: `extension/changelog.md` inside the VSIX, and a tab on the
 * Marketplace listing. A shipped document naming a product that no longer
 * exists is the 'documents describing a state the same release changed' class,
 * which this repository has now hit in the README (three deleted features),
 * in the CHANGELOG (a feature the same entry removed) and here.
 *
 * Bound to the manifest rather than written down a second time, which is the
 * only shape that cannot go stale: the README went stale in exactly this way
 * before it was bound.
 */
/*
 * THE README'S SETTINGS TABLE IS BOUND TO THE MANIFEST.
 *
 * Found by a `phase-verifier` at the 0.6.1 gate, in a hotfix whose DoD said in
 * so many words that "`readme.test.ts` guards it": deleting the
 * `agentDeck.codex.maxTranscriptBytes` row from `README.md` left this file
 * **80/80 green**. Nothing connected the two.
 *
 * It is the same class as everything else in this file — the README is the
 * MARKETPLACE LISTING PAGE, so a setting the extension reads and the page
 * never mentions is a setting users cannot find, and a row for a setting that
 * no longer exists is a page describing a product that does not ship.
 *
 * Bound BOTH WAYS and derived from the manifest rather than written down a
 * second time. A third copy of the key list would agree with whichever copy
 * was edited last, which is exactly how the README went stale before.
 */
describe('the README settings table lists exactly the settings the manifest declares', () => {
  /** Every `| \`agentDeck.x\` | …` row, in order. */
  function documentedSettings(): string[] {
    return [...README.matchAll(/^\|\s*`(agentDeck\.[A-Za-z0-9.]+)`\s*\|/gm)].map(
      (m) => m[1] ?? '',
    );
  }

  it('names every declared setting, and no setting that is not declared', () => {
    const declared = Object.keys(
      (MANIFEST as { contributes: { configuration: { properties: Record<string, unknown> } } })
        .contributes.configuration.properties,
    ).sort();
    // The control: a table this pattern cannot read would make the comparison
    // below "empty equals empty" and pass forever.
    expect(documentedSettings().length, 'the README settings table was not found').toBeGreaterThan(
      0,
    );
    expect(documentedSettings().sort()).toStrictEqual(declared);
  });

  it('the row for a numeric setting states the default the manifest promises', () => {
    const properties = (
      MANIFEST as {
        contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
      }
    ).contributes.configuration.properties;
    const rows = README.split('\n').filter((line) => /^\|\s*`agentDeck\./.test(line));
    let checked = 0;
    for (const row of rows) {
      const key = /`(agentDeck\.[A-Za-z0-9.]+)`/.exec(row)?.[1];
      if (key === undefined) continue;
      const fallback = properties[key]?.default;
      if (typeof fallback !== 'number') continue;
      // Only rows that CHOOSE to state a number are held to it. A row is
      // allowed to describe a setting without quoting its default; what it
      // may not do is quote a different one.
      const stated = [...row.matchAll(/\b(\d{4,})\b/g)].map((m) => Number(m[1]));
      if (stated.length === 0) continue;
      checked += 1;
      expect(stated, `${key}'s README row states a number that is not its default`).toContain(
        fallback,
      );
    }
    // At least one row must actually be exercised, or this is a loop over
    // nothing wearing an assertion.
    expect(checked, 'no README settings row states a default').toBeGreaterThan(0);
  });
});

describe('the shipped documents name the shipped product', () => {
  it('the CHANGELOG masthead does not carry a superseded product name', () => {
    const masthead = CHANGELOG_TEXT.split('\n').slice(0, 6).join(' ');
    expect(masthead, 'the masthead must name the product').toContain('Agent Deck');
    expect(
      masthead,
      'the CHANGELOG masthead still carries the pre-0.6.0 display name',
    ).not.toContain('Agent Deck for Claude Code');
  });

  it('every quoted display name in the current entry matches the manifest exactly', () => {
    // Quoted names only - prose that merely mentions Claude Code is fine and
    // must stay fine, since the product still observes it. What is pinned is a
    // string presented AS the product's name.
    const entry = currentChangelogEntry(CHANGELOG_TEXT);
    const quotedIn = (text: string): string[] =>
      [...text.matchAll(/"(Agent Deck[^"]*)"/g)].map((m) => m[1] ?? '');
    const quoted = quotedIn(entry);

    /*
     * THE VACUITY CONTROL MOVED, AND WHY IT MOVED IS THE POINT.
     *
     * It used to require the CURRENT entry to quote at least one display name,
     * on the reasoning that an empty loop proves nothing. True, and it made
     * the guard a rule that every future entry must quote the product's name
     * - which the 0.6.1 entry, a memory fix, had no reason to do. A guard that
     * fires on correct prose gets deleted rather than fixed; this file says so
     * about the version patterns twenty lines down.
     *
     * So the control is what a control should be: proof that the pattern and
     * the corpus can produce a match at all, taken over the WHOLE changelog,
     * where the 0.6.0 rename entry quotes the name several times. The equality
     * loop below still runs over the current entry alone, so an entry that
     * quotes a WRONG name is caught whether or not it quotes a right one.
     */
    expect(
      quotedIn(CHANGELOG_TEXT).length,
      'no entry anywhere quotes a display name - the pattern itself is broken',
    ).toBeGreaterThan(0);

    const displayName = String(MANIFEST.displayName);
    for (const name of quoted) {
      // The OLD name is allowed to appear, but only as history - i.e. only
      // when the entry also carries the new one. Asserted as membership in the
      // pair rather than equality, because a rename entry legitimately names
      // both.
      expect(
        [displayName, 'Agent Deck for Claude Code'],
        `${name} is neither the manifest's display name nor the one it replaced`,
      ).toContain(name);
    }
    // An entry that quotes the SUPERSEDED name and not the current one is the
    // 0.6.0 defect exactly. An entry that quotes neither is fine.
    if (quoted.includes('Agent Deck for Claude Code')) {
      expect(
        quoted,
        'an entry naming the old product must also carry the name the manifest carries',
      ).toContain(displayName);
    }
  });
});


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
      // NOT the literal `89 ms`, which is what this row asserted first. A
      // verifier pointed out the trap and it is a good one: pinning the digits
      // of a measurement means the next honest re-measure turns this red, and
      // the cheapest way back to green is to keep quoting a number nobody
      // re-took. The claim is that a hook cost is STATED, not what it was.
      ['the hook cost against a closed port', /closed loopback port/i],
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


// ---------------------------------------------------------------------------
// v0.7.0 Phase 1b — the multi-window paragraph (DoD 1b.7)
// ---------------------------------------------------------------------------
//
// The README IS the Marketplace listing page, and this repository has already
// shipped that page describing three features it had deleted. The section this
// guards describes behaviour a user cannot discover by looking — two windows
// quietly sharing one socket — so a stale sentence here is worse than usual:
// there is nothing on screen to contradict it.

describe('README: several windows, one port (Phase 1b)', () => {
  const HEADING = '## Several windows, one port';
  const SECTION = sectionText(HEADING);

  it('states the four claims the design actually makes', () => {
    const claims: [string, RegExp][] = [
      ['first window binds and leads', /binds the port/i],
      ['a later window attaches instead of failing', /attaches to the leader/i],
      ['each window still reads its own workspace', /own workspace's transcripts/i],
      // NARROWED after a 2026-09-06 verifier round. The page said "each window
      // keeps only the events belonging to a session it is following", which
      // is false of the LEADER: its own socket ingests every payload that
      // reaches it, as `shared.ts`'s header states. The deck-visible effect is
      // nil - cards come from transcript discovery, not from hook events - but
      // a false sentence on the Marketplace listing page is a false sentence,
      // and the guard here checked that the sentence EXISTED rather than that
      // it was true.
      ['the filter is the attached windows\', not every window', /windows attached to the leader/i],
      ['the changeover has no coordinator', /no election, no lock file/i],
    ];
    for (const [what, re] of claims) {
      expect(re.test(SECTION), `the multi-window section no longer states: ${what}`).toBe(true);
    }
  });

  it('keeps the two promises a user is entitled to read as unchanged', () => {
    // G5, in the words a user reads rather than the words the contract uses.
    expect(SECTION).toContain('127.0.0.1');
    expect(SECTION).toMatch(/does not leave your machine|none of this leaves your machine/i);
    // The port policy. The whole section would otherwise read as "Agent Deck
    // sorts the port out for you", which is the one thing it must never do.
    expect(SECTION).toMatch(/will not pick a different one/i);
  });

  it('says the stream is redacted, and does not promise a queue it has no store for', () => {
    expect(SECTION).toMatch(/after the same redaction|no reasoning content/i);
    // G7. A user reading "the others take over" would reasonably assume the
    // events in between were held for them. They are not, and the page says so.
    expect(SECTION).toMatch(/lost rather than queued/i);
  });

  it('does not claim the hook stream is what puts sessions on a deck', () => {
    // The correction's substance: what a window shows comes from the
    // transcripts it reads. Saying so is what makes the narrowed sentence
    // above complete rather than merely less wrong.
    expect(SECTION).toMatch(/from the transcripts that window reads/i);
  });

  it('the collision bullet no longer says a busy port is always an error', () => {
    // It was true until Phase 1b and is now true only of a FOREIGN holder. The
    // sentence that changed is in a different section from the one above, which
    // is exactly how a page goes half-stale, so it is asserted here rather than
    // left to the section guard.
    // Whitespace-normalised rather than matched with a regex: markdown wraps
    // this sentence across two indented lines, and a pattern that has to know
    // where the wrap falls goes stale the next time the paragraph is reflowed.
    const hookNotes = sectionText(CC_HOOK_HEADING).replace(/\s+/g, ' ');
    expect(hookNotes).toContain('second Agent Deck window is not a collision at all');
    expect(hookNotes).toContain('never silently picks a different port');
  });

  it('the section is reachable from the anchor the collision bullet links to', () => {
    // A relative anchor that names no heading is a link to nowhere, and the
    // Marketplace renders it as one. Derived from the heading rather than
    // written twice.
    const anchor = HEADING.replace(/^##\s+/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    expect(anchor).toBe('several-windows-one-port');
    expect(README).toContain(`(#${anchor})`);
  });
});

/* -------------------------------------------------------------------------- *
 * v0.7.0 DoD 5.3 — the README's Stats section is BOUND, not restated
 * -------------------------------------------------------------------------- */

/*
 * Every sentence in the Stats section that names a number, a setting, a term or
 * an engine's capability is held to the code or the goldens that make it true.
 * The README is the Marketplace listing page, and this repository has shipped a
 * listing that described three deleted features — covered by nothing. Each
 * guard below reads its truth from the module that owns it rather than from a
 * second copy written here.
 */
const STATS = sectionText('## Stats');

/** A `### ` subsection of the Stats section, to the next `### ` or the end. */
function statsSubsection(heading: string): string {
  const start = STATS.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`the Stats section has no subsection: ${heading}`);
  const rest = STATS.slice(start + heading.length + 2);
  const end = rest.indexOf('\n### ');
  return end < 0 ? rest : rest.slice(0, end);
}

/** The seven named phenomena, as the view and the spec name them. */
const VOCABULARY = [
  'Re-read loop',
  'Churn chain',
  'Context churn',
  'Silent subagent',
  'Compaction',
  'Stall',
  'Waiting on you',
] as const;

/** The five settings v0.7.0 added (PLAN Phase 3 "five settings incl. `agentDeck.canvas.autoFit`"). */
const V070_SETTINGS = [
  'agentDeck.canvas.autoFit',
  'agentDeck.pricing',
  'agentDeck.stats.enabled',
  'agentDeck.stats.idleFlushMs',
  'agentDeck.stats.retentionDays',
];

describe('DoD 5.3 — the README Stats section', () => {
  it('defines the seven vocabulary terms, each in bold, in the Stats section', () => {
    for (const term of VOCABULARY) {
      expect(STATS, `the Stats section does not define ${term}`).toContain(`**${term}**`);
    }
    // Vacuity control: the section is real and is not the whole document.
    expect(STATS.length).toBeGreaterThan(1_000);
    expect(STATS).not.toContain('## Claude Code version window');
  });

  it('states the measurement parameters the deriver actually uses', () => {
    const loop = /`LOOP_MIN`, (\d+)\)/.exec(STATS);
    expect(loop, 'the re-read loop bullet no longer states LOOP_MIN').not.toBeNull();
    expect(Number(loop?.[1])).toBe(LOOP_MIN);
    const spike = /rose by ([\d,]+) or more/.exec(STATS);
    expect(spike, 'the context churn bullet no longer states the threshold').not.toBeNull();
    expect(Number((spike?.[1] ?? '').replace(/,/g, ''))).toBe(SPIKE_TOKENS.cc);
    // "Claude Code only" is true because no other engine carries a threshold.
    // A second engine gaining one turns this red, and the sentence with it.
    expect(Object.keys(SPIKE_TOKENS)).toStrictEqual(['cc']);
    expect(STATS).toContain('Claude Code only');
  });

  it('"waiting on you" names exactly the interactive tools the renderer uses', () => {
    // Read as TEXT: `webview/format.ts` belongs to the webview project, and the
    // host typecheck does not cover it. The extraction has its own control.
    const source = readText('webview/format.ts');
    const literal = /INTERACTIVE_TOOL_NAMES[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    const tools = [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(tools.length, 'INTERACTIVE_TOOL_NAMES was not found in webview/format.ts').toBeGreaterThan(0);
    const bullet = STATS.split('\n- ').find((b) => b.startsWith('**Waiting on you**')) ?? '';
    const named = [...bullet.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1] ?? '');
    expect(named.sort()).toStrictEqual([...tools].sort());
  });

  it('names exactly the five v0.7.0 settings, and every one is declared', () => {
    const block = statsSubsection('### The five settings');
    const named = [...block.matchAll(/^- `(agentDeck\.[A-Za-z0-9.]+)`/gm)].map((m) => m[1] ?? '');
    expect(named.sort()).toStrictEqual([...V070_SETTINGS].sort());
    const declared = Object.keys(MANIFEST.contributes.configuration.properties);
    for (const setting of V070_SETTINGS) expect(declared, setting).toContain(setting);
  });

  it('every `agentDeck.*` name anywhere in the README is a declared setting', () => {
    const declared = new Set(Object.keys(MANIFEST.contributes.configuration.properties));
    const named = [...README.matchAll(/`(agentDeck\.[A-Za-z0-9.]+)`/g)].map((m) => m[1] ?? '');
    expect(named.length).toBeGreaterThan(10);
    const undeclared = [...new Set(named)].filter((name) => !declared.has(name));
    expect(undeclared, 'the README names a setting the manifest does not declare').toStrictEqual([]);
  });

  it('the pricing example is a table the extension ACCEPTS, and the worked cost is its arithmetic', () => {
    const fences = [...STATS.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? '');
    expect(fences).toHaveLength(1);
    const example = JSON.parse(fences[0] ?? '{}') as Record<string, unknown>;
    const parsed = parsePricing(example['agentDeck.pricing']);
    expect(parsed.invalid, 'the README example is a malformed pricing entry').toStrictEqual([]);
    expect(parsed.table.size).toBe(1);
    const [model] = [...parsed.table.keys()];

    // The worked turn, and the figure the README states for it, are recomputed
    // through the deriver's own function. Edit a price in the example without
    // the total and this goes red.
    const turn = { ordinal: 0, input: 2, cacheCreation: 13_390, cacheRead: 28_807, output: 1_000 };
    const cost = costOfSeries([turn], model, parsed.table);
    expect(cost).toBeDefined();
    expect(STATS).toContain(`**$${(cost ?? 0).toFixed(4)}**`);
    for (const figure of ['2 fresh prompt tokens', '13,390', '28,807', '1,000 output tokens']) {
      expect(STATS, figure).toContain(figure);
    }
    expect(STATS).toContain('A subscription plan yields no per-token cost');
  });

  it('names the clear command by its manifest title, and states its multi-window limit', () => {
    const commands = (
      MANIFEST as unknown as {
        contributes: { commands: { command: string; title: string; category: string }[] };
      }
    ).contributes.commands;
    const clear = commands.find((c) => c.command === 'agentDeck.stats.clearHistory');
    expect(clear).toBeDefined();
    expect(STATS).toContain(`**${String(clear?.category)}: ${String(clear?.title)}**`);
    expect(STATS).toContain('another window that is already open keeps showing what it had read');
  });

  it('the privacy paragraph says where the history lives, and where it does not', () => {
    const block = statsSubsection('### Where it lives, and what leaves the machine');
    expect(block).toContain('**Nothing leaves the machine.**');
    expect(block).toContain('global storage');
    for (const not of ['`~/.claude`', '`~/.codex`', "OpenCode's directories", 'your workspace']) {
      expect(block, not).toContain(not);
    }
    expect(block).toContain('`agentDeck.stats.enabled`');
    expect(block).toContain('**Clear Stats History**');
  });

  it('states the two limits, and "an hour" is still the default it names', () => {
    const block = statsSubsection('### Two limits, stated plainly');
    expect(block).toContain('an hour without');
    expect(block).toContain('no VS Code window is open');
    // "One hour by default" is a claim about the manifest.
    expect(MANIFEST.contributes.configuration.properties['agentDeck.stats.idleFlushMs']?.default).toBe(
      3_600_000,
    );
  });
});

/* -------------------------------------------------------------------------- *
 * v0.7.0 DoD 5.3 — no shipped document still says nothing is kept
 * -------------------------------------------------------------------------- */

/*
 * Found by the Phase 5 verifier, after 5.3 had been recorded as correcting
 * the persistence sentences: the README still said "Agent Deck keeps no history
 * by design", on the same page as the Stats section, and SECURITY.md — which
 * ships in the VSIX — still said "no persistence" and listed "writes of any
 * kind" as excluded. Nothing read those files for the claim, which is how the
 * sentences survived a release that made them false. Each pattern is paired
 * with the sentence that was really shipping, so the scan cannot pass by
 * matching nothing.
 */
const STALE_PERSISTENCE_CLAIMS: ReadonlyArray<{ readonly re: RegExp; readonly shipped: string }> = [
  { re: /keeps? no history/i, shipped: 'lost rather than queued — Agent Deck keeps no history by design.' },
  { re: /\bno persistence\b/i, shipped: 'discards it when the window closes: no database, no cache file, no persistence.' },
  { re: /writes of any kind/i, shipped: 'Not implemented, and not accepted as contributions: writes of any kind' },
  { re: /historical replay or\s+persistence/i, shipped: 'writes of any kind · historical replay or\npersistence' },
];

describe('DoD 5.3 — the shipped documents do not deny the history 0.7.0 keeps', () => {
  const SHIPPED = ['README.md', 'SECURITY.md', 'site/index.html'] as const;

  it('no stale no-persistence claim in the README, SECURITY.md or the site', () => {
    for (const file of SHIPPED) {
      const text = readText(file);
      for (const { re } of STALE_PERSISTENCE_CLAIMS) {
        expect(re.test(text), `${file} still matches ${re}`).toBe(false);
      }
    }
  });

  it('every pattern fires on the sentence that was really shipping', () => {
    for (const { re, shipped } of STALE_PERSISTENCE_CLAIMS) {
      expect(re.test(shipped), `${re} does not match its own shipped sentence`).toBe(true);
    }
  });

  it('SECURITY.md names the one write, where it lives and how it is turned off and cleared', () => {
    const security = readText('SECURITY.md').replace(/\s+/g, ' ');
    expect(security).toContain('stats history');
    expect(security).toContain('`agentDeck.stats.enabled`');
    expect(security).toContain('**Clear Stats History**');
    expect(MANIFEST.contributes.configuration.properties['agentDeck.stats.enabled']).toBeDefined();
  });

  it('no document says there is no vscode:prepublish while the manifest has one', () => {
    const manifest = JSON.parse(readText('package.json')) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.['vscode:prepublish'], 'the manifest has no prepublish').toBeDefined();
    for (const file of SHIPPED) {
      expect(readText(file), file).not.toMatch(/there is no `?vscode:prepublish/i);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * v0.7.0 DoD 5.3 — the engine table is the goldens' `unavailable`, read back
 * -------------------------------------------------------------------------- */

/*
 * THE RULE, per cell, over every FULL-coverage golden of that engine:
 *
 *   - every record lists `F<n>:<engine>`          -> the cell reads `no`
 *   - no record lists `F<n>` for that engine at all -> the cell reads `yes`
 *   - anything between (some sessions, or one PART) -> the cell is qualified:
 *                                                      neither `yes` nor `no`
 *
 * A code whose reason is not the engine's name (`F13.completed:snapshot`,
 * `F9:telemetry-present`) is a fact about a snapshot or a precedence, not an
 * engine gap, and does not count. Excluded sessions carry no facts and are
 * left out. So a table cell that claims more than the goldens show goes red,
 * and so does one that claims less.
 */
const ENGINE_TABLE_ROWS: Readonly<Record<string, string>> = {
  'Files read, edited and written': 'F1',
  'Tool calls and errors, per tool': 'F2',
  Loops: 'F3',
  'Churn chains': 'F4',
  'Prompt and output tokens, per agent': 'F5',
  'Cache ratio': 'F6',
  'Context churn': 'F7',
  'Silent subagents': 'F8',
  Cost: 'F9',
  'Context fill': 'F10',
  Compactions: 'F12',
  Stalls: 'F13',
};

const TABLE_ENGINES = ['cc', 'opencode', 'codex'] as const;

function engineTable(): { label: string; cells: string[] }[] {
  const block = statsSubsection('### What each engine can supply');
  const rows = block
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const [header, rule, ...body] = rows;
  expect(header).toStrictEqual(['Fact', 'Claude Code', 'OpenCode', 'Codex']);
  expect(rule?.every((cell) => /^-+$/.test(cell))).toBe(true);
  return body.map((cells) => ({ label: cells[0] ?? '', cells: cells.slice(1) }));
}

function fullGoldens(): StatsRecord[] {
  const dir = join(ROOT, 'fixtures', 'golden', 'stats');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readText(`fixtures/golden/stats/${name}`)) as StatsRecord)
    .filter((record) => record.coverage === 'full');
}

type Verdict = 'yes' | 'no' | 'qualified';

function goldenVerdict(records: readonly StatsRecord[], fact: string, engine: string): Verdict {
  const whole = `${fact}:${engine}`;
  const touches = (record: StatsRecord): boolean =>
    record.unavailable.some(
      (code) => code === whole || (code.startsWith(`${fact}.`) && code.endsWith(`:${engine}`)),
    );
  if (records.every((record) => record.unavailable.includes(whole))) return 'no';
  if (!records.some(touches)) return 'yes';
  return 'qualified';
}

describe('DoD 5.3 — the three-engine table agrees with the goldens', () => {
  it('lists exactly the facts it is bound to', () => {
    expect(engineTable().map((row) => row.label).sort()).toStrictEqual(
      Object.keys(ENGINE_TABLE_ROWS).sort(),
    );
  });

  it('every cell says what the goldens say — no more, no less', () => {
    const goldens = fullGoldens();
    const seen = new Set<Verdict>();
    for (const row of engineTable()) {
      const fact = ENGINE_TABLE_ROWS[row.label] ?? '';
      TABLE_ENGINES.forEach((engine, i) => {
        const records = goldens.filter((record) => record.engine === engine);
        expect(records.length, `no full ${engine} golden`).toBeGreaterThan(0);
        const verdict = goldenVerdict(records, fact, engine);
        seen.add(verdict);
        const cell = row.cells[i] ?? '';
        const where = `${row.label} / ${engine}: goldens say ${verdict}, README says "${cell}"`;
        if (verdict === 'yes') expect(cell, where).toBe('yes');
        else if (verdict === 'no') expect(cell, where).toBe('no');
        else expect(['yes', 'no', ''], where).not.toContain(cell);
      });
    }
    // Vacuity control: all three verdicts are exercised by the real goldens,
    // so this is not a table of "yes" checked against a rule that never fires.
    expect([...seen].sort()).toStrictEqual(['no', 'qualified', 'yes']);
  });

  it('the verdict rule is not vacuous: it reads a planted gap', () => {
    const planted = [
      { unavailable: ['F1:cc'] },
      { unavailable: ['F1:cc'] },
    ] as unknown as StatsRecord[];
    expect(goldenVerdict(planted, 'F1', 'cc')).toBe('no');
    expect(goldenVerdict([{ unavailable: [] }] as unknown as StatsRecord[], 'F1', 'cc')).toBe('yes');
    expect(
      goldenVerdict([{ unavailable: ['F2.errors:codex'] }] as unknown as StatsRecord[], 'F2', 'codex'),
    ).toBe('qualified');
    // A snapshot-reason code is not an engine gap.
    expect(
      goldenVerdict(
        [{ unavailable: ['F13.completed:snapshot'] }] as unknown as StatsRecord[],
        'F13',
        'cc',
      ),
    ).toBe('yes');
  });
});

/* -------------------------------------------------------------------------- *
 * v0.7.0 DoD 5.5b — the activity-bar sidebar is the documented entry point
 * -------------------------------------------------------------------------- */

describe('DoD 5.5b — the README install section names the sidebar and its menu', () => {
  // The EXACT heading, newline included: `## Install` is also a prefix of the
  // two hook-install headings, and `sectionText` refuses a repeated match.
  const INSTALL = sectionText('## Install\n');

  it('names the activity-bar icon as the entry point', () => {
    expect(INSTALL).toContain('the Agent Deck icon in the activity bar');
  });

  it('lists the menu EXACTLY as src/sidebar/menu.ts declares it, in order', () => {
    const listed = [...INSTALL.matchAll(/^- \*\*([^*]+)\*\* —/gm)].map((m) => m[1] ?? '');
    expect(listed).toStrictEqual(SIDEBAR_MENU.map((entry) => entry.label));
    // Vacuity control: the menu is not empty, so equality is not empty-equals-empty.
    expect(listed.length).toBeGreaterThan(0);
  });

  it('shows the sidebar screenshot, and says several windows need nothing', () => {
    expect(INSTALL).toContain('](media/sidebar.png)');
    expect(INSTALL).toContain('](#several-windows-one-port)');
  });

  it('offers the user-level ~/.claude/settings.json FIRST for the Claude Code hook block', () => {
    const global = CC_HOOK_SECTION.indexOf('`~/.claude/settings.json`');
    const local = CC_HOOK_SECTION.indexOf('`.claude/settings.local.json`');
    expect(global).toBeGreaterThanOrEqual(0);
    expect(local).toBeGreaterThanOrEqual(0);
    expect(global).toBeLessThan(local);
  });
});

// ---------------------------------------------------------------------------
// v0.7.1 DoD 6.8 — the Claude Code telemetry section
// ---------------------------------------------------------------------------

const TELEMETRY_HEADING = '## Claude Code telemetry (optional)';

/**
 * The four Claude Code content flags. Each puts real text on the wire; the
 * section says they stay unset, and NO env block in the README may set one.
 * Spelled out here rather than read from the README, so the check cannot
 * agree with a typo in the document it checks.
 */
const CONTENT_FLAGS = [
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_RAW_API_BODIES',
] as const;

/**
 * The Phase 0b paste block (v0.7.0 PLAN, "Paste block for the user") — the env
 * that produced `fixtures/otel-cc-2.1.260/` — with ONE key changed, as DoD 6.8
 * requires: the endpoint moves from the spike's `4318` to the hook listener's
 * port. A frozen copy, so a hand-trimmed or reordered block is a difference
 * this test names rather than a block nothing has evidence about.
 */
function phase0bEnvAt(port: unknown): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}`,
    OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
    OTEL_METRIC_EXPORT_INTERVAL: '5000',
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
  };
}

/** True when a parsed fence carries an `env` object naming any content flag. */
function envSetsAContentFlag(fence: unknown): string[] {
  if (fence === null || typeof fence !== 'object') return [];
  const env = (fence as { env?: unknown }).env;
  if (env === null || typeof env !== 'object') return [];
  return CONTENT_FLAGS.filter((flag) => Object.prototype.hasOwnProperty.call(env, flag));
}

describe('DoD 6.8 — the README documents the telemetry route, and never sets a content flag', () => {
  const SECTION = sectionText(TELEMETRY_HEADING);
  const fences = jsonFencesUnder(TELEMETRY_HEADING);

  it('sits after the Claude Code hook section and before the Codex one', () => {
    const at = README.indexOf(TELEMETRY_HEADING);
    expect(at).toBeGreaterThan(README.indexOf(CC_HOOK_HEADING));
    expect(at).toBeLessThan(README.indexOf(CODEX_HOOK_HEADING));
  });

  it('prints exactly one block: the Phase 0b env, endpoint on agentDeck.port', () => {
    expect(fences).toHaveLength(1);
    const parsed = JSON.parse(fences[0] ?? '') as { env?: unknown };
    // The port is the MANIFEST's default, not a literal written here twice.
    expect(DEFAULT_PORT).toBe(DEFAULT_HOOK_PORT);
    expect(parsed).toStrictEqual({ env: phase0bEnvAt(DEFAULT_PORT) });
    // Key ORDER too: a paste block is copied as it reads.
    expect(Object.keys(parsed.env as object)).toStrictEqual(Object.keys(phase0bEnvAt(DEFAULT_PORT)));
  });

  it('names the setting, its machine scope, the label, and the three paths', () => {
    expect(SECTION).toContain('`agentDeck.telemetry.enabled`');
    expect(SECTION).toContain('machine-scoped');
    expect(SECTION).toContain('estimated by Claude Code');
    expect(SECTION).toContain('not an engine report');
    for (const path of Object.values(TELEMETRY_PATHS)) expect(SECTION).toContain(`\`${path}\``);
    // The setting's default is stated by the manifest; the section says what
    // off means, and it must be the route's actual answer.
    expect(SECTION).toContain('`403`');
  });

  it('says the four content flags stay unset, in prose, naming each', () => {
    const prose = SECTION.replace(/```json\n[\s\S]*?\n```/g, '');
    for (const flag of CONTENT_FLAGS) expect(prose, flag).toContain(`\`${flag}\``);
    expect(prose).toMatch(/content flags stay unset/);
  });

  it('no env block anywhere in the README sets a content flag', () => {
    const parsed = JSON_FENCES.map((text) => JSON.parse(text) as unknown);
    const withEnv = parsed.filter(
      (fence) => fence !== null && typeof fence === 'object' && 'env' in (fence as object),
    );
    // VACUITY CONTROL: there is an env block to check, and the predicate sees
    // a planted flag in one.
    expect(withEnv.length).toBeGreaterThan(0);
    expect(envSetsAContentFlag({ env: { ...phase0bEnvAt(1), OTEL_LOG_USER_PROMPTS: '1' } })).toStrictEqual([
      'OTEL_LOG_USER_PROMPTS',
    ]);
    for (const fence of parsed) expect(envSetsAContentFlag(fence)).toStrictEqual([]);
    // And not merely as keys: no fence's TEXT names one at all, so a flag
    // inside a nested object or a comment-like string is caught too.
    for (const text of JSON_FENCES) {
      for (const flag of CONTENT_FLAGS) expect(text.includes(flag), flag).toBe(false);
    }
  });

  it('the CHANGELOG entry for the shipped version names the setting', () => {
    const block = CHANGELOG_TEXT.split(`\n## ${MANIFEST.version} `)[1]?.split('\n## ')[0] ?? '';
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('`agentDeck.telemetry.enabled`');
    expect(block).toContain('estimated by Claude Code');
  });

  /*
   * No view renders a tool duration: telemetry's durations reach the stats
   * record (history, extension API) and nothing draws them. Round 1 of the
   * phase verifier found three shipped sentences saying otherwise; round 2
   * found the third still shipping, because nothing checked it. A sentence
   * that names a view may not place durations, "both", or "the figures" in
   * it, unless it says the view shows no per-tool durations.
   */
  it('no sentence in the telemetry section or the 0.7.1 entry places tool durations in a view', () => {
    const VIEW = /\b(?:Stats view|Tokens view|Tokens part)\b/;
    const PLACES = [/\bdurations?\b/i, /\bBoth appear\b/, /\bThe figures reach\b/];
    const DENIES = /\bno per-tool durations\b/;
    const placing = (text: string): string[] =>
      sentencesOf(paragraphs(text)).filter(
        (s) => VIEW.test(s) && !DENIES.test(s) && PLACES.some((re) => re.test(s)),
      );

    // VACUITY: the three sentences round 1 cited, verbatim as they shipped, are
    // each caught; the sentence that replaced them is not.
    expect(placing('the duration of a tool call where the session\'s own records state none. Both appear in the Stats view.')).toHaveLength(1);
    expect(placing('Tool durations where the session states none, in the Stats view\'s per-tool figures.')).toHaveLength(1);
    expect(placing('The figures reach the Stats view; the session tree and its wire messages carry none of them.')).toHaveLength(1);
    expect(placing('The Stats view shows no per-tool durations.')).toStrictEqual([]);

    const block = CHANGELOG_TEXT.split(`\n## ${MANIFEST.version} `)[1]?.split('\n## ')[0] ?? '';
    expect(block.length).toBeGreaterThan(0);
    expect(SECTION.length).toBeGreaterThan(0);
    // Both texts DO name a view, so the rule is not passing over prose that never mentions one.
    expect(VIEW.test(block)).toBe(true);
    expect(VIEW.test(SECTION)).toBe(true);
    expect(placing(SECTION), 'README telemetry section').toStrictEqual([]);
    expect(placing(block), `CHANGELOG ${MANIFEST.version}`).toStrictEqual([]);
  });
});
