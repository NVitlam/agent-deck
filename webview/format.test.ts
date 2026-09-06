import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { ToolNode } from '../src/model/events.js';
import {
  COLLAPSED_PREVIEW_CHARS,
  EM_DASH,
  collapsePreview,
  degradedReasonText,
  formatCost,
  formatDuration,
  formatTokens,
  formatWindowTokens,
  statusLabel,
} from './format.js';
import { longPreview } from './testdata.js';

describe('collapsePreview', () => {
  it('returns short text untouched and unmarked', () => {
    const result = collapsePreview('hello');
    expect(result).toEqual({ text: 'hello', truncated: false, hiddenChars: 0, marker: '' });
  });

  it('does not truncate at exactly the limit', () => {
    const text = 'x'.repeat(COLLAPSED_PREVIEW_CHARS);
    expect(collapsePreview(text).truncated).toBe(false);
  });

  it('truncates one character past the limit', () => {
    const text = 'x'.repeat(COLLAPSED_PREVIEW_CHARS + 1);
    const result = collapsePreview(text);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(result.hiddenChars).toBe(1);
  });

  it('names how many characters it hid, rather than cutting silently', () => {
    const text = longPreview(2000);
    const result = collapsePreview(text);
    expect(result.text).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(result.hiddenChars).toBe(2000 - COLLAPSED_PREVIEW_CHARS);
    expect(result.marker).toContain(String(2000 - COLLAPSED_PREVIEW_CHARS));
  });

  it('handles the host maximum of 8 KB', () => {
    const result = collapsePreview(longPreview(8192));
    expect(result.text).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(result.hiddenChars).toBe(8192 - COLLAPSED_PREVIEW_CHARS);
  });
});

describe('formatCost', () => {
  // `costUsd` is hard 0 and 0 means NOT COMPUTED. `$0.00` would assert the
  // session was free, which no code in this repo can support.
  it('renders 0 as an em-dash', () => {
    expect(formatCost(0)).toBe(EM_DASH);
  });

  it('never emits a currency symbol', () => {
    for (const value of [0, 1, 12.5, -3, Number.NaN]) {
      expect(formatCost(value)).not.toContain('$');
    }
  });

  it('renders a non-zero value with its declared unit and no conversion', () => {
    expect(formatCost(1.5)).toBe('1.50 USD');
  });
});

describe('formatTokens', () => {
  it('groups thousands', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1,000');
    expect(formatTokens(17_745)).toBe('17,745');
    expect(formatTokens(1_234_567)).toBe('1,234,567');
  });

  it('refuses non-finite input rather than printing NaN', () => {
    expect(formatTokens(Number.NaN)).toBe(EM_DASH);
  });
});

describe('formatWindowTokens', () => {
  // `SessionState.windowTokens` — the Codex engine's context-window ceiling
  // (v0.6.0 Phase 3, spec C8, D0.2). Same idiom as `formatTokens`, restated
  // under its own name: absent is EM_DASH, never 0, and CC/OpenCode sessions
  // (which never set the field) get the em-dash forever, with no per-engine
  // branch anywhere in the function.
  it('groups thousands, exactly like formatTokens', () => {
    expect(formatWindowTokens(0)).toBe('0');
    expect(formatWindowTokens(200_000)).toBe('200,000');
    expect(formatWindowTokens(1_234_567)).toBe('1,234,567');
  });

  it('renders absent (undefined) as EM_DASH, never 0 — the CC/OpenCode case', () => {
    // CC and OpenCode sessions never set `windowTokens` at all, so this is
    // the render every non-Codex session gets, permanently.
    expect(formatWindowTokens(undefined)).toBe(EM_DASH);
  });

  it('refuses non-finite input rather than printing NaN', () => {
    expect(formatWindowTokens(Number.NaN)).toBe(EM_DASH);
  });
});

describe('formatDuration', () => {
  it('keeps sub-second durations in milliseconds', () => {
    expect(formatDuration(75)).toBe('75ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('switches to seconds and minutes', () => {
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(59_900)).toBe('59.9s');
    expect(formatDuration(61_000)).toBe('1m 01s');
  });

  it('renders an unknown duration as an em-dash, not as zero', () => {
    expect(formatDuration(undefined)).toBe(EM_DASH);
  });
});

describe('degradedReasonText', () => {
  it('covers both reasons the host can send, and an absent one', () => {
    expect(degradedReasonText('noHookEvents')).toContain('hook events');
    expect(degradedReasonText('listenerDown')).toContain('listener');
    expect(degradedReasonText(undefined)).toContain('hook tap');
  });
});

// ---------------------------------------------------------------------------
// Status rendering is exhaustive, and the COMPILER is what enforces it
// ---------------------------------------------------------------------------

/**
 * User ruling, 2026-09-06. This REPLACES DoD 0c.4's "untrusted-input guard"
 * clause, which was struck: there is no guard on the host→webview direction
 * and there will not be one. `src/bridge/messages.ts` guards INBOUND UI
 * intents; a `ToolNode` travels outbound, which is the trusted direction. A
 * type-level check is the honest control for a trusted channel.
 *
 * Two assertions, and the first is the load-bearing one because it costs
 * nothing and cannot be satisfied by accident.
 */

/**
 * Every member of `ToolNode['status']` that `statusLabel` does NOT branch on.
 *
 * Must be `never`. Add a fifth status without a `case` and this alias becomes
 * that status, `[X] extends [never]` becomes `false`, and the `= true` below
 * stops compiling — so `npm run typecheck`, which is a gate, goes red.
 *
 * The tuple wrapper is deliberate: a bare `X extends never` distributes over a
 * union and would be vacuously true for the empty case, which is the exact
 * shape of vacuity this repository keeps recording.
 */
type UncoveredStatus = Exclude<
  ToolNode['status'],
  'running' | 'done' | 'error' | 'stalled'
>;
const _noUncoveredStatus: [UncoveredStatus] extends [never] ? true : false = true;

describe('statusLabel is exhaustive over ToolNode.status', () => {
  it('has no uncovered status (checked by tsc, asserted here so it is visible)', () => {
    // The real check happened at compile time — this line just keeps the
    // constant referenced and puts the property in the test report.
    expect(_noUncoveredStatus).toBe(true);
  });

  it('labels every status distinctly, with no empty label', () => {
    const STATUSES: ToolNode['status'][] = ['running', 'done', 'error', 'stalled'];
    const labels = STATUSES.map((s) => statusLabel(s));
    // Vacuity control: an empty list would satisfy both assertions below.
    expect(labels).toHaveLength(4);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /**
   * MUTATION-PROVED, 2026-09-06. Adding `| 'mutant'` to `ToolNode['status']`
   * and running `npm run typecheck` produces, verbatim:
   *
   *   webview/format.ts(162,32): error TS2345:
   *     Argument of type '"mutant"' is not assignable to parameter of type 'never'.
   *
   * and the build fails. Recorded rather than re-run: spawning `tsc` per test
   * would cost seconds for a property the gate already checks on every run.
   */
  it('the `never` sink is a real parameter, not a comment', async () => {
    const src = await readFile(
      fileURLToPath(new URL('./format.ts', import.meta.url)),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    // Vacuity control: the strip must not have eaten the file.
    expect(code).toMatch(/export function statusLabel/u);
    expect(code).toMatch(/status: never/u);
    expect(code).toMatch(/default:/u);
  });
});
