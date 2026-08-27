# `synthetic-dropped-actions/` — the session the liveness defect was reported against

Captured **2026-08-27** by `docs/evidence/AUDIT-2026-08-27.md` §7.5. Redacted in place by
`node scripts/redact-paths.mjs fixtures/synthetic-dropped-actions` before it was tracked.

## What this is

The user reported, against the **Marketplace build `nvitlam.agent-deck-0.1.2`**, that during a
session where two subagents were dispatched the deck failed to show some tool actions, and that the
loss grew as the session went on. This is that session.

```
projects/c--Users-dev-projects-agent-deck/
  41194183-a387-4072-bb84-bc472bf7b5e9.jsonl                    main transcript, 658 lines, 121 tool_use
  41194183-…/subagents/agent-a75b1dc5b08d53b32.jsonl            P3-SPEC,    33 tool_use
  41194183-…/subagents/agent-a75b1dc5b08d53b32.meta.json        join sidecar, toolUseId toolu_01KQ1C2F…
  41194183-…/subagents/agent-a59e0e1e6100c4132.jsonl            P3-CAPTURE, 92 tool_use
  41194183-…/subagents/agent-a59e0e1e6100c4132.meta.json        join sidecar, toolUseId toolu_01VBVmHv…
  41194183-…/tool-results/bfqxg2sz2.txt                         offloaded payload, 54,118 bytes
  41194183-…/tool-results/bz0bwf6ev.txt                         offloaded payload, 326,846 bytes
```

| | |
|---|---|
| CC version | `2.1.246` on every line, single value |
| Session span | `2026-08-26T21:49:58.252Z` → `2026-08-27T06:00:45.633Z` (8 h 11 m) |
| `isSidechain: true` entries | **0** — as Phase 0 measured, subagents get their own files |
| Subagents in the live session | **9**; the **2** the report concerns are the pair captured here |
| `tool_use` in this corpus | **246** = 121 main + 33 + 92 |

**Two of nine subagents, on purpose.** Both are complete `(.jsonl, .meta.json)` pairs, so
`fingerprintSession`'s pairing assertion is satisfied and the corpus fingerprints `ok` as it
stands. Copying all nine would have added 1.9 MB for subagents the report is not about.

## What the audit measured on it, and why that matters

Run through the **production** path — `fingerprintSession` → `graftSession` — the full nine-subagent
session produced **537 tool nodes against 537 `tool_use` blocks**: zero parked, zero skipped files,
nothing lost. **The content path is not where the reported loss comes from.** That measurement is
what redirected the diagnosis to the store (`AUDIT-2026-08-27` §7.3, H5) and is what Phase 5.5's
DoD 5.5.1 and 5.5.2 were written against.

The same run also found **84 malformed lines, 4.8% of 1,751** — every one an entry `type` outside
`KNOWN_ENTRY_TYPES` (`atis-latch` 42, `mode` 20, `file-history-delta` 13, `system` 9), and **none of
them carrying a `tool_use` block**. DoD 5.5.6 moved those four into `IGNORED_ENTRY_TYPES`, so this
corpus is also the evidence for that split.

## Redaction

`scripts/redact-paths.mjs`, run once, then run again to prove it idempotent:

```
run 1   files=7 skipped=0 changed=7
        hits: home-win-fwd 4446, home-win-json 1152, home-unix 54, home-msys 38, user 37
run 2   files=7 skipped=0 changed=0   hits={}
```

Absolute paths became `<HOME>`-relative; the username and machine name became `<USER>` / `<HOST>`.

**The project slug still carries the developer name, and that is deliberate.**
`c--Users-dev-projects-agent-deck` is Claude Code's own directory name and a
join key — `projectSlug` is derived from it and `src/opencode/slug.ts` pins the two engines'
agreement on it. Rewriting it would destroy the property the corpus exists to preserve. That is why
`scripts/privacy-sweep.mjs` carries the `capture-dropped-actions` ALLOW rule, exactly as the `cc-*`
corpora do.

**Join keys and ordinals are untouched**, and it is checked rather than asserted: after redaction
the three transcripts still hold 121 / 33 / 92 `tool_use` blocks in the same order, and
`src/release/redact-paths.test.ts` pins the property on a staged corpus.

## Replay

Same as every other CC corpus — nothing here reads `~/.claude`:

```
CLAUDE_PROJECTS_ROOT=fixtures/synthetic-dropped-actions/projects
```
