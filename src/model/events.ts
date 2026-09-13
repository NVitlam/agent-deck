/**
 * Agent Deck — domain model, extension/webview message contract, and the
 * parser-facing types.
 *
 * Types only. No I/O, no dependencies, no logic beyond runtime type guards.
 * Everything Agent Deck holds is in-memory and discarded on window close
 * (G7); nothing here describes persisted state.
 */

// TYPE-ONLY, and the only import this file has ever carried (v0.7.0 Phase 4,
// DoD 4.1). `stats/schema.ts` imports `CompactionRecord` from here the same
// way, so the two files form a cycle in the TYPE graph and nothing in the
// value graph: both erase to nothing at runtime, and `apply.ts`'s "imports
// only events.ts" guard is about what a CSP-strict bundle can reach, which
// this does not change.
import type { StatsRecord } from '../stats/schema.js';

// ---------------------------------------------------------------------------
// (a) Domain model — session tree held in the extension host
// ---------------------------------------------------------------------------

/**
 * Tokens, split the way the model API actually bills and the way a context
 * window actually fills.
 *
 * MEASURED, and the reason this type exists at all. Assistant `usage` objects
 * in the committed Claude Code corpora carry `input_tokens` of roughly **2**
 * while the prompt itself sits in `cache_creation_input_tokens` +
 * `cache_read_input_tokens`. A field named `in` that reads `input_tokens`
 * alone therefore reports single digits for a five-figure prompt, and that is
 * what `0.1.2` shipped. `src/model/tokens.test.ts` pins the arithmetic to a
 * real captured message by `message.id`.
 *
 * **The "~2" is true of the caching corpora and NOT of all captured data.**
 * A session against a local model with no prompt caching puts the whole prompt
 * in `input_tokens` and leaves both cache fields at 0. **The sum rule is right
 * either way** — that is the point of summing all three rather than switching
 * on whichever field looks populated.
 *
 * `prompt` is the sum of all three, each defaulting to 0 when absent or
 * non-finite.
 *
 * **There is no `window` field, and that is a measurement, not an omission.**
 * No captured transcript states a context limit anywhere, so Agent Deck states
 * no percentage. A model-name-to-window lookup table would be memory rather
 * than fixture, which G6 forbids outright. `contextNow` is an absolute number
 * or it is nothing.
 */
export interface TokenPair {
  /**
   * Everything sent to the model for this message:
   * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
   */
  prompt: number;
  /** `output_tokens`. */
  output: number;
}

/**
 * How much of an oversize transcript was read — v0.8.0 Phase 7, DoD 7.7.
 *
 * Both figures are BYTES and both are measured rather than estimated:
 * `totalBytes` is discovery's own `statSync().size`, the same number the size
 * gate compares, and `readBytes` is what the engine actually took.
 *
 * There is deliberately no percentage and no "how much is missing" field. A
 * byte count is not a record count — Codex lines run to hundreds of kilobytes
 * apiece — so a percentage of bytes would read as a percentage of the session,
 * which is a different quantity nobody measured. The two numbers are stated
 * and the reader may divide them knowing what they are.
 */
export interface TranscriptPartial {
  readBytes: number;
  totalBytes: number;
}

export interface SessionState {
  sessionId: string; // <sessionId>.jsonl basename
  projectSlug: string;
  workspaceMatch: boolean;
  liveness: 'live' | 'idle' | 'ended' | 'unsupported';
  schemaOk: boolean;
  root: AgentNode;
  /**
   * What is left after the token split: cost, and nothing else.
   *
   * **`inputTokens` and `outputTokens` were REMOVED from this field**, not
   * renamed. They were the whole-session sums of the per-agent `in`/`out`
   * pair, so they carried the same defect {@link TokenPair} describes,
   * multiplied by the number of agents. A field that keeps its name and
   * changes its meaning is worse than one that goes away: the removal breaks
   * every reader at compile time, which is the point.
   *
   * `costUsd` is unchanged, and **0 still means NOT YET COMPUTED**, never
   * "free" — there is no price table in this repository and inventing one
   * would put a fabricated number in front of the user.
   */
  totals: { costUsd: number };
  /**
   * Cost as Claude Code's own telemetry states it — v0.7.0 Phase 1, DoD 1.9f
   * (Component 12). Summed from the `claude_code.cost.usage` metric.
   *
   * **PARSED AND STORED, RENDERED NOWHERE.** Phase 1 wires the parse boundary
   * and the join and stops there: F9(c) derivation is Phase 2 and the visible
   * cost-source label is Phase 4. A test asserts no webview surface reads this.
   *
   * Deliberately NOT folded into {@link SessionState.totals}, whose `costUsd`
   * means "the engine reported this" and where 0 means NOT YET COMPUTED.
   * Merging the two would make an estimate indistinguishable from an
   * engine-stated figure at exactly the moment Phase 0 found that no engine
   * states one: F9 is `UNAVAILABLE` on all three, with OpenCode's
   * `session.cost` measured at 0 across all three stores and 30 sessions.
   *
   * Separate field, separate provenance, so the Phase 2 precedence between
   * engine cost, a user price table and this can be written down and tested
   * both ways rather than lost in an assignment.
   */
  telemetryCostUsd?: number;
  /**
   * Whether the telemetry this window received includes the session's
   * `claude_code.session.count` point — v0.7.1 DoD 6.3b (user ruling,
   * 2026-09-10). Present and `true` only; absent otherwise.
   *
   * Claude Code emits that point once, at the session's start, and exports cost
   * as increments. So {@link SessionState.telemetryCostUsd} covers the session
   * from its start only when this is set, and `deriveStats` selects telemetry
   * as the cost source only then; otherwise the cost stays here, unselected,
   * and the record names `F9:telemetry-partial`. Set by the telemetry join in
   * `src/otel/join.ts` and nothing else; never on the deck's wire in
   * production (the panel is sent the engines' own states).
   */
  telemetrySessionCountSeen?: true;
  /**
   * How full the session's context is **right now**: the last assistant
   * message of the main transcript, by ordinal.
   *
   * The main transcript, not the deepest subagent: each subagent has its own
   * window, and "how much room is left in the conversation I am watching" is a
   * question about the session's own thread. Per-agent figures live on
   * {@link AgentNode.contextNow}.
   *
   * Not a sum. A context window is a level, not a total — summing successive
   * prompts answers "how much was spent", which is {@link SessionState.burn}.
   *
   * **OPTIONAL because an engine may not report it, and absent is not zero.**
   * The OpenCode engine leaves this unset: its per-step token data lives in
   * `step-finish` part rows that nothing reads yet. A renderer shows
   * `EM_DASH` for absent and a real figure for present; writing 0 here would
   * claim an empty context window, which is a wrong number rather than a
   * missing one. See `src/opencode/graft.ts`.
   */
  contextNow?: TokenPair;
  /**
   * Everything the session has spent: summed across distinct `message.id`
   * over every agent in the tree, parked agents contributing nothing.
   *
   * This is the additive figure, and it is the one that grows without bound.
   * It is deliberately NOT what a node or a cell shows — a user watching a
   * long session wants to know how close to the ceiling they are, and burn
   * cannot answer that.
   *
   * **OPTIONAL for the same reason as {@link SessionState.contextNow}**, and
   * unset by the OpenCode engine for a DIFFERENT one worth recording: that
   * engine's `session.tokens_input` IS a genuine session-cumulative total —
   * measured, 24 of 24 sessions equal to the sum of their `step-finish`
   * rows — but it counts only UNCACHED input. Across the anchor corpus
   * `cache.read` sums to 8,875,276 against `input`'s 1,227,047, so mapping it
   * onto `prompt` would under-report by roughly 7x. That is precisely the
   * defect {@link TokenPair} exists to remove, so it is left absent rather
   * than filled with a plausible wrong total.
   */
  burn?: TokenPair;
  /**
   * Phase 2 additive, and optional so every Phase 1 construction of this
   * interface stays valid. The spec'd fields above are untouched.
   *
   * `ToolNode` has no `children` field and that stays true, so a subagent
   * `AgentNode` does NOT nest inside the `ToolNode` that spawned it: the
   * grafter places it adjacent in the parent agent's `children`. The real
   * spawn relationship therefore exists only here. A renderer that wants to
   * draw a subagent under its spawning tool call reads these edges; without
   * them that relationship is not recoverable from `root` alone.
   */
  spawnEdges?: readonly SpawnEdge[];
  /**
   * The transcript was too big to read whole, so part of it was read and
   * this session is built from that part — v0.8.0 Phase 7, DoD 7.7.
   *
   * Additive and optional for the reason `spawnEdges` and `parked` are:
   * every earlier construction of this interface stays valid and no field
   * above changes meaning. **Absence reads as "read whole"**, which is what
   * every session before this release was.
   *
   * ## Why a session says this at all, instead of being skipped
   *
   * Before this, a Codex transcript over `agentDeck.codex.maxTranscriptBytes`
   * was measured from its directory entry and never opened — correct, because
   * Codex stores tool output whole and inline and a long session reaches
   * hundreds of megabytes. But the user saw nothing on the deck and one line
   * on a channel they had no reason to open, so the biggest session on the
   * machine was the one Agent Deck was silent about. G3 says refuse rather
   * than guess; it does not say refuse SILENTLY.
   *
   * ## What is and is not claimed
   *
   * The bytes read are real and everything derived from them is a fact about
   * the session. What is NOT claimed is completeness: counts, totals and the
   * tree are of the part that was read, and a renderer must say so rather
   * than present them as the session. That is the whole reason this field is
   * on the state instead of being a detail of the engine — a figure a user
   * cannot tell is partial is worse than no figure.
   */
  partial?: TranscriptPartial;
  /**
   * Agents the grafter knows exist and deliberately did NOT attach to the
   * tree, each with the machine-readable code saying why.
   *
   * Phase 4.5 additive, and optional for the same reason `spawnEdges` is:
   * every earlier construction of this interface stays valid, and no field
   * above changes meaning.
   *
   * A parked agent is absent from `root` on purpose — G3 refuses rather than
   * guessing a parent — so without this field a parked agent reaches the
   * webview through no channel at all, and "refuse, don't guess" is a decision
   * the renderer cannot see. `root` cannot recover it: there is nothing in the
   * tree to recover it from.
   *
   * An empty list is the honest value for a session that parks nothing, and it
   * is also what a refused (`schemaOk: false`) session carries: a refusal
   * renders nothing, and a new field is not a hole to smuggle content through.
   */
  parked?: readonly ParkedGraft[];
  /**
   * Which observation engine produced this state.
   *
   * Phase 4 additive, and optional for the third time and the same reason
   * `spawnEdges` and `parked` were: every earlier construction of this
   * interface stays valid and no field above changes meaning. **Absence reads
   * as `'cc'`**, which is what every state produced before the OpenCode engine
   * existed was. `agent-deck-spec.md` OC7 is the authority for the shape.
   *
   * The tag exists so ISOLATION is assertable: G2 gained a cross-engine half —
   * a corrupt or absent OpenCode database must leave CC sessions rendering
   * unchanged, and a CC parse failure must leave OpenCode sessions rendering
   * unchanged — and a test can only name the sessions that must be unaffected
   * if the state says which engine produced them.
   *
   * **Both of the scope lines Phase 4 wrote here have been crossed, by user
   * decision at the Phase 5 gate.** The paragraph that stood here said
   * `SessionPatch` does not carry the field and that nothing in
   * `src/model/session.ts` produces a state carrying it. Neither is true from
   * Phase 5 on, and the old text is superseded rather than quietly corrected,
   * because a reader who trusts it will draw the wrong conclusion twice:
   *
   * - **`SessionFieldPatch` carries it** (gate amendment B2), for the
   *   uniformity DoD 5.1 asks for. The reasoning that argued against it still
   *   holds — the engine cannot change mid-session — so the key is one the
   *   model never emits. `SessionFieldPatch.engine` says so at its own site.
   * - **The CC engine STAMPS `'cc'`** (gate amendment B3). `session.ts` sets
   *   the field explicitly, so every state on the wire names its engine rather
   *   than leaving the CC case to be inferred from absence.
   *
   * The field stays OPTIONAL, and absence still reads as `'cc'`. Making it
   * required would invalidate every earlier construction of this interface,
   * which is the entire reason it — like `spawnEdges` and `parked` — was added
   * optional in the first place.
   */
  /**
   * **Widened for the Codex engine (v0.6.0 Phase 2, spec C11).** The field
   * keeps every property described above: still optional, absence still
   * reads as `'cc'`, and no earlier construction of this interface is
   * invalidated. Codex sessions are tagged `'codex'`.
   *
   * `src/bridge/diagnostics.ts` declares the same three-way union
   * SEPARATELY, because that module imports nothing at all by design. The
   * two declarations are kept in step by hand; `typecheck` is what catches
   * them drifting, and it did — widening only this one produced three
   * errors, which is how the second site was found rather than assumed.
   * Nothing emits a `'codex'` diagnostic until the host mounts the engine
   * in Phase 3 (DoD 3.2); the channel can carry one now so the pair does
   * not have to be widened twice.
   */
  engine?: 'cc' | 'opencode' | 'codex';

  /**
   * The model's context window for this session, in tokens — the third
   * number a Codex cell carries beside Context and Burn (Phase 0 decision
   * **D0.2**, spec C8).
   *
   * **OPTIONAL, and absent is never `0`.** `0` would claim a model with no
   * context at all, which is a wrong number rather than a missing one — the
   * same rule {@link SessionState.contextNow} states for its own absence. A
   * renderer shows `EM_DASH` when it is unset, and per D0.2 **no engine gets
   * a percentage or a gauge**, because two of the three cannot report one.
   *
   * The Codex engine reads it from the transcript's `model_context_window`
   * and from nowhere else. Codex also ships a network-fetched model cache
   * stating a different figure for what looks like the same concept; that
   * file is on the G10 never-opened list and `docs/codex-contract.md` A7
   * records the number as a non-evidence observation, so a later reader
   * meets it there instead of rediscovering it and concluding the
   * transcript is wrong.
   *
   * **The cache is deliberately not NAMED here.** `src/codex/never-open.ts`
   * is the one place its filename appears, and the G10 test greps for each
   * name and asserts it occurs only in that list. The grep is scoped to
   * `src/codex/` today, so a literal here would pass — and would break the
   * moment anyone widened the scope, which is the direction that guard
   * should be free to move.
   *
   * The CC and OpenCode engines leave it unset: no CC transcript states a
   * window size (a census over every `cc-*` fixture for any key containing
   * context/window/limit/max finds tool INPUTS only), and a model-name
   * lookup table would be memory rather than fixture (G6).
   */
  windowTokens?: number;
}

/**
 * One `tool_use` block -> one subagent. The primary-key join, taken from the
 * sidecar's `meta.toolUseId`; never inferred, and never derived from a hook
 * event (`SubagentStart` carries no `tool_use_id` at all).
 */
export interface SpawnEdge {
  /** The `tool_use` block that spawned the agent — the join key. */
  toolUseId: string;
  /** The spawned agent's id; matches an `AgentNode.id` in the tree. */
  agentId: string;
  /** `AgentNode.id` the agent was attached under: `'root'`, or a parent agent. */
  parentNodeId: string;
  /** Depth walked from the root. 1 = child of root. */
  depth: number;
  /** `spawnDepth` as written in the sidecar, kept even when it disagrees. */
  recordedDepth: number;
}

/**
 * Why an agent is known to exist and is deliberately not in the tree.
 *
 * The same vocabulary `graft.ts` produces, where every member is documented
 * with the join outcome behind it. It is restated here rather than imported
 * because this module imports nothing at all, and that is load-bearing:
 * `bridge/apply.ts` is bundled into a CSP-strict browser context and reaches
 * only this file — a property `bridge/apply.test.ts` re-derives from disk by
 * walking the real import graph. Importing `graft.ts` here would drag
 * `node:crypto` and the parser's filesystem code into the webview bundle.
 *
 * The two definitions are held together by assignment, not by agreement:
 * `session.ts` maps a `GraftSnapshot`'s `parked` entries field by field into
 * this shape, so a code or a property added on the grafter's side and not here
 * is a compile error at that mapping rather than a value that silently never
 * arrives.
 */
export type ParkCode =
  | 'sidecarMissing'
  | 'sidecarUnusable'
  | 'missingJoinKey'
  | 'noMatchingToolUse'
  | 'ambiguousJoinKey'
  | 'parentAgentMissing'
  | 'parentAgentContradiction'
  | 'parentNotGrafted'
  // -- OpenCode engine only (Phase 4). `src/model/graft.ts`'s own `ParkCode`
  // does NOT carry these: the CC grafter cannot produce them, and widening its
  // union would say it could. This union is the wire's, so it is the superset,
  // and the assignment at `session.ts`'s `toWireParked` still type-checks.
  /**
   * A `task` part carries no `state.metadata.sessionId`, so there is no child
   * session to attach. Measured on 9 of 30 task parts (`agent-deck-spec.md`
   * OC3, `docs/opencode-contract.md` amendment §G) and therefore a NORMAL
   * state — most likely a call observed before the child row exists, the exact
   * analogue of CC's sidecar-before-transcript window.
   *
   * Distinct from {@link ParkCode} `joinKeyContradiction` on purpose: a missing
   * key and a contradicted key are different stories, for the same reason
   * `unsupportedVersion` and `versionChangedMidFile` are distinct for CC. It is
   * never resolved by guessing the nearest child in time (OC3, rule 2).
   */
  | 'taskWithoutChild'
  /**
   * The `task` part's `state.metadata.sessionId`, its
   * `state.metadata.parentSessionId`, and the named child row's
   * `session.parent_id` do not all agree.
   *
   * A NEW code rather than a reuse of `parentAgentContradiction`: that one
   * describes a CC sidecar's `parentAgentId` disagreeing with where the
   * `tool_use` key resolved — one claim against one resolution. This is a
   * three-way primary-key cross-assertion with no sidecar in it, and collapsing
   * the two would make the wire unable to say which check failed.
   */
  | 'joinKeyContradiction'
  /**
   * A child `session` row names a `parent_id`, but no `task` part in that
   * parent session joins to it. The child exists and nothing legitimately
   * attaches it, so it parks rather than being hung off the root.
   */
  | 'noSpawningTaskPart'
  /**
   * A child session was REFUSED by the per-session version window while its
   * parent was accepted. The join was never attempted.
   *
   * **A new code because the existing one told a false story.** Through Phase 4
   * this case surfaced as {@link ParkCode} `joinKeyContradiction`: the grafter
   * looked the child up among the accepted rows, did not find it, and reported
   * the only failure it had a word for. It was visible and it was safe — G3 was
   * never violated, nothing was guessed — but the keys did not disagree. The
   * child was out of window, which is a compatibility fact about one session,
   * not a data-integrity fact about a join.
   *
   * The distinction is the same one `taskWithoutChild` and
   * `joinKeyContradiction` already draw between a missing key and a
   * contradicted one, and it matters for the same reason: a user reading
   * "contradiction" goes looking for corrupt data, and there is none to find.
   *
   * Recorded as `docs/evidence/phase-4/COVERAGE.md` item 29 and closed by
   * `PLAN.md`'s Phase 5 gate amendment B7. Only refused ROOT sessions render
   * `unsupported`; a refused child parks here instead, so its parent still
   * renders its remaining tree.
   */
  | 'childSessionUnsupported'
  // -- Codex engine only (v0.6.0 Phase 2). Same treatment as the OpenCode
  // block above: `src/model/graft.ts`'s own narrower union does NOT carry
  // these, because the CC grafter cannot produce them and widening its
  // union would say it could. This union is the wire's, so it is the
  // superset, and `session.ts`'s `toWireParked` assignment still holds.
  /**
   * A Codex subagent carrying NEITHER join key — no `agent_path` to match a
   * spawn's `task_name`, and no thread id matching a spawn's `agent_id`.
   *
   * **This is a TRIPWIRE and it is expected to fire zero times**, which is
   * the opposite of what its name suggests and the reason this comment
   * exists. It is NOT the routine state of the `v1` dialect. `v1` children
   * graft perfectly well — by id rather than by name (`agent-deck-spec.md`
   * C4a) — and an earlier ruling that parked the whole dialect with no
   * filament was reversed on corrected evidence. The premise had been that
   * a `v1` child "cannot be grafted, there is no `task_name` to join on";
   * `task_name` is indeed absent, and the join is not. *"I did not find a
   * join"* had been written down as *"there is no join"*.
   *
   * A test asserts this code fires zero times across the whole corpus. A
   * tripwire that fires routinely is not a tripwire.
   */
  | 'dialectV1'
  /**
   * A Codex subagent whose `agent_path` key is ABSENT.
   *
   * Distinct from present-and-`null`, which is what a `v1` thread carries
   * and which GRAFTS. Collapsing the two is how the dialect was nearly
   * refused, and it is why `CodexOptional` exists at all.
   */
  | 'noAgentPath'
  /**
   * A spawn whose `tool_response` names a child that no thread carries.
   * The spawn happened and the child is not there — so the call renders and
   * nothing is invented to hang off it (G3).
   */
  | 'orphanSpawn'
  /**
   * Two threads claiming one `agent_path`.
   *
   * **A second tripwire expected to fire zero times.** Codex ENFORCES path
   * uniqueness in the engine — a second spawn asking for a taken path is
   * refused outright with `agent path /root/dup already exists`, which is a
   * refused CALL, not a park. This code exists for the day that stops being
   * true, and a test pins the zero.
   */
  | 'duplicateAgentPath'
  /**
   * A forked subagent whose `subagent_history_start_ordinal` is missing
   * while its transcript plainly carries inherited records.
   *
   * Absence of the key is normally the legitimate `fork_turns: "none"`
   * signal and drops nothing; this is the contradictory case, where the
   * boundary is needed and not stated, so the thread's own work cannot be
   * separated from its parent's.
   */
  | 'forkBoundaryMissing';

/** One agent that is known to exist and is deliberately not in the tree. */
export interface ParkedGraft {
  /**
   * The identity of the thing that did not graft. It matches no `AgentNode.id`
   * under `root`.
   *
   * For the CC engine this is always an agent id. **For the OpenCode engine's
   * `taskWithoutChild` it is a `prt_*` part row id**, because the entire
   * content of that case is that no child session id exists — OpenCode parks a
   * *part*, not an agent, and the row id is the only stable identity the data
   * offers for the thing that was parked. `fixtures/opencode-1.18.22/GOLDEN.md`
   * DEVIATIONS item 3 raised this as a spec misfit and offered two fixes: an
   * optional part id beside this field, or documenting the field as the wider
   * claim. **Phase 4 took the second**, because a second identity field would
   * have to be optional, every renderer would then have to know which of two
   * fields to read, and the field's one real job — "name the thing that is
   * missing from the tree, so a refusal is visible" — is served by either id.
   * The `code` says which kind it is, and it does so exhaustively.
   */
  agentId: string;
  /** Machine-readable refusal reason. */
  code: ParkCode;
  /** The join key as read, when there was one worth quoting. */
  toolUseId?: string;
  /** Human-readable explanation, carried through from the join where possible. */
  reason: string;
  /** `parentAgentId` from the sidecar, when the sidecar supplied one. */
  parentAgentId?: string;
}

/**
 * One turn's token usage, as the engine stated it — v0.7.0 Phase 1, DoD 1.4.
 *
 * The four components are kept SEPARATE rather than pre-summed into a
 * {@link TokenPair}, because the facts need them apart: F6 (cache ratio) is
 * `cacheRead` against the rest, and F7 (context churn) is the turn-over-turn
 * delta of `cacheCreation` alone. A pair would make both underivable, and
 * re-deriving them from a sum is impossible rather than merely awkward.
 *
 * The relationship to {@link AgentNode.burn} is an identity, not an
 * approximation, and DoD 1.4 asserts it over every corpus session that has a
 * series:
 *
 *     burn.prompt === Σ (input + cacheCreation + cacheRead)
 *     burn.output === Σ output
 *
 * `ordinal` is position within this agent's series, from 0, in the order the
 * engine wrote the turns.
 */
export interface UsageTurn {
  ordinal: number;
  /**
   * Tokens sent that were NOT served from cache.
   *
   * Per engine, and the engines disagree about what their own field means:
   * Claude Code's `input_tokens` is already exclusive of cache, while Codex's
   * is cache-INCLUSIVE, so the Codex reader subtracts `cached_input_tokens`
   * to land on the same quantity. `src/codex/parse.ts` records the
   * measurement (0 of 116 records satisfy the Claude Code sum).
   */
  input: number;
  /** Tokens written to the cache this turn. The quantity F7 spikes on. */
  cacheCreation: number;
  /** Tokens served from cache this turn. */
  cacheRead: number;
  /** Tokens generated this turn. */
  output: number;
  /**
   * F14 — when the ENGINE says this turn happened, in epoch milliseconds.
   *
   * v0.8.0 Phase 7, DoD 7.1. Absent where the engine states no time for a
   * turn, and absent on every engine that states no series at all — Codex
   * writes a running `total_token_usage` from which no turn can be recovered
   * (`src/codex/parse.ts` records the measurement), so it has no `UsageTurn`
   * for this field to hang on rather than a turn whose time is unknown.
   */
  atMs?: number;
}

/**
 * A context compaction the engine performed — v0.7.0 Phase 1, DoD 1.4b; F12.
 *
 * `trigger` is READ, never inferred. Claude Code writes `auto` or `manual` in
 * its `compactMetadata`, and Phase 0 measured that the two entries have
 * IDENTICAL key sets (DoD 0.3b), so one reader handles both and nothing has to
 * guess which happened. OpenCode has its own `compaction` part carrying no
 * token figures at all, which is why the token halves are optional and why
 * `'engine'` exists as a third value: an OpenCode compaction is a real event
 * that simply does not state what it cost.
 */
export interface CompactionRecord {
  /** Position among this agent's tool calls when the compaction landed. */
  ordinal: number;
  trigger: 'auto' | 'manual' | 'engine';
  /** Prompt tokens immediately before. Absent where the engine states none. */
  preTokens?: number;
  /** Prompt tokens immediately after. Absent where the engine states none. */
  postTokens?: number;
  durationMs?: number;
}

export interface AgentNode {
  id: string; // agentId from transcript, or 'root'
  kind: 'main' | 'subagent';
  label: string; // meta.agentType + meta.description
  status: 'running' | 'done' | 'error';
  spawnDepth: number; // from meta.json; 0 for main
  children: (AgentNode | ToolNode)[];
  /**
   * This agent's context level: its own last assistant message by ordinal.
   *
   * REPLACES `tokens: { in, out }`, which read `input_tokens` alone and so
   * reported single digits for real prompts — see {@link TokenPair}. The old
   * field is gone rather than deprecated so no renderer can keep reading it.
   *
   * Optional for the reason {@link SessionState.contextNow} gives: an engine
   * that does not report a context level leaves it unset, and absent renders
   * as `EM_DASH` rather than as 0.
   */
  contextNow?: TokenPair;
  /**
   * This agent's spend: summed across its own distinct `message.id`s.
   *
   * Optional; see {@link SessionState.burn}.
   */
  burn?: TokenPair;
  /**
   * This agent's per-turn usage, in the order the engine wrote it — DoD 1.4.
   *
   * **Wired where the engine states a series; absent where it does not, and
   * NEVER approximated from a total** (the locked answer, 2026-09-05). Codex
   * is the case that makes the rule concrete: it reports a running
   * `total_token_usage`, from which a per-turn series cannot be recovered, so
   * a reader that divided or differenced it would be inventing turns.
   *
   * Absent therefore means "this engine states no series", which is a
   * different claim from an empty array (a session that ran no turn).
   */
  usageSeries?: readonly UsageTurn[];
  /**
   * The model this agent ran, verbatim from the engine — DoD 1.4b.
   *
   * Never normalised, never mapped to a family or a context-window size. G6
   * forbids a lookup table nobody captured, and Phase 0 recorded the harder
   * lesson beneath it: one model's behaviour is not the engine's, so the
   * string is evidence and any tidying of it destroys evidence.
   */
  model?: string;
  /**
   * Compactions this agent's context went through — DoD 1.4b, F12.
   *
   * Absent where the engine writes no compaction entry (Codex: no payload type
   * carries one). An empty array would claim "measured, none happened".
   */
  compactions?: readonly CompactionRecord[];
  /*
   * THERE IS DELIBERATELY NO `agentName` HERE, AND IT IS A MEASUREMENT RATHER
   * THAN AN OMISSION — v0.7.0 DoD 1.9e, closed by the user on 2026-09-06.
   *
   * Component 12's draft promised `agentName` on this interface, from the OTel
   * exporter's `agent.name` attribute. The corpus has no key to hang it on:
   * across all 850 records of `fixtures/otel-cc-2.1.260/`, `agent.name` appears
   * on 36 units (6 `api_request` logs + 30 metric points) and `agent_id` on 10
   * (4 of 40 tool spans + 6 `llm_request`), and the two NEVER co-occur. Session
   * `f7f0eef9…` carries TWO distinct `agent_id`s against ONE `agent.name`, so
   * even "this session had a single subagent, so the name is its" is false.
   * `agent.name` is not in {@link TELEMETRY_KEPT_KEYS} and never crosses the
   * parse boundary at all.
   *
   * The field was REMOVED rather than left unset, because a field nothing can
   * ever set is a promise the type keeps making. `agent-deck-spec.md` §L
   * (2026-09-06) is the authority; `src/otel/join.test.ts` asserts the
   * co-occurrence measurement, so a capture where the two DO co-occur turns it
   * red — which is the signal to reopen this, not a regression.
   */
  startedAt: number;
  endedAt?: number;
}

export interface ToolNode {
  id: string; // tool_use id — the graft key
  toolName: string; // 'Agent' nodes are graft points
  /**
   * `'stalled'` is DERIVED, never parsed and never stored (v0.7.0 Phase 0c).
   *
   * The grafter only ever writes the other three — its rule is
   * `resultPreview === undefined ? 'running' : 'done'`, which has no clock in
   * it. `src/model/stall.ts` promotes `'running'` to `'stalled'` at assembly
   * time when the SESSION has observed no activity for longer than
   * `agentDeck.livenessThresholdMs`. It therefore clears by construction: any
   * hook or transcript write moves `lastActivityAt` and the next derivation
   * returns `'running'` again, with no reset path to forget.
   *
   * It is a statement about SILENCE, not about duration. The corpus that
   * forced it holds an `Agent` call that ran 47 minutes and completed beside
   * the reported stall that ran 18 and never did — the stall is the shorter of
   * the two. See `docs/evidence/phase-0c/ROOTCAUSE.md` §5.
   */
  status: 'running' | 'done' | 'error' | 'stalled';
  /**
   * The instant the stall threshold was crossed — `lastActivityAt +
   * thresholdMs`. Present iff `status === 'stalled'`.
   *
   * NOT the instant the question was asked, which would make the elapsed time
   * the user sees jump with the poll cadence and would differ between two
   * derivations of one underlying state.
   */
  stalledSinceMs?: number;
  inputPreview: string; // post-redaction, truncated
  /**
   * The file this call touches, read from ONE named key of the structured
   * input — v0.7.0 Phase 1, DoD 1.3. F1 is built on it.
   *
   * Which key, per engine and per tool, comes from
   * `src/stats/toolclass.ts`, which is GENERATED from the Phase 0 census. No
   * regex, no scan for path-shaped strings: Layer 1 reads structure, never
   * text. A search tool's `path` is a SCOPE rather than a file touched, and
   * the census gives it no key for exactly that reason.
   *
   * Absent on every Codex call, and that is measured rather than unimplemented:
   * `exec` is a `custom_tool_call` whose input is a STRING of JavaScript and
   * can carry no key at all, and Codex touches files through shell commands
   * whose names live inside command text. Phase 0 records F1 as
   * `UNAVAILABLE:codex`.
   */
  filePath?: string;
  /**
   * SHA-256 over canonical JSON of the **untruncated** structured input —
   * DoD 1.2. `src/stats/canonical.ts` is the definition.
   *
   * It exists so two calls can be compared for identity without anyone reading
   * their arguments: F3 counts repeats of one `toolName + inputHash` within an
   * agent, and F4 joins churn chains on it.
   *
   * **Taken before truncation, which is the whole point.** `inputPreview` is
   * cut at `agentDeck.previewBytes`; two calls differing only past that cut
   * have identical previews, and hashing the preview would report them as a
   * loop. Every producer hashes what the engine parsed.
   *
   * OPTIONAL on this interface although spec §E calls it required, and the
   * reason is B3, the same precedent that keeps `engine` optional: this one
   * type is both the host's domain model and the wire contract, and two
   * hand-built wire corpora serialise `ToolNode`s that will never pass through
   * a production grafter again. Every ENGINE sets it — asserted per engine over
   * each corpus by DoD 1.5, which is a stronger check than the type could make
   * — and the Phase 2 deriver requires it, emitting `unavailable` when absent.
   */
  inputHash?: string;
  /**
   * This call's position within its own agent's transcript, from 0, in order
   * of first appearance — DoD 1.1.
   *
   * First sighting of a `tool_use` id wins its ordinal: a repeated id keeps the
   * call site where the tool was invoked. Per AGENT, not per session, so two
   * agents' ordinals are not comparable and nothing should sort across them.
   *
   * OPTIONAL for the same B3 reason as {@link ToolNode.inputHash}.
   */
  ordinal?: number;
  resultPreview?: string; // post-redaction; sourced from JSONL or tool-results/
  /**
   * How long the call took.
   *
   * **Two sources, and the precedence is decided rather than incidental**
   * (v0.7.0 Phase 1). The engines state it themselves — Claude Code from the
   * transcript's own timestamps, OpenCode from `state.time.start/end` — and
   * Claude Code telemetry states it again on `claude_code.tool` spans. The
   * ENGINE wins; telemetry only fills where the engine states none.
   *
   * That order is not a preference. The engine-derived value is what every
   * committed golden already carries, so letting telemetry overwrite it would
   * move goldens whenever telemetry happened to be on — making a user's
   * `settings.json` a factor in whether this repository's fixtures reproduce.
   */
  durationMs?: number;
  /**
   * F14 — the instant the ENGINE says this call began, in epoch milliseconds.
   *
   * v0.8.0 Phase 7, DoD 7.1; spec `Amendment 2026-09-12`: *"gathered at the
   * parse boundary, from the engine's own timestamps only; absent where the
   * engine states none"*.
   *
   * ## Absent is a fact, and it is not the same fact as `durationMs` absent
   *
   * {@link ToolNode.durationMs} has TWO producers and telemetry is one of
   * them: `otel/join.ts` fills it where the engine states none. These two do
   * not, and may not — the amendment says "the engine's own timestamps only",
   * so a telemetry-filled duration legitimately stands beside an absent start.
   * A reader that treats `durationMs` as implying a start/end pair is wrong
   * for exactly the telemetry case, which is why this is written down here
   * rather than left to be inferred from the two fields being adjacent.
   *
   * The other direction is also legitimate and commoner: a RUNNING call has a
   * start and no end, and therefore no duration. Neither field implies the
   * other in either direction.
   */
  startedAtMs?: number;
  /**
   * F14 — the instant the ENGINE says this call ended, in epoch milliseconds.
   *
   * See {@link ToolNode.startedAtMs}. Absent on every call the engine has not
   * reported a result for, and absent on every engine that states no end.
   */
  endedAtMs?: number;
  /**
   * The observed engine reports that IT already truncated this payload, before
   * Agent Deck saw it.
   *
   * **Not the same claim as `redact.ts`'s marker**, and that distinction is the
   * whole reason the field exists. Our own truncation is ours: we chose the
   * ceiling, the marker says so, and raising `agentDeck.previewBytes` changes
   * it. This one is the engine's, it happened upstream, and no setting here can
   * recover the bytes. A renderer that shows one marker for both tells the user
   * a payload is retrievable when it is not.
   *
   * OpenCode sets it in `state.metadata.truncated`; **14 tool parts in the
   * anchor corpus carry it**. `docs/opencode-contract.md` §8.4 calls it "the
   * flag to trust". It was dropped silently through Phase 4 —
   * `fixtures/opencode-1.18.22/GOLDEN.md` DEVIATION 5 and
   * `docs/evidence/phase-4/COVERAGE.md` item 22 — recorded there as a known
   * information loss rather than an untested branch, because the field had
   * nowhere to land. Phase 5's gate amendment B7 gives it one.
   *
   * The CC engine never sets it. CC's `<persisted-output>` stub is a different
   * mechanism: it offloads to `tool-results/*.txt` and the bytes are still
   * there to read, which is the opposite of this flag's claim. Absent means
   * "not claimed", never "known to be whole".
   */
  truncated?: boolean;
}

/** Anything that can appear in `AgentNode.children`. */
export type TreeNode = AgentNode | ToolNode;

/**
 * Runtime discriminator for `TreeNode`.
 *
 * `ToolNode` has no `kind` field in the spec, so rather than adding one we
 * test for `AgentNode`'s `kind` discriminant. Kept as a guard function so the
 * spec'd interfaces stay untouched.
 */
export function isAgentNode(node: TreeNode): node is AgentNode {
  return (node as Partial<AgentNode>).kind !== undefined;
}

/** Inverse of {@link isAgentNode}; present so callers never negate by hand. */
export function isToolNode(node: TreeNode): node is ToolNode {
  return !isAgentNode(node);
}

// ---------------------------------------------------------------------------
// (b) Extension <-> webview message contract
// ---------------------------------------------------------------------------

/**
 * How one `SessionState` becomes the next.
 *
 * Phase 1 left this as `unknown` and said "Phase 2 defines it". This is that
 * definition. Do not narrow it further without amending the spec.
 *
 * The contract is exact, not advisory: for any two states the session model
 * produces, `applySessionPatch(prev, diffSessionState(prev, next))`
 * deep-equals `next`. `src/model/session.test.ts` asserts that round trip over
 * captured-fixture replays, so a patch shape that cannot express some change
 * fails a test rather than silently rendering a wrong tree.
 *
 * Absence means "unchanged", everywhere. An empty patch is never produced:
 * `diffSessionState` returns `undefined` when nothing changed, so a `diff`
 * message always carries a real difference.
 */
export interface SessionPatch {
  /** Session-level scalars. Only the keys that changed are present. */
  fields?: SessionFieldPatch;
  /**
   * Tree edits. Order matters, with one exception: every `removeNode` is
   * applied before any other op, so a node moving between parents cannot
   * transiently exist twice. See `applySessionPatch` in `session.ts`.
   */
  tree?: readonly TreeOp[];
  /** Whole-list replacement; present only when the edge set changed. */
  spawnEdges?: readonly SpawnEdge[];
  /**
   * Whole-list replacement; present only when the parked set changed.
   *
   * Absence means unchanged, like every other key here — so a session that
   * parked an agent on one snapshot keeps it across every later diff that does
   * not mention it.
   */
  parked?: readonly ParkedGraft[];
}

/** Session-level scalar changes. Absent key = unchanged. */
export interface SessionFieldPatch {
  projectSlug?: string;
  workspaceMatch?: boolean;
  liveness?: SessionState['liveness'];
  schemaOk?: boolean;
  /** Replaced whole. One number now, and it is cost. */
  totals?: SessionState['totals'];
  /** Replaced whole; `prompt` and `output` are never patched apart. */
  contextNow?: TokenPair;
  /** Replaced whole, same rule as {@link SessionFieldPatch.contextNow}. */
  burn?: TokenPair;
  /**
   * See {@link SessionState.windowTokens}. A bare number, never patched
   * apart from anything — there is nothing else to keep it in step with.
   *
   * Added alongside the Codex host wiring (v0.6.0 Phase 3, DoD 3.2): without
   * this key a Codex session's window-token count could be carried on the
   * first snapshot but never diffed onto the wire afterwards, which is the
   * same silent-drop shape `SessionFieldPatch.engine`'s own history warns
   * about.
   */
  windowTokens?: number;
  /**
   * See {@link SessionState.engine}.
   *
   * **This key can never be present in a patch the model produces**, and that is
   * stated here rather than left to be rediscovered: the engine that observed a
   * session cannot change while the session exists, so `diffSessionState` has
   * nothing to compare that could differ. It is carried because `PLAN.md` DoD
   * 5.1 specifies the field as "the same move as `spawnEdges` and `parked`",
   * and both of those are patch fields — uniformity, bought with a branch that
   * provably never fires. The user took that trade at the Phase 5 gate with the
   * cost stated (gate amendment B2). **Do not delete it as dead code**; it is
   * deliberate, and `applySessionPatch` honours it if it ever does arrive.
   */
  engine?: SessionState['engine'];
}

/**
 * A change to an `AgentNode`'s own scalars. `children` is never patched here
 * — child membership is expressed by `insertNode` / `removeNode` /
 * `reorderChildren`, so a node keeps its identity when its parent changes.
 *
 * `null` on an optional field means CLEARED (the field became absent);
 * an absent key means unchanged. The two are different, and the diff producer
 * distinguishes them.
 */
export interface AgentNodeFieldPatch {
  kind?: AgentNode['kind'];
  label?: string;
  status?: AgentNode['status'];
  spawnDepth?: number;
  /** Replaced whole; `prompt` and `output` are never patched apart. */
  contextNow?: TokenPair;
  /** Replaced whole, same rule as {@link AgentNodeFieldPatch.contextNow}. */
  burn?: TokenPair;
  /**
   * v0.7.0 Phase 1 — replaced whole, never appended to.
   *
   * Unlike most fields here this one genuinely changes mid-session: a series
   * GROWS as an agent takes turns, so a running panel receives it as a diff.
   * Whole replacement rather than an append op, because the property that
   * matters is exactness and an append would additionally have to say where.
   */
  usageSeries?: readonly UsageTurn[] | null;
  model?: string | null;
  /** Replaced whole, same rule as {@link AgentNodeFieldPatch.usageSeries}. */
  compactions?: readonly CompactionRecord[] | null;
  startedAt?: number;
  endedAt?: number | null;
}

/** A change to a `ToolNode`'s scalars. `null` = cleared; see {@link AgentNodeFieldPatch}. */
export interface ToolNodeFieldPatch {
  toolName?: string;
  status?: ToolNode['status'];
  inputPreview?: string;
  resultPreview?: string | null;
  durationMs?: number | null;
  /**
   * `null` = cleared. See {@link ToolNode.startedAtMs}.
   *
   * Carried for the EXACTNESS reason this file states for `truncated` and
   * `stalledSinceMs` below, and it is not theoretical here: a call is added
   * with a start and no end, and gains its end in a later patch when the
   * engine writes the result. That is a field that really moves, not one
   * carried only to keep the contract total.
   */
  startedAtMs?: number | null;
  /** `null` = cleared. See {@link ToolNode.endedAtMs}. */
  endedAtMs?: number | null;
  /** `null` = cleared. See {@link ToolNode.truncated}. */
  truncated?: boolean | null;
  /**
   * `null` = cleared. See {@link ToolNode.stalledSinceMs}.
   *
   * Carried for the SAME reason as `truncated` above, and the reason is not
   * bookkeeping: this file states the patch contract as EXACT, so an optional
   * field a patch cannot express BREAKS that property rather than merely
   * under-reporting it.
   *
   * It is also a live rendering defect without this. In a running panel a
   * stall arrives as a DIFF, not a snapshot — the host emits on a 5 s liveness
   * tick — so a patch carrying `status: 'stalled'` and no `stalledSinceMs`
   * paints the chip amber with no elapsed time beside it. A user who opens the
   * panel on an already-stalled tool would see the silence measured and a user
   * who watched it stall would not. Found by `phase-verifier` at the Phase 0c
   * gate, against a suite of 2,988 green tests.
   */
  stalledSinceMs?: number | null;
  /**
   * v0.7.0 Phase 1, and carried for the exactness reason above rather than
   * because they move.
   *
   * These three are written when a call is first seen and never change after —
   * a hash of an input that is already fixed, its position, and the file it
   * named. So in practice the patch that carries them is the ADD of a new node,
   * not an update. They are diffed anyway because `events.ts` states the patch
   * contract as exact for any two states the model produces, and a field a
   * patch cannot express breaks that property whether or not today's engines
   * happen to exercise it.
   */
  filePath?: string | null;
  inputHash?: string | null;
  ordinal?: number | null;
}

/**
 * One tree edit.
 *
 * `replaceRoot` exists because the root's id can change, and `replaceNode`
 * cannot address a node whose id is absent from the previous tree.
 */
export type TreeOp =
  /** The whole tree, when the root's identity changed. */
  | { op: 'replaceRoot'; node: AgentNode }
  /** Replace the node with this id, and its whole subtree, in place. */
  | { op: 'replaceNode'; id: string; node: TreeNode }
  /**
   * Insert `node` under `parentId`, immediately after the sibling named by
   * `afterId`; `afterId: null` means "first child".
   *
   * **A SIBLING ANCHOR, NEVER AN INDEX. This field used to be `index: number`,
   * and that is the defect `AUDIT-2026-08-27` section 7.3 identified as the
   * strongest candidate for the loss the shipped `0.1.2` was reported to
   * produce.** An index is a statement about the receiver's array, so the
   * moment the receiver's child list is one node short — because one earlier
   * op could not be applied — every later insert lands in the wrong place and
   * every later `updateTool` addresses a node that is not there. The error
   * does not stay one node wide; it compounds for the life of the session,
   * which is exactly the "the loss grew as the session went on" the user
   * reported.
   *
   * An anchor degrades instead: an unknown `afterId` appends, which is wrong
   * in ORDER and right in MEMBERSHIP, and order is recoverable from the very
   * next `reorderChildren` or from a resync. Membership is not recoverable at
   * all once a node has been dropped.
   */
  | { op: 'insertNode'; parentId: string; afterId: string | null; node: TreeNode }
  /** Detach the node with this id, and its subtree, from wherever it is. */
  | { op: 'removeNode'; id: string }
  /** Set `parentId`'s child order; `order` must be the resulting id set. */
  | { op: 'reorderChildren'; parentId: string; order: readonly string[] }
  | { op: 'updateAgent'; id: string; fields: AgentNodeFieldPatch }
  | { op: 'updateTool'; id: string; fields: ToolNodeFieldPatch };

export interface SnapshotMessage {
  type: 'snapshot';
  sessions: SessionState[];
}

export interface DiffMessage {
  type: 'diff';
  sessionId: string;
  patch: SessionPatch;
}

export interface SchemaMismatchMessage {
  type: 'schemaMismatch';
  sessionId: string;
}

/**
 * The hook tap's health, which is NOT a property of any session and therefore
 * cannot travel on `SessionState`.
 *
 * G2 in message form. When no hook events are arriving — the user has not
 * installed the hook block, or the listener failed to bind — the content tap
 * still renders a full tree, but nothing can say what is running *right now*.
 * The webview shows a banner and, per spec C4, does not nag.
 *
 * Global rather than per-session on purpose: the listener is one socket for
 * the whole window, so a per-session degraded flag would repeat one fact N
 * times and invite the two copies to disagree.
 *
 * Phase 3 addition. The spec listed three host -> webview messages and
 * simultaneously required a degraded banner; those two statements were not
 * satisfiable together, because no message carried the flag. This is the
 * smaller change: a fourth message, rather than a field on every session.
 */
/**
 * A HOOK TAP's health. DoD 5.0b: it says which tap.
 *
 * It had no `engine` field, because when it was written there was one tap and
 * the question did not arise. Then there were three engines and the message
 * still described exactly one of them - Claude Code's - while the webview
 * painted it onto every card and labelled it with that card's own engine. A
 * Codex session whose hooks were arriving and being attributed was told its
 * hooks were silent (defect D2, own eyes, 2026-09-03).
 *
 * D2's fix stopped the lie by narrowing the render to Claude Code cells. It
 * did not give the other engines a truth of their own, and that is what this
 * field is for: the message now NAMES its subject, so a tap that has something
 * to say can say it, and a surface that renders it knows what it is rendering.
 *
 * OPENCODE IS EXEMPT BY DESIGN AND WILL NEVER APPEAR HERE. It has no hook tap
 * at all - its liveness comes from a cursor on `event_sequence.seq` - so
 * "hooks silent" is not a true-or-false statement about it, it is a category
 * error. The union is `'cc' | 'codex'` rather than the three-engine tag for
 * exactly that reason: the type refuses the message that cannot be meaningful,
 * which is cheaper than a rule someone has to remember.
 */
export interface DegradedMessage {
  type: 'degraded';
  /**
   * Which tap this is about.
   *
   * Required, not optional-defaulting-to-`cc`. An absent engine defaulting to
   * Claude Code is how the panel-wide flag became a per-card lie in the first
   * place, and a default is exactly what stops a reviewer noticing that a new
   * send site forgot to say.
   */
  engine: 'cc' | 'codex';
  degraded: boolean;
  /** Absent when `degraded` is false. Mirrors `DegradedReason` in liveness.ts. */
  reason?: 'noHookEvents' | 'listenerDown';
}

/**
 * The LIVE Layer 1 facts: one `StatsRecord` per session the host currently
 * observes, as the stats pipeline last derived them (v0.7.0 Phase 4, DoD 4.1).
 *
 * Every record has already passed `validateStatsRecord` ON THE HOST. There is
 * no untrusted-input guard on the host→webview direction and there must not
 * be one — the webview is a pure renderer of what a trusted host sends, and a
 * second validator on the receiving side would be a second account of one
 * rule. A record the host could not validate never reaches the wire; it is
 * dropped and counted (`statsDropped` on the diagnostics counters line).
 */
export interface StatsSnapshotMessage {
  type: 'statsSnapshot';
  records: StatsRecord[];
}

/**
 * The STORED history: the newest record per session from the local store, in
 * session order (`startedAt` ascending, then `sessionId`), for the Trends
 * view. Same host-side validation as {@link StatsSnapshotMessage}.
 *
 * `enabled` is `agentDeck.stats.enabled` as the host read it: the Trends view
 * shows an empty state when the store is off, and "the store is off" is not
 * the same statement as "the store is empty".
 */
export interface StatsStoreMessage {
  type: 'statsStore';
  records: StatsRecord[];
  enabled: boolean;
}

/**
 * Host settings the RENDERER reads (v0.7.0 Phase 4, DoD 4.0).
 *
 * Sent when a surface is created, again on every reload (the new document
 * knows nothing), and on every configuration change. The webview's default
 * while no message has arrived is the manifest default, so no surface waits
 * on this to behave.
 *
 * **The Tweaks panel rides HERE rather than on a message of its own** (v0.8.0
 * Phase 7, DoD 7.6). It is the same fact — settings as the host read them —
 * going to a second surface, and a second type would have needed a second
 * send site kept in step with this one by hand. It is also what makes the
 * panel a renderer: the amendment says settings are the source of truth, so
 * the control's position is whatever the last one of these said.
 */
export interface SettingsMessage {
  type: 'settings';
  canvasAutoFit: boolean;
  /**
   * The four `src/sidebar/tweaks.ts` settings, keyed WITHOUT the `agentDeck.`
   * prefix, as the host read them.
   *
   * Typed structurally rather than imported from `tweaks.ts`, deliberately:
   * `bridge/apply.test.ts` pins this module's import graph, and a type-only
   * import would widen it to buy a narrowing the boundary guard already does
   * better. `isTweakKey`/`isTweakValue` are the real check, at the one place
   * untrusted input arrives.
   */
  tweaks: Readonly<Record<string, boolean | string>>;
}

/**
 * The host asks the panel to show one of its view modes (v0.7.0 Phase 4,
 * DoD 4.6b). `agentDeck.openStats` opens the panel and sends `stats`; nothing
 * else sends this. View mode stays webview-local UI state — this is a
 * REQUEST from the host, not a value the host owns.
 */
export interface ShowViewMessage {
  type: 'showView';
  mode: 'canvas' | 'list' | 'stats';
}

export type HostToWebviewMessage =
  | SnapshotMessage
  | DiffMessage
  | SchemaMismatchMessage
  | DegradedMessage
  | StatsSnapshotMessage
  | StatsStoreMessage
  | SettingsMessage
  | ShowViewMessage;

export interface ExpandNodeMessage {
  type: 'expandNode';
  sessionId: string;
  nodeId: string;
}

export interface SelectSessionMessage {
  type: 'selectSession';
  sessionId: string;
}

/**
 * The webview telling the host that it could not apply a patch and needs a
 * fresh snapshot.
 *
 * **The ONE new host<->webview message type permitted in v0.5.0**, and it
 * amends DoD 5.1's "no new host<->webview message types" — recorded at
 * `PLAN.md` Phase 5.5 DoD 5.5.2 rather than assumed here.
 *
 * Why it has to exist. Before it, `webview/store.ts` recorded a `patchFailure`
 * and its own comment said "the host owes us a snapshot" — while nothing told
 * the host anything. The host applies every patch to its own copy first and
 * re-snapshots when *its* apply fails, so a divergence that exists only on the
 * webview side was invisible to the only party that could repair it. The
 * webview then applied every later diff to a base the host did not have.
 *
 * `failedOp` is the op NAME, never the payload: this message travels from an
 * untrusted renderer to the host, and a name from a closed set is a thing the
 * host can validate. Absent when the failure was not attributable to one op.
 */
export interface ResyncRequestMessage {
  type: 'resyncRequest';
  /** Free text for the diagnostics channel. Never parsed, never branched on. */
  reason: string;
  /** The `TreeOp['op']` that could not be applied, when there was exactly one. */
  failedOp?: TreeOp['op'];
  /** The session whose patch failed, when the failure named one. */
  sessionId?: string;
}

/**
 * The SIDEBAR asking the host to run one of its menu commands (v0.7.0 Phase 4,
 * DoD 4.6b).
 *
 * `command` is a member of `src/sidebar/menu.ts`'s list and nothing else: the
 * guard in `bridge/messages.ts` refuses any other string, so the sidebar
 * cannot be turned into a way of running arbitrary commands by a message that
 * merely looks like one of its own. The PANEL ignores this message entirely;
 * only the sidebar's controller executes it.
 */
export interface RunCommandMessage {
  type: 'runCommand';
  command: string;
}

/**
 * The TWEAKS panel asking the host to write one setting (v0.8.0 Phase 7,
 * DoD 7.6).
 *
 * `key` is a member of `src/sidebar/tweaks.ts`'s list and `value` is a value
 * that member may take — both checked by `isTweakKey`/`isTweakValue` in the
 * `bridge/messages.ts` guard, at the boundary, BEFORE the host calls
 * `WorkspaceConfiguration.update`. The host writes into the user's settings
 * on the strength of this message, so a string that merely looks like a key
 * must not reach that call.
 *
 * The PANEL ignores this message entirely; only the sidebar controller acts
 * on it — the same division `runCommand` already has.
 */
export interface UpdateTweakMessage {
  type: 'updateTweak';
  /** A `TWEAK_SETTINGS` key, without the `agentDeck.` section prefix. */
  key: string;
  value: boolean | string;
}

export type WebviewToHostMessage =
  | ExpandNodeMessage
  | SelectSessionMessage
  | ResyncRequestMessage
  | RunCommandMessage
  | UpdateTweakMessage;

/**
 * One tree op that could not be applied, reported instead of thrown.
 *
 * DoD 5.5.1: "a patch whose target id is absent is an explicit `applyError`
 * with the op and id, not a throw". The distinction is deliberate and narrow —
 * a MISSING TARGET is a divergence, which is recoverable by resync, while a
 * structurally impossible patch (a tool node offered as the root) is a bug in
 * the producer and still throws. Turning the second into a soft error would
 * hide a defect in code that runs on both sides of the wire.
 */
export interface ApplyError {
  /** The op that could not be applied. */
  op: TreeOp['op'];
  /** The id the op addressed, when it addressed one. */
  id?: string;
  /** Human-readable, for the diagnostics channel. Never parsed. */
  reason: string;
}

// ---------------------------------------------------------------------------
// (c) Parser-facing types
// ---------------------------------------------------------------------------

/**
 * A JSON value as read off disk. Used where the shape is CC's business and
 * not ours; `unknown` at the leaves keeps `any` out of exported signatures.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * One parsed JSONL line from a main or subagent transcript.
 *
 * Only `type` is present on every observed line. Re-measured after the Phase 1
 * re-harvest across all 7 committed CC 2.1.234 transcripts (124 lines):
 * `type` 124/124, and `agentId` appears on all 84 subagent lines but 0 of the
 * 40 main-transcript lines. `queue-operation` carries only
 * `type`/`operation`/`timestamp`/`sessionId`; `attachment` never carries
 * `message`; `file-history-snapshot` carries nothing beyond `type`.
 * Everything except `type` is therefore optional, and the index signature keeps
 * unknown/extra fields rather than forcing callers to strip them.
 *
 * Do not tighten this from memory — re-count against the fixtures. Requiring a
 * field that real data omits refuses valid sessions, which is worse than the
 * drift the requirement would catch.
 */
export interface TranscriptEntry {
  /** e.g. 'user', 'assistant', 'system', 'queue-operation'. Never absent. */
  type: string;
  uuid?: string;
  /** `null` on the first entry of a transcript. */
  parentUuid?: string | null;
  sessionId?: string;
  /** ISO-8601 string as written by CC. */
  timestamp?: string;
  /** CC version that wrote the line; may change mid-file. */
  version?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  /** Present in subagent transcripts; names the agent that wrote the line. */
  agentId?: string;
  /** Narrowed by parse.ts; the raw message body is CC's schema, not ours. */
  message?: unknown;
  /** CC adds fields between versions; keep them rather than dropping them. */
  [key: string]: unknown;
}

/**
 * The `<sessionId>/subagents/agent-<agentId>.meta.json` sidecar.
 * `toolUseId` names the parent `tool_use` block — the primary key that makes
 * subagent attribution a join rather than an inference.
 */
export interface SubagentMeta {
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
  /** Present at spawnDepth >= 2. */
  parentAgentId?: string;
  worktreePath?: string;
  spawnedWithWorktree?: boolean;
  worktreeBranch?: string;
  [key: string]: unknown;
}

/** Why a file could not be read or was skipped wholesale. */
export interface SkippedFile {
  path: string;
  reason: string;
}

/**
 * Counters the parser accumulates instead of throwing. Malformed input
 * increments a counter and is skipped; parsing never crashes on input (G3).
 */
export interface ParseDiagnostics {
  /** Lines that were not valid JSON or lacked the minimum shape. */
  malformedLines: number;
  /** Lines successfully parsed into a `TranscriptEntry`. */
  parsedLines: number;
  /**
   * Lines skipped because their `type` is recognised and deliberately not
   * modelled — `IGNORED_ENTRY_TYPES` in `src/parser/parse.ts` (DoD 5.5.6).
   *
   * Separate from `malformedLines` because they mean different things: this
   * one says "CC writes a shape we do not read", which is a normal state of a
   * drifting undocumented format, and the other says "this line is broken",
   * which is not. Before Phase 5.5 the two were one number and a healthy
   * `2.1.246` session read as 4.8% malformed.
   */
  ignoredLines: number;
  /** Files that could not be read or were deliberately skipped. */
  skippedFiles: SkippedFile[];
}

/** A zeroed `ParseDiagnostics`. Convenience only — no state is shared. */
export function emptyDiagnostics(): ParseDiagnostics {
  return { malformedLines: 0, parsedLines: 0, ignoredLines: 0, skippedFiles: [] };
}

/**
 * The refusal result. A fingerprint failure makes the session render
 * `unsupported`; it never yields a partial tree (G3). Carries enough detail
 * to say *what* did not match.
 */
export interface SchemaMismatch {
  kind: 'schemaMismatch';
  /** Human-readable explanation, e.g. "expected subagents/ directory". */
  reason: string;
  /**
   * Where the mismatch was detected: a file path, a dotted field path, or a
   * directory that was expected by the layout fingerprint.
   */
  path?: string;
  /** The field or layout element that failed, when narrower than `path`. */
  field?: string;
  /** What the fingerprint required. */
  expected?: string;
  /** What was found instead. */
  actual?: string;
  /** CC version string observed on the offending entry, when known. */
  observedVersion?: string;
}

/** Narrowing guard for {@link ParseResult} without throwing. */
export function isSchemaMismatch(value: unknown): value is SchemaMismatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'schemaMismatch'
  );
}

/**
 * Result type letting a parse call return either data or a `SchemaMismatch`
 * without throwing. `ok: false` is a refusal, not an exception.
 */
export type ParseResult<T> =
  | { ok: true; value: T; diagnostics: ParseDiagnostics }
  | { ok: false; mismatch: SchemaMismatch; diagnostics: ParseDiagnostics };

// ---------------------------------------------------------------------------
// (d) Hook-event contract — the liveness source (spec v2 §C4 and §3)
// ---------------------------------------------------------------------------
//
// Additive to Phase 1. Nothing above this banner changed.
//
// This section is deliberately free of any string literal naming the main
// thread. Main-thread-ness is a boolean derived from key absence, never a
// sentinel id, because CC omits `agent_id` on main-thread events rather than
// sending a placeholder. A correlator matching a placeholder string would
// silently drop every main-thread event.

/**
 * A hook payload exactly as it arrives on the wire: CC's JSON, unmodified.
 *
 * Every field is optional, and deliberately so. The payload shape is NOT
 * uniform across event types — the join keys appear independently:
 *
 *   PreToolUse / PostToolUse   carry `tool_use_id` and `tool_name`
 *   SubagentStop               carries `agent_id`, no `tool_use_id`
 *   Stop                       carries neither join key
 *   SubagentStart              carries `agent_id`, and NO `tool_use_id`
 *                              (confirmed absent, 3/3 measured events)
 *
 * Because `SubagentStart` has no `tool_use_id`, a subagent's parent
 * `tool_use` block cannot be recovered from hook events alone; that join comes
 * from the JSONL sidecar's `meta.toolUseId` (see {@link SubagentMeta}). Never
 * infer a parent from a hook event.
 *
 * The index signature keeps unknown keys rather than stripping them. That is
 * not hypothetical: the measured `SubagentStart` payload carries `prompt_id`,
 * a key absent from every previously documented event.
 *
 * Key names here are CC's snake_case wire names, not Agent Deck's camelCase.
 */
export interface RawHookPayload {
  /** e.g. 'PreToolUse'. See {@link CONFIRMED_HOOK_EVENT_NAMES}. */
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /**
   * Subagent join key. The key is ABSENT ENTIRELY on main-thread events; CC
   * does not substitute a placeholder. Measured over 181 real events on CC
   * 2.1.234: `Stop` lacks it 6/6, `SubagentStop` carries it 4/4. A later
   * capture added `SubagentStart`, which carries it 3/3.
   */
  agent_id?: string;
  agent_type?: string;
  /**
   * Parent `tool_use` join key. Present on `PreToolUse`/`PostToolUse`.
   * Confirmed ABSENT on `SubagentStart` (3/3). Optional per event type — do
   * not treat it as a required field of the payload.
   */
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  /** Observed on the measured `SubagentStart` payload (3/3), a 36-char uuid. */
  prompt_id?: string;
  /** CC adds fields between versions; keep them rather than dropping them. */
  [key: string]: unknown;
}

/**
 * Hook event names actually received from real CC on the pinned version
 * 2.1.234.
 *
 * The first four were measured over a 181-event capture. `SubagentStart` was
 * added after it was registered in this repo's hook block and a later loopback
 * capture received it 3/3, all well-formed — it is no longer speculative.
 *
 * `SessionStart` was the last to be confirmed, and *why* it stayed unmeasured
 * for two phases is the reusable part: it fires once, at session onset. Every
 * earlier capture was taken by a listener that bound partway through an
 * already-running session, so the one moment it could have been observed had
 * already passed. Its absence measured nothing about CC — it measured when the
 * listener started. Settled by binding the listener FIRST and then opening a
 * fresh CC window: `fixtures/hook-events/cc-2.1.234-sessionstart.jsonl` is
 * that capture. Before recording any future name as unobserved, check that the
 * observer could have been running at the moment it would have fired.
 *
 * The measured `SessionStart` key set is exactly `session_id`,
 * `transcript_path`, `cwd`, `hook_event_name`, `source` (`source` =
 * `startup`), identical on both captured events. No `agent_id` — consistent
 * with the rule that absence of that key IS the main-thread signal — no
 * `tool_use_id`, and no `prompt_id`, which makes it the only observed type
 * lacking one (285/285 events in
 * `fixtures/hook-events/cc-2.1.234-redacted.jsonl` carry `prompt_id`).
 */
export const CONFIRMED_HOOK_EVENT_NAMES = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

export type ConfirmedHookEventName = (typeof CONFIRMED_HOOK_EVENT_NAMES)[number];

/**
 * Registered in the hook block but never yet received on the pinned version.
 *
 * EMPTY TODAY — every registered name has now been measured at least once. The
 * mechanism is kept rather than deleted: this is where a name waits between
 * being registered and being observed, and a future CC release is expected to
 * add names. While the list is empty {@link KNOWN_HOOK_EVENT_NAMES} equals
 * {@link CONFIRMED_HOOK_EVENT_NAMES} and {@link isKnownHookEventName} agrees
 * with {@link isConfirmedHookEventName} on every input; adding one literal
 * here widens {@link KnownHookEventName} and both lists automatically.
 */
export const UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES = [] as const;

/** `never` while {@link UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES} is empty. */
export type UnconfirmedKnownHookEventName =
  (typeof UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES)[number];

export type KnownHookEventName =
  | ConfirmedHookEventName
  | UnconfirmedKnownHookEventName;

/**
 * Names Agent Deck expects to see: the confirmed set plus anything registered
 * but not yet measured. This list is documentation, not a filter — the
 * listener accepts any `hook_event_name` and flags anything outside
 * {@link CONFIRMED_HOOK_EVENT_NAMES} as unconfirmed, so a future capture can
 * prove or disprove it. Nothing is ever rejected for its name.
 */
export const KNOWN_HOOK_EVENT_NAMES: readonly KnownHookEventName[] = [
  ...CONFIRMED_HOOK_EVENT_NAMES,
  ...UNCONFIRMED_KNOWN_HOOK_EVENT_NAMES,
];

/** True only for names measured on the pinned CC version. Never throws. */
export function isConfirmedHookEventName(
  value: unknown,
): value is ConfirmedHookEventName {
  return (
    typeof value === 'string' &&
    (CONFIRMED_HOOK_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/** True for the confirmed set plus any registered-but-unmeasured name. */
export function isKnownHookEventName(
  value: unknown,
): value is KnownHookEventName {
  return (
    typeof value === 'string' &&
    (KNOWN_HOOK_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/**
 * A hook payload after normalization, as consumers (the liveness engine) see
 * it.
 *
 * Two properties carry the whole correlation contract:
 *
 * - {@link isMainThread} is a boolean derived purely from whether the payload
 *   object had an `agent_id` key. It is not a string, not an id, and not
 *   comparable to any id. There is no sentinel value meaning "the thread with
 *   no agent" — ask this boolean.
 * - {@link agentId} is OMITTED from the object when the payload had no
 *   `agent_id` key. It is never defaulted and never filled with a placeholder,
 *   so `'agentId' in event === false` is a valid and meaningful test.
 *
 * The combination `isMainThread === false` with `agentId` omitted means the
 * `agent_id` key was present but unusable (null, empty, or not a string). Real
 * CC has not been observed to send that; it surfaces as an unattributable
 * subagent event rather than being silently promoted, because guessing is
 * worse than refusing (G3).
 */
export interface NormalizedHookEvent {
  /** Monotonic per-listener arrival counter, starting at 1. */
  seq: number;
  /** `Date.now()` at the moment the request body finished arriving. */
  receivedAt: number;
  /** Omitted when the payload carried no usable `hook_event_name`. */
  eventName?: string;
  /**
   * False when {@link eventName} is absent or is not one of
   * {@link CONFIRMED_HOOK_EVENT_NAMES}. An unconfirmed event is still
   * delivered — this flag is the explicit "not a confirmed type" marker, so a
   * consumer can count it without the listener having to reject it.
   */
  eventNameConfirmed: boolean;
  /** Omitted when the payload carried no usable `session_id`. */
  sessionId?: string;
  /**
   * The subagent join key. OMITTED, not defaulted, when `agent_id` was absent
   * or unusable. See the note on {@link isMainThread}.
   */
  agentId?: string;
  /** True exactly when the payload object had no `agent_id` key at all. */
  isMainThread: boolean;
  /**
   * Parent `tool_use` join key, when the event type carries one. Omitted on
   * event types that do not — notably `SubagentStart`, which has no such key
   * at all. Its absence is normal, not an error.
   */
  toolUseId?: string;
  toolName?: string;
  transcriptPath?: string;
  cwd?: string;
  /** The payload as received, unmodified. In-memory only (G7). */
  raw: RawHookPayload;
}
