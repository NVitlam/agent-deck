/**
 * Agent Deck — the OpenCode project key (PLAN.md Phase 4,
 * `Amendment 2026-08-27` A1).
 *
 * `SessionState.projectSlug` means **"the project key"** for both engines, so
 * one workspace observed by two engines carries one key. The OpenCode value is
 * the slug derived from `project.worktree` by the same rule Claude Code uses to
 * name its `~/.claude/projects/<slug>` directory.
 *
 * That rule is {@link slugifyWorkspace} in `src/parser/tailer.ts` — strip
 * trailing separators, then `[:\\/]` -> `-` — and it is IMPORTED here rather
 * than restated. Two agreeing literals is not a contract; the recorded lesson
 * is that a module-boundary partition produces silent seams, not crashes.
 * `slugifyWorkspace` is not changed by this file and must not be:
 * `fixtures/synthetic-path-matrix/slug-cases.json` row `windows-drive-upper`
 * pins its current output and `src/model/pathmatrix.test.ts` asserts it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE DELTA: THE DRIVE LETTER
 * ---------------------------------------------------------------------------
 *
 * Measured. Both sides are read OFF DISK by `slug.test.ts` — the `worktree`
 * column of a committed corpus on one side, the name of the one slug directory
 * under `fixtures/cc-2.1.246/projects/` on the other — so neither is quoted
 * here. The shape of the finding, with the real path stood in for:
 *
 *   project.worktree (opencode.db)   C:/ws/Some-Project
 *   CC slug directory                c--ws-Some-Project
 *
 * Exactly one character differs, and every other component keeps its case. So
 * this function is CC's encoding plus a lower-cased drive letter, **and nothing
 * else lower-cased**.
 *
 * The worked example is deliberately synthetic. An earlier draft spelled the
 * capturing machine's real path out here and the privacy sweep flagged nine
 * developer-identifier hits in this file — `src/` is deliberately in the
 * sweep's scope, unlike `fixtures/`, where such paths are load-bearing. The
 * evidence lives in the test, which reads it; prose does not need it.
 *
 * **The honest caveat.** Whether CC *itself* lower-cases the drive letter is
 * NOT established by this evidence: `fixtures/cc-2.1.246`'s own transcript
 * carries a `cwd` whose drive letter is UPPER-case while its slug directory's
 * is lower-case, and NTFS preserves the case a directory was *created* with,
 * so the lower-case spelling may date from an earlier session rather than from
 * a rule. Both spellings occur in real data. What is pinned here is a
 * **canonical form for Agent Deck's project key** that agrees byte-for-byte
 * with the one CC directory this repo has captured — not a claim about CC's
 * internals. Every slug COMPARISON elsewhere stays case-insensitive
 * (`normalizeSlug`, `workspaceMatch`), so the canonicalisation cannot be
 * load-bearing for matching; it only decides how the key is spelled.
 */

import { slugifyWorkspace } from '../parser/tailer.js';

/**
 * A Windows drive prefix, and only that: a single ASCII letter followed by a
 * colon at the very start of the path.
 *
 * Deliberately anchored, because the lower-casing must not reach anything else.
 * A WSL mount such as `/mnt/C/ws` has a `C` that is a directory name, not a
 * drive prefix — `slug-cases.json` row `wsl-mount-uppercase-drive` keeps its
 * upper-case `C`, and `slug.test.ts` asserts that it still does.
 */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * The project key for an OpenCode `project.worktree` path.
 *
 * Identical to {@link slugifyWorkspace} except that a Windows drive letter is
 * lower-cased. Pure, and total: any string in, a slug out, no filesystem access
 * and nothing that can throw.
 */
export function slugFromWorktree(worktreePath: string): string {
  const slug = slugifyWorkspace(worktreePath);
  if (!DRIVE_PREFIX.test(worktreePath)) return slug;
  // The drive letter is the FIRST character of the slug, because the colon
  // that follows it is the first character the substitution touches.
  return slug.charAt(0).toLowerCase() + slug.slice(1);
}
