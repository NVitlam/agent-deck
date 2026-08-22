# Changelog

All notable changes to Agent Deck for Claude Code are documented here.

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
