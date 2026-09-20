/**
 * The `Skill` call's one named input key — v0.9.0 DoD 9.3.
 *
 * ## Why this is not in `toolclass.ts`
 *
 * `toolclass.ts` is GENERATED from the Phase 0 census (`scripts/gen-toolclass.mjs`)
 * and carries a digest over its rows, so a hand-added function there is lost the
 * next time it is regenerated. The census answers two questions — what a tool
 * DOES and which key holds the file it touches — and a skill name is neither. So
 * the key lives here, by hand, and `skills.test.ts` BINDS this module to the
 * census instead of letting the two drift: it asserts that the census still
 * carries `Skill` for `cc`, still says its input is an object, and still gives it
 * no `fileKey`. If any of those moves, this module's premise moved with it.
 *
 * ## The rule is the `filePath` rule
 *
 * ONE named key off the structured input. No regex over any value, no scan for
 * name-shaped strings, no reading of any other key. Layer 1 reads structure,
 * never text.
 *
 * ## `args` is prose and is never read
 *
 * A real `Skill` input, from `fixtures/cc-2.1.260`:
 *
 *     {"skill":"handoff","args":"Phase 1 (v0.6.0) - Spec amendment, contract v2,
 *      Codex fixture harvest. NOT CLOSED: blocked on the Codex account usage
 *      limit ..."}
 *
 * The `args` half is the user's own prose about their own work — the single most
 * content-shaped string on a `Skill` call, and the exact class G4 exists to keep
 * out of the record. It is never read here, and `skills.test.ts` holds its
 * literal captured bytes against every derived record.
 */

import type { ToolEngine } from './toolclass.js';

/**
 * The tool, and the engine whose vocabulary names it.
 *
 * Claude Code only, and that is measured rather than a limitation: no committed
 * OpenCode or Codex corpus carries a skill-invoking tool, and inventing a name
 * for one would be memory rather than fixture (G6).
 */
export const SKILL_TOOL = 'Skill';

/** The engine whose `Skill` tool this module reads. */
export const SKILL_ENGINE: ToolEngine = 'cc';

/**
 * The key holding the invoked skill's name.
 *
 * Census-observed across all five `Skill` calls in `fixtures/cc-2.1.260`; the
 * only other key those inputs carry is `args`, which is prose.
 */
export const SKILL_NAME_KEY = 'skill';

/**
 * The invoked skill's name, or `undefined`.
 *
 * `undefined` for every tool that is not the `Skill` tool, for any engine other
 * than the one that has it, for an unstructured input, and for an input whose
 * `skill` key holds anything but a non-empty string. Those are defined answers,
 * not fallbacks: a call that states no name has none, and a substitute would be
 * a value this repository made up.
 */
export function skillNameOf(engine: ToolEngine, tool: string, input: unknown): string | undefined {
  if (engine !== SKILL_ENGINE || tool !== SKILL_TOOL) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[SKILL_NAME_KEY];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
