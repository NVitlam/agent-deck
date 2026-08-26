# `fixtures/synthetic-layout/` — HAND-MUTATED, NOT CAPTURED DATA

Everything under this directory is **synthetic**. None of it came out of a real Claude Code
session. It was written by hand to make `src/parser/fingerprint.ts` prove that it refuses the
layouts it claims to refuse.

G6 says fixtures are law. That law only works if captured data and invented data are never
confused, so:

- **Captured data lives in `fixtures/cc-2.1.234/`** and is the ground truth for what CC 2.1.234
  actually writes. Never edit it. If the fingerprint rejects anything in there, the fingerprint is
  wrong.
- **This directory is invented.** Never cite it as evidence of CC's behaviour. It is evidence of
  *our* behaviour: what Agent Deck does when the layout is wrong.

Markers that keep the two apart:

- the project-slug directory in every case is literally named
  `SYNTHETIC-hand-mutated-not-captured`;
- the session id is `deadbeef-0000-4000-8000-000000000001` and the agent ids are
  `asynthetic0000001` / `asynthetic0000002`;
- message text is `SYNTHETIC FIXTURE` / `SYNTHETIC REPLY`; tool ids are `toolu_SYNTHETIC…`.

Each case is a complete miniature projects tree — `<case>/<slug>/…` — a handful of lines per file,
so the mutation is readable at a glance rather than buried in a 48 KB transcript. All files use LF
endings (`.gitattributes` marks `fixtures/** -text`).

## Cases

Accepted (these must NOT be refused):

| case | what it proves |
| --- | --- |
| `00-valid-control` | the baseline every mutation is one edit away from: depth-1 + depth-2 subagents, unknown JSON fields, an unknown record `type`, a stray `auto-mode-classifier-error.txt` beside `subagents/`, a stray `notes/` directory, a stray file inside `subagents/`, a sibling `memory/` directory, and no `tool-results/` |
| `14-malformed-lines-tolerated` | corrupt lines and non-object JSON increment `malformedLines` and are skipped — they are not schema drift (G3) |
| `16-zero-byte-main-transcript` | an empty transcript is a just-created session, not a mismatch; no `version` is observed, and absence is not evidence of a *different* version |
| `19-tool-results-present` | `tool-results/` is optional; present or absent, both accept |

Refused, each for its own distinct reason code:

| case | expected `code` |
| --- | --- |
| `01-subagent-meta-missing` | `subagentMetaMissing` |
| `02-subagent-transcript-missing` | `subagentTranscriptMissing` |
| `03-meta-missing-tooluseid` | `metaFieldMissing` (`toolUseId` — the join key) |
| `04-meta-invalid-json` | `metaInvalidJson` |
| `05-subagents-dir-renamed` | `subagentsDirectoryMisnamed` (`agents/` instead of `subagents/`) |
| `06-agent-filename-convention` | `subagentFileNameConvention` (`asynthetic0000001.jsonl`, no `agent-` prefix) |
| `07-version-not-pinned` | `unsupportedVersion` (whole file at `4.4.0`, out of range on major and minor) |
| `08-version-changes-midfile` | `versionChangedMidFile` (starts `2.1.234`, line 3 is `4.4.0` — in range, then out) |
| `09-main-transcript-is-a-directory` | `mainTranscriptNotAFile` |
| `10-meta-not-an-object` | `metaNotAnObject` |
| `11-entry-missing-uuid` | `entryFieldMissing` |
| `12-agent-id-mismatch` | `agentIdMismatch` |
| `13-depth2-without-parent-agent-id` | `metaParentAgentIdRule` |
| `15-no-session-transcripts` | `noSessionTranscripts` (only a `memory/` sibling) |
| `17-meta-spawndepth-wrong-type` | `metaFieldType` (`spawnDepth` as a string) |
| `18-session-id-mismatch` | `sessionIdMismatch` |
| `20-subagents-is-a-file` | `subagentsPathNotDirectory` |
| `21-meta-tooluseid-whitespace` | `metaFieldMissing` (`toolUseId` is `"   "`; `actual: 'blank'`, where 03 is `actual: 'absent'`) |

Cases 05 and 08 are the ones worth re-reading before changing anything. 05 is the directory
convention tripwire: subagent attribution rests on an undocumented convention, so a rename must be
loud. 08 is the withdrawn drift-tolerance proposal (Phase 0 handover, trap 5): a file whose CC
version changes partway through.

**07 and 08 have now been re-versioned TWICE, for the same reason both times, and the pattern is
the point.** Both originally carried `2.1.235`, chosen because it was "not `2.1.234`" back when the
parser accepted the anchor and nothing else. Phase 4 (2026-08-20) replaced that with an acceptance
box of +/-5 on the third component and +/-1 on the second, which puts `2.1.235` *inside* it — so both
were moved to `2.1.400`. The 2026-08-26 amendment then stopped comparing the third component at all,
which accepted `2.1.400` too. They now carry **`4.4.0`**, out of range on the major **and** the minor
component, so no future move of the anchor inside `2.x` can re-admit them.

**A refusal fixture whose version quietly becomes acceptable does not fail. It passes, while testing
nothing.** That is why these two are named in the acceptance rule's own change checklist: whenever
`isVersionAccepted` moves, re-check that `4.4.0` is still refused. Their expectations have never
changed; their bytes have, twice, to keep those expectations true.

The accepted direction — a mid-file change where every observed version is inside the window, which
is CC updating itself under a live session — is deliberately **not** a committed fixture. It is
covered by temp-built sessions in `src/parser/fingerprint.test.ts`, because the window is a matrix
and a fixture per row would be twenty trees each saying one thing. It also has a real witness that
is not committed: live session `3f8e00ab-…` changes from `2.1.234` at line 3 to `2.1.235` at line 47
of its main transcript, measured 2026-08-20.
