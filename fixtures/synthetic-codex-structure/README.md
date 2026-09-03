# `synthetic-codex-structure` — the Codex fingerprint's mutation corpus

Every file here is a **three- or four-record slice of a real transcript from
`fixtures/codex-0.151.0-alpha.7.2/`, with exactly one thing changed.** Nothing here
was written by hand and nothing here is invented: the bytes are captured bytes, and
the mutation is a `delete` or a single assignment applied to a `JSON.parse` of one
real line. That is the same treatment `fixtures/synthetic-structure-2.1.246/` gives
the Claude Code anchor.

`src/codex/fingerprint.test.ts` is the only reader.

## The four base slices

| base | taken from | records |
|---|---|---|
| **root v2** | `spawn-shapes/…-01a0641d-8281-…jsonl` ordinals 0, 7, 12 | `session_meta` (user) · `turn_context` (`v2`) · `function_call spawn_agent` (`collaboration`) |
| **subagent v2** | `baseline/…-01a063dd-883a-…jsonl` ordinals 0, 1, 6, 20 | `session_meta` (subagent) · `session_meta` (user, inherited across the fork) · `turn_context` (`v2`) · `custom_tool_call exec` |
| **root v1** | `resume-twice-v1/…-01a06420-fabe-…jsonl` ordinals 0, 5, 21 | `session_meta` (user) · `turn_context` (`v1`) · `function_call spawn_agent` (`multi_agent_v1`) |
| **root v1, no spawn** | `long-output/…-01a0641f-c9c0-…jsonl` ordinals 0, 5, 12 | `session_meta` (user) · `turn_context` (`v1`) · `function_call exec_command` |

The last one is the corpus case spec C3a exists for: one thread, no spawn records,
and `multi_agent_version` stated **only** on its `turn_context`. `session_meta` alone
cannot type it.

A slice is not dense in `ordinal` — records between the chosen ones are dropped and
the ordinals of the kept ones are untouched. The fingerprint does not assert
density (there is no `CodexMismatchCode` for it), so that costs nothing here; a
package that later asserts density must not use these files as its input.

## The four unmutated controls

`ok-root-v2`, `ok-subagent-v2`, `ok-root-v1`, `ok-root-v1-no-spawn`.

They exist because **a refusal fixture with no control proves nothing**: without
them, the slicing itself could be what refuses, and every "the guard fired" test
would pass while measuring the wrong cause. The suite asserts each control returns
`ok: true` with its expected dialect.

## Two traps these files are built against

**A refusal fixture whose version quietly becomes acceptable does not fail — it
passes, while testing nothing.** The Claude Code engine's `synthetic-layout/07` and
`08` had to be re-versioned twice for exactly that. So the two halves are kept
apart, deliberately and in both directions:

- every **structural** refusal fixture carries the anchor version `0.151.0-alpha.7.2`
  untouched, so it can only be refused for its structure;
- every **version** fixture is structurally perfect — the only edited bytes are
  inside the `cli_version` string — so it can only be refused for its version.

**`agent_path` is deliberately outside the fingerprint list** (spec C3, user
decision 2026-09-03; `CodexMismatchCode` has no member for it). Two files pin that
as a positive, because an absence nobody asserts is an absence that comes back:
`subagent-agent-path-absent.jsonl` (the key deleted) and
`subagent-agent-path-null.jsonl` (the `v1` present-and-null shape planted on a `v2`
subagent so the field is the only thing under test). **Both must return `ok: true`.**

## Privacy

These carry the same `cwd` and the same rollout paths as the corpus they are sliced
from — `codex-probe/scratch` and `~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl` — and
both are covered by the `codex-probe-scratch-repo` and `codex-rollout-transcript-path`
FOREIGN exemptions in `scripts/privacy-sweep.mjs`, which are keyed by VALUE and not
by path. `base_instructions` is already scrubbed in the corpus and stays scrubbed
here. No new value shape is introduced by any mutation: every mutation deletes a
key, retypes an `ordinal`, or writes a version string or a dialect tag.

## Regenerating

Do not hand-edit. Re-slice from the corpus at the ordinals in the table above and
re-apply the one mutation named by each filename; the mutations are enumerated in
`src/codex/fingerprint.test.ts`, which names every file and the exact
`CodexMismatchCode` it must produce.
