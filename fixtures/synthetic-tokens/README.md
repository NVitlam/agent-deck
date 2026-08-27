# `fixtures/synthetic-tokens/` — HAND-MADE, NOT CAPTURED DATA

Everything under this directory is **synthetic**, and it exists for exactly one assertion that
captured data cannot make.

G6 says fixtures are law, and that law only works if captured data and invented data are never
confused. The same markers `fixtures/synthetic-graft/` uses apply here, deliberately identical so
the two read as one family: the project-slug directory is literally
`SYNTHETIC-hand-mutated-not-captured`, the session id is `deadbeef-0000-4000-8000-0000000000a1`,
the agent ids are `agraft0000000001` / `agraft0000000002`, and the message text is
`SYNTHETIC FIXTURE` / `SYNTHETIC REPLY`. Never cite anything here as evidence of what Claude Code
writes.

## `00-cache-fields-absent`

The main transcript is `synthetic-graft/00-valid-control`'s, which is known to fingerprint,
with `message.id` and `message.usage` stamped onto its two assistant lines:

| line | `message.id` | `input_tokens` | `cache_creation_input_tokens` | `cache_read_input_tokens` | `output_tokens` |
|---|---|---|---|---|---|
| 2 | `msg_SYNTHTOKENS000000001` | 4321 | **absent** | **absent** | 99 |
| 3 | `msg_SYNTHTOKENS000000002` | 8765 | **absent** | **absent** | 12 |

**The absence is the fixture.** `0.1.3` changed `prompt` from `input_tokens` to
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, and the risk that change
carries is at the edges: a transcript without the cache fields must yield **exactly**
`input_tokens`, not `NaN`, not 0, and not a `undefined + n`. No captured fixture can prove that,
because every real assistant message in `fixtures/cc-2.1.234/**` and `fixtures/cc-2.1.246/**`
carries all three — the census is in `src/model/events.ts`'s `TokenPair`.

Two messages rather than one, on purpose: `contextNow` (the LAST message) and `burn` (the sum
across distinct ids) are therefore **different numbers** here — `8,765 / 12` against
`13,086 / 111`. A one-message fixture would let a bug that returns the sum for both pass silently,
which is this repo's most-recorded defect class.

Read by `src/model/tokens.test.ts`.
