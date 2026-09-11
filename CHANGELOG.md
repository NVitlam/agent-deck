# Changelog

All notable changes to Agent Deck are documented here.

## 0.7.1 - 2026-09-11 - Claude Code's own telemetry, received on the hook listener

### Added

- **Claude Code's OpenTelemetry export, received — optional, off by default.** The
  hook listener now answers `POST /v1/metrics`, `/v1/logs` and `/v1/traces` on the
  same `127.0.0.1` port as the hooks (`agentDeck.port`), OTLP over HTTP in JSON.
  Nothing is received until `agentDeck.telemetry.enabled` is turned on and Claude
  Code's own `env` settings name that address; the README's "Claude Code telemetry
  (optional)" section has the block to paste. Agent Deck writes none of it.
- **A cost for Claude Code sessions, estimated by Claude Code.** With telemetry on,
  a Claude Code session's cost in the Tokens view is Claude Code's own cost
  metric, summed per session and labelled "estimated by Claude Code", for a
  session whose start the window received (below). Where an engine states a cost,
  that is shown instead; where neither an engine cost nor such a telemetry cost
  exists, a cost from `agentDeck.pricing` is.
- **Tool durations where the session states none**, from Claude Code's tool spans,
  in each session's stats record — the local history and the extension API. The
  Stats view shows no per-tool durations. A duration the session's own records
  state is never replaced.
- **`agentDeck.telemetry.enabled`**, boolean, default `false`, machine-scoped.
  Changes apply to the next request, without a reload.
- **Telemetry figures on the Agent Deck output channel's counters line**, per
  signal: requests accepted, refused by status (`400`, `405`, `413`, `415`),
  refused because the setting is off, and rows still unmatched after the join has
  retried: a tool span whose session or tool call the next update after it arrived
  does not show, or a session's start or cost held for a session not shown yet
  when its slot was pushed out. A row that arrives early and joins a moment later
  is not counted. Each such tool span also writes one line naming its
  `session.id` and `tool_use_id`, and nothing else from the span.

### How it behaves

- **Answers:** `200` accepted, `400` not an OTLP JSON body for that path, `403` the
  setting is off (the body names the setting), `405` not a POST, `413` over the
  hooks' 512 KiB cap, `415` a content type that is not JSON. No answer is
  retryable.
- **Parsed once, where it arrives.** The five account attributes Claude Code
  attaches to every record (`user.email`, `user.id`, `user.account_id`,
  `user.account_uuid`, `organization.id`) and the `prompt`, `response` and
  `user_prompt` fields are dropped there, along with every attribute Agent Deck
  does not read. Other VS Code windows receive the parsed figures by relay, never
  the request body.
- **Content, never activity.** Telemetry never touches the liveness or stall
  clock: it does not make a session live, does not clear a stall, never makes a
  session this window has not seen working count as one to record, and never adds
  a session (a session id that appears only in telemetry adds nothing to the deck).
  For a session already being recorded, a cost change may produce a newer stored
  record and may delay the idle write, like any change to the record.
- **The cost is shown only for a session whose start the window received.**
  Claude Code exports cost as increments and sends one `claude_code.session.count`
  point when a session starts; a telemetry cost is the session's cost only when
  that point arrived, and otherwise it is not shown and the stats record names
  `F9:telemetry-partial` — a session already under way when the window opened or
  the setting was turned on, or across a reload. A session's start and cost that
  arrive before the window shows the session are kept for up to 256 sessions.
- **The deck is unchanged.** The cost reaches the Stats view's Tokens part; the
  session tree and its wire messages carry no telemetry figure.

### Changed

- **The gate's Node is `24.18.1`**, for local runs and CI (`devEngines` and both
  workflows), from `22.23.2`.
- **`SECURITY.md` lists the listener's six paths and the one outbound call site.**
  It said the event path was the only route and that no outbound HTTP client was
  compiled in; both had stopped being true in 0.7.0, when the second-window relay
  arrived. Each property it states about the listener and the bundle now names
  the test that proves it, and the telemetry routes' answers are a table.
- **A GitHub Release carries its version's section of this file as its notes**,
  in place of notes generated from commits. The project page describes the
  Stats view, the local history and the telemetry cost.

## 0.7.0 - 2026-09-10 - a Stats view, a local history, and every window live

### Added

- **A Stats view, and a local history behind it.** Agent Deck now derives facts
  from each session's structure — which files it touched and how, which calls
  it repeated, how its tokens moved — and keeps them in a history on your
  machine. Facts only: counts, ratios and token figures, never message text,
  tool payloads or reasoning, and nothing that says why a number is what it is.
  The README's Stats section defines every term the view uses.

- **Tools that stop making progress are shown as stalled.** A tool call that is
  still running while the session has gone quiet for longer than
  `agentDeck.livenessThresholdMs` (default 120 seconds) is drawn amber, with the
  length of the silence beside it, and the agent holding it carries a count of
  how many of its tools are in that state. It clears the moment anything
  arrives.

  It measures **silence, not duration**: a long tool call that is still
  reporting activity is not stalled, and a short one that has gone quiet is.
  The session's own status is unchanged — a stalled tool does not make a
  session look live.

- **The Stats view** is a third view mode beside the canvas and the list:
  files by read, edit, write and error counts; identical-call loops and churn
  chains, with every call in a chain a link back to the tree; tokens per agent,
  cache ratio and context fill where the engine states them, context-churn and
  compaction markers on a per-turn strip, stalls, and cost with its source
  named beside it — the engine's own figure, or your own prices from
  `agentDeck.pricing`, with the model ids seen listed so they can be copied
  into that setting; and trends over the stored history, one point per
  session. Excluded sessions are counted in the footer with their reason code
  and appear in no table. The engine chips narrow every view exactly as they
  narrow the deck. What each engine can and cannot supply is a table in the
  README.

- **The history stays on your machine.** It is kept in VS Code's own storage
  for this extension, one JSON Lines file per week — never under `~/.claude`,
  `~/.codex`, OpenCode's directories or your workspace — and nothing is ever
  sent anywhere. A record is written when a session ends, or after
  `agentDeck.stats.idleFlushMs` (default one hour) without a change for a
  session that never visibly ends; a session that does more work afterwards is
  written again and the newer record wins. Nothing on disk is ever rewritten.
  Only a session seen doing work while a window is open is recorded: opening a
  window does not write the transcripts already on disk into the history.
  `agentDeck.stats.enabled` turns it off (no file, no directory),
  `agentDeck.stats.retentionDays` (default 90) bounds it, and **Agent Deck:
  Clear Stats History** removes it after a confirmation.

- **Your own prices, for a cost the engine does not report.**
  `agentDeck.pricing` takes USD per million tokens per model id. Agent Deck
  ships no price table and never guesses one; a model with no entry gets no
  figure, and a subscription plan yields no per-token cost.

- **An extension API.** Another extension can read the same records through
  `vscode.extensions.getExtension('nvitlam.agent-deck').exports`: `apiVersion`
  1, `getLiveStats()`, `getStoredStats()` and `onDidUpdateStats`, which fires
  for every record written and at most once every two seconds per session while
  a session changes. It hands out these records and nothing else.

- **An activity-bar entry.** An Agent Deck icon in the activity bar opens a
  sidebar listing the commands: Open Deck, Open Statistics, Show Diagnostics,
  Settings, Clear Stats History. The deck now opens in the first editor group,
  and when more than one group is open the widths are evened.

- **The canvas re-fits itself.** On every event that changes the geometry —
  a node selected, the drawer opened, expanded or closed, an agent grafted,
  removed or parked, the panel resized, a session switch, an engine chip, a
  switch back to the canvas — the tree is fitted to the field again. A manual
  pan or zoom persists until the next such event. Token counters and status
  colours never re-fit. `agentDeck.canvas.autoFit` (default on) turns it off,
  leaving the fit on entry and on Reset view.

- **Stalled `AskUserQuestion` and `ExitPlanMode` calls read "waiting on
  you".** Same amber, same elapsed time, same count on the agent; only the
  word changes, and only for those two documented interactive tools.

- **The tool-call drawer follows the latest call** in whichever direction the
  list grows, and holds still while an entry is expanded.

### Fixed

- **A second VS Code window had no liveness at all.** The hook listener's port
  is fixed — the block you pasted names it — so the first window bound it and
  every later window failed to, and showed a deck with nothing running. A later
  window now finds the first one on that port and follows its event stream,
  keeping only the events for its own sessions; close the first window and the
  others take over. Still one socket, still `127.0.0.1` only, and the stream
  carries only what the hooks already send, after the same redaction the panel
  applies.

- **"+N more characters - expand to see all" on a drawer entry did nothing when
  clicked.** It expands now, and clicking again collapses.

## 0.6.1 - 2026-09-05 - Codex sessions no longer exhaust the extension host

### Fixed

- **A large `~/.codex/sessions` folder could crash the extension host.** Agent
  Deck re-read *every* Codex transcript on the machine, in full, once a second,
  and allocated each file in a single buffer as it went. On a machine with a few
  gigabytes of Codex history that is what it sounds like: an out-of-memory crash
  of the VS Code extension host, taking every extension in the window with it.
  Reported by a user with a 3.11 GB sessions folder and seven host dumps.

  Four things changed, and between them a Codex data root now costs about what
  reading a directory costs:

  - **A transcript is read once.** Byte offsets survive from one poll to the
    next, so a file nothing has appended to is not opened at all — Agent Deck
    looks at its size and moves on.
  - **Very large files are measured, not opened.** A rollout transcript above
    `agentDeck.codex.maxTranscriptBytes` (new, default 64 MiB) is skipped
    without being read, and named on the Agent Deck output channel with its size
    and the limit so you can raise it deliberately if you want to.
  - **Unsupported and unrelated sessions cost 256 KiB.** The version check and
    the "is this session from this workspace?" check now run on the first 256
    KiB of a transcript. A Codex version Agent Deck has not been taught to read,
    or a session belonging to a different project, is dropped there instead of
    after being parsed in full.
  - **Nothing is read in one gulp.** After that first slice, reads are capped at
    4 MiB at a time, so a long session arrives over a few polls rather than in a
    single allocation.

  Sessions render exactly as before: the trees, tool calls, tokens and context
  figures are unchanged, and the pinned Codex fixtures reproduce byte-for-byte.

- **The empty-window message named one engine.** Opening a window with no folder
  said "open a folder to see its Claude Code sessions", in a release that reads
  three engines and to users who may have no Claude Code installed. It no longer
  names an engine, because the thing it describes — no folder open — has nothing
  to do with which engine you use.

### Added

- **`agentDeck.codex.maxTranscriptBytes`** (default `67108864`, 64 MiB). The
  largest Codex transcript Agent Deck will open. A session already being
  followed keeps being followed if it grows past the limit; the limit gates the
  first read of a file, not a tail already in progress.

## 0.6.0 - 2026-09-04 - a third engine, Codex

### Added

- **Codex sessions appear in the deck.** Agent Deck reads the rollout
  transcripts Codex writes under `~/.codex` (or `$CODEX_HOME`) and renders them
  beside your Claude Code and OpenCode sessions: the session tree, subagents and
  their spawn edges, tool calls, tokens and the context window. Read-only, like
  everything else here - no App Server, no socket to Codex, and the files Codex
  keeps its credentials and sandbox secrets in are named in the source as never
  opened.
- **An optional Codex hook block, for live status.** Six events, pasted by you
  into `~/.codex/hooks.json` and trusted by you in Codex itself. Without it a
  Codex session still renders in full; what the hooks add is *live* - which
  agent is running right now and which tool call is in flight. The README
  carries the block and the trust steps, and a test compares the block in the
  README byte-for-byte against the one that produced this release's fixtures,
  so the instructions cannot drift from what was proven to work.
- **Per-engine "hooks silent" warnings.** A Codex card now reports its OWN hook
  tap: if the listener is down, or the paste block was never added or never
  trusted, the card says so and liveness falls back to inference. Previously
  only Claude Code had this, which meant a Codex user with no hooks saw a deck
  that simply never went live, with nothing to act on. OpenCode has no hook tap
  at all and is deliberately never given this warning.
- **The extension is now named "Agent Deck — Watch Your Agents Work."** It read
  "Agent Deck for Claude Code", which named one of the three engines it
  observes. The Marketplace ID is unchanged, so this is a rename on the listing
  page and nowhere else - your installed extension updates in place.
- **A project page**, published from `site/` to GitHub Pages.

### Fixed

- **The empty deck no longer names an engine.** With no sessions to show it read
  "Waiting for a Claude Code session…" — on every install, whichever engines you
  actually run, because the panel never told the deck which engines it was
  observing and the deck fell back to naming Claude Code. It now reads "Waiting
  for a session to start." Copy that really is about one engine is unchanged:
  the filter chips still say Claude Code, OpenCode and Codex, and a card still
  carries its own engine's tag.
- **A session that starts with a slash command is named after the command.** It
  used to be named after the markup Claude Code writes around it, so a session
  begun with `/phase` showed
  `<command-message>phase</command-message> <command-name>/phase</command-name>`
  on its deck card and at the root of its tree. It now reads `/phase`, with any
  arguments appended - `/phase 3`, and no `<command-...>` tag survives into a
  label. A message that merely mentions such a tag is left alone: those are your
  words, and a label is supposed to show them.
- **"Hooks silent" is only ever said about Claude Code.** That warning counts
  Claude Code hook events, and when none had arrived it was written onto every
  card in the deck, labelled with that card's own engine - so a Codex card said
  Codex hooks were silent while they were arriving and being read, and an
  OpenCode card said the hook listener was down when OpenCode never uses it.
  The per-card warning is now shown on Claude Code cards only.

  Two things it is worth being exact about. A quiet Claude Code tap is still
  announced in the panel-wide banner - but only while the Claude Code half is
  actually running; see the next entry. And the hook listener is shared - if it
  is down, Codex liveness really is affected too.

  An earlier draft of this entry ended "per-engine liveness warnings do not
  exist yet; the banner is the only channel." That was true when the fix landed
  and is not true of this release: they exist now, and a Codex card reports its
  own tap. See **Per-engine "hooks silent" warnings** above. The sentence is
  corrected here rather than deleted because the two entries are about the same
  defect - the first stopped the panel saying something false about Codex, and
  the second gave Codex something true to say.
- **Codex liveness works in a workspace where Claude Code has never run.** The
  loopback hook listener is shared by both engines, and it was only ever started
  when the open folder matched a Claude Code project. Open a folder that Claude
  Code has never touched and the listener was never started at all: Codex hook
  events had nowhere to arrive, so Codex sessions showed no live status and no
  in-flight tool calls, silently. If the folder also had no OpenCode database,
  the extension did not start at all.

  The listener now starts whenever anything that uses it is present - a Claude
  Code project for this folder, or a Codex installation on the machine. If
  neither is there it is deliberately not started, and the Output channel says
  so once. A port already in use is still reported as an error and the port is
  never silently changed: the port is a setting, and a listener that quietly
  moved would be a recorder that quietly recorded nothing.
- **The Output channel names the right engine when a session goes away.** Every
  "session removed" line said `cc`, whichever engine the session belonged to,
  because the engine was discarded before the removal was noticed. Diagnostics
  only - it never reached the deck - but a log that misreports which engine did
  what is worse than no log.
- **No empty column in the deck when you run Claude Code and Codex but not
  OpenCode.** Lanes were positioned by a fixed slot per engine, so the middle
  slot stayed empty and the two populated lanes sat either side of a gap. Lanes
  are now packed against the engines actually present.
- **The context-window figure survives a turn that recorded no usage.** Codex
  states the window in two places and Agent Deck read only one of them, so a
  session whose turn ended before any token usage existed - an interrupted turn,
  or one that hit an account limit - showed an em dash for a number the
  transcript states plainly. Context and burn still show an em dash there, which
  is correct: those figures genuinely do not exist yet.

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
  it. The report behind this was a session-by-session field comparison of a
  `2.1.251` capture against the anchor, and it found no difference at all.

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
