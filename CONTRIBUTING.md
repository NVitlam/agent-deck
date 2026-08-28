# Contributing

- **Read-only, always.** Nothing may write to `~/.claude`, to Claude Code's settings or session
  files, or to an OpenCode store. A code path that writes outside this repository fails review.
- **Zero egress.** No network except the loopback hook listener on `127.0.0.1`. No telemetry.
- **Refuse, don't guess.** A schema mismatch renders a session `unsupported`; a malformed line
  increments a counter and is skipped. Never a partial tree, never a crash on input.
- **Fixtures are law.** Parser behaviour is pinned to captured fixtures. A new Claude Code or
  OpenCode version means capturing fixtures *before* changing code.
- **The captures carry no real identity.** Paths, usernames and project slugs in `fixtures/` are
  synthetic and consistent. `node scripts/privacy-sweep.mjs` must exit 0 before any commit; it
  prints `identity=SKIPPED` for you, which is expected and not a failure.
- `npm test` · `npm run typecheck` · `npm run lint` · `npm run build` must all be clean.
