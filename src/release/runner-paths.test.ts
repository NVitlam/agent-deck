/**
 * The runner never overwrites a record — v0.7.0 Phase 4, DoD 4.0a (carried
 * from the Phase 3 handoff, where two mid-run deaths' `adhoc-001.json`
 * records were overwritten by the ad-hoc runs that followed).
 *
 * The rule is a pure function with an injected `exists`, so it is driven here
 * against a fake directory; the wiring — that `scripts/test-run.mjs` actually
 * calls it — is asserted by reading the runner's source for the call, the way
 * `testrun.test.ts` asserts the classifier is used rather than merely correct.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_ATTEMPTS,
  recordFileName,
  uniqueRecordName,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- a plain .mjs tool module with no type declarations.
} from '../../scripts/runner-paths.mjs';

const RUNNER = join(__dirname, '..', '..', 'scripts', 'test-run.mjs');

describe('recordFileName', () => {
  it('is the historical name for the first attempt, and a -rN suffix after', () => {
    expect(recordFileName('adhoc', 1, 1)).toBe('adhoc-001.json');
    expect(recordFileName('adhoc', 1, 2)).toBe('adhoc-001-r2.json');
    expect(recordFileName('phase-4-gate', 12, 3)).toBe('phase-4-gate-012-r3.json');
  });
});

describe('uniqueRecordName', () => {
  it('takes the first free name, in attempt order', () => {
    const taken = new Set(['adhoc-001.json', 'adhoc-001-r2.json']);
    expect(uniqueRecordName('adhoc', 1, (n: string) => taken.has(n))).toBe('adhoc-001-r3.json');
    expect(uniqueRecordName('adhoc', 2, (n: string) => taken.has(n))).toBe('adhoc-002.json');
  });

  it('THE SCENARIO: four ad-hoc runs after two deaths leave all six records on disk', () => {
    const disk = new Set<string>();
    const written: string[] = [];
    for (let run = 0; run < 6; run += 1) {
      const name = uniqueRecordName('adhoc', 1, (n: string) => disk.has(n));
      expect(disk.has(name), `${name} would have been overwritten`).toBe(false);
      disk.add(name);
      written.push(name);
    }
    expect(written).toStrictEqual([
      'adhoc-001.json',
      'adhoc-001-r2.json',
      'adhoc-001-r3.json',
      'adhoc-001-r4.json',
      'adhoc-001-r5.json',
      'adhoc-001-r6.json',
    ]);
    expect(disk.size).toBe(6);
  });

  it('is bounded: a directory that answers "exists" for everything throws rather than spinning', () => {
    expect(() => uniqueRecordName('adhoc', 1, () => true)).toThrow(/no free record name/);
    expect(MAX_ATTEMPTS).toBeGreaterThan(100);
  });
});

describe('the runner uses it', () => {
  it('scripts/test-run.mjs writes through uniqueRecordName and not through a literal name', () => {
    const source = readFileSync(RUNNER, 'utf8');
    expect(source).toContain("from './runner-paths.mjs'");
    expect(source).toContain('uniqueRecordName(label, index');
    // The old shape — the padded index joined straight into the path — is gone.
    expect(source).not.toMatch(/path\.join\(OUT_DIR, `\$\{label\}-\$\{String\(index\)\.padStart\(3, '0'\)\}\.json`\)/);
  });
});
