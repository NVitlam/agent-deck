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

## Privacy — read before the public flip, and before writing any sweep

This directory introduced **two path shapes the repo had never carried before**, and the existing
privacy sweep does not look for either:

- a **POSIX home**, `/home/<user>`
- a **WSL UNC**, `\\wsl.localhost\<distro>\home\<user>`

A sweep grepping `C:\Users\dev` or `projects` matches **neither**. That is the same trap
`fixtures/hook-events/` already carries from the opposite direction — its paths are
backslash-separated, so a forward-slash grep finds nothing there. The repo does not go public
without the sweep passing, so a sweep that silently returns clean is worse than one that fails
loudly.

### What is redacted here, and what is not

**The WSL-side account name is redacted.** Every Linux-side home path in
`wsl-environment.measured.json` is stored as the literal token `/home/<redacted-user>`, and its UNC
spelling as `\\wsl.localhost\Ubuntu\home\<redacted-user>`. The hand-made rows in `slug-cases.json`
use the neutral account `probe` (`/home/probe/agent-deck`,
`\\wsl.localhost\Ubuntu\home\probe\agent-deck`), which is not the distro's real account — a test
asserts that.

What was **kept**, because the measurement is about it and not about the name: that `$HOME` is a
posix absolute path under `/home`, that the Linux projects root is `$HOME/.claude/projects` joined
with `/`, that `wslpath -w` maps a Linux path to `\\wsl.localhost\<distro>\<the same path,
backslashed>`, the distro and kernel identifiers that date the measurement, and **sha256 digests of
the two redacted strings** so a re-run still proves it is describing *this* machine. The WSL leg
compares digests where it used to compare literals; that is the same strength with the name removed.
The digests are a **stability pin, not protection** — a short POSIX account name is low-entropy and the
digest is trivially reversible from a username list. The point is category containment: the two new
shapes no longer appear here with an account name in them.

**The Windows-side account name is deliberately NOT redacted**, here or in `slug-cases.json`. It is
irreducible: Claude Code itself wrote the directory name
`c--Users-dev-projects-agent-deck` under `fixtures/cc-2.1.234/projects`, that
directory is the matrix's only `cc-capture` witness, and redacting the path it decodes from would
destroy the witness while removing nothing from the repo. The WSL side had the opposite property —
`claudeDirectoryPresent: false`, no capture on that side of the boundary, every posix/`wslMount` row
`witness: "encoding-rule"` — so no evidence depended on the account name and it went.

### The patterns a Phase 5 sweep must run

Copy these verbatim. They are extended-regex, and they are the same patterns
`src/model/pathmatrix.test.ts` enforces (`describe('privacy sweep over fixtures/synthetic-path-matrix')`),
each with a positive control so a pattern that rots into matching nothing fails instead of reporting
coverage. The id in the left column is the id used there.

```
posix-home            /home/[A-Za-z0-9._<>-]+
slug-posix-home       -home-[A-Za-z0-9._<>]+
unc-wsl               \\wsl\.localhost\\[^\\]+\\home\\[A-Za-z0-9._<>-]+
slug-unc-wsl          --wsl\.localhost-[A-Za-z0-9._]+-home-[A-Za-z0-9._<>]+
windows-user          [A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._<>-]+
wsl-mount-user        /mnt/[A-Za-z]/Users/[A-Za-z0-9._<>-]+
slug-wsl-mount-user   -mnt-[A-Za-z]-Users-[A-Za-z0-9._<>]+
```

Two things a sweep gets wrong here if it is naive:

1. **Backslashes are doubled inside JSON.** `\\wsl.localhost\Ubuntu\home\probe` is stored as
   `\\\\wsl.localhost\\Ubuntu\\home\\probe`. Collapse runs of backslashes before matching (the test does
   `text.replace(/\\+/g, '\\')`), or the `unc-wsl` pattern finds nothing and looks clean.
2. **Match the slug forms too.** After encoding, every separator is a dash, so `/home/probe` becomes
   `-home-probe` and none of the path patterns match it.

Expected result on this directory today, after collapsing backslash runs: `posix-home` and `unc-wsl`
hits carry only `<redacted-user>` or `probe`; `windows-user`, `wsl-mount-user` and their slug forms
carry only `dev` (documented retention above) or `Probe` (the synthetic probe workspace). Anything
else is a finding.

### Swept, and clean, on 2026-08-20

Also searched across all three files, with zero hits: email addresses
(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`), session/agent UUIDs
(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`), credentials
(`sk-|ghp_|api[_-]?key|password|authorization|token`), hostnames and machine identifiers
(`hostname|WSL_INTEROP|USERPROFILE|APPDATA|machine-id`), and non-loopback IPv4 addresses — the only
dotted-quad in the directory is the kernel version `6.6.87.2-microsoft-standard-WSL2`, which is
machine configuration, not identity, and is load-bearing as the measurement's date stamp. No
transcript content, no tool output and no foreign account exist here: `/home` in that distro holds
exactly one account (G8).

## What this directory does not contain

No transcripts, no session content, no hook events. Nothing here was read out of `~/.claude` on
either side of the WSL boundary, and the probe that produced the measurements writes only inside a
`mkdtemp` directory under the OS temp dir on the platform it runs on.
