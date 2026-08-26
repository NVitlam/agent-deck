# Changelog

All notable changes to Agent Deck for Claude Code are documented here.

## 0.1.2 - compatibility fix

**Every Claude Code session written from 2026-08-24 onward rendered
`unsupported`, on every machine.** Not some sessions, and nothing to do with
which model was answering: 0.1.1 accepted a version string within five patch
releases of `2.1.234`, so the accepted range stopped at `2.1.239`. Claude Code
shipped `2.1.240` and kept going. By 2026-08-26 it was on `2.1.246` and the
extension had been dark for two days. The refusal was the schema fingerprint
doing exactly what it is built to do, on the wrong signal.

**The patch component is no longer compared at all.** A transcript is read when
its major version matches the anchor's and its minor is within one - `2.0.x`
through `2.2.x`, with whatever patch number Claude Code ships next. What refuses
a session now is its **structure**: a required field missing or wrong-typed, a
subagent sidecar without the `toolUseId` join key, the subagent directory
convention moving. Those are the changes that would make the rendered tree
wrong, and they are the ones worth refusing on. Every refusal code, and the
`unsupported` state itself, is unchanged.

`PINNED_CC_VERSION` moves to `2.1.246` and now means something narrower than it
used to: it is a **provenance** anchor, naming the release whose captured
fixture proved the structure the parser asserts. It moves only when a new
fixture is harvested. It is not a support claim and moving it does not make a
version work.

Two fixtures were captured before the code changed, because a compatibility
claim with no bytes behind it is not a claim:

- `fixtures/cc-2.1.246/` - a live mirror-pair session on this repository at
  `2.1.246`, carrying one subagent and its join sidecar. This is the anchor.
- `fixtures/cc-2.1.241/` - a real session run against a local `local-model` model,
  which had been refused for its version string alone. It reads in full: 121
  lines, 0 malformed, an unrecognised record type counted and skipped, an
  unrecognised file in the session directory ignored.

A third, `fixtures/synthetic-structure-2.1.246/`, is the anchor's own head slice
with one required key renamed. It carries the anchor version exactly and is
still refused, which is the demonstration that the structure is what bites.

No behaviour outside the version check changed, and no manifest key other than
the version number moved.

## 0.1.1

Documentation: usage walkthrough and panel-opening instructions; corrected
minimum VS Code version.

## 0.1.0

Initial release.

- **Live session deck.** Every Claude Code session on the machine, rendered as a
  deck of blobs that breathe while work is in flight and settle when it stops.
  Pan and zoom, filter by liveness, and open any session to walk inside it.
- **Agent topology with primary-key joins.** A session interior draws the main
  agent as a nucleus, its tool calls as chronological dot arcs, and each
  subagent as a cell attached by a filament to the exact `tool_use` block that
  spawned it. The attribution is a keyed join on the sidecar's `toolUseId`, not
  a heuristic - measured at 27 of 27 resolved, 0 ambiguous, across four sessions
  and three Claude Code versions. Nested subagents are supported.
- **Tool call inspector.** Open any node for its payload. Thinking blocks are
  dropped at the parse boundary, payloads are truncated with an explicit marker
  stating kept and original bytes, and large payloads offloaded by Claude Code
  to `tool-results/` are followed rather than silently missed.
- **Token and cost tracking.** Per-session and per-agent token totals and cost,
  accumulated from the transcript as it is written.
- **Hook-driven liveness.** A loopback HTTP listener on `127.0.0.1:47821`
  receives Claude Code hook events and answers "what is running right now".
  Liveness and content come from two independent sources on purpose, so a
  parsing failure degrades the tree without taking liveness down with it.
- **Explicit refusal instead of guessing.** Session content is pinned to a
  schema fingerprint. A Claude Code version outside the accepted window renders
  an explicit `unsupported` state rather than a partial or wrong tree.
  Malformed lines increment a counter and are skipped.
- **Read-only and egress-free.** No writes to `~/.claude`, to Claude Code
  settings or to session files. No network access beyond the loopback listener.
  No telemetry. All state is in memory and is discarded on window close.
