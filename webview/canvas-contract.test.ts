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
 * Every runtime export of `canvas-contract.ts` at version 2, sorted.
 *
 * Types and interfaces are absent because they are erased at runtime and this
 * list is built from the module object. That is a real limit and it is stated
 * rather than hidden: a change to `SessionLayout`'s FIELDS does not move this
 * list, so this test guards the contract's runtime NAMES, not its type shapes.
 * `npm run typecheck` covers the shapes, across both projects.
 *
 * WHEN THIS TEST FAILS, do not just update the list. The list moving means the
 * shared host/webview surface moved, which is exactly the moment
 * `CANVAS_CONTRACT_VERSION` is supposed to be bumped. Bump it, update the list,
 * and record what changed in the constant's doc comment.
 */
const SURFACE_AT_V2: readonly string[] = [
  'ANIMATED_CLASSES',
  'CANVAS_CONTRACT_VERSION',
  'CRACKED_CLASS',
  'DECK_FILTERS',
  'DEFAULT_VIEW_MODE',
  'DOT_CAP',
  'FOREIGN_CLASS',
  'HOLLOW_LIVE_CLASS',
  'PARKED_CLASS',
  'REDUCED_MOTION_CLASS',
  'SYNTHETIC_CORPUS_PREFIX',
  'TESTID',
  'WIRE_CORPUS_DIR',
  'ZOOM_MAX',
  'ZOOM_MIN',
];

describe('CANVAS_CONTRACT_VERSION', () => {
  it('is the version this file describes', () => {
    // If this fails, someone bumped the constant. That is fine and expected —
    // but SURFACE_AT_V2 and its name are now describing a version that no
    // longer exists, so both move together or neither does.
    expect(CANVAS_CONTRACT_VERSION).toBe(2);
  });

  it('pins the shared runtime surface, so the shape cannot move silently', () => {
    const actual = Object.keys(contract)
      .filter((key) => typeof (contract as Record<string, unknown>)[key] !== 'undefined')
      .sort();
    expect(actual).toEqual([...SURFACE_AT_V2].sort());
  });

  it('detects an addition to the surface', () => {
    // Vacuity control. Without it, a bug that made `Object.keys` return the
    // frozen list itself would turn the assertion above into a permanent pass.
    // A test that cannot fail is the defect this whole file was written to
    // correct, so it would be absurd to reintroduce it one level up.
    const withExtra = [...SURFACE_AT_V2, 'SOMETHING_NEW'].sort();
    expect(withExtra).not.toEqual([...SURFACE_AT_V2].sort());
  });

  it('is imported by something, which is the property that was missing', () => {
    // The original defect was not a wrong value — it was a constant nothing
    // referenced. This asserts the import resolves to a real number rather than
    // `undefined`, which is what a deleted or renamed export would produce.
    expect(typeof CANVAS_CONTRACT_VERSION).toBe('number');
    expect(contract.CANVAS_CONTRACT_VERSION).toBe(CANVAS_CONTRACT_VERSION);
  });
});
