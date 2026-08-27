# Changelog

All notable changes to Agent Deck for Claude Code are documented here.

## 0.1.3 - two things the deck was quietly getting wrong

**One dropped message cost a whole session's tree, and nothing said so.**

Agent Deck sends the panel a full snapshot once and then a stream of small
patches. If the panel ever failed to apply one of those patches - because the
message never arrived, or because it addressed a node the panel did not have -
`0.1.2` threw away **the entire patch**, kept the tree it already had, and told
nobody. Every patch after that was then applied to a tree that no longer matched
the extension's, so it failed too, and was thrown away too. The deck stayed on
screen looking fine and stopped growing.

Measured on a real eight-hour session with two subagents, 107 patches: drop
**one** of them, and `0.1.2` discards 102 of the remaining 106, freezing the tree
four events in. **Zero of 246 tool calls survive to the end.** Not the two the
dropped message carried - all of them. The loss grows the longer the session
runs, which is exactly how it was reported.

Three changes, and the first two are what make it impossible rather than merely
recoverable:

- **Inserts name a sibling, not a position.** A patch used to say "insert this
  as child number 3", which is a statement about the panel's own array. One node
  out of step and every later insert landed in the wrong place. It now says
  "insert this after that node"; if the panel does not have that node it appends
  instead - the wrong ORDER, which the next update corrects, rather than a lost
  node, which nothing corrects.
- **A patch that cannot be fully applied is applied as far as it can be.** The
  parts that fit go in, the parts that do not are reported. A patch that would
  leave a session without a root is still refused outright - that cannot happen
  from a dropped message and means something else is wrong.
- **The panel now tells the extension when it could not keep up**, and gets a
  fresh snapshot back. That message did not exist. The panel had a note in its
  own code saying "the extension owes us a snapshot" and no way to ask for one.

**A diagnostics channel, because there was nothing to look at.** When this was
first reported there was no way to check it: across an eight-hour session the
extension had written two lines to the editor's log, both of them "extension
activated". There is now an **Agent Deck** output channel - one line per session
appearing or leaving, per refusal, per hook-listener error, per patch failure and
per resync, and a counters line every minute. It is created the first time there
is something to say, it never opens itself, and **Agent Deck: Show Diagnostics**
in the Command Palette is the only thing that reveals it. Nothing is sent
anywhere and nothing is written to disk; the read-only, zero-egress posture is
unchanged.

**And the token counts were wrong by three orders of magnitude.**

The deck showed "848 in" for a session Claude Code's own context display put at
roughly 76% of a one-million-token window. The cause is small and total: Agent
Deck read `input_tokens` from each message's usage record, and on a Claude
model with prompt caching that field is **about 2**. The prompt itself is
recorded in two other fields, `cache_creation_input_tokens` and
`cache_read_input_tokens`, and they were not being read. (It is not always 2 —
a session against a local model with no caching puts the whole prompt in
`input_tokens`. All three are added together, so both cases come out right.) On one committed capture a single message reads
`2 + 13,390 + 28,807` - and the deck displayed the 2.

The prompt is now all three added together, and it is reported as **two
different numbers**, because two different questions were being confused:

- **context** - the last message's prompt and output. A level, not a running
  total. This is what fills a context window, and it is what the nodes, the
  cells and the session header now show.
- **burn** - everything spent, summed across every distinct message in the
  session. It only grows. It is in the inspector, labelled, next to the context
  figure for the same node.

**No percentage, and that is deliberate.** A percentage needs a window size, and
no Claude Code transcript states one anywhere - checked across every captured
fixture for any field naming a context limit. Agent Deck could guess one from
the model name; it will not. It shows the number it can read and no number it
cannot.

Nothing else moves in this release. No parser change, no new refusal, no change
to what is read or where - the token fields were always being read, and two of
the three were being ignored.

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
