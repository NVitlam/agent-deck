# Changelog

All notable changes to Agent Deck for Claude Code are documented here.

## 0.5.0 - 2026-08-30 - a second engine, a real tree, and the numbers that were wrong

**Agent Deck now watches OpenCode sessions as well as Claude Code ones**, renders
a session's topology as a tree rather than a cloud of blobs, and reports token
figures that are right. The version jump from `0.1.2` is honest: two observation
engines and a new renderer are not a patch.

### It observes OpenCode too

OpenCode sessions appear in the same deck, tagged `OC`, beside Claude Code's
`CC`. The engine chips at the top left filter to one engine or show both.

The posture is exactly the one Claude Code gets, and in one respect it is
stricter:

- **Read-only.** One file is read - the SQLite database at
  `%USERPROFILE%\.local\share\opencode\opencode.db`. Nothing under OpenCode's
  data or config directories is ever written, created or deleted.
- **Zero sockets.** The Claude Code side has exactly one, the loopback hook
  listener you install yourself. The OpenCode side has **none at all**: it reads
  the database and nothing else. No port, no localhost, no `opencode serve`.
- **Four tables are never read**, by name: `account`, `control_account`,
  `credential` and `session_share`. Those are the ones whose schema carries
  access tokens, refresh tokens and share secrets. Not "filtered out" - not
  queried. They are also excluded from every test fixture in this repository.

If OpenCode is not installed, the deck says nothing about it. An absent data
directory is not an error and is not a warning.

### A tree instead of a cloud

The session view is rebuilt. What is on screen is now the shape of the run:

- **A tidy tree.** Every agent is a node, children sit under their parent in
  **spawn order**, and the layout is a pure function of the session - the same
  session always draws the same way.
- **Filaments** connect a parent to each agent it spawned, leaving the parent's
  bottom edge and arriving at the child's top edge. Every spawn draws, always.
- **No tool dots.** An earlier build rode a row of dots on each node, one per
  tool call, capped at 24. The row never fitted the box it sat under, and worse,
  a filament was anchored on the *spawning dot* - so on a node whose calls had
  been capped away, the connection to its own subagents was simply not drawn.
  Measured on a real 15-subagent session: 0 of 15 filaments drawable. The row is
  gone. The node already carries `{calls} calls`, and the drawer lists every
  call with its status and the child it spawned.
- **Wide ranks wrap.** More than 8 children lay out in rows of 8 on a shared
  column grid, so a broad session frames on screen instead of running off it.
- **Labels wrap; nothing is elided.** No `…` on any surface. A node label takes
  up to two rows, breaking on whitespace or after a hyphen, the box grows
  downward to fit, and every node, card and header carries its whole label on
  hover.
- **A parked rail** for anything that could not be attached to a parent, each
  item carrying the stable code saying why. Data the deck cannot place is shown
  as unplaced, never guessed into position.
- **Focus.** Click into any agent and the tree re-roots on it; the breadcrumb
  walks back out.
- **One viewport.** Pan and zoom behave identically in the deck, the tree and
  the focus view, because all three now use the same module. Entering a session
  fits the tree to the panel, and **Reset view** re-roots and fits rather than
  returning to an origin that could leave the root off-screen.
- **The inspector is a drawer along the bottom**, the width of the panel, with
  the call list on the left and the detail pane growing beside it. Calls can be
  read oldest-first or newest-first, and an oldest-first list follows new calls
  as they arrive until you open one or scroll away.
- **Cell dragging is gone.** It moved cells without meaning anything, and a
  layout that a user can nudge is a layout that cannot be trusted to show spawn
  order. Removed by design, not deferred.

Three deck layouts (List, Grid, Lanes) and three sort orders (Live first,
Recent, Engine). Keyboard: `A C O` for engines, `1 2 3` for layout, `L R E` for
sort. None of it is persisted - close the panel and it is the default again.

### One dropped message no longer costs a whole session

*Prepared as `0.1.3`, which was never published; it ships here.*

Agent Deck sends the panel a full snapshot once and then a stream of small
patches. If the panel ever failed to apply one - because the message never
arrived, or because it addressed a node the panel did not have - `0.1.2` threw
away **the entire patch**, kept the tree it already had, and told nobody. Every
later patch was then applied to a tree that no longer matched, so it failed too.
The deck stayed on screen looking fine and stopped growing.

Measured on a real eight-hour session with two subagents, 107 patches: drop
**one**, and `0.1.2` discards 102 of the remaining 106, freezing the tree four
events in. **Zero of 246 tool calls survive to the end.**

- **Inserts name a sibling, not a position.** A patch used to say "insert this as
  child number 3", which is a statement about the panel's own array. It now says
  "insert this after that node"; if the panel does not have that node it appends
  instead - the wrong order, which the next update corrects, rather than a lost
  node, which nothing corrects.
- **A patch that cannot be fully applied is applied as far as it can be**, and
  the parts that do not fit are reported.
- **The panel can now ask for a fresh snapshot** when it knows it has fallen
  behind. That message did not exist.

### The token counts were wrong by three orders of magnitude

*Also prepared as `0.1.3`.*

The deck showed "848 in" for a session Claude Code's own context display put at
roughly 76% of a one-million-token window. Agent Deck read `input_tokens` from
each message's usage record, and on a Claude model with prompt caching that
field is **about 2**; the prompt itself lives in `cache_creation_input_tokens`
and `cache_read_input_tokens`, and neither was being read. All three are now
summed, which is also right for a local model with no caching, where the whole
prompt does sit in `input_tokens`.

Two different quantities are now reported separately, because they answer
different questions:

- **context** - the last message's prompt. A level. It goes up and down.
- **burn** - the running total across the session. It only goes up.

There is no percentage, because no transcript states the model's window size and
guessing one from the model name would be memory rather than measurement.

**For OpenCode sessions, context reads as an em dash.** OpenCode's stored totals
count only uncached input - measured across two captured corpora, cached prompt
tokens run 7x to 12x the uncached ones - so mapping them to `context` would have
recreated exactly the defect above through the other engine. An honest absence is
shown instead of a wrong number, and never a `0`.

### A diagnostics channel

*Also prepared as `0.1.3`.* Across an eight-hour session the extension had
written two lines to the editor's log, both of them "extension activated". There
is now an **Agent Deck** output channel - one line per session appearing or
leaving, per refusal, per hook-listener error, per patch failure and per resync,
and a counters line every minute. It is created the first time there is something
to say, it never opens itself, and **Agent Deck: Show Diagnostics** in the
Command Palette is the only thing that reveals it. Nothing is sent anywhere and
nothing is written to disk.

### Fixed

- **An OpenCode workspace that moved showed nothing.** The project key came from
  `project.worktree`, and OpenCode keeps one project row per repository and never
  rewrites that column when the directory moves. So every session of a moved
  workspace - including sessions run at the *new* path - resolved to the old one,
  matched no open folder, and the deck rendered nothing at all: absent rather than
  refused, which looks exactly like an engine that does not work. The key now comes
  from `session.directory`, which OpenCode does keep current, falling back to
  `project.worktree` and never guessing. Neither committed corpus could have caught
  it - in both, those two columns hold the same string - so a corpus was captured
  for it and no golden byte moved.
- **A refused session said so without saying why.** A graft that *threw* recorded
  its message; a graft that *refused* - the ordinary, designed outcome - recorded a
  bare count. The diagnostics channel now writes one line per refusal naming the
  code, the file and line, the field, and what was expected against what was found.
  Every field is a name, a type, a version or a line number: no value out of a
  transcript reaches the channel, and the absolute path is reduced to a file name.
- **A session imported from another machine is now documented as unsupported.**
  Claude Code's `--teleport` writes the imported history into the local transcript
  with a version the compatibility window does not accept, so the whole session
  renders `unsupported`. That was already the behaviour; it was not written down.

- **An OpenCode session now reports its token burn.** It read as an em dash, and the README said
  otherwise. The figure counts the whole prompt — cached tokens included, which is most of it on a
  long session — rather than the uncached input alone that would have understated it roughly
  sevenfold. **Context** still reads as an em dash for OpenCode: that number is a level rather than
  a total and needs per-step data Agent Deck does not read yet.

### Compatibility

- **Claude Code `2.1.251` joins the test corpus.** It was reported as refusing
  every session. It does not: the version window accepts it, and a field-level
  comparison against the anchor found no structural drift - the entry fields, the
  subagent directory convention and the sidecar join keys are unchanged. The
  corpus is a witness, not a new anchor: `PINNED_CC_VERSION` stays at `2.1.246`,
  because moving it cannot make a version work and only a fresh harvest may move
  it. Diagnosis: `docs/evidence/release-0.5.0/DRIFT-2.1.251.md`.

### Note on `0.1.3`

**This release supersedes the unreleased `0.1.3`.**

`0.1.3` was built, verified by side-load, and **never published**. Its two fixes
are the two above and they reach you here. There is no `0.1.3` on the
Marketplace and there will not be one; `0.1.2` is the version this release
follows.

If you are reading the repository rather than the Marketplace: the `hotfix/0.1.3`
branch is kept, not merged and not deleted. Both of its fixes are present on this
release line already - established by looking for the identifiers on both
branches rather than by reading the merge graph - so merging it would add nothing
and deleting it would discard the reference for a build somebody signed off by
running it.

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
