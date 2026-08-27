# Agent Deck

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/nvitlam.agent-deck?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=nvitlam.agent-deck)

A **read-only** VS Code extension that renders live Claude Code session topology — subagent trees,
in-flight tool calls, token and cost totals — by observing Claude Code's exhaust. It never wraps,
proxies, launches, or configures Claude Code.

> **Claude Code compatibility** — anchor `2.1.246`, accepts `2.0.x` to `2.2.x`, refuses on
> structural change, not on patch number. See [Claude Code version window](#claude-code-version-window).
>
> This badge is text, not a remote image: a project whose selling point is zero egress should not
> make its own README phone home to a badge service to render.

---

![Agent Deck](media/screenshot-deck.png)

## Read-only by design

Agent Deck observes. It never acts.

- It reads Claude Code's session JSONL and listens for hook events. That is all.
- It never wraps, proxies, launches or configures Claude Code.
- It never writes to `~/.claude`, to Claude Code settings, or to your session
  files. Installing the hooks is a manual paste block you control, below.
- Zero network egress. The only socket it opens is an HTTP listener bound to
  `127.0.0.1`, which is how the hooks reach it. Non-loopback requests are
  dropped.
- No telemetry, no analytics, no CDN. Every asset the panel renders is local,
  enforced by a strict Content-Security-Policy.

All state lives in memory and is discarded when the window closes.

## Features

**The deck** - every live session at a glance, breathing while it works.

![The deck](media/screenshot-deck.png)

**Agent topology** - the main agent as a nucleus, tool calls as chronological
dots, and subagents joined by filaments to the exact `tool_use` block that
spawned them. That join is a primary key, not a guess.

![Agent topology](media/screenshot-topology.png)

**Tool call inspector** - open any node for its payload, truncated with an
explicit marker and with thinking blocks dropped at the parse boundary.

![Tool call inspector](media/screenshot-inspector.png)

## What it is

Claude Code leaves two kinds of exhaust behind, and Agent Deck reads both without touching either:

| Tap | Source | What it answers |
| --- | --- | --- |
| **Hooks** | a hook snippet *you* paste into your settings POSTs to a loopback HTTP listener | what is running right now |
| **JSONL** | `~/.claude/projects/<slug>/...`, read from local disk | what happened |

The split is deliberate. The hook contract is documented and stable with thin payloads; the session
files are undocumented and rich. Keeping them on separate failure paths means a Claude Code schema
change degrades the panel instead of killing it.

Everything the extension knows lives in memory in the extension host and is discarded when the
window closes. There is no database, no cache file, and nothing is ever written back to Claude Code.

## Requirements

- **VS Code** `^1.75.0`
- **Node** `>=20` on your `PATH` — the hook block below is a `node -e` one-liner, so your Node is
  what runs it
- **Claude Code** on the `2.x` line, within one minor of the anchor (see below). Patch releases are
  read as they come.

## Install

Install from the VS Code Marketplace - open the **Extensions** view and search for
**Agent Deck**, or run:

```console
code --install-extension nvitlam.agent-deck
```

**Then install the hook block below.** It is not optional: without it Agent Deck can still read
session transcripts, but nothing tells it what is running right now, so liveness is inferred from
file mtime alone.

## Install the hook (one manual paste)

Content and the tree render from the session files alone. The hook tap is what makes liveness
*live* — which agent is running right now, which tool call is in flight.

**Agent Deck never installs this for you and never writes either settings file.** Read-only means
read-only, including your configuration. You paste it; you own it.

Paste the `"hooks"` key below into **one** of:

- your project's own `.claude/settings.local.json` — what this repository does, and the choice that
  keeps `~/.claude` untouched entirely; or
- your user-level `~/.claude/settings.json`, if you would rather have it everywhere.

Both files are JSON objects. Merge the `"hooks"` key into whatever is already there rather than
replacing the file.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"let b='';process.stdin.setEncoding('utf8');process.stdin.on('error',()=>process.exit(0));process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const r=require('http').request({host:'127.0.0.1',port:47821,path:'/event',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(b),connection:'close'}},s=>{s.resume();s.on('end',()=>process.exit(0))});r.on('error',()=>process.exit(0));r.setTimeout(1000,()=>{r.destroy();process.exit(0)});r.end(b)});setTimeout(()=>process.exit(0),2000)\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"let b='';process.stdin.setEncoding('utf8');process.stdin.on('error',()=>process.exit(0));process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const r=require('http').request({host:'127.0.0.1',port:47821,path:'/event',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(b),connection:'close'}},s=>{s.resume();s.on('end',()=>process.exit(0))});r.on('error',()=>process.exit(0));r.setTimeout(1000,()=>{r.destroy();process.exit(0)});r.end(b)});setTimeout(()=>process.exit(0),2000)\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"let b='';process.stdin.setEncoding('utf8');process.stdin.on('error',()=>process.exit(0));process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const r=require('http').request({host:'127.0.0.1',port:47821,path:'/event',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(b),connection:'close'}},s=>{s.resume();s.on('end',()=>process.exit(0))});r.on('error',()=>process.exit(0));r.setTimeout(1000,()=>{r.destroy();process.exit(0)});r.end(b)});setTimeout(()=>process.exit(0),2000)\"",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"let b='';process.stdin.setEncoding('utf8');process.stdin.on('error',()=>process.exit(0));process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const r=require('http').request({host:'127.0.0.1',port:47821,path:'/event',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(b),connection:'close'}},s=>{s.resume();s.on('end',()=>process.exit(0))});r.on('error',()=>process.exit(0));r.setTimeout(1000,()=>{r.destroy();process.exit(0)});r.end(b)});setTimeout(()=>process.exit(0),2000)\"",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"let b='';process.stdin.setEncoding('utf8');process.stdin.on('error',()=>process.exit(0));process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const r=require('http').request({host:'127.0.0.1',port:47821,path:'/event',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(b),connection:'close'}},s=>{s.resume();s.on('end',()=>process.exit(0))});r.on('error',()=>process.exit(0));r.setTimeout(1000,()=>{r.destroy();process.exit(0)});r.end(b)});setTimeout(()=>process.exit(0),2000)\"",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"let b='';process.stdin.setEncoding('utf8');process.stdin.on('error',()=>process.exit(0));process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const r=require('http').request({host:'127.0.0.1',port:47821,path:'/event',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(b),connection:'close'}},s=>{s.resume();s.on('end',()=>process.exit(0))});r.on('error',()=>process.exit(0));r.setTimeout(1000,()=>{r.destroy();process.exit(0)});r.end(b)});setTimeout(()=>process.exit(0),2000)\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Notes on that block, each of them measured rather than assumed:

- **It is `node -e`, not `curl`, and that is not a style choice.** This command runs inside your real
  Claude Code session on every tool call. Against a closed loopback port — which is what it finds
  whenever Agent Deck is not running — `node` takes `ECONNREFUSED` and exits `0` in well under a
  fifth of a second, while `curl.exe` burns its full connect timeout (measured between 1.1 s and
  2.1 s, exiting non-zero) and stalls your session that long every single time. Simplifying it to
  `curl` costs you roughly an order of magnitude, forever, on the common path. `SECURITY.md` §5
  carries the numbers.
- **The port must match `agentDeck.port`.** The block names `47821` literally, which is that
  setting's default. If you change one, change the other: Agent Deck reports a port collision as an
  error and never silently picks a different port, because the block you pasted has no way of being
  told.
- **No Claude Code restart is needed.** Hook settings are re-read per invocation — registering a new
  event and seeing it arrive without a restart was measured on `2.1.234`.
- **The POST is unconditional.** With nothing listening it is refused and nothing happens. A quiet
  listener is not evidence that hooks stopped firing.
- **Six events are registered:** `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart`,
  `SubagentStop`, `Stop`. Registering fewer still works — liveness degrades rather than fails, and
  falls back to transcript modification times with a banner — but the panel gets blunter.

## Open the panel

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on
macOS), type `Agent Deck`, and run **Agent Deck: Open Session Deck**.

That is the **only** entry point. Agent Deck contributes no sidebar icon, no status-bar item and no
activity-bar view - one command, one panel.

Open the folder your Claude Code session runs in first. The extension matches the open workspace
against your `~/.claude/projects` directories; if that folder has no Claude Code sessions it says so
and does nothing else.

## Usage

Three levels, and Escape walks back up out of any of them.

**Deck** - every Claude Code session on the machine, one blob each. The chip row filters by
liveness: **all**, **live**, **idle**, **ended**, **refused**. Colour is the same channel
everywhere - green live, yellow idle, grey ended, red refused - and the legend at the bottom of the
panel restates it. Drag to pan, wheel to zoom, click a session to go inside it.

**Topology** - the session interior. The main agent is the nucleus, each tool call is a dot placed
in chronological order around it, and a subagent hangs off a filament drawn from the exact tool-call
dot that spawned it. Click any node to open it in the inspector. The **Deck** breadcrumb returns to
the deck, and **Reset view** re-centres pan and zoom without changing anything else.

**Inspector** - the detail pane for whatever is selected. Per agent it lists status
(**running**, **done**, **error**), **tokens** as *in ctx / out* and **burn** as *in / out*,
duration and spawn depth, with the tool payload beneath it. The two token rows answer different
questions: *tokens* is the last message's own prompt and output, which is what fills a context
window, and *burn* is everything the agent has spent, which only grows. No percentage is shown,
because no transcript states a window size and Agent Deck does not guess one from the model name. **Show details** / **Hide details** collapses the payload, **Close** dismisses
the pane.

## Settings

| Setting | What it does |
| --- | --- |
| `agentDeck.port` | The loopback port the hook listener binds on `127.0.0.1`. Must match the port in the block you pasted. |
| `agentDeck.livenessThresholdMs` | How long a session may go quiet before it stops counting as live. Set it too low and one long tool call makes a healthy session flap. |
| `agentDeck.previewBytes` | Ceiling on tool-payload bytes kept per node for previews. Nothing is ever sent off the machine either way. |

## Privacy

`SECURITY.md` ships inside the VSIX alongside this file and carries the enforcement detail and the
measurements. The short version:

- **Zero egress.** The only socket is the inbound loopback hook listener, bound to the literal
  `127.0.0.1`. There is no outbound HTTP client compiled into the shipped bundle at all, and a test
  fails if that changes. POSTs from a non-loopback origin are dropped on the strength of the
  socket's own remote address — proxy headers are attacker-controlled strings and are never
  consulted for that decision.
- **No persistence, no telemetry.** All state is in memory in the extension host and is discarded
  when the window closes. No database, no cache file, no analytics of any kind.
- **Redaction at the parse boundary.** Thinking blocks are dropped, and the `signature` field is
  dropped with them — Claude Code writes thinking blocks with an empty text string and the bytes in
  `signature`, so dropping only the visible text would be doing nothing. Tool payloads are truncated
  with a marker, including the large ones Claude Code offloads to `tool-results/*.txt`.
- **The webview has no filesystem and no network access**, enforced by a strict Content Security
  Policy. It receives snapshot and diff messages and sends back UI intents; that is the whole
  channel.
- **Stated plainly:** any process running as you can POST to the loopback port and inject fabricated
  liveness events. There is no authentication, because the only way to add one would be a shared
  secret carried in the snippet you pasted. What an injected event buys is a wrong picture in a
  read-only panel: nothing is executed, nothing is written, nothing leaves the machine.

## Claude Code version window

`src/parser/fingerprint.ts` is the authority for this, and the numbers have exactly one home there:
`PINNED_CC_VERSION` is the anchor and `VERSION_WINDOW` is the allowance.

- **Anchor `2.1.246`** — the version the committed fixtures were captured from. It is a
  **provenance** anchor rather than a support claim: it names the release whose structure was proved
  against real bytes, and it moves only when a new fixture is harvested.
- **Accepted `2.0.x` to `2.2.x`** — major exact, minor +/-1. **The patch component is not compared
  at all.** Whatever Claude Code ships next on this line is read.
- **What refuses instead is the structure** — a required field missing or wrong-typed, a subagent
  sidecar without its join key, the subagent directory convention moving. Those are the changes that
  would make the rendered tree wrong, and they are the ones worth refusing on.
- Out-of-range, malformed and unreadable versions are still refused: the session renders
  `unsupported`, never a partial tree.
- A transcript whose version changes partway through — Claude Code updating itself under a live
  session — is accepted while every version in it stays in range, and refused as
  `versionChangedMidFile` once the drift leaves it.

**How the anchor moves, and why it is not a lever.** One way only: capture a session from the new
release, check the structural assertions against those bytes, commit the fixture, then move the
constant. It is never moved to make a version work, because moving it cannot make anything work —
the patch number is not consulted. If a new release breaks the deck, the structural rules are what
changed, and those are what need looking at.

**What this costs, stated plainly.** Reading releases nobody captured means reading releases nobody
verified, so a structural change we have not seen can surface as a **wrong tree** rather than an
honest refusal. The alternative was measured, twice: a tolerance counted in patch releases expires,
and when it expired on 2026-08-24 every session for every user rendered `unsupported`. Tightening
the string does not buy correctness; it buys a blackout. The structural assertions are where the
honesty is kept, and they were not loosened alongside it.

## What it does not do

- **No writes of any kind.** Not to `~/.claude`, not to your Claude Code settings, not to session
  files. Zero write capability is the trust anchor, not a default that could be configured away.
- **No launching, wrapping or proxying Claude Code.** It observes what is already there.
- **No historical replay and no persistence.** Close the window and the state is gone.
- **No telemetry, no analytics, no network egress.**
- **No cost dashboards.** Totals are rendered where they belong on the tree, and that is all.

## Development

Build and side-load from a checkout:

```console
npm ci
npm run build
npm run package
code --install-extension dist/agent-deck.vsix
```

## Licence

See [`LICENSE`](LICENSE).

## Status

Released on the VS Code Marketplace as `nvitlam.agent-deck`. The parser, the grafter, the liveness
engine and the renderer are covered by an automated suite that runs against transcripts captured
from real Claude Code sessions.
