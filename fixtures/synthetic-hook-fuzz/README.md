# `synthetic-hook-fuzz` — hostile-input corpus for the loopback hook listener

`synthetic-` means what it means everywhere else in `fixtures/`: **hand-made, not captured.** Nothing
here came off a real machine. Every session id is a zeroed UUID, every path is rooted at a
non-existent `X:\synthetic\`, and no tool output, prompt text or file content appears at all. That
is content-free *by construction*, which is a stronger claim than the one `fixtures/hook-events/`
can make — that directory is content-free but deliberately **not anonymous**, because it keeps real
`cwd`, `transcript_path`, `session_id`, `agent_id` and `prompt_id` values in order to pin the
main-thread rule. This corpus needs none of that, so it carries none of it.

## What it is for

`src/hooks/listener.test.ts` replays every record in `corpus.jsonl` over a real loopback socket
against a real `HookListener` and asserts, per record:

- the HTTP status the listener answers, and
- the **exact counter deltas** the request produces, and
- that the listener is still serving afterwards.

The last of those is the DoD line ("listener never crashes"). The first two are why the corpus is
not just a pile of garbage strings: "never crashes" is necessary and far too weak on its own — a
listener that answered `200 OK` to every byte sequence on earth would satisfy it. G3 is *refuse,
don't guess*, so each malformed shape has to earn a specific refusal, and the corpus is where that
mapping is written down.

## Encoding rules

**Bodies are base64.** Several cases are made of raw C0 control bytes, invalid UTF-8 and lone
UTF-16 surrogates. Embedding those literally would make `corpus.jsonl` binary to git — no reviewable
diff, ever — and would compound the `grep -a` hazard this repo already documents. `corpus.jsonl` is
therefore **pure printable ASCII plus `\n`**, and both the generator and a test assert that. If you
add a case, encode it; do not embed it.

**Oversized bodies are descriptors, not blobs.** `{"kind":"pad", ...}` records are materialized by
the reader relative to whatever `maxBodyBytes` the listener under test is configured with, so one
record exercises the shipped 512 KiB default and a small cap alike, and the repo does not carry
megabytes of padding. Same for `{"kind":"nest", ...}`, which is depth, not text.

## Record shape

```jsonc
{
  "id":    "class/short-name",      // unique; the test's per-case label
  "class": "malformed-json",        // see the class list below
  "note":  "why this case exists",  // prose, read by humans only
  "body":  { "kind": "base64", "data": "..." },   // or {"kind":"pad"|"nest", ...}
  "expect": {
    "status": 400,                  // or a list, where more than one outcome is correct
    "counters": { "malformedJson": 1 }     // exact deltas; or {"anyOf": [ {...}, {...} ]}
  },

  // all optional
  "headers": { "content-type": "text/plain" },   // null deletes the header
  "method":  "GET",
  "path":    "/not-the-event-path",
  "remote":  "192.168.1.50"        // forces the perceived origin; see below
}
```

`expect.counters` is an exact-delta map. Every counter not named in it must be **unchanged** by the
request — that is what stops a case from passing for the wrong reason. `{"anyOf": [ … ]}` exists for
the two `nesting` cases only, where whether V8's parser copes with the depth is not a property this
repo controls. Each alternative inside `anyOf` is itself a **complete** delta map and the observed
delta must equal one of them outright, so the looser form is still exact — it never degrades into
"some counter moved, near enough".

## `remote` and G5

Cases with a `remote` field run against a listener constructed with the **test-only**
`spoofRemoteAddress` option. The suite never binds a non-loopback socket in order to prove that
non-loopback requests are refused — doing that would itself violate G5 and would make the suite
unrunnable on a locked-down machine. The spoof can only ever make the guard stricter or make a test
fail; it cannot widen what the socket accepts.

## Classes

| class | what it attacks | expected outcome |
| --- | --- | --- |
| `well-formed` | the control group | `200`, `accepted` |
| `missing-keys` | absent fields, incl. the minimal `SessionStart` shape | `200`, `accepted` — **missing is not malformed** |
| `unknown-fields` | forward compatibility: keys and event names no version has sent | `200`, carried in `raw` |
| `type-confusion` | every known field, wrong type | `200`, coerced nowhere |
| `prototype-pollution` | `__proto__` / `constructor.prototype` in the body | `200`, `Object.prototype` untouched |
| `nesting` | parser recursion depth | answers, either way |
| `malformed-json` | syntax the JSON grammar forbids | `400`, `malformedJson` |
| `truncated-json` | a body cut mid-token | `400`, `malformedJson` |
| `not-an-object` | valid JSON, wrong top-level type (incl. `null`) | `400`, `notAnObject` |
| `control-characters` | raw C0 bytes vs. the same bytes as `\uXXXX` escapes | raw → `400`; escaped → `200` |
| `encoding` | invalid UTF-8, truncated sequences, BOM, lone surrogates | mixed, all pinned |
| `empty` | zero-length body | `400`, `emptyBody` |
| `oversize` | bodies past the cap | `413`, `oversize` |
| `at-cap` | the inclusive boundary and one byte under it | `200`, `accepted` |
| `content-type` | wrong media types, and the ones that must be tolerated | `415` / `200` |
| `route` | wrong paths, traversal, percent-encoding, query strings | `404` / `200` |
| `method` | non-POST verbs incl. an `OPTIONS` preflight | `405`, `badMethod` |
| `non-loopback` | spoofed off-box origins, incl. near-miss spellings | `403`, `droppedNonLoopback` |

The count of records is deliberately **not** written here, and no test asserts it: counts in prose
go stale on the next addition and then read as regressions. The test derives the set from the file
and asserts that every class in this table is represented.

**What the `oversize` class does NOT reach.** The replay speaks through an HTTP client, so every
body here arrives with a truthful `Content-Length` and is refused by the listener's declared-size
guard — the streaming guard inside the `data` handler never runs for any record in this file. That
is not a gap in the corpus; the record format has no way to express a request with no declared
length. The cases that do reach it are `Transfer-Encoding: chunked` requests written on a bare
socket, and they live in the transport-level block of `src/hooks/listener.test.ts`. If you are
adding a case because you want to exercise the streaming cap, add it there, not here.

## Regenerating

```
node fixtures/synthetic-hook-fuzz/build-corpus.mjs
```

The generator is provenance, not a build step — the suite reads the committed `corpus.jsonl` and
never runs the generator. It refuses to write a file containing any byte outside printable ASCII
plus `\n`.
