# Security posture

Agent Deck observes Claude Code's exhaust and renders it. It never writes to Claude Code, never
launches or wraps it, and never sends anything anywhere. This document records **what is enforced,
how it is enforced, and how that enforcement was measured** — not intentions.

Scope note: this file is Phase 4 groundwork. It deliberately contains no vulnerability-disclosure
address, no support commitment and no version-support matrix, because none of those exist yet.
Phase 5 owns the published version. The repository is **private** at time of writing; before it is
ever made public, read the privacy note in `fixtures/README.md` first — the committed fixtures are
content-free but **not anonymous**.

---

## 1. The architecture is the guarantee

Two independent taps, and neither of them is a network client.

| tap | source | what it answers |
| --- | --- | --- |
| **hooks** | a user-installed hook snippet POSTs to a loopback HTTP listener | what is running right now |
| **JSONL** | `~/.claude/projects/<slug>/…` read from local disk | what happened |

Everything the extension knows comes from those two, both local. The host holds state in memory
only and discards it when the window closes: no database, no cache file, no persistence.

This matters because "we promise not to send telemetry" is a policy and policies drift. **There is
no outbound HTTP client compiled into the shipped artifact at all** — see §4. Zero egress here is a
property of what the build contains, and a test fails if that changes.

---

## 2. Grounding rules that this posture rests on

These are build-time law in this repository, not guidelines. A change that breaks one fails review.

- **G1 — read-only, always.** No writes to Claude Code settings, session files, or anything under
  `~/.claude`, ever. Hook installation is a snippet the user pastes themselves; the extension never
  edits a settings file to install it. In this repository the hook block lives in the repo-local
  `.claude/settings.local.json` precisely so that `~/.claude` stays untouched.
  `src/hooks/listener.ts` imports no filesystem API at all, and a test asserts that against the
  source text — including that it never resolves a home directory.

  **Amended 2026-08-27, when a second observation source arrived and measurement contradicted the
  plain reading.** Agent Deck also reads OpenCode's SQLite store,
  `%USERPROFILE%\.local\share\opencode\opencode.db`, and that database is in **WAL** mode. Opening a
  WAL database read-only **writes to SQLite's own `-shm` shared-memory index**, and **creates
  `-shm`/`-wal` if they are absent**. So G1's claim is stated precisely rather than absolutely:

  > **No writes to any file the observed engine treats as content.**

  `opencode.db` itself is never modified — measured byte- and mtime-identical across every probe —
  and `auth.json`, `log/`, `snapshot/`, `repos/` and `tool-output/` are never opened at all. What is
  touched is SQLite's lock and index sidecar, which **every** reader of a WAL database touches,
  including OpenCode's own process, and which holds no session content. The read-only handle is
  still the enforcement: a write through it throws `ERR_SQLITE_ERROR` errcode 8, `attempt to write a
  readonly database`.

  The one mode that writes nothing at all, `file:…?immutable=1`, was **rejected for the live
  database and is used only for this repository's committed test fixtures**. It buys zero writes by
  skipping the WAL, which against a live database means silently returning whatever was last
  checkpointed — a confidently wrong tree, which is worse than a sidecar. Requesting it on a
  WAL-mode file is refused in code, so it cannot later be pointed at your data.

  Four secret-bearing tables — `account`, `control_account`, `credential`, `session_share` — are
  never read. **Five** are dropped **by schema** from any committed fixture: those four plus
  `account_state`, which holds no secret itself and exists only to point at `account`. A superset
  is the safe direction for a drop list, and the fifth is named here because this document
  previously implied the two counts were the same one. Dropped *by schema* means the table is never
  created in the fixture, so no column named `access_token`, `refresh_token`, `value` or `secret`
  exists in the artifact at all — there is nothing to leak even if the drop of a *row* were ever
  missed. All five measured zero rows at capture time, which is exactly why the rule keys on the
  schema rather than on the rows.
- **G2 — source separation.** A JSONL parse failure must never take liveness down, and vice versa.
  The two taps do not share a failure path.
- **G3 — refuse, don't guess.** Malformed input increments a counter and is skipped. A schema
  fingerprint mismatch renders a session `unsupported` rather than a partial tree. Nothing about
  input may crash the extension host — see §3.
- **G4 — redaction is production code.** Thinking blocks are dropped at the parse boundary, and the
  `signature` field is dropped with them: Claude Code writes thinking blocks to disk with an
  **empty** `thinking` string and the bytes in `signature`, so a redaction that dropped only the
  visible text would be doing nothing. Tool payloads are truncated with a marker, and large payloads
  offloaded to `tool-results/*.txt` go through the same path. Current truncation behaviour, its
  measured limits and its open items are tracked in the maintainer's working notes; this document
  does not restate them, because a live description written from inside the phase that is changing
  them would be wrong by the time it merged.
- **G5 — zero egress.** No network except the loopback hook listener. Non-loopback requests are
  dropped. This is the subject of §4.
- **G6 — fixtures are law.** Parser behaviour is pinned to bytes captured from real sessions.

### The second read-only source, stated in full

G1 above says what is never touched. This says what *is*, because "read-only" is a claim about
scope as much as about direction, and a reader cannot check a scope that is only ever described by
its complement.

**Where.** `%USERPROFILE%\.local\share\opencode\opencode.db` — one SQLite file, opened through
`node:sqlite`'s `DatabaseSync` with `{ readOnly: true }`. `AGENT_DECK_OPENCODE_ROOT` overrides the
directory, which is how every test reaches a fixture instead of your data. Nothing else in that
directory is opened: not `auth.json`, not `log/`, `snapshot/`, `repos/` or `tool-output/`.

**What.** Six tables, and only these columns. The engine asserts every one of them before it reads
anything; a missing table or column refuses the store outright rather than rendering a partial tree
(G3). Unknown tables and columns are ignored and counted, never read.

| Table | Columns read |
|---|---|
| `project` | `id`, `worktree`, `vcs` |
| `session` | `id`, `project_id`, `parent_id`, `version`, `agent`, `title`, `directory`, `slug`, `model`, `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `time_created`, `time_updated`, `time_archived` |
| `message` | `id`, `session_id`, `time_created`, `time_updated`, `data` |
| `part` | `id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data` |
| `event` | `id`, `aggregate_id`, `seq`, `type`, `data` |
| `event_sequence` | `aggregate_id`, `seq`, `owner_id` |

Three of those `session` columns — `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write` —
are **asserted but never selected**. The schema contract names them, so if a future OpenCode drops
one the engine refuses instead of quietly rendering a tree built on a shape it has never seen. A
required column that nothing reads looks like an oversight and is not.

**Reasoning content is dropped at the parse boundary**, before any record is built — the G4 rule,
applied to the second engine. For OpenCode the reasoning bytes exist verbatim in the store, so
unlike the Claude Code case that test cannot be vacuous: it searches the produced `SessionState`
for the literal captured bytes.

**No SQL from a caller, ever.** Every statement is a fixed SELECT written in `src/opencode/db.ts`;
no query is assembled from input, and no database handle escapes that module.

**How it degrades, without ever crashing (G3).** A missing file, an unreadable one, or a corrupt
one each surface as a named degrade — `databaseMissing`, `databaseUnreadable`, `databaseCorrupt` —
and leave Claude Code sessions rendering unchanged (G2). A schema that is not OpenCode's renders
every session `unsupported`. A graft that cannot place a row surfaces as `graftFailed`, which is a
*containment* rather than a fix: it keeps a throw from escaping into the extension host, at the
cost of darkening every OpenCode session over one unplaceable row. That trade is recorded rather
than presented as a solution.

### The third read-only source, stated in full

Same treatment as OpenCode above, and for the same reason: a scope described only by its complement
is a scope nobody can check.

**Where.** `$CODEX_HOME` when it is set and non-empty, otherwise `~/.codex` — resolved at read time,
never captured at module load. That variable relocates Codex's **entire** surface, credentials
included, so an engine that hard-coded the home location would observe nothing at all for such a
user while reporting a confident absence. An explicit root passed by the caller outranks both, and
is how every test reaches a fixture instead of your data (G6).

**What, exactly.** Four operations and no others:

| Path | How it is read |
|---|---|
| `<root>/sessions/**/rollout-*.jsonl` | byte-offset tailing through the shared `FileTail` |
| `<root>/sessions/**` | `readdirSync` to discover those files |
| `<root>/thread-writer-locks/` | `readdirSync` — **names only** |
| a transcript | `statSync().mtimeMs`, for the liveness fallback |

The lock files are **never opened**. They are 0 bytes and their whole content is their name, so the
engine reads the directory listing and stops there. `.coordination.lock` is process-lifetime and is
not a thread; it is excluded by name.

**Neither `hooks.json` nor `config.toml` is opened by this extension.** They are Codex's own files;
you edit one and Codex's trust prompt covers the other. Agent Deck never reads them, and G1 already
forbids writing them.

**Discovery walks the tree; it never composes a path from a clock.** Rollout files are partitioned
by the day a thread *started*, so a session running past midnight puts a child under a different day
from its parent, and a reader that built `YYYY/MM/DD` from `Date.now()` would silently miss it.

**No socket to Codex. No App Server, no `app-server proxy`, no second port.** Codex hooks POST to
the *same* loopback listener Claude Code's do — one socket for the whole extension, which is what §4
audits.

**Reasoning is dropped at the parse boundary** (G4), and for Codex there are two shapes of it:
`response_item` records typed `reasoning` including `encrypted_content`, and `event_msg` items typed
`Reasoning` including `summary_text` and `raw_content`. Both the plaintext summary and the encrypted
bytes are dropped, never stored, never decoded, never displayed. **A spawned agent's task
*description* is encrypted in the hook payload and is likewise never decoded** — its task *name*
arrives in plaintext and is what labels the node, which is a real and deliberate asymmetry rather
than an oversight.

**Large tool output is stored WHOLE and INLINE by Codex** — no offload file, unlike Claude Code.
248,000 bytes of stdout have been measured in a single record. The hazard here is therefore a very
long line rather than missing content, and truncation is applied on our side before anything is
displayed.

#### G10 — the never-opened list

Named in code as an exclusion list, not filtered after the fact: the name is judged **before** any
path is joined, stat'ed or descended into, so there is no moment at which one of these exists as a
string that has been handed to the filesystem. `src/codex/never-open.ts` holds the list, and a test
greps the engine's source for each name and asserts it appears only there.

| | Never opened |
|---|---|
| files | `auth.json`, `installation_id`, `cap_sid`, `models_cache.json` |
| directories | `.sandbox-secrets/**` — not descended into, not stat'ed inside, not reported |
| suffixes | `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm` |

The SQLite exclusion is **by decision, not by difficulty**. Those are live databases Codex is
writing. The read-only-WAL argument that lets the OpenCode engine open its store does not transfer
for free, and opening one is a separate question with its own gate.

#### The trust step is yours, and it is manual

Codex requires a hook command to be **trusted** before it will run, and that click happens in the
Codex extension — not here. Two consequences worth knowing:

- **Editing `hooks.json` invalidates the trust entry**, and the hook then silently stops firing
  until a human re-trusts it. If liveness goes quiet after you change that file, this is why.
- Six events sharing one identical command produce **six distinct trust hashes**, one per event.
  That is measured; the mechanism is not, so do not infer one. A check written expecting a single
  hash across six events reports a failure that is not there.

---

## 3. The listener's trust boundary

`src/hooks/listener.ts` is the only inbound surface. Its properties:

- Binds the **literal** `127.0.0.1`, hard-coded, never a hostname and never the wildcard. The bind
  host is a module constant and is not configurable; only the port is.
- Validates the **socket's** remote address on every request. Proxy headers — `X-Forwarded-For`,
  `X-Real-IP`, `Forwarded` — are attacker-controlled strings and are never consulted for that
  decision. A non-loopback origin is answered `403` and counted.
- Refuses an ephemeral port. The pasted hook snippet names a fixed port literally, and there is no
  discovery file to tell it otherwise — writing one would break G1. A port collision surfaces as a
  typed error the user is shown; the listener never silently rebinds somewhere else. The one way to
  bind port 0 is an option marked TEST-ONLY in the source, which exists so the suite can bind a port
  atomically instead of racing for one; a source scan asserts that no production module under `src/`
  names it, and it cannot change the bind address either way.
- Caps request bodies, by **two** guards, because one of them cannot see the other's cases. The cap
  is `DEFAULT_MAX_BODY_BYTES` in `src/hooks/listener.ts`. A body whose declared `Content-Length`
  already exceeds the cap is never buffered at all — that is an allocation guard on the headers
  alone. A body that arrives with no declared length, i.e. `Transfer-Encoding: chunked`, is measured
  as it streams and cut at the same cap. Either way the request is counted and answered `413`. A
  body that keeps arriving past a hard multiple of the cap has its socket destroyed rather than held
  open.
- Never throws on input. Every refusal path increments a named counter and answers a status code.
  Consumer callbacks that throw are caught and counted, so a downstream bug cannot take the socket
  down.
- Serves no files and reads no paths. The only route is the event path; every other path is a `404`,
  including traversal attempts, which have nothing to traverse to.

**Hostile-input testing.** `fixtures/synthetic-hook-fuzz/corpus.jsonl` is a synthetic corpus replayed
over a real loopback socket against a real listener at the shipped default body cap. It covers
malformed JSON, bodies truncated mid-token, oversized bodies and the exact byte at the cap boundary,
wrong and absent content types, wrong methods and routes, raw C0 control bytes versus the same bytes
as `\u` escapes, invalid UTF-8, BOM prefixes, lone surrogates, `__proto__` and
`constructor.prototype` bodies, deeply nested JSON, type-confused fields, unknown forward-compatible
fields, minimal-but-valid payloads, and spoofed off-box origins. Each case asserts the status code
**and the exact counter deltas** — every counter not named must be unchanged — because "it did not
crash" is satisfied by a listener that answers `200` to everything.

The corpus speaks through an HTTP client, so every one of its bodies arrives with a truthful
`Content-Length` and every oversize case is therefore answered by the declared-size guard. Reaching
the *streaming* guard needs a request the corpus format cannot express, so those cases are driven
from a bare socket in `src/hooks/listener.test.ts`: a `Transfer-Encoding: chunked` body with no
declared length at all, an **understated** `Content-Length` (measured: node frames the body by the
declared length, so the surplus becomes the next request rather than reaching the cap), an
overstated `Content-Length`, an unparseable request line, a header block that never terminates, and
pipelined requests. See that directory's `README.md`.

**What the boundary does NOT protect against, stated plainly:** any process running as you on your
own machine can POST to the loopback port and inject fabricated liveness events. There is no
authentication, and adding one would mean a shared secret that the pasted hook snippet would have to
carry. The consequence of that injection is bounded by what the extension does with an event: it
renders it. Nothing is executed, nothing is written, nothing leaves the machine. An attacker already
running code as you has far better options than lying to a read-only panel.

---

## 4. The zero-egress audit

**Three parts**, all in `src/hooks/egress.test.ts`, all run in the ordinary suite. None can skip.
§4a and §4b below describe the first two, which cover the shipped host bundle.

The third covers the **OpenCode engine**, and it exists because the first two cannot: it bundles
`src/opencode/index.ts` as its own entry point and denies **`node:http` as well** as `dns` and
`net`. The host bundle cannot make that claim, because there the loopback hook listener is the one
sanctioned socket — so a host-bundle scan would pass while an engine that opened an HTTP client hid
behind the listener's allowance. **The OpenCode engine opens zero sockets of any kind.** Its
liveness is a cursor over the `event_sequence` table, not a subscription; the SSE accelerator
OpenCode offers is deliberately not used. The same describe asserts the shipped bundle never
reaches the test-only fixture builder, which is the one module in that tree that opens a database
for writing.

### 4a. Dependency review — what could open a socket

**Method.** The VSIX ships `dist/` and nothing else: `vsce` is invoked with `--no-dependencies` and
`.vscodeignore` excludes `node_modules/**`. So the shipped runtime surface is the esbuild bundle,
not a dependency tree that never gets installed on a user's machine. The audit therefore enumerates
the module ids **the built bundle actually requires** and gates them, rather than auditing a
lockfile.

**What is asserted, on a bundle built on demand rather than read off disk** (`npm run package` does
not rebuild `dist/` and there is no `vscode:prepublish`, so trusting the on-disk artifact could
silently measure an old one):

- every module id the bundle names is either a `node:` builtin or `vscode` — nothing third-party
  survives bundling as a separate module. Both spellings of "names" are scanned: `require("x")`
  **and** dynamic `import("x")`, which esbuild leaves verbatim rather than rewriting, so a
  require-only scan would have been blind to it;
- none of `net`, `tls`, `https`, `http2`, `dns`, `dgram`, `child_process`, `worker_threads`,
  `cluster` or `inspector` is reachable, in either the bare or `node:` spelling, through either
  form. That is proved by injection rather than asserted: the same check applied to the real bundle
  with one dynamic import appended must report the injected module;
- `node:http` **is** present, so the check is not vacuous — it is the listener;
- no outbound client API is compiled in: no `http.request` / `https.request`, no `fetch(`, no
  `XMLHttpRequest`, no `new WebSocket(`, no `navigator.sendBeacon`;
- the loopback literal appears and `0.0.0.0` does not, asserted against the **built artifact** so
  that a build step rewriting a constant could not slip past the source-level guard.

**Limits, honestly.** Nobody read every dependency's source. This is a reachability argument about
the shipped bundle plus the runtime measurement below — not a proof that no dependency contains
egress code somewhere. The webview is a separate artifact with its own bundle guard and its own
strict CSP, and is not covered by this section.

### 4b. Runtime socket census — what actually opens

**Method.** A child `node` process stages the freshly built `dist/extension.cjs` beside a stub
`vscode` module (module resolution is relative, so the stub is what `require('vscode')` finds —
the same technique the extension-host load test uses). Before the bundle is loaded, the child wraps
`net.Socket.prototype.connect`, `net.connect`, `http.request`/`get`, `https.request`/`get`,
`tls.connect`, `dgram.createSocket`, the `dns` resolvers and `Module._load`. It then drives the real
exported `activate()` against the committed fixtures, and counts live handles with
`process._getActiveHandles()` at four points, classifying each by its underlying libuv handle —
`TCP` is the only kind that can leave the machine.

The harness's own probe POST deliberately speaks raw HTTP over a socket connected with the
**pre-instrumentation** `connect`, so it does not appear in its own census; that it returned `200`
proves the connection really happened and the listener really answered.

**Result** (Node v24.15.0, Windows, one run; reproduce with
`AGENT_DECK_CENSUS_DEBUG=1 npx vitest run src/hooks/egress.test.ts`):

| phase | handles observed |
| --- | --- |
| bundle loaded, before `activate()` | none at all |
| after `activate()` | `Server`/**TCP** on `127.0.0.1:<configured port>`, plus 19 `FSWatcher`/`FSEvent` |
| after serving one hook event | the same, plus the harness's client socket and the child's stdout pipe |
| after `deactivate()` | no TCP handle, no watcher |

Outbound connections attempted by the extension: **0 at load, 0 through activation, 0 across the
entire run.** The file watchers are `FSEvent` handles — local filesystem, not sockets.

**One measured surprise, recorded rather than smoothed over.** The run is *not* DNS-silent. Node's
own `Server.listen(port, host)` routes through `lookupAndListen` → `dns.lookup(host, { all: true })`
**even when the host is already a literal IP address**. So there is exactly one DNS call in the
whole run, its argument is the string `127.0.0.1`, and its caller — captured from the stack — is the
inbound bind. The test asserts all three: the count is exactly one, the argument is a loopback
literal, and the stack names the bind. Asserting the run is DNS-free would be false, and asserting
merely "at least one lookup, and each looked fine" would be weaker than this paragraph claims —
which is how a measured finding turns into a comfortable story.

**Limits, honestly.** This measures one activation cycle on committed fixtures, on one OS and one
Node version. Code paths that cycle never exercises are not covered by it. It measures the Node
extension host, not the webview.

---

## 5. Installing the hook

Hook installation is a manual paste block; the extension never writes it for you (G1). Two things
about the command in that block matter for your own safety rather than ours:

- **It must fail fast when nothing is listening**, because it runs inside your real session — now
  your Codex sessions as well as your Claude Code ones, since both engines post to this one
  listener. The block uses `node -e` rather than `curl`: `node` takes `ECONNREFUSED` and exits `0`.

  **Re-measured 2026-09-04** against a closed loopback port, five runs each, timing **the exact
  one-liner this README pastes** — read out of the README rather than retyped, so the number
  describes what ships:

  | command | min | median | max | exit |
  |---|---|---|---|---|
  | the shipped `node -e` block | 87 ms | **89 ms** | 99 ms | 0 |
  | `curl.exe` 8.18.0, `-m 5` | 2,154 ms | **2,158 ms** | 2,169 ms | 7 |

  **A ratio of about 24×**, and the number that matters is the median, not the ratio: 89 ms is a
  cost you would not notice on a tool call and 2.2 s is one you would, on every tool call, in a
  session you are trying to work in.

  Two earlier measurements on this same machine are kept rather than overwritten, because the
  spread is the point: `node -e` at **81 ms / exit 0**, and `curl.exe` at both **2,098 ms / exit 7**
  and **~1,140 ms / exit 28**. The exit code differs with whether the port is refused or filtered
  and the timing differs with the curl build; **no measurement has ever put them within an order of
  magnitude of each other**, which is the claim the block rests on.
- **The POST is unconditional.** With nothing bound, it is refused and nothing happens. Do not read
  a quiet listener as evidence that hooks have stopped firing.

---

## 6. Hard exclusions

Not implemented, and not accepted as contributions: writes of any kind · historical replay or
persistence · wrapping or launching Claude Code · telemetry or any egress. v1's zero write
capability is the trust anchor, and the point of writing it down is that it is easier to defend a
boundary than to relocate one.
