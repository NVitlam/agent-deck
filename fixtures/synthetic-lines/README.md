# fixtures/synthetic-lines — HAND-MADE, NOT CAPTURED DATA

**These files are hand-written by a developer. They were never produced by Claude Code.**
They must never be mistaken for, moved into, or cited as the real capture under
`fixtures/cc-2.1.234/`, which is the only fixture tree that carries schema authority (G6).

Their sole purpose is to exercise the parser's refusal paths: G3 says malformed input increments a
counter and is skipped, never crashes, and you cannot test that against a well-formed capture.
Every UUID here is obvious `1111…`/`8888…` filler and every session id is all zeroes, so nothing in
this directory can be confused with a real session.

All files are LF-terminated (`.gitattributes` marks `fixtures/** -text`, so the bytes committed are
the bytes read).

| file | contents | expected parser outcome |
| --- | --- | --- |
| `invalid-json.jsonl` | 2 lines: one unterminated object, one with a stray `]` | 2 malformed (`invalidJson`) |
| `truncated-mid-json.jsonl` | 1 line cut mid-string, **no trailing newline** | 1 malformed (`invalidJson`) |
| `wrong-shape.jsonl` | 5 lines: bare string, array, number, `null`, object with no `type` | 5 malformed (4 `notAnObject`, 1 `missingType`) |
| `blank-lines.jsonl` | empty, spaces-only and tab-only lines | 3 malformed (`empty`) |
| `unknown-type.jsonl` | `"type":"sidechain-marker"` and `"type":""` | 2 malformed (1 `unknownType`, 1 `missingType`) |
| `unknown-fields-ok.jsonl` | valid `assistant` + `queue-operation` lines carrying fields CC 2.1.234 never wrote | **2 parsed successfully**, unknown fields kept |
| `thinking-block.jsonl` | an `assistant` line whose content holds a `thinking` block with unmistakable marker strings | 1 parsed; both marker strings absent from the result (G4) |
| `lone-surrogate.jsonl` | valid JSON containing the escape `\ud800` with no low surrogate | 1 malformed (`loneSurrogate`) |

`truncated-mid-json.jsonl` deliberately has no terminating newline: that is what a transcript looks
like mid-append. The tailer holds such a line back, so the parser only sees it when a caller feeds a
whole file in one go — which is exactly what `parse.test.ts` does.
