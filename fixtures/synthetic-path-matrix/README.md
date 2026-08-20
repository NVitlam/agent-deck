# `synthetic-path-matrix` — the Phase 4 path-resolution matrix

Two files, two different provenances. Read the distinction before quoting either.

## `slug-cases.json` — hand-made

Workspace paths and the slug this repo's encoding must produce for each. **Hand-made, not
captured**, which is what the `synthetic-` prefix means everywhere in `fixtures/`. Each row carries a
`witness` field, and only one value of it is a claim about Claude Code:

- `witness: "cc-capture"` — the slug is one CC actually wrote. Exactly one row has it today
  (`windows-drive-lower`), and `src/model/pathmatrix.test.ts` asserts that row's `expectedSlug` is
  literally a directory name under `fixtures/cc-2.1.234/projects`. The test reads the directory; it
  does not hard-code its contents.
- `witness: "encoding-rule"` — the row is this repo's encoding rule applied to that path form. It is
  a pin on *our* behaviour, not evidence about CC's.

Every posix and `/mnt/...` row is `encoding-rule`, and the test asserts that. The reason is measured
and recorded in the other file: **no Claude Code has ever run inside this machine's WSL distro**, so
there is no capture to check a Linux-side slug against. What the WSL leg does verify is that our
resolution code, running under a real Linux Node, produces these slugs and resolves
`$HOME/.claude/projects` — not that a CC process on Linux would agree with them.

## `wsl-environment.measured.json` — measured

**Not synthetic and not a CC capture**: environment facts read back from a live WSL2 Ubuntu distro,
plus the output of this repo's own resolution code executed inside it. It lives here because it is
the other half of the same matrix. Its `provenance`, `measuredAt` and `howMeasured` fields say so in
the file, and a test asserts the `provenance` field still says `MEASURED`.

The headline number it records:

```
C:\Users\dev\projects\agent-deck   ->  C--Users-dev-projects-agent-deck
/mnt/c/Users/dev/projects/agent-deck  ->  -mnt-c-Users-dev-projects-agent-deck
```

One physical directory, two spellings, two slugs — and not case variants of each other, so no
normalisation merges them. `wslpath -u` of the first returns the second, measured, so the two rows
describe the same bytes on disk. Agent Deck does not translate between them: see the WSL boundary
note in `src/model/correlate.ts`.

## Running the WSL leg

```
npx vitest run src/model/pathmatrix.test.ts
```

The WSL half skips when the machine has no WSL or the distro has no Linux Node, and it says so on
stderr with the command that fixes it. To make absence a failure instead — which is what verifying
the Phase 4 DoD item wants:

```
AGENT_DECK_REQUIRE_WSL=1 npx vitest run src/model/pathmatrix.test.ts
```

`AGENT_DECK_WSL_NODE=/path/to/node` points the leg at a specific Linux Node.

## What this directory does not contain

No transcripts, no session content, no hook events. Nothing here was read out of `~/.claude` on
either side of the WSL boundary, and the probe that produced the measurements writes only inside a
`mkdtemp` directory under the OS temp dir on the platform it runs on.
