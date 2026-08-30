/**
 * F2 — a refused graft says WHY, and says nothing it should not.
 *
 * THE DEFECT
 * ----------
 * Through v0.5.0 `ClaimTracker#graft` handled its two failure modes
 * asymmetrically. A graft that THREW kept its message in `#lastGraftError` and
 * surfaced it through `DataPathDiagnostics`. A graft that REFUSED — the
 * DESIGNED path, the one the whole fingerprint exists to produce — did this and
 * only this:
 *
 *     if (!result.ok) this.#graftRefusals += 1;
 *
 * `result.mismatch` carried `code`, `path` (file **and line**), `field`,
 * `expected`, `actual` and `observedVersion`, and every one of them was thrown
 * away. `formatCounters` printed `graftRefusals=N`.
 *
 * On 2026-08-31 that made ONE teleported transcript — 465 imported lines
 * stamped `version: "1.0"` — read as "the CC adapter is broken on 2.1.251".
 * Recovering the real reason took bundling `src/parser/fingerprint.ts`
 * out-of-tree and running it by hand. The counter did not merely fail to help;
 * it pointed at the wrong engine, the wrong version and the wrong subsystem.
 * `docs/evidence/release-0.5.0/DRIFT-2.1.251.md` §1 is the incident.
 *
 * THE OTHER HALF, WHICH IS WHY THIS FILE IS LONGER THAN THE FIX
 * -------------------------------------------------------------
 * A diagnostics channel is a surface a user is invited to copy into a bug
 * report, so "log the reason" and "log the transcript" are one keystroke apart.
 * The contract (release brief decision 5) is that every field is a **name, a
 * type, a version or a line number** and none is a value out of a transcript,
 * and the tests below are built to fail if that ever stops being true:
 *
 *   - an INVENTED needle is planted in a transcript VALUE, and asserted absent
 *     from the line — with a vacuity control proving the needle really is in
 *     the file, because a needle that was never planted is absent for free;
 *   - the ABSOLUTE PATH is asserted absent. `fingerprint.ts` builds
 *     `mismatch.path` as `<absolute transcript path>:<line>`, which on Windows
 *     begins `C:\Users\<user>\` — the developer-identifier class
 *     `scripts/privacy-sweep.mjs` hard-fails on. `refusalLocation` reduces it
 *     to `<basename>:<line>`, and the reduction is asserted, not assumed.
 *
 * The needles are fiction, on `src/release/privacy.test.ts`'s own precedent:
 * fragmenting a real name hides it from `grep` without removing it, so nothing
 * real is written here at all.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { graftSession } from '../model/graft.js';
import { PINNED_CC_VERSION } from '../parser/fingerprint.js';
import { formatEvent, graftRefusedEvent, refusalLocation } from './diagnostics.js';

/** Invented. `Zaphod` has two heads and no relationship to anybody. */
const NEEDLE = 'Zaphod-Beeblebrox-was-here';
/** A version string no CC release has, and outside the window either way. */
const OUT_OF_WINDOW = '1.0';

const AT = '2026-08-31T00:00:00.000Z';

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A slug directory holding one transcript that WILL refuse, whose content
 * carries the needle.
 *
 * The refusal is a version refusal because that is the shape the real incident
 * had — and because it is the one that puts a value (`"1.0"`) into `actual`,
 * which is precisely the field this file has to prove is a version and not
 * content.
 */
function refusingSession(): { slugDir: string; transcript: string; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-refusal-'));
  temps.push(root);
  const slugDir = join(root, 'c--invented-agent-deck');
  mkdirSync(slugDir, { recursive: true });
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const transcript = join(slugDir, `${sessionId}.jsonl`);
  const line = {
    type: 'user',
    uuid: '11111111-1111-4111-8111-111111111111',
    parentUuid: null,
    sessionId,
    timestamp: AT,
    version: OUT_OF_WINDOW,
    isSidechain: false,
    // The needle lives in a VALUE, which is the only place it could leak from.
    message: { role: 'user', content: [{ type: 'text', text: NEEDLE }] },
  };
  writeFileSync(transcript, `${JSON.stringify(line)}\n`, 'utf8');
  return { slugDir, transcript, sessionId };
}

describe('F2 — refusalLocation reduces a path to <basename>:<line>', () => {
  it('drops the directory and keeps the line, on both separators', () => {
    expect(refusalLocation('C:\\Users\\somebody\\.claude\\projects\\c--invented-agent-deck\\s.jsonl:1')).toBe(
      's.jsonl:1',
    );
    expect(refusalLocation('/home/somebody/.claude/projects/c--invented-agent-deck/s.jsonl:42')).toBe('s.jsonl:42');
  });

  it('keeps a subagent transcript name, which says more than the session id does', () => {
    expect(refusalLocation('C:\\p\\c--invented-agent-deck\\s\\subagents\\agent-a1b2.jsonl:7')).toBe(
      'agent-a1b2.jsonl:7',
    );
  });

  it('keeps a path with no line suffix, and survives a dotted field path whole', () => {
    expect(refusalLocation('C:\\p\\c--invented-agent-deck\\s\\subagents')).toBe('subagents');
    // `SchemaMismatch.path` also permits a dotted field path, which is not a
    // filesystem path and must not be truncated at a separator it does not have.
    expect(refusalLocation('message.content.0.type')).toBe('message.content.0.type');
  });

  it('answers undefined for absent and empty, rather than an empty field', () => {
    expect(refusalLocation(undefined)).toBeUndefined();
    expect(refusalLocation('')).toBeUndefined();
    // A trailing separator leaves no basename; that is "cannot say", not ''.
    expect(refusalLocation('C:\\p\\c--invented-agent-deck\\')).toBeUndefined();
  });

  it('is not fooled by the Windows drive colon', () => {
    // A right-hand split on a bare `:` would cut `C` off `C:` and report a
    // line number of nothing. The line suffix is matched as a digit run.
    expect(refusalLocation('C:\\s.jsonl')).toBe('s.jsonl');
  });
});

describe('F2 — the line a real refusal produces', () => {
  it('names the code, the field, the versions and the file, and emits one line', async () => {
    const { transcript, sessionId } = refusingSession();
    const result = await graftSession(transcript);
    if (result.ok) throw new Error('the fixture was supposed to refuse');

    const event = graftRefusedEvent(sessionId, 'cc', {
      code: result.mismatch.code,
      ...(result.mismatch.path === undefined ? {} : { path: result.mismatch.path }),
      ...(result.mismatch.field === undefined ? {} : { field: result.mismatch.field }),
      ...(result.mismatch.expected === undefined ? {} : { expected: result.mismatch.expected }),
      ...(result.mismatch.actual === undefined ? {} : { actual: result.mismatch.actual }),
    });
    const line = formatEvent(event, AT);

    expect(line.split('\n')).toHaveLength(1);
    expect(line).toBe(
      `${AT} graft refused engine=cc session=${sessionId} code=unsupportedVersion ` +
        `at=${sessionId}.jsonl:1 field=version expected=${PINNED_CC_VERSION} ` +
        `actual=${OUT_OF_WINDOW}`,
    );
  });

  it('leaks no transcript value into the line', () => {
    /*
     * THE VACUITY CONTROL COMES FIRST. A needle that was never written is
     * absent from every line for free, and this repository's most-recorded
     * defect is an assertion that passes because it is asking nothing.
     */
    const { transcript, sessionId } = refusingSession();
    const onDisk = readFileSync(transcript, 'utf8');
    expect(onDisk).toContain(NEEDLE);

    return graftSession(transcript).then((result) => {
      if (result.ok) throw new Error('the fixture was supposed to refuse');
      const event = graftRefusedEvent(sessionId, 'cc', {
        code: result.mismatch.code,
        ...(result.mismatch.path === undefined ? {} : { path: result.mismatch.path }),
        ...(result.mismatch.field === undefined ? {} : { field: result.mismatch.field }),
        ...(result.mismatch.expected === undefined ? {} : { expected: result.mismatch.expected }),
        ...(result.mismatch.actual === undefined ? {} : { actual: result.mismatch.actual }),
      });
      const line = formatEvent(event, AT);

      expect(line).not.toContain(NEEDLE);
      // Not merely the whole needle: no fragment of it either, which is what
      // catches a future change that clips a value instead of dropping it.
      expect(line).not.toContain('Zaphod');
      expect(line).not.toContain('Beeblebrox');
      // `reason` is the mismatch's one free-text field and is deliberately not
      // carried. Free text is the door content walks through.
      expect(line).not.toContain(result.mismatch.reason);
    });
  });

  it('leaks no absolute path into the line', async () => {
    const { transcript, sessionId } = refusingSession();
    const result = await graftSession(transcript);
    if (result.ok) throw new Error('the fixture was supposed to refuse');

    // Vacuity control: the mismatch really does carry the absolute path, so
    // the reduction below is doing work rather than describing an empty case.
    expect(result.mismatch.path).toContain(transcript);

    const event = graftRefusedEvent(sessionId, 'cc', {
      code: result.mismatch.code,
      ...(result.mismatch.path === undefined ? {} : { path: result.mismatch.path }),
    });
    const line = formatEvent(event, AT);

    expect(line).not.toContain(transcript);
    // The temp root stands in for `C:\Users\<user>\.claude\projects\<slug>`:
    // the directory, whatever it is, does not appear.
    expect(line).not.toContain(tmpdir());
    expect(line).not.toContain('c--invented-agent-deck');
    expect(line).toContain(`at=${sessionId}.jsonl:1`);
  });

  it('omits a field the mismatch did not carry, rather than writing it empty', () => {
    // `field=` reads as "we looked and found nothing", which is a different
    // claim from "the mismatch did not carry this" — rule 18's class.
    const line = formatEvent(
      graftRefusedEvent('s1', 'opencode', { code: 'subagentsDirectoryMisnamed' }),
      AT,
    );
    expect(line).toBe(`${AT} graft refused engine=opencode session=s1 code=subagentsDirectoryMisnamed`);
    expect(line).not.toContain('at=');
    expect(line).not.toContain('field=');
    expect(line).not.toContain('undefined');
  });
});
