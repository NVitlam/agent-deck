/**
 * v0.7.0 Phase 1, DoD 1.2 — the canonicaliser and `inputHash`.
 *
 * **The expected digests are not this file's opinion.** Every vector below was
 * produced by `lab/spike/stats/derive-facts.mjs`'s own `canonical`/`inputHash`
 * — the INDEPENDENT reader that measured `LOOP_MIN` in Phase 0, which imports
 * nothing from `src/`. So these assertions pin agreement with the
 * implementation the constant was chosen under. If `canonical.ts` and the spike
 * ever diverge, `LOOP_MIN = 3` stops describing this code and these go red.
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  DEPTH_LIMIT_TOKEN,
  inputHash,
  MAX_CANONICAL_DEPTH,
} from './canonical.js';

describe('canonicalJson — shape', () => {
  it('sorts object keys at every depth and leaves arrays in order', () => {
    expect(canonicalJson({ z: { d: 4, c: 3 }, a: [1, 2] })).toBe(
      '{"a":[1,2],"z":{"c":3,"d":4}}',
    );
  });

  it('is insensitive to key insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('is SENSITIVE to array order, because order is meaning in a tool input', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('represents values JSON cannot carry as null, never as undefined', () => {
    // `JSON.stringify` returns undefined (not a string) for these, which would
    // splice the literal "undefined" into the serialisation.
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(() => 0)).toBe('null');
    expect(canonicalJson(Number.NaN)).toBe('null');
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe('null');
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}');
  });
});

describe('canonicalJson — G3, never crash on input', () => {
  it('cuts at the depth bound instead of overflowing the stack', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < MAX_CANONICAL_DEPTH * 4; i += 1) deep = { n: deep };

    // The assertion that matters is that this RETURNS at all.
    const out = canonicalJson(deep);
    expect(out).toContain(DEPTH_LIMIT_TOKEN);
    expect(() => inputHash(deep)).not.toThrow();
  });

  it('cuts a deep ARRAY too — the other recursion arm', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < MAX_CANONICAL_DEPTH * 4; i += 1) deep = [deep];
    expect(canonicalJson(deep)).toContain(DEPTH_LIMIT_TOKEN);
  });

  it('survives a cyclic object rather than recursing forever', () => {
    // Cannot arrive from `JSON.parse`, but the function is exported.
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => canonicalJson(cycle)).not.toThrow();
  });
});

describe('inputHash — agreement with the Phase 0 spike reader', () => {
  // value, canonical form, sha256 hex — all three produced by the spike.
  const VECTORS: ReadonlyArray<readonly [string, unknown, string, string]> = [
    ['null', null, 'null', '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'],
    ['empty object', {}, '{}', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'],
    [
      'a Read call',
      { file_path: '/a/b.ts' },
      '{"file_path":"/a/b.ts"}',
      'f4cdf4f4337b9e4a512cc1fb8ee76caa5c26f397a72946387df75b35270abf08',
    ],
    [
      'keys out of order',
      { b: 2, a: 1 },
      '{"a":1,"b":2}',
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    ],
    [
      'nested, unsorted',
      { z: { d: 4, c: 3 }, a: [1, 2] },
      '{"a":[1,2],"z":{"c":3,"d":4}}',
      '2017291ad1637af1e2cfd3ca6a7e54ccba6437b0c9d3c49475a3db4f468a95b2',
    ],
    [
      'non-ASCII, hashed as UTF-8',
      { s: 'café — §' },
      '{"s":"café — §"}',
      'a1fa37f218737b0f379af7f5c94b96e0ba20943ba6cbeba2bcb8bf376942817a',
    ],
  ];

  for (const [name, value, canon, digest] of VECTORS) {
    it(`reproduces the spike for ${name}`, () => {
      expect(canonicalJson(value)).toBe(canon);
      expect(inputHash(value)).toBe(digest);
    });
  }

  it('gives array order its own digest', () => {
    expect(inputHash([1, 2])).toBe(
      '49a64717d5d4cb19952e6eac2946415cf6879adacf9908e7d872332d32c6e684',
    );
    expect(inputHash([2, 1])).toBe(
      'af1a1fc110b6094c48582b0ef83553cb7908d7a4365424eef28e76ef6c88d630',
    );
  });

  it('is a 64-character lowercase hex digest', () => {
    expect(inputHash({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
