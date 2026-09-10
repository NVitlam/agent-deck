/**
 * Canonical JSON, and the `inputHash` built on it.
 *
 * v0.7.0 Phase 1, DoD 1.2. The locked answer (2026-09-05) is exact and this
 * module implements it and nothing else: **sorted-key JSON of the full
 * structured input, UTF-8, SHA-256, hex.**
 *
 * ## What the hash is FOR, because it decides every edge case below
 *
 * `inputHash` exists so two tool calls can be compared for identity without
 * anyone reading their arguments. F3 (identical-call loop) counts repeats of
 * one `toolName + inputHash` within one agent; F4 (churn chain) joins on it.
 * So the only property that matters is: **equal inputs hash equal, different
 * inputs hash different.** It is never shown to a user, never reversed, and
 * carries no security claim — SHA-256 is here because it is the spec's
 * choice and collision-free at this scale, not as a defence against anyone.
 *
 * ## Why sorted keys, and why arrays are NOT sorted
 *
 * `JSON.stringify` preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}`
 * serialise differently while being the same input. Keys are therefore sorted
 * at every depth. Arrays are left in order, deliberately: in a tool input an
 * array's order is meaning (`Edit`'s replacements, a list of paths), so
 * sorting one would make two genuinely different calls collide.
 * `docs/evidence/phase-0-stats/VERDICT.md` DoD 0.6 states the same rule.
 *
 * ## The hash is taken BEFORE truncation
 *
 * This is the whole point of DoD 1.2. `inputPreview` is cut at
 * `agentDeck.previewBytes`; two calls differing only past that cut have
 * identical previews. If the hash were taken from the preview they would look
 * like a loop when they are not. Every call site hashes the structured input
 * the engine parsed, not the string a user will see.
 */

import { createHash } from 'node:crypto';

/**
 * Depth at which {@link canonicalJson} stops descending and emits
 * {@link DEPTH_LIMIT_TOKEN}.
 *
 * Mirrors `redact.ts`'s `MAX_REDACTION_DEPTH`, and exists for the same reason:
 * G3 says never crash on input. A hostile or merely absurd tool input nested
 * thousands deep would otherwise overflow the stack, and this function runs on
 * every tool call in every session. Committed corpora nest nowhere near this,
 * so the bound changes no real hash.
 */
export const MAX_CANONICAL_DEPTH = 64;

/** Emitted in place of anything nested deeper than {@link MAX_CANONICAL_DEPTH}. */
export const DEPTH_LIMIT_TOKEN = '"[agent-deck: depth]"';

/**
 * Deterministic JSON for a parsed value: object keys sorted at every depth,
 * array order preserved.
 *
 * Total by construction. Anything `JSON.stringify` declines to represent —
 * `undefined`, a function, a symbol, `NaN`, `Infinity` — becomes `null`,
 * matching `JSON.stringify`'s own treatment of those values inside an array or
 * object. That collapses a handful of exotic inputs onto one hash, which is
 * correct for a value that cannot survive a JSON round trip anyway: the engines
 * hand us `JSON.parse` output, where none of them can occur.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth >= MAX_CANONICAL_DEPTH) return DEPTH_LIMIT_TOKEN;
  if (value === null || typeof value !== 'object') {
    // `?? 'null'` catches undefined/function/symbol, where stringify returns
    // undefined rather than a string.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k], depth + 1)}`)
    .join(',');
  return `{${body}}`;
}

/**
 * SHA-256, hex, over {@link canonicalJson} of the **untruncated** structured
 * input.
 *
 * A call with no recorded input hashes `null` rather than being left absent, so
 * two inputless calls to the same tool compare equal — which is what F3 means
 * by a repeat.
 */
export function inputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}
