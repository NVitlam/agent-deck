// The canvas contract's version, and the only thing that can make it mean
// something.
//
// WHY THIS FILE EXISTS. `PLAN.md`'s Phase 5 gate amendment B1 introduced
// `CANVAS_CONTRACT_VERSION` and said "a test pins it". The phase verifier
// checked, and that sentence was FALSE: a repo-wide grep found exactly one
// reference to the constant — its own declaration. No test imported it, no
// module imported it, an unused `export` trips no lint rule, and nothing could
// fail when the shape moved. Its own doc comment claimed the purpose it did not
// have: "so a test can fail when the shape moves without anyone saying so".
//
// That is precisely what B1's second paragraph said it was avoiding — a
// constant introduced already-satisfied. This file is the correction.
//
// WHAT A VERSION CONSTANT CAN AND CANNOT BE HERE. It is NOT a compatibility
// negotiation: the host and the webview ship in one VSIX and are always the
// same build, so nothing branches on it and nothing should. What it can be is a
// TRIPWIRE — a declared surface, and a test that fails when the surface moves
// without the declaration moving with it. That converts "we changed the shared
// shape and forgot to say so" from an invisible event into a red test naming
// what changed.
//
// This is the same job `src/bridge/contract.ts` does for the element id, on the
// surface where this repo has already paid once: Phase 3's host emitted
// `<div id="app">` while the webview looked for `#agent-deck-root`, both
// packages internally consistent, both fully tested, and the panel rendered
// into the wrong element with nothing failing.

import { describe, expect, it } from 'vitest';

import * as contract from './canvas-contract.js';
import { CANVAS_CONTRACT_VERSION } from './canvas-contract.js';

/**
 * Every runtime export of `canvas-contract.ts` at version 3, sorted.
 *
 * Types and interfaces are absent because they are erased at runtime and this
 * list is built from the module object. That is a real limit and it is stated
 * rather than hidden: a change to a shared interface's FIELDS does not move
 * this list, so this test guards the contract's runtime NAMES, not its type
 * shapes. `npm run typecheck` covers the shapes, across both projects.
 *
 * WHEN THIS TEST FAILS, do not just update the list. The list moving means the
 * shared host/webview surface moved, which is exactly the moment
 * `CANVAS_CONTRACT_VERSION` is supposed to be bumped. Bump it, update the list,
 * and record what changed in the constant's doc comment.
 *
 * **THAT INSTRUCTION WAS NOT FOLLOWED IN PHASE 7, and the audit found it.** The
 * list moved — `ZOOM_MIN`/`ZOOM_MAX` were removed and the token contract was
 * rewritten — while the constant stayed at 2. The list was updated and the
 * version was not, which is the one failure mode this file cannot detect on its
 * own: a version constant can only be a tripwire for whoever re-reads the rule
 * above. Version 3 is the correction, and its doc comment names all four
 * changes.
 */
const SURFACE_AT_V3: readonly string[] = [
  'ANIMATED_CLASSES',
  'CANVAS_CONTRACT_VERSION',
  'CRACKED_CLASS',
  'DEFAULT_ENGINE_FILTER',
  'DEFAULT_LIVENESS_FILTER',
  'DEFAULT_VIEW_MODE',
  'ENGINE_FILTERS',
  'FOREIGN_CLASS',
  'HOLLOW_LIVE_CLASS',
  'LIVENESS_FILTERS',
  'PARKED_CLASS',
  'REDUCED_MOTION_CLASS',
  'SYNTHETIC_CORPUS_PREFIX',
  'TESTID',
  'WIRE_CORPUS_DIR',
];

describe('CANVAS_CONTRACT_VERSION', () => {
  it('is the version this file describes', () => {
    // If this fails, someone bumped the constant. That is fine and expected —
    // but SURFACE_AT_V3 and its name are now describing a version that no
    // longer exists, so both move together or neither does.
    expect(CANVAS_CONTRACT_VERSION).toBe(5);
  });

  it('pins the shared runtime surface, so the shape cannot move silently', () => {
    const actual = Object.keys(contract)
      .filter((key) => typeof (contract as Record<string, unknown>)[key] !== 'undefined')
      .sort();
    expect(actual).toEqual([...SURFACE_AT_V3].sort());
  });

  it('no longer exports the deleted phyllotaxis names', () => {
    // Named individually rather than left to the set comparison above, because
    // this is the assertion that says WHY the version moved. Each of these
    // described code Phase 7 deleted — `sessionLayout()` and the blob deck —
    // and each was still exported, with no consumer, describing a shape the
    // renderer no longer draws.
    for (const gone of [
      'DOT_CAP',
      'SessionLayout',
      'CellPlacement',
      'DotPlacement',
      'DeckPlacement',
      'DeckFilter',
      'DECK_FILTERS',
      'ZOOM_MIN',
      'ZOOM_MAX',
    ]) {
      expect({ gone, present: gone in contract }).toStrictEqual({ gone, present: false });
    }
  });

  it('names each filter axis once, and the two axes differently', () => {
    // The collision this version closed: two modules each exported a type
    // called `DeckFilter`, one meaning an engine and one meaning a liveness.
    // Types are erased, so only the value halves can be asserted here — but a
    // value list per axis is exactly what a component iterates to draw chips,
    // so a re-collision would show up as one of these being wrong.
    expect(contract.ENGINE_FILTERS).toStrictEqual(['all', 'cc', 'oc', 'cx']);
    expect(contract.LIVENESS_FILTERS).toStrictEqual(['all', 'live', 'idle', 'ended']);
    expect(contract.DEFAULT_ENGINE_FILTER).toBe('all');
    expect(contract.DEFAULT_LIVENESS_FILTER).toBe('all');
    // Neither list is a subset of the other, so no single name could cover
    // both. Stated as an assertion so "just merge them" fails here first.
    expect(contract.ENGINE_FILTERS.filter((v) => contract.LIVENESS_FILTERS.includes(v as never)))
      .toStrictEqual(['all']);
  });

  it('carries the third engine (v0.6.0 Phase 3, Codex) as a fourth filter value', () => {
    // The widening this version bump records. `cx` is added beside `cc`/`oc`
    // — never replacing either — and `all` still leads the list.
    expect(contract.ENGINE_FILTERS).toContain('cx');
    expect(contract.ENGINE_FILTERS.indexOf('all')).toBe(0);
    expect(contract.ENGINE_FILTERS).toHaveLength(4);
  });

  it('detects an addition to the surface', () => {
    // Vacuity control. Without it, a bug that made `Object.keys` return the
    // frozen list itself would turn the assertion above into a permanent pass.
    // A test that cannot fail is the defect this whole file was written to
    // correct, so it would be absurd to reintroduce it one level up.
    const withExtra = [...SURFACE_AT_V3, 'SOMETHING_NEW'].sort();
    expect(withExtra).not.toEqual([...SURFACE_AT_V3].sort());
  });

  it('is imported by something, which is the property that was missing', () => {
    // The original defect was not a wrong value — it was a constant nothing
    // referenced. This asserts the import resolves to a real number rather than
    // `undefined`, which is what a deleted or renamed export would produce.
    expect(typeof CANVAS_CONTRACT_VERSION).toBe('number');
    expect(contract.CANVAS_CONTRACT_VERSION).toBe(CANVAS_CONTRACT_VERSION);
  });
});
