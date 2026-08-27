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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_HOOK_PORT } from '../hooks/listener.js';
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
const SPEC = readText('agent-deck-spec.md');

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
}

const MANIFEST = JSON.parse(readText('package.json')) as Manifest;
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

  it('names no absolute developer path', () => {
    // Case-insensitive: the project slug capitalises the drive letter both ways
    // on Windows, and this file ships to strangers.
    for (const forbidden of ['dev', 'projects', 'C:\\Users']) {
      expect(README.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
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
      expect(
        existsSync(join(ROOT, link)),
        `README links ${link}, which does not exist`,
      ).toBe(true);
    }
  });
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

  it('states the anchor version the fingerprint actually uses', () => {
    const stated = [...README.matchAll(ANCHOR_RE)].map((m) => m[1]);
    expect(stated.length).toBeGreaterThan(0);
    for (const version of stated) expect(version).toBe(PINNED_CC_VERSION);
  });

  it('states the window tolerances the fingerprint actually uses', () => {
    const minors = [...README.matchAll(MINOR_RE)].map((m) => Number(m[1]));
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

  it('states window corners derived from those tolerances', () => {
    const { min, max } = corners();
    const stated = [...README.matchAll(CORNERS_RE)];
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
    const literals = [...README.matchAll(/`(\d+\.\d+\.\d+)`/g)].map((m) => m[1] ?? '');
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

describe('agent-deck-spec.md restates the superseded version posture nowhere', () => {
  it('carries neither superseded sentence, anywhere in the document', () => {
    const lower = SPEC.toLowerCase();
    for (const phrase of SUPERSEDED_PHRASES) {
      expect(lower, `agent-deck-spec.md still says "${phrase}"`).not.toContain(phrase);
    }
  });

  it('carries no reworded restatement of it, in any section', () => {
    // Whole document. The predecessor of this test read section 3 alone, so a
    // contradiction in any other section was untested rather than absent.
    expect(contradictionsIn(SPEC)).toStrictEqual([]);
  });

  it('keeps the supersession exemption to a note, not a licence', () => {
    // An exempted sentence is one that both restates the old posture and says
    // it is superseded. That is a footnote-shaped thing; a document with many
    // of them is a document routing around this guard.
    const exempted = sentencesOf(SPEC).filter(
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
describe('the spec version-posture amendment matches the shipped constants', () => {
  const AMENDMENT_HEADING = '## Amendment 2026-08-26 — Version posture';

  /** The last dated amendment: its heading through the end of the document. */
  const amendment = ((): string => {
    const start = SPEC.indexOf(AMENDMENT_HEADING);
    if (start < 0) throw new Error('the dated version-posture amendment could not be located');
    return SPEC.slice(start);
  })();

  it('is the last section, so nothing later can quietly contradict it', () => {
    expect(SPEC.indexOf(AMENDMENT_HEADING)).toBe(SPEC.lastIndexOf(AMENDMENT_HEADING));
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
