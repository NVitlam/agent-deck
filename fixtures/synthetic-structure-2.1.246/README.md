# `fixtures/synthetic-structure-2.1.246/` — the tripwire, proved

**Hand-mutated, not captured.** The slug directory is named
`SYNTHETIC-hand-mutated-not-captured` for the usual reason: nothing in here is evidence about what
Claude Code does (G6).

## What it is

One file: a copy of `fixtures/cc-2.1.246/head-5.jsonl` with **exactly one key renamed**.

```
SYNTHETIC-hand-mutated-not-captured/
  07e6c820-b285-4ea8-8127-98ea762291d9.jsonl   5 lines, one key renamed on line 3
```

Line 3 is the first entry in the slice that carries `CONVERSATION_CORE` — a `user` entry — and
`uuid` is the **first** key `checkEntry` asserts on it. That key is renamed to `uuidRenamedByHand`,
in place, so key order and every other byte of the line are as captured. Lines 1, 2, 4 and 5 are
byte-identical to the source.

| Property | Value |
|---|---|
| `version` on line 3 | `2.1.246` — **in range**, and equal to `PINNED_CC_VERSION` itself |
| Expected refusal | `entryFieldMissing`, `field: 'uuid'`, at `…jsonl:3` |

## Why it exists

Since the 2026-08-26 amendment the version string refuses only on a major mismatch or a minor
distance greater than 1 — the patch component is not compared at all. That leaves the **structural**
assertions as the only thing that can refuse an in-range session, and a compatibility story nobody
can demonstrate is a claim. This fixture is the demonstration: an in-range version, at the anchor
exactly, still refused, and refused for the structure.

The test that consumes it is named so that the point survives a grep — it contains the phrase
**"structure not string"**.

Regenerate it (from the repo root) with the recipe it was built by: take
`fixtures/cc-2.1.246/head-5.jsonl`, parse line 3, rebuild the object renaming `uuid` to
`uuidRenamedByHand` and preserving key order, and write all five lines back out.
