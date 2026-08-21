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
//      literals is not a contract, so the literal is read from the manifest.
//   5. THE VERSION BADGE GOES STALE. This is the trap in the DoD's own wording:
//      "pinned-CC-version badge" describes the pre-Phase-4 world of one pinned
//      version, and the shipped rule is an acceptance WINDOW. The constants are
//      IMPORTED from `src/parser/fingerprint.ts` rather than written down again
//      - a test that hard-coded 2.1.234 would rot in exactly the same way the
//      README would, and would rot silently.
//   6. THE SPEC CONTRADICTS THE PRODUCT. Carry-forward G: `agent-deck-spec.md`
//      section 3 still said "pin to the installed CC version" after the code
//      stopped doing that. The section is pinned to the same constants, and the
//      superseded phrase is asserted absent - pin the spec to the code, not to
//      a phrase someone remembered to update once.
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PINNED_CC_VERSION, VERSION_WINDOW, versionWindow } from '../parser/fingerprint.js';

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
}

const MANIFEST = JSON.parse(readText('package.json')) as Manifest;
const DEFAULT_PORT = MANIFEST.contributes.configuration.properties['agentDeck.port']?.default;

const LIVE_SETTINGS = JSON.parse(readText('.claude/settings.local.json')) as HookSettings;

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

  it('links no image, so nothing points at an asset that does not exist', () => {
    // Covers the missing-screenshot case and the remote-badge case at once: an
    // extension whose headline claim is zero egress should not fetch its own
    // badge from a third party to render its README.
    expect(README).not.toMatch(/!\[[^\]]*\]\(/);
  });
});

describe('the hook paste block', () => {
  it('has exactly one JSON fence carrying a `hooks` key, and every fence parses', () => {
    expect(JSON_FENCES.length).toBeGreaterThan(0);
    const parsed = JSON_FENCES.map((text) => JSON.parse(text) as unknown);
    const hookBlocks = parsed.filter(isHookSettings);
    expect(hookBlocks).toHaveLength(1);
  });

  it('is byte-identical to the live block in .claude/settings.local.json', () => {
    const block = JSON.parse(JSON_FENCES[0] ?? '') as unknown;
    expect(isHookSettings(block)).toBe(true);
    if (!isHookSettings(block)) return;

    // Whole-object equality catches matchers and timeouts too; the per-command
    // loop below exists so a failure names the event that drifted.
    expect(block.hooks).toStrictEqual(LIVE_SETTINGS.hooks);

    const readmeCommands = commandsOf(block);
    const liveCommands = commandsOf(LIVE_SETTINGS);
    expect([...readmeCommands.keys()].sort()).toStrictEqual([...liveCommands.keys()].sort());
    for (const [event, commands] of liveCommands) {
      expect(readmeCommands.get(event), `command drift on ${event}`).toStrictEqual(commands);
    }
  });

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

  it('binds only loopback', () => {
    const fence = JSON_FENCES[0] ?? '';
    expect(fence).toContain("host:'127.0.0.1'");
    expect(fence).not.toContain('0.0.0.0');
  });
});

describe('the version badge is accurate against the shipped constants', () => {
  const window = versionWindow();
  const corners = (): { min: string; max: string } => {
    if (window === undefined) throw new Error('PINNED_CC_VERSION does not parse');
    return {
      min: `${String(window.major)}.${String(window.minMinor)}.${String(window.minPatch)}`,
      max: `${String(window.major)}.${String(window.maxMinor)}.${String(window.maxPatch)}`,
    };
  };

  /** `anchor \`x.y.z\``, `Anchor: \`x.y.z\`` - every way this document says it. */
  const ANCHOR_RE = /\banchor(?:ed on)?:?\s+`(\d+\.\d+\.\d+)`/gi;
  const MINOR_RE = /\bminor \+\/-(\d+)/g;
  const PATCH_RE = /\bpatch \+\/-(\d+)/g;
  const CORNERS_RE = /`(\d+\.\d+\.\d+)` to `(\d+\.\d+\.\d+)`/g;

  it('states the anchor version the fingerprint actually uses', () => {
    const stated = [...README.matchAll(ANCHOR_RE)].map((m) => m[1]);
    expect(stated.length).toBeGreaterThan(0);
    for (const version of stated) expect(version).toBe(PINNED_CC_VERSION);
  });

  it('states the window tolerances the fingerprint actually uses', () => {
    const minors = [...README.matchAll(MINOR_RE)].map((m) => Number(m[1]));
    const patches = [...README.matchAll(PATCH_RE)].map((m) => Number(m[1]));
    expect(minors.length).toBeGreaterThan(0);
    expect(patches.length).toBeGreaterThan(0);
    for (const minor of minors) expect(minor).toBe(VERSION_WINDOW.minor);
    for (const patch of patches) expect(patch).toBe(VERSION_WINDOW.patch);
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

  it('claims no version literal outside the anchor and the corners', () => {
    // A badge is only accurate if nothing NEXT to it contradicts it. Backticked
    // `x.y.z` literals are how this document names CC versions; `^1.90.0` and
    // `>=20` do not match because the backtick is not followed by a digit.
    const { min, max } = corners();
    const allowed = new Set([PINNED_CC_VERSION, min, max]);
    const literals = [...README.matchAll(/`(\d+\.\d+\.\d+)`/g)].map((m) => m[1] ?? '');
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(allowed.has(literal), `unexplained version literal ${literal}`).toBe(true);
    }
  });

  it('says the window is a window, not a single supported version', () => {
    expect(README).toContain('versionChangedMidFile');
    expect(README).toContain('major exact');
  });
});

describe('agent-deck-spec.md section 3 no longer contradicts the product', () => {
  /** Section 3 only: heading through the start of section 4. */
  const section3 = ((): string => {
    const start = SPEC.indexOf('## 3. Observation model');
    const end = SPEC.indexOf('\n## 4.', start);
    if (start < 0 || end <= start) {
      throw new Error('agent-deck-spec.md section 3 could not be located');
    }
    return SPEC.slice(start, end);
  })();

  // Literal, and deliberately blunt: the section may not reproduce the
  // superseded sentence even to quote it as superseded. Measured - the first
  // draft of the amendment quoted the old phrase in its own supersession note
  // and this failed. Paraphrase the old posture; do not quote it.
  it('drops the superseded single-pin posture', () => {
    expect(section3.toLowerCase()).not.toContain('pin to the installed cc version');
    expect(section3.toLowerCase()).not.toContain('no multi-version support');
  });

  it('states the same anchor and tolerances as the shipped constants', () => {
    const anchors = [...section3.matchAll(/\banchor(?:ed on)?:?\s+`(\d+\.\d+\.\d+)`/gi)].map(
      (m) => m[1],
    );
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(anchor).toBe(PINNED_CC_VERSION);

    const minors = [...section3.matchAll(/\bminor \+\/-(\d+)/g)].map((m) => Number(m[1]));
    const patches = [...section3.matchAll(/\bpatch \+\/-(\d+)/g)].map((m) => Number(m[1]));
    expect(minors.length).toBeGreaterThan(0);
    expect(patches.length).toBeGreaterThan(0);
    for (const minor of minors) expect(minor).toBe(VERSION_WINDOW.minor);
    for (const patch of patches) expect(patch).toBe(VERSION_WINDOW.patch);
  });

  it('names the module that owns the numbers, and the mid-file refusal code', () => {
    expect(section3).toContain('src/parser/fingerprint.ts');
    expect(section3).toContain('versionChangedMidFile');
    expect(section3).toContain('2026-08-21');
  });
});
