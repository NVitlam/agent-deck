/**
 * `gen-webview-goldens.mjs --check` compares CONTENT, not line endings.
 *
 * Found at the v0.7.0 Phase 5 gate, 2026-09-10: all 21 webview goldens read
 * `changed` and the check exited 1 on a correct tree, because the files are
 * stored LF and checked out CRLF under `core.autocrlf`, and the check compared
 * raw bytes. `git diff` was empty. Both directions are pinned here: a CRLF copy
 * of a golden is the same golden, and a golden whose content moved is not —
 * so the fix cannot have been bought by a comparison that accepts anything.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- a plain .mjs script with no declarations; the same import `webview-layout.test.ts` makes.
import { sameGolden as untypedSameGolden } from '../../scripts/gen-webview-goldens.mjs';

/** Typed at the one place it enters TypeScript, so every call below is checked. */
const sameGolden = untypedSameGolden as (current: string | null, body: string) => boolean;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('the webview golden check reads content, not line endings', () => {
  const lf = '{\n  "generator": "scripts/gen-webview-goldens.mjs",\n  "max": 0\n}\n';

  it('a CRLF checkout of a golden is the same golden', () => {
    expect(sameGolden(lf.replace(/\n/g, '\r\n'), lf)).toBe(true);
    expect(sameGolden(lf, lf)).toBe(true);
  });

  it('a golden whose content moved is NOT the same, in either ending', () => {
    const moved = lf.replace('"max": 0', '"max": 1');
    expect(sameGolden(moved, lf)).toBe(false);
    expect(sameGolden(moved.replace(/\n/g, '\r\n'), lf)).toBe(false);
    expect(sameGolden(null, lf)).toBe(false);
  });

  it('holds on a real committed golden as this checkout has it', () => {
    // The file exactly as git checked it out here, against its LF form: the
    // pair that read `changed` before the fix.
    const onDisk = readFileSync(join(ROOT, 'webview', 'goldens', 'stats', 'n0.json'), 'utf8');
    expect(sameGolden(onDisk, onDisk.replace(/\r\n/g, '\n'))).toBe(true);
    expect(sameGolden(onDisk, `${onDisk.replace(/\r\n/g, '\n')} `)).toBe(false);
  });
});
