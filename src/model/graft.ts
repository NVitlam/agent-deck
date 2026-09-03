/**
 * Agent Deck — the tree grafter (spec v2 C5; the v1 "stitcher").
 *
 * Builds a session's tree by joining three things that arrive independently
 * and in no guaranteed order:
 *
 *   1. `tool_use` blocks in a transcript          -> `ToolNode`s
 *   2. `subagents/agent-<id>.meta.json` sidecars  -> the graft edge, via
 *      `meta.toolUseId`, which names the exact `tool_use` block that spawned
 *      the agent
 *   3. `subagents/agent-<id>.jsonl` transcripts   -> the subagent's own
 *      `AgentNode`, which may itself contain `tool_use` blocks that other
 *      sidecars point at (`spawnDepth >= 2`, verified on real data)
 *
 * The join is a PRIMARY-KEY join, not an inference. This module does not
 * re-implement it: `attribution.ts` owns `RESOLVED` / `AMBIGUOUS` /
 * `UNRESOLVED` and this module imports it. What is added here, and only here,
 * is what `attribution.ts` deliberately left out:
 *
 *   - tree construction from the resolved edges;
 *   - explicit PARKING of everything that did not resolve;
 *   - re-joining when late data arrives, in any order.
 *
 * Grounding constraints this module is held to:
 *
 *   G1  Read-only. {@link TreeGrafter} does no I/O at all. The one loader,
 *       {@link graftSession}, opens files for reading and writes nothing.
 *   G3  Refuse, don't guess. Two separate rules:
 *         - a fingerprint mismatch yields NO tree at all, not a partial one
 *           ({@link graftSession} returns `ok: false` and no `snapshot`);
 *         - an agent whose parent is not known is PARKED with a machine-
 *           readable reason and is never attached to a guessed parent. There
 *           is no nearest-match, no "sole remaining candidate", and no
 *           fallback to the root.
 *   G6  Fixtures are law. Every measured number quoted below was re-derived
 *       from `fixtures/cc-2.1.234/` by `graft.test.ts`, not from memory.
 *   G7  In-memory only. Snapshots are frozen values; nothing is persisted.
 *
 * SCOPE: topology and the per-node facts the transcripts state outright.
 * Liveness is NOT decided here — {@link toSessionState} takes it as a required
 * argument rather than inventing one, because "is it still running" is the
 * hooks source's answer and the JSONL source must never fake it (G2).
 *
 * `totals.costUsd` is always 0, and 0 here means NOT YET COMPUTED — it does not
 * mean the session was free. There is no price table in this repo, and a
 * number derived from a rate held in an LLM's memory would be a fabrication
 * shown to a user as a fact. Whoever adds pricing must also change this field
 * from "unset" to "computed", and until then the renderer should present it as
 * unknown rather than as a dollar amount.
 */

import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type {
  AgentNode,
  ParseDiagnostics,
  SessionState,
  SubagentMeta,
  TokenPair,
  ToolNode,
  TranscriptEntry,
  TreeNode,
} from './events.js';
import { isAgentNode } from './events.js';
import type {
  AmbiguousAttribution,
  AttributionReport,
  ResolvedAttribution,
  SubagentSource,
  TranscriptSource,
  UnresolvedAttribution,
} from '../parser/attribution.js';
import { attributeSubagents, loadSessionForAttribution } from '../parser/attribution.js';
import type { FingerprintMismatch, FingerprintOptions } from '../parser/fingerprint.js';
import { fingerprintSession } from '../parser/fingerprint.js';
import type { ParseOptions } from '../parser/parse.js';
import { hydratePersistedOutputs } from '../parser/parse.js';
import { DEFAULT_MAX_PAYLOAD_BYTES, truncatePreservingMarker } from '../parser/redact.js';

// ---------------------------------------------------------------------------
// Parking — the explicit "not grafted" state
// ---------------------------------------------------------------------------

/**
 * Why an agent is not in the tree. Every code is a refusal, and every one of
 * them can be cleared by later data — that is the whole point of parking
 * rather than dropping.
 *
 * The first six mirror `attribution.ts`'s outcomes one-for-one so that no
 * information is lost in translation. The last two are the grafter's own:
 * they describe states that only exist once you are building a tree.
 */
export type ParkCode =
  /** A transcript exists for the agent but its sidecar has not arrived. */
  | 'sidecarMissing'
  /** The sidecar arrived but could not be read/parsed, so there is no key. */
  | 'sidecarUnusable'
  /** `toolUseId` is absent, non-string, or blank. */
  | 'missingJoinKey'
  /** No `tool_use` block seen so far carries the key. May resolve later. */
  | 'noMatchingToolUse'
  /** The key matches two or more `tool_use` blocks. */
  | 'ambiguousJoinKey'
  /** `parentAgentId` names an agent with no transcript and no sidecar. */
  | 'parentAgentMissing'
  /** The key resolved somewhere other than `parentAgentId` names. */
  | 'parentAgentContradiction'
  /**
   * The agent's own join resolved, but the transcript holding its parent
   * `tool_use` block belongs to an agent that is itself parked. Grafting this
   * one would require inventing the missing link, so it parks too and is
   * released the moment its ancestor resolves.
   */
  | 'parentNotGrafted';

/** One agent that is known to exist and is deliberately not in the tree. */
export interface ParkedGraft {
  agentId: string;
  code: ParkCode;
  /** The join key as read, when there was one worth quoting. */
  toolUseId?: string;
  /** Human-readable explanation, carried through from the join where possible. */
  reason: string;
  /** `parentAgentId` from the sidecar, when the sidecar supplied one. */
  parentAgentId?: string;
}

/** One resolved graft edge, stated explicitly so callers never infer it from array positions. */
export interface GraftEdge {
  /** The `tool_use` block that spawned the agent — the join key. */
  toolUseId: string;
  /** The agent that was grafted on. */
  agentId: string;
  /**
   * The `AgentNode.id` the agent was attached under: `'root'` for the main
   * transcript, or the parent agent's id for nested spawns.
   */
  parentNodeId: string;
  /** Depth walked from the root, not the sidecar's own claim. 1 = child of root. */
  depth: number;
  /** `spawnDepth` as written in the sidecar, kept even when it disagrees. */
  recordedDepth: number;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface GraftCounts {
  /** Agents attached to the tree. */
  grafted: number;
  /** Agents deliberately left off it. */
  parked: number;
  /** `ToolNode`s in the whole tree, across every agent. */
  toolNodes: number;
}

/**
 * An immutable view of the tree as of the data supplied so far.
 *
 * Deep-frozen: a consumer cannot mutate a snapshot and make a later diff lie.
 * Each call to {@link TreeGrafter.snapshot} builds a fresh object graph, so
 * two snapshots never share a node.
 */
export interface GraftSnapshot {
  sessionId: string;
  projectSlug: string;
  root: AgentNode;
  /** Agents that did not graft, in a stable order (by `agentId`). */
  parked: readonly ParkedGraft[];
  /** Resolved edges, in a stable order (by `agentId`). */
  edges: readonly GraftEdge[];
  /** Cost only. 0 means NOT YET COMPUTED — see the file header. */
  totals: { costUsd: number };
  /** The MAIN transcript's last assistant message. Not a sum. */
  contextNow: TokenPair;
  /** Summed over every agent in the tree; parked agents contribute nothing. */
  burn: TokenPair;
  counts: GraftCounts;
  /**
   * `spawnDepth` values that disagree with the depth walked from the parent
   * chain. Reported, never corrected — see `attribution.ts`.
   */
  depthMismatches: readonly { agentId: string; recorded: number; computed: number }[];
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Identity of the session being grafted. No paths — the tree is not a filesystem view. */
export interface GrafterInit {
  sessionId: string;
  projectSlug: string;
}

/** A batch of transcript lines as they arrive from the tailer or a replay. */
export interface TranscriptBatch {
  kind: 'main' | 'subagent';
  /** Absolute path of the file. Identifies the source; never rendered. */
  path: string;
  /** Required when `kind` is `'subagent'`. */
  agentId?: string;
  entries: readonly TranscriptEntry[];
}

/** A sidecar as it arrives. `meta` absent means it could not be read/parsed. */
export interface SidecarArrival {
  agentId: string;
  metaPath: string;
  meta?: SubagentMeta;
  metaFailure?: string;
}

// ---------------------------------------------------------------------------
// Preview extraction
// ---------------------------------------------------------------------------

/** Preview budget for a single node, in UTF-8 bytes. Well under redaction's 8 KB. */
export const DEFAULT_PREVIEW_BYTES = 512;

/**
 * Floor on the ceiling {@link graftSession} hands the parse/redaction layer,
 * in UTF-8 bytes. **Do not remove this as a redundant clamp — it is load
 * bearing, and its absence does not fail loudly.**
 *
 * `previewBytes` is otherwise the single ceiling: it governs the parse layer
 * and the previews alike, so a payload is cut once. Below this floor that
 * would break a different thing entirely. CC leaves a `<persisted-output>`
 * stub in the JSONL where a large tool result used to be, and the stub is
 * where the pointer to `tool-results/<id>.txt` lives:
 *
 *   <persisted-output>
 *   Output too large (62.3KB). Full output saved to: ...\\tool-results\\b6uvpgxa4.txt
 *   Preview (first 2KB): ...
 *   </persisted-output>
 *
 * The measured stub in the committed capture is **2,186 bytes**. Truncating a
 * transcript string below that cuts the closing `</persisted-output>` off, and
 * `parsePersistedOutputPointer` matches on the closing tag: it returns
 * `undefined`, hydration never runs, and the offloaded 63,774-byte payload is
 * never opened at all. Nothing throws and no counter moves — the preview just
 * shows a truncated stub. That is a silent loss of the entire G4 offload path,
 * so a `previewBytes` under this floor narrows the PREVIEW (the second,
 * marker-preserving pass in `preview()`) and never the parse. The same holds
 * for an explicit {@link GraftSessionOptions.parse} `maxPayloadBytes`: it may
 * raise the parse ceiling and is clamped up to this floor if it is lower. That
 * escape hatch was open until Phase 4 and cost nothing visible when used —
 * which is exactly why it is closed here rather than documented and left.
 *
 * Set to redaction's own 8 KB default rather than to 2,186: that is the byte
 * budget G4 already documents, and it leaves margin for a longer stub than the
 * one CC happens to write today. The alias means lowering
 * `DEFAULT_MAX_PAYLOAD_BYTES` lowers this floor with it; `graft.test.ts`
 * asserts this constant exceeds the stub actually on disk, so that coupling
 * fails a test rather than silently disabling offload hydration. That test,
 * and the one showing a 128-byte `previewBytes` still hydrates, are the guard.
 */
export const MIN_PARSE_CEILING_BYTES = DEFAULT_MAX_PAYLOAD_BYTES;

export interface GraftOptions {
  /** Per-node preview ceiling in UTF-8 bytes. Defaults to {@link DEFAULT_PREVIEW_BYTES}. */
  previewBytes?: number;
}

function contentBlocksOf(entry: TranscriptEntry): readonly unknown[] {
  const message = entry['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/**
 * Flatten a `tool_result`'s `content` to text.
 *
 * Both observed shapes are handled: a plain string (21 of 26 `tool_result`
 * blocks in the capture) and an array of `{type:'text',text}` blocks (5 of 26).
 * Anything else is JSON-stringified rather than dropped — losing a preview
 * silently is worse than showing an ugly one.
 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (typeof block !== 'object' || block === null) continue;
      const text = (block as { text?: unknown }).text;
      parts.push(typeof text === 'string' ? text : safeStringify(block));
    }
    return parts.join('\n');
  }
  if (content === undefined || content === null) return '';
  return safeStringify(content);
}

/** `JSON.stringify` that cannot throw and never returns `undefined`. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[agent-deck: value could not be serialised]';
  }
}

/**
 * A node preview: the payload cut to `previewBytes`, marked when it was cut.
 *
 * Marker-preserving, deliberately. `graftSession` hands the parse layer the
 * SAME ceiling this uses, so in the loader path a payload is cut once — but
 * that cut leaves a marker on the string, which makes the string longer than
 * the ceiling, and this function would then cut the marker back off and
 * re-mark against 8,248 bytes instead of the 63,774 the payload really had.
 * {@link truncatePreservingMarker} keeps the marker quantifying the ORIGINAL.
 *
 * Callers other than the loader (the incremental `addTranscript` path, whose
 * entries were parsed elsewhere at a ceiling this class never chose) get the
 * same protection for free: any second pass over a marked string preserves the
 * original count instead of inventing a smaller one.
 */
function preview(text: string, previewBytes: number): string {
  return truncatePreservingMarker(text, previewBytes).text;
}

// ---------------------------------------------------------------------------
// Per-transcript scan
// ---------------------------------------------------------------------------

interface ToolCall {
  toolUseId: string;
  toolName: string;
  /** Order of first appearance within the owning transcript. */
  order: number;
  inputPreview: string;
  startedAt?: number;
  resultPreview?: string;
  endedAt?: number;
  isError: boolean;
}

interface AgentAccumulator {
  agentId: string;
  /** In first-appearance order. */
  calls: ToolCall[];
  byId: Map<string, ToolCall>;
  /** Deduped token usage per assistant `message.id`; see {@link scanEntries}. */
  usageByMessage: Map<string, MessageUsage>;
  /** Next ordinal to hand out. First sighting of an id wins it. */
  usageOrdinal: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
  entryCount: number;
  /**
   * The transcript's own summary line, if it wrote one — design §0's first
   * choice for the session label, and design amendment A8.6.
   *
   * MEASURED, not assumed: the entry is `{"type":"ai-title","aiTitle":"..."}`.
   * Present in `fixtures/cc-2.1.234` and `fixtures/cc-2.1.241`; ABSENT in
   * `cc-2.1.237` and `cc-2.1.246`, which write `atis-latch` instead and carry
   * no title at all. Both branches are pinned by a real fixture, which is why
   * the fallback below is not speculative.
   */
  sessionTitle?: string;
  /** §0's second choice: the first user message's own words. */
  firstUserText?: string;
}

/**
 * One assistant message's usage, deduplicated across the lines that repeat it.
 *
 * `ordinal` is assigned at FIRST sighting and never moves, so "the last
 * message" is a statement about transcript order rather than about which line
 * happened to update a counter last. It is an ordinal and not the timestamp
 * because two lines of one streamed message share a timestamp to the second,
 * and a tie there would make `contextNow` depend on Map iteration order.
 * `at` is carried alongside for callers that want the wall time; nothing in
 * this module orders on it.
 */
interface MessageUsage {
  /** `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. */
  prompt: number;
  /** `output_tokens`. */
  output: number;
  ordinal: number;
  at?: number;
}

function epoch(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Accumulate one transcript's `tool_use`/`tool_result` blocks, timestamps and
 * token usage.
 *
 * Token de-duplication is measured, not assumed. CC writes one JSONL line per
 * content block of a streamed assistant message, and every one of those lines
 * repeats the SAME `message.usage` object updated so far: in
 * `agent-a1a53f42c5eca8824.jsonl` lines 3 and 4 share
 * `msg_011CeBgYk4Ci1ZkTxynEZh3j` with `output_tokens` 1 then 518. Summing the
 * lines would therefore double-count. We keep the MAXIMUM seen per
 * `message.id` and sum across distinct ids, which is exact for a monotonically
 * growing counter and degrades to "the largest number CC stated" if it ever
 * stops growing.
 *
 * WHAT `prompt` IS, AND WHY IT IS NOT `input_tokens`. `input_tokens` alone is
 * ~2 on every real assistant message in the anchor Claude Code corpora — the
 * prompt lives in `cache_creation_input_tokens` + `cache_read_input_tokens`.
 * On `fixtures/cc-2.1.234`, message `msg_011CeBgXDhoTEXnkTHVvjNSh` reads
 * `2 + 13390 + 28807 = 42199`, and `0.1.2` displayed the `2`.
 * `src/model/tokens.test.ts` pins that arithmetic by `message.id`.
 *
 * A session against a local model with no prompt caching puts the whole prompt
 * in `input_tokens` and leaves both cache fields at 0, which is why the rule
 * SUMS all three rather than picking whichever field looks populated. Each
 * component defaults to 0 when absent or non-finite, so a fixture without
 * cache fields still yields exactly `input_tokens` and nothing changes for it.
 * See `events.ts`'s {@link TokenPair}.
 */
/**
 * How much of a derived session label reaches the WIRE — design amendment A9.1.
 *
 * It was 26, design §0's DISPLAY ceiling, applied here with an ellipsis. A9.1
 * removed every ellipsis from every surface: the renderer wraps to two rows and
 * hover carries the rest, so the model's job is to send enough for hover to be
 * worth doing rather than to decide what fits.
 *
 * 200 rather than unbounded because the fallback source is a whole first user
 * message, which is routinely thousands of characters, and a label is not a
 * transcript. A cut at 200 is marked by nothing, deliberately: a `…` in the
 * data is a rendering decision made in the model, and it would arrive on every
 * surface including the ones with room.
 */
export const SESSION_LABEL_MAX_CHARS = 200;

/**
 * A text block the IDE injected rather than something the user typed.
 *
 * MEASURED on `fixtures/cc-2.1.234`: the first user entry's content array
 * begins `<ide_opened_file>The user opened the file ... in the IDE.` and the
 * person's actual first sentence is the SECOND block. A label taken from block
 * zero would name a file nobody mentioned, on every session opened from an
 * editor — which is every session this product observes.
 */
const INJECTED_BLOCK = /^\s*<[a-z_]+>/i;

/**
 * A slash command, as Claude Code actually writes it into the transcript.
 *
 * MEASURED on the committed fixtures, and BOTH ORDERINGS OCCUR, which is why
 * nothing here depends on position:
 *
 *   fixtures/cc-2.1.241/…/6082be25…jsonl
 *     `<command-name>/compact</command-name>` then `<command-message>` then
 *     an EMPTY `<command-args></command-args>`
 *   fixtures/synthetic-dropped-actions/…/41194183…jsonl
 *     `<command-message>phase</command-message>` then
 *     `<command-name>/phase</command-name>`, with no `<command-args>` at all
 *
 * `INJECTED_BLOCK` above does not catch these and cannot be made to: its class
 * is `[a-z_]+`, and every tag in this family carries a HYPHEN. So the raw
 * wrapper reached `firstUserText` and a session opened with `/phase` was
 * labelled, on the deck card and on the tree root, with the literal
 * `<command-message>phase</command-message> <command-name>/phase</command-name>`.
 * Reported by own eyes against the shipped build (D3, 2026-09-03); the Claude
 * Code engine has shipped it since v0.5.0.
 *
 * The rule: the label is the command NAME with any ARGS appended — `/phase`,
 * or `/phase 3` — and no `<command-*>` markup survives into it.
 */
const COMMAND_NAME_TAG = /<command-name>([\s\S]*?)<\/command-name>/i;
const COMMAND_ARGS_TAG = /<command-args>([\s\S]*?)<\/command-args>/i;
/** Every tag in the family, WITH its content: nothing of it reaches a label. */
const COMMAND_ANY_TAG = /<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/gi;

/**
 * `<command-*>` wrapper -> the command as a person typed it, or `null`.
 *
 * `null` means "not a command wrapper", never "an empty label": a
 * `<command-name>` whose content is blank is not a command, and returning `''`
 * would put an empty string where the id fallback belongs.
 */
export function commandLabelFrom(text: string): string | null {
  const name = stripCommandTags(COMMAND_NAME_TAG.exec(text)?.[1] ?? '');
  if (name === '') return null;
  const args = stripCommandTags(COMMAND_ARGS_TAG.exec(text)?.[1] ?? '');
  return args === '' ? name : `${name} ${args}`;
}

/**
 * Remove every `<command-*>` tag from a captured name or argument list.
 *
 * The tags NEST — `<command-args><command-name>/y</command-name></command-args>`
 * is well-formed and the args regex above captures the inner element whole. Not
 * reachable from any committed fixture, and found by `phase-verifier` probing
 * the boundary rather than by the corpus, which is the only way it was ever
 * going to be found. Without this the composed label carries markup and the
 * user-facing claim that none of it reaches a label is simply false.
 */
function stripCommandTags(value: string): string {
  return value.replace(/<\/?command-[a-z-]+>/gi, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * The text a label may be built from: the wrapper's own words if it is a
 * command, otherwise the text with any stray `<command-*>` block removed.
 *
 * The second half is not decoration. A message that quotes a command tag
 * without being one — or a future member of the family this build has not
 * met — must not put markup on a card either, and stripping the tag WITH its
 * content is what guarantees that. An empty result is no label at all, so the
 * caller keeps looking.
 */
function labelSourceFrom(text: string): string | null {
  const command = commandLabelFrom(text);
  if (command !== null) return command;
  if (!/<command-[a-z-]+>/i.test(text)) return text;
  const stripped = text.replace(COMMAND_ANY_TAG, '').trim();
  return stripped === '' ? null : stripped;
}

/**
 * §0's label sources, captured as the entries go past — A8.6.
 *
 * FIRST WINS for both, so a re-read of the same transcript cannot change a
 * label that is already on screen. Neither source is required: a session with
 * no title and no user text keeps the id, which is §0's own `label-fallback`
 * and is the honest answer rather than an invented phrase.
 */
function captureSessionLabel(acc: AgentAccumulator, entry: TranscriptEntry): void {
  if (acc.sessionTitle === undefined && entry['type'] === 'ai-title') {
    const title = entry['aiTitle'];
    if (typeof title === 'string' && title.trim() !== '') acc.sessionTitle = title.trim();
    return;
  }
  if (acc.firstUserText !== undefined || entry['type'] !== 'user') return;
  const message = entry['message'];
  if (typeof message !== 'object' || message === null) return;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    const text = content.trim();
    if (text === '') return;
    // A command wrapper is checked BEFORE the injected-block skip, and it has
    // to be: it is the user's own first action, not something the IDE put in
    // front of it, and `INJECTED_BLOCK` cannot see it anyway (D3).
    const source = labelSourceFrom(text);
    if (source !== null && !INJECTED_BLOCK.test(source)) acc.firstUserText = source;
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== 'text' || typeof b.text !== 'string') continue;
    const text = b.text.trim();
    if (text === '') continue;
    const source = labelSourceFrom(text);
    if (source === null || INJECTED_BLOCK.test(source)) continue;
    acc.firstUserText = source;
    return;
  }
}

/** One line, bounded for the wire. No ellipsis (A9.1). Never mid-surrogate. */
function toSessionLabel(text: string): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  const chars = [...oneLine];
  if (chars.length <= SESSION_LABEL_MAX_CHARS) return oneLine;
  return chars.slice(0, SESSION_LABEL_MAX_CHARS).join('');
}

function scanEntries(acc: AgentAccumulator, entries: readonly TranscriptEntry[], previewBytes: number): void {
  for (const entry of entries) {
    acc.entryCount++;
    captureSessionLabel(acc, entry);
    const at = epoch(entry['timestamp']);
    if (at !== undefined) {
      if (acc.firstTimestamp === undefined || at < acc.firstTimestamp) acc.firstTimestamp = at;
      if (acc.lastTimestamp === undefined || at > acc.lastTimestamp) acc.lastTimestamp = at;
    }

    const message = entry['message'];
    if (typeof message === 'object' && message !== null) {
      const m = message as { id?: unknown; usage?: unknown };
      const usage = m.usage;
      if (typeof m.id === 'string' && typeof usage === 'object' && usage !== null) {
        const u = usage as {
          input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          output_tokens?: unknown;
        };
        const promptTok =
          countOf(u.input_tokens) +
          countOf(u.cache_creation_input_tokens) +
          countOf(u.cache_read_input_tokens);
        const outTok = countOf(u.output_tokens);
        const prev = acc.usageByMessage.get(m.id);
        const next: MessageUsage = {
          prompt: prev === undefined ? promptTok : Math.max(prev.prompt, promptTok),
          output: prev === undefined ? outTok : Math.max(prev.output, outTok),
          // First sighting owns the ordinal. A later line of the same streamed
          // message updates the counters and must NOT move the message.
          ordinal: prev === undefined ? acc.usageOrdinal++ : prev.ordinal,
        };
        const stamp = at ?? prev?.at;
        if (stamp !== undefined) next.at = stamp;
        acc.usageByMessage.set(m.id, next);
      }
    }

    for (const block of contentBlocksOf(entry)) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        is_error?: unknown;
      };

      if (b.type === 'tool_use') {
        if (typeof b.id !== 'string' || b.id.trim() === '') continue;
        // A repeated id inside one transcript keeps the first sighting: the
        // call site is where the tool was invoked, and re-reading the same
        // file must not shuffle the tree.
        if (acc.byId.has(b.id)) continue;
        const call: ToolCall = {
          toolUseId: b.id,
          toolName: typeof b.name === 'string' ? b.name : '',
          order: acc.calls.length,
          inputPreview: preview(safeStringify(b.input ?? {}), previewBytes),
          isError: false,
        };
        if (at !== undefined) call.startedAt = at;
        acc.calls.push(call);
        acc.byId.set(b.id, call);
        continue;
      }

      if (b.type === 'tool_result') {
        if (typeof b.tool_use_id !== 'string') continue;
        const call = acc.byId.get(b.tool_use_id);
        // A result whose call has not been seen is NOT a reason to invent a
        // call node. It is dropped here and picked up when the call arrives,
        // because transcripts are replayed in file order and the call always
        // precedes its result in the same file.
        if (call === undefined) continue;
        call.resultPreview = preview(resultText(b.content), previewBytes);
        if (b.is_error === true) call.isError = true;
        if (at !== undefined) call.endedAt = at;
        continue;
      }
    }
  }
}

/**
 * A `usage` component as a number: absent, non-finite or the wrong type is 0.
 *
 * Named rather than inlined three times, because "defaulting to 0 when absent
 * or non-finite" is the rule for every component and a copy that forgets
 * `Number.isFinite` turns one `NaN` into a `NaN` total.
 */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Everything this agent spent: summed across distinct `message.id`. */
function usageBurn(acc: AgentAccumulator): TokenPair {
  let prompt = 0;
  let output = 0;
  for (const u of acc.usageByMessage.values()) {
    prompt += u.prompt;
    output += u.output;
  }
  return { prompt, output };
}

/**
 * How full this agent's context is right now: its LAST assistant message by
 * ordinal, not a sum.
 *
 * An agent with no assistant message yet has no context level to report, and
 * `{ prompt: 0, output: 0 }` is the honest answer for it rather than a
 * placeholder — the tree shows a node with no message as having sent nothing,
 * which it has not.
 */
function usageContextNow(acc: AgentAccumulator): TokenPair {
  let best: MessageUsage | undefined;
  for (const u of acc.usageByMessage.values()) {
    if (best === undefined || u.ordinal > best.ordinal) best = u;
  }
  return best === undefined
    ? { prompt: 0, output: 0 }
    : { prompt: best.prompt, output: best.output };
}

// ---------------------------------------------------------------------------
// The grafter
// ---------------------------------------------------------------------------

/** Internal id of the main transcript's agent node. Matches `events.ts`. */
export const ROOT_NODE_ID = 'root';

/**
 * Incremental, order-independent tree builder.
 *
 * Feed it transcript batches and sidecars in ANY order; call
 * {@link snapshot} whenever you want the current tree. The snapshot is
 * recomputed from the accumulated state each time rather than patched in
 * place: a patched tree can drift from the data that produced it, and the
 * whole value of this component is that it cannot.
 */
export class TreeGrafter {
  private readonly sessionId: string;
  private readonly projectSlug: string;
  private readonly previewBytes: number;

  /** Main transcript accumulator, created eagerly so `root` always exists. */
  private readonly main: AgentAccumulator;
  /** Subagent transcripts, keyed by `agentId`. */
  private readonly agents = new Map<string, AgentAccumulator>();
  /** Sidecars, keyed by `agentId`. */
  private readonly sidecars = new Map<string, SidecarArrival>();
  /** Paths already ingested, per source, so a full re-read is idempotent. */
  private readonly consumed = new Map<string, number>();
  /** Hydrated `tool-results/` payloads, keyed by `tool_use` id. */
  private readonly hydrated = new Map<string, string>();

  constructor(init: GrafterInit, options: GraftOptions = {}) {
    this.sessionId = init.sessionId;
    this.projectSlug = init.projectSlug;
    this.previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
    this.main = newAccumulator(ROOT_NODE_ID);
  }

  /**
   * Append a batch of parsed lines.
   *
   * Appending is cumulative and position-tracked per path, so replaying a
   * whole file after having seen its first N lines adds only the new ones.
   * A subagent batch without an `agentId` is ignored: the file name is the
   * only place the id comes from, and guessing it would invent an agent.
   */
  addTranscript(batch: TranscriptBatch): void {
    if (batch.kind === 'subagent' && (batch.agentId === undefined || batch.agentId === '')) return;
    const acc = batch.kind === 'main' ? this.main : this.agentAccumulator(batch.agentId ?? '');
    const already = this.consumed.get(batch.path) ?? 0;
    const fresh = batch.entries.slice(already);
    if (fresh.length > 0) scanEntries(acc, fresh, this.previewBytes);
    this.consumed.set(batch.path, already + fresh.length);
  }

  /** Register a sidecar. A later arrival for the same agent replaces an earlier one. */
  addSidecar(arrival: SidecarArrival): void {
    if (arrival.agentId === '') return;
    this.sidecars.set(arrival.agentId, arrival);
    // Knowing the sidecar is enough to know the agent exists, even with no
    // transcript yet — so it can be parked rather than being invisible.
    this.agentAccumulator(arrival.agentId);
  }

  /**
   * Supply an offloaded `tool-results/<id>.txt` payload for a `tool_use` id.
   *
   * Kept separate from {@link addTranscript} because reading that file is I/O
   * and this class does none. The payload replaces the `<persisted-output>`
   * stub in the node's `resultPreview`.
   */
  addToolResultPayload(toolUseId: string, text: string): void {
    if (toolUseId === '') return;
    this.hydrated.set(toolUseId, preview(text, this.previewBytes));
  }

  /** Agents this grafter knows about, from a transcript or a sidecar. */
  knownAgentIds(): readonly string[] {
    return [...this.agents.keys()].sort();
  }

  private agentAccumulator(agentId: string): AgentAccumulator {
    const existing = this.agents.get(agentId);
    if (existing !== undefined) return existing;
    const created = newAccumulator(agentId);
    this.agents.set(agentId, created);
    return created;
  }

  /** Run the join over everything seen so far. Exposed for tests and diagnostics. */
  attribution(): AttributionReport {
    // `attributeSubagents` indexes `tool_use` blocks out of raw entries; we
    // have already reduced them to calls, so we hand it a synthetic entry
    // carrying exactly the blocks we saw. This keeps ONE implementation of the
    // join (attribution.ts) rather than a second, subtly different one here.
    // Paths are session-relative names, never filesystem paths: nothing in a
    // snapshot may depend on where the fixtures happen to live.
    const transcripts: TranscriptSource[] = [
      {
        kind: 'main',
        path: `${this.sessionId}.jsonl`,
        entries: [syntheticToolUseEntry(this.main.calls)],
      },
    ];
    for (const [agentId, acc] of this.agents) {
      transcripts.push({
        kind: 'subagent',
        path: `${agentId}.jsonl`,
        agentId,
        entries: [syntheticToolUseEntry(acc.calls)],
      });
    }
    const subagents: SubagentSource[] = [...this.sidecars.values()]
      .map((s) => {
        const source: SubagentSource = { agentId: s.agentId, metaPath: s.metaPath };
        if (s.meta !== undefined) source.meta = s.meta;
        if (s.metaFailure !== undefined) source.metaFailure = s.metaFailure;
        return source;
      })
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
    return attributeSubagents({ transcripts, subagents });
  }

  /**
   * Build the tree from everything seen so far.
   *
   * Two passes, in this order and for this reason:
   *
   *   1. the join decides which agents have a parent AT ALL (attribution.ts);
   *   2. the tree is grown from the root outwards, so an agent whose resolved
   *      parent transcript is itself parked never gets attached — it parks
   *      with `parentNotGrafted` instead of being hoisted to the root.
   *
   * Pass 2 is what makes out-of-order arrival safe: it is a fixpoint over the
   * data present, not a record of the order it arrived in.
   */
  snapshot(): GraftSnapshot {
    const report = this.attribution();
    const parked: ParkedGraft[] = [];
    const edges: GraftEdge[] = [];

    /** agentId -> the resolved attribution, for the agents that have one. */
    const resolved = new Map<string, ResolvedAttribution>();
    for (const a of report.attributions) {
      if (a.status === 'resolved') resolved.set(a.agentId, a);
      else parked.push(parkFromAttribution(a, this.sidecars.get(a.agentId)));
    }

    // Agents known only from a transcript: no sidecar has arrived, so there is
    // no join key at all. Explicitly parked, not silently ignored.
    for (const agentId of this.agents.keys()) {
      if (this.sidecars.has(agentId)) continue;
      parked.push({
        agentId,
        code: 'sidecarMissing',
        reason: `agent ${agentId} has a transcript but no sidecar has arrived, so there is no join key yet`,
      });
    }

    // --- pass 2: grow from the root, refusing to hoist orphans --------------
    /** Parent node id keyed by the agentId whose TRANSCRIPT holds the tool_use. */
    const childrenOf = new Map<string, ResolvedAttribution[]>();
    for (const a of resolved.values()) {
      const holder = a.parent.transcriptKind === 'main' ? ROOT_NODE_ID : (a.parent.agentId ?? '');
      const list = childrenOf.get(holder);
      if (list === undefined) childrenOf.set(holder, [a]);
      else list.push(a);
    }

    const grafted = new Set<string>();
    const build = (
      acc: AgentAccumulator,
      nodeId: string,
      depth: number,
      spawn: ToolCall | undefined,
    ): AgentNode => {
      const children: TreeNode[] = [];
      const spawnsAt = new Map<string, ResolvedAttribution[]>();
      for (const child of childrenOf.get(nodeId) ?? []) {
        const list = spawnsAt.get(child.toolUseId);
        if (list === undefined) spawnsAt.set(child.toolUseId, [child]);
        else list.push(child);
      }

      for (const call of acc.calls) {
        children.push(this.toolNode(call));
        // The subagent hangs beside the `tool_use` that spawned it, in the
        // same children array: `ToolNode` has no `children` field in the
        // spec'd model, so adjacency plus the explicit `edges` list is the
        // graft record. Deterministic order: by agentId within one call.
        const spawned = (spawnsAt.get(call.toolUseId) ?? [])
          .slice()
          .sort((a, b) => a.agentId.localeCompare(b.agentId));
        for (const child of spawned) {
          const childAcc = this.agents.get(child.agentId);
          if (childAcc === undefined) continue;
          grafted.add(child.agentId);
          edges.push({
            toolUseId: child.toolUseId,
            agentId: child.agentId,
            parentNodeId: nodeId,
            depth: depth + 1,
            recordedDepth: child.recordedDepth,
          });
          children.push(build(childAcc, child.agentId, depth + 1, call));
        }
      }

      const sidecar = this.sidecars.get(acc.agentId);
      const node: AgentNode = {
        id: nodeId,
        kind: nodeId === ROOT_NODE_ID ? 'main' : 'subagent',
        label: this.labelFor(nodeId, sidecar?.meta),
        status: agentStatus(spawn),
        spawnDepth: depth,
        children,
        contextNow: usageContextNow(acc),
        burn: usageBurn(acc),
        startedAt: acc.firstTimestamp ?? 0,
      };
      if (spawn?.endedAt !== undefined) node.endedAt = spawn.endedAt;
      return node;
    };

    const root = build(this.main, ROOT_NODE_ID, 0, undefined);

    // Anything that resolved but never got reached from the root is parked:
    // its parent transcript belongs to an agent that is itself parked.
    for (const a of resolved.values()) {
      if (grafted.has(a.agentId)) continue;
      const park: ParkedGraft = {
        agentId: a.agentId,
        code: 'parentNotGrafted',
        toolUseId: a.toolUseId,
        reason: `agent ${a.agentId} joins ${a.toolUseId} in ${a.parent.transcriptKind === 'main' ? 'the main transcript' : `agent ${String(a.parent.agentId)}'s transcript`}, which is not itself grafted yet`,
      };
      const declared = this.sidecars.get(a.agentId)?.meta?.parentAgentId;
      if (typeof declared === 'string' && declared !== '') park.parentAgentId = declared;
      parked.push(park);
    }

    parked.sort((a, b) => a.agentId.localeCompare(b.agentId));
    edges.sort((a, b) => a.agentId.localeCompare(b.agentId));

    // `burn` sums over every agent in the tree; `contextNow` does NOT, and
    // that asymmetry is the whole point of the split. A context window is a
    // level and the session's level is the MAIN transcript's — each subagent
    // has its own window, so adding them answers no question anyone asked.
    let burnPrompt = 0;
    let burnOutput = 0;
    let toolNodes = 0;
    walk(root, (node) => {
      if (isAgentNode(node)) {
        burnPrompt += node.burn?.prompt ?? 0;
        burnOutput += node.burn?.output ?? 0;
      } else {
        toolNodes++;
      }
    });

    const snapshot: GraftSnapshot = {
      sessionId: this.sessionId,
      projectSlug: this.projectSlug,
      root,
      parked,
      edges,
      // costUsd 0 means NOT YET COMPUTED, never "free". There is no price
      // table in this repo and inventing one would put a fabricated number in
      // front of the user. See the file header.
      totals: { costUsd: 0 },
      // Read from the MAIN accumulator, not back off `root.contextNow`:
      // `AgentNode.contextNow` is optional (an engine may not report one) and
      // this snapshot's field is not. Same value, no `undefined` to launder.
      contextNow: usageContextNow(this.main),
      burn: { prompt: burnPrompt, output: burnOutput },
      counts: { grafted: grafted.size, parked: parked.length, toolNodes },
      depthMismatches: report.depthMismatches.map((d) => ({
        agentId: d.agentId,
        recorded: d.recorded,
        computed: d.computed,
      })),
    };
    return deepFreeze(snapshot);
  }

  private toolNode(call: ToolCall): ToolNode {
    const hydrated = this.hydrated.get(call.toolUseId);
    const resultPreview = hydrated ?? call.resultPreview;
    const node: ToolNode = {
      id: call.toolUseId,
      toolName: call.toolName,
      // `done` is stated by the data (a `tool_result` arrived). `running` is
      // the absence of that statement, not a claim that it is still going.
      status: call.isError ? 'error' : call.resultPreview === undefined ? 'running' : 'done',
      inputPreview: call.inputPreview,
    };
    if (resultPreview !== undefined) node.resultPreview = resultPreview;
    if (call.startedAt !== undefined && call.endedAt !== undefined) {
      node.durationMs = call.endedAt - call.startedAt;
    }
    return node;
  }

  private labelFor(nodeId: string, meta: SubagentMeta | undefined): string {
    // THE ROOT'S LABEL COMES FROM THE TRANSCRIPT — design §0, implemented at
    // amendment A8.6. This line returned `this.sessionId` unconditionally from
    // the first release until 2026-08-29, so §0's `label-fallback` fired on
    // every session that ever rendered and the deck card and the tree root both
    // showed an id where a label belongs. `webview/store.ts` maps this straight
    // onto `SessionSummary.label`, so one line fixes both surfaces.
    if (nodeId === ROOT_NODE_ID) {
      const title = this.main.sessionTitle;
      if (title !== undefined) return toSessionLabel(title);
      const first = this.main.firstUserText;
      if (first !== undefined) return toSessionLabel(first);
      return this.sessionId;
    }
    if (meta === undefined) return nodeId;
    const type = typeof meta.agentType === 'string' ? meta.agentType : '';
    const description = typeof meta.description === 'string' ? meta.description : '';
    return description === '' ? type : `${type}: ${description}`;
  }

}

/**
 * A subagent is `done` once the `tool_use` that spawned it carries a
 * `tool_result` — the parent transcript stating outright that the call
 * returned. The root has no such statement anywhere in the JSONL, so it stays
 * `running`: whether a session has ended is the hooks source's answer (G2),
 * which is why {@link toSessionState} takes liveness as an argument.
 */
function agentStatus(spawn: ToolCall | undefined): AgentNode['status'] {
  if (spawn === undefined) return 'running';
  if (spawn.isError) return 'error';
  return spawn.resultPreview === undefined ? 'running' : 'done';
}

function newAccumulator(agentId: string): AgentAccumulator {
  return {
    agentId,
    calls: [],
    byId: new Map(),
    usageByMessage: new Map(),
    usageOrdinal: 0,
    entryCount: 0,
  };
}

/**
 * Wrap already-scanned calls back into the one entry shape
 * `attribution.indexToolUses` reads. Deliberate: the join lives in exactly one
 * module and this class does not get its own copy of it.
 */
function syntheticToolUseEntry(calls: readonly ToolCall[]): TranscriptEntry {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: calls.map((c) => ({ type: 'tool_use', id: c.toolUseId, name: c.toolName })),
    },
  };
}

function parkFromAttribution(
  a: AmbiguousAttribution | UnresolvedAttribution,
  sidecar: SidecarArrival | undefined,
): ParkedGraft {
  const park: ParkedGraft = {
    agentId: a.agentId,
    code: a.status === 'ambiguous' ? 'ambiguousJoinKey' : a.code,
    reason: a.reason,
  };
  if (a.toolUseId !== undefined) park.toolUseId = a.toolUseId;
  const declared = sidecar?.meta?.parentAgentId;
  if (typeof declared === 'string' && declared !== '') park.parentAgentId = declared;
  return park;
}

/** Depth-first walk over a tree, parents before children. */
export function walk(node: TreeNode, visit: (node: TreeNode) => void): void {
  visit(node);
  if (!isAgentNode(node)) return;
  for (const child of node.children) walk(child, visit);
}

/** Every `AgentNode` in the tree, root first, in child order. */
export function agentNodes(root: AgentNode): AgentNode[] {
  const out: AgentNode[] = [];
  walk(root, (node) => {
    if (isAgentNode(node)) out.push(node);
  });
  return out;
}

/** Find one node by id, or `undefined`. Ids are unique within a snapshot. */
export function findNode(root: AgentNode, id: string): TreeNode | undefined {
  let hit: TreeNode | undefined;
  walk(root, (node) => {
    if (hit === undefined && node.id === id) hit = node;
  });
  return hit;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Serialization — what the golden snapshots pin
// ---------------------------------------------------------------------------

/**
 * A canonical, machine-independent rendering of a snapshot.
 *
 * Three rules, all of them about reproducibility on a machine that is not the
 * one that captured the fixtures:
 *
 *   1. no absolute paths — nothing here comes from the filesystem layout;
 *   2. no wall-clock values — every timestamp is derived from a fixture line,
 *      and `startedAt` is rendered as an OFFSET from the session's first
 *      timestamp so a re-harvest changes one anchor rather than every node;
 *   3. previews are pinned by `sha256:<first 16 hex>` + byte length rather
 *      than verbatim, because tool inputs in the captured sessions embed the
 *      capturing machine's absolute paths. The digest still fails loudly if a
 *      preview changes by one byte.
 */
export interface SerializedNode {
  [key: string]: unknown;
}

export interface SerializedSnapshot {
  sessionId: string;
  projectSlug: string;
  /** ISO-8601 of the session's earliest timestamp; the anchor for all offsets. */
  epochAnchor: string | null;
  root: SerializedNode;
  parked: ParkedGraft[];
  edges: GraftEdge[];
  totals: GraftSnapshot['totals'];
  contextNow: TokenPair;
  burn: TokenPair;
  counts: GraftCounts;
  depthMismatches: GraftSnapshot['depthMismatches'];
}

/**
 * `sha256:<first 16 hex>:<utf8 byte length>` of a preview.
 *
 * Goldens pin previews by digest rather than verbatim because the captured
 * sessions' tool inputs embed the capturing machine's absolute paths, and a
 * golden containing those is a golden that only reproduces on that machine.
 * The digest still fails on a one-byte change.
 */
export function previewFingerprint(text: string | undefined): string | null {
  if (text === undefined) return null;
  const bytes = Buffer.from(text, 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}:${bytes.byteLength}`;
}

function serializeNode(node: TreeNode, anchor: number | undefined): SerializedNode {
  if (!isAgentNode(node)) {
    const out: SerializedNode = {
      node: 'tool',
      id: node.id,
      toolName: node.toolName,
      status: node.status,
      inputPreview: previewFingerprint(node.inputPreview),
      resultPreview: previewFingerprint(node.resultPreview),
      durationMs: node.durationMs ?? null,
    };
    return out;
  }
  return {
    node: 'agent',
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: node.status,
    spawnDepth: node.spawnDepth,
    contextNow: node.contextNow === undefined ? null : { ...node.contextNow },
    burn: node.burn === undefined ? null : { ...node.burn },
    startedAtOffsetMs: anchor === undefined || node.startedAt === 0 ? null : node.startedAt - anchor,
    endedAtOffsetMs: anchor === undefined || node.endedAt === undefined ? null : node.endedAt - anchor,
    children: node.children.map((child) => serializeNode(child, anchor)),
  };
}

/** Canonical form of a snapshot, ready to `JSON.stringify(…, null, 2)` into a golden. */
export function serializeSnapshot(snapshot: GraftSnapshot): SerializedSnapshot {
  let anchor: number | undefined;
  walk(snapshot.root, (node) => {
    if (!isAgentNode(node)) return;
    if (node.startedAt === 0) return;
    if (anchor === undefined || node.startedAt < anchor) anchor = node.startedAt;
  });
  return {
    sessionId: snapshot.sessionId,
    projectSlug: snapshot.projectSlug,
    epochAnchor: anchor === undefined ? null : new Date(anchor).toISOString(),
    root: serializeNode(snapshot.root, anchor),
    parked: snapshot.parked.map((p) => ({ ...p })),
    edges: snapshot.edges.map((e) => ({ ...e })),
    totals: { ...snapshot.totals },
    contextNow: { ...snapshot.contextNow },
    burn: { ...snapshot.burn },
    counts: { ...snapshot.counts },
    depthMismatches: snapshot.depthMismatches.map((d) => ({ ...d })),
  };
}

/** The exact text a golden file holds: canonical JSON, LF endings, trailing newline. */
export function goldenText(snapshot: GraftSnapshot): string {
  return `${JSON.stringify(serializeSnapshot(snapshot), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Composing a SessionState
// ---------------------------------------------------------------------------

/**
 * Facts the grafter cannot learn from transcripts and therefore will not
 * invent. Both are required arguments, deliberately.
 */
export interface SessionFacts {
  /** From the hooks source. The JSONL source never decides this (G2). */
  liveness: SessionState['liveness'];
  /** Whether the session's slug matches the open workspace. */
  workspaceMatch: boolean;
}

/** Compose the webview-facing `SessionState` from a snapshot plus the facts above. */
export function toSessionState(snapshot: GraftSnapshot, facts: SessionFacts): SessionState {
  return {
    sessionId: snapshot.sessionId,
    projectSlug: snapshot.projectSlug,
    workspaceMatch: facts.workspaceMatch,
    liveness: facts.liveness,
    schemaOk: true,
    root: snapshot.root,
    totals: { ...snapshot.totals },
    contextNow: { ...snapshot.contextNow },
    burn: { ...snapshot.burn },
  };
}

// ---------------------------------------------------------------------------
// Loader — the only part that touches the disk
// ---------------------------------------------------------------------------

export interface GraftSessionOptions extends GraftOptions, FingerprintOptions {
  /**
   * Parse options, forwarded to the parse/redaction layer.
   *
   * `maxPayloadBytes` is DERIVED — `max(previewBytes, MIN_PARSE_CEILING_BYTES)`
   * — unless this object sets it explicitly. An explicit value still WINS over
   * `previewBytes`, exactly as before, but it can no longer go below
   * {@link MIN_PARSE_CEILING_BYTES}: the effective ceiling is
   * `max(this, MIN_PARSE_CEILING_BYTES)`.
   *
   * The clamp is deliberate and it is a behaviour change from the version that
   * let an explicit value win outright. Measured through the production path
   * on the committed capture, with the offloaded 63,774-byte payload:
   *
   *     {previewBytes:512}                              -> "===== run.mjs =====…"
   *                                                        marker "512 of 63774"
   *     {previewBytes:512, parse:{maxPayloadBytes:512}} -> "<persisted-output>…"
   *                                                        marker "512 of 2186"
   *
   * A ceiling under the floor cuts CC's ~2.2 KB `<persisted-output>` stub
   * before its closing tag, `parsePersistedOutputPointer` returns `undefined`,
   * the offloaded file is never opened, and the preview silently becomes the
   * stub. No throw, no counter, no diagnostic — the G4 offload path just stops
   * existing. G4 is build-time law, so it is not something a caller may switch
   * off by naming one number; the knob for shorter previews is `previewBytes`,
   * which narrows the preview without touching hydration.
   *
   * Any value at or above the floor is honoured as it always was, including
   * one below `previewBytes`, which reintroduces a double cut: the marker
   * reports the original size, and the kept bytes are the smaller of the two
   * ceilings. Only the below-floor range changed.
   */
  parse?: ParseOptions;
  /** Read `tool-results/*.txt` payloads into previews. Default `true`. */
  hydrateToolResults?: boolean;
}

/**
 * A refusal carries NO tree. `mismatch` is the whole answer (G3): a session
 * whose layout does not fingerprint renders `unsupported`, never a partial
 * tree assembled from the parts that happened to parse.
 */
export type GraftSessionResult =
  | { ok: true; snapshot: GraftSnapshot; diagnostics: ParseDiagnostics }
  | { ok: false; mismatch: FingerprintMismatch; diagnostics: ParseDiagnostics };

/**
 * Fingerprint, read and graft one session, identified by its main transcript.
 *
 * Read-only: `fingerprintSession` and `loadSessionForAttribution` open files
 * for reading and this function adds only `hydratePersistedOutputs`, which
 * does the same. Nothing is written, anywhere (G1).
 */
export async function graftSession(
  mainTranscript: string,
  options: GraftSessionOptions = {},
): Promise<GraftSessionResult> {
  const fingerprintOptions: FingerprintOptions = {};
  if (options.pinnedVersion !== undefined) fingerprintOptions.pinnedVersion = options.pinnedVersion;
  const fingerprinted = await fingerprintSession(mainTranscript, fingerprintOptions);
  if (!fingerprinted.ok) {
    return { ok: false, mismatch: fingerprinted.mismatch, diagnostics: fingerprinted.diagnostics };
  }

  const fp = fingerprinted.value;

  // ---- ONE ceiling, applied once above 8 KB (Phase 4 carry-forward A) ----
  // The parse/redaction layer is given the ceiling the grafter's previews use,
  // so `previewBytes` genuinely controls the kept payload. Before this, parse
  // cut at `redact.DEFAULT_MAX_PAYLOAD_BYTES` (8192) and `preview()` cut
  // whatever survived, so `previewBytes` above 8192 could not increase the
  // kept payload at all — measured across all 8 payloads over 8 KB in the
  // committed capture, 7 of them inline and 1 offloaded.
  //
  // The floor is a decision, not a clamp: see MIN_PARSE_CEILING_BYTES for the
  // mechanism (a 2,186-byte `<persisted-output>` stub, cut below its closing
  // tag, silently disables the whole offload path). Removing it looks safe and
  // is not.
  const previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  // An explicit `parse.maxPayloadBytes` still wins over `previewBytes` — a
  // caller who names the parse ceiling means it — but it is clamped UP to the
  // floor. It used to win outright, which left an unguarded escape
  // hatch around the floor: `parse:{maxPayloadBytes:512}` cut the stub below
  // its closing tag and silently disabled offload hydration — the preview
  // became the stub itself, marked "512 of 2186" instead of the offloaded
  // payload marked "512 of 63774". Measured on the committed capture; no
  // production caller sets it (`session.ts` forwards `previewBytes` only), so
  // the clamp changes no shipped behaviour. See GraftSessionOptions.parse.
  const derivedCeiling = Math.max(previewBytes, MIN_PARSE_CEILING_BYTES);
  const requested = options.parse?.maxPayloadBytes;
  // A non-finite request is not a request: `Math.max(x, NaN)` is NaN, which
  // would disable truncation altogether rather than clamp it.
  const parseCeiling =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.max(requested, MIN_PARSE_CEILING_BYTES)
      : derivedCeiling;
  const parseOptions: ParseOptions = { ...(options.parse ?? {}), maxPayloadBytes: parseCeiling };

  const loaded = await loadSessionForAttribution(fp, parseOptions);
  const diagnostics: ParseDiagnostics = {
    malformedLines: loaded.malformedLines,
    parsedLines: loaded.parsedLines,
    ignoredLines: loaded.ignoredLines,
    skippedFiles: loaded.unreadable.map((u) => ({ path: u.path, reason: u.reason })),
  };

  // `previewBytes` rather than `options.previewBytes`: the grafter and the
  // parse layer must be given the same number, and reading it from one
  // variable is what makes "the same" checkable rather than asserted.
  const grafter = new TreeGrafter(
    { sessionId: fp.sessionId, projectSlug: basename(fp.slugDir) },
    { previewBytes },
  );

  for (const source of loaded.input.transcripts) {
    const batch: TranscriptBatch = {
      kind: source.kind,
      path: source.path,
      entries: source.entries,
    };
    if (source.agentId !== undefined) batch.agentId = source.agentId;
    grafter.addTranscript(batch);
  }
  for (const sub of loaded.input.subagents) {
    const arrival: SidecarArrival = { agentId: sub.agentId, metaPath: sub.metaPath };
    if (sub.meta !== undefined) arrival.meta = sub.meta;
    if (sub.metaFailure !== undefined) arrival.metaFailure = sub.metaFailure;
    grafter.addSidecar(arrival);
  }

  if (options.hydrateToolResults !== false && fp.toolResultsDir !== undefined) {
    // The absolute path CC wrote into the stub is discarded by
    // `hydratePersistedOutputs`; only the basename is used, resolved under the
    // ACTIVE projects root. Under fixture replay the embedded path points into
    // the real user's ~/.claude, and it is never opened.
    const projectsRoot = dirname(fp.slugDir);
    const slug = basename(fp.slugDir);
    for (const source of loaded.input.transcripts) {
      for (const entry of source.entries) {
        const hydrated = await hydratePersistedOutputs(
          entry,
          {
            projectsRoot,
            slug,
            sessionId: fp.sessionId,
            // The same one ceiling. The offload path is 1 of the 8 payloads
            // over 8 KB in the capture, not the defect's scope, but it is on
            // the same rule as the other 7.
            ...parseOptions,
          },
          diagnostics,
        );
        for (const item of hydrated) {
          if (item.toolUseId === '') continue;
          grafter.addToolResultPayload(item.toolUseId, item.read.text);
        }
      }
    }
  }

  return { ok: true, snapshot: grafter.snapshot(), diagnostics };
}

/** `<projectsRoot>/<slug>/<sessionId>.jsonl`, for callers assembling a replay by hand. */
export function mainTranscriptPath(projectsRoot: string, slug: string, sessionId: string): string {
  return join(projectsRoot, slug, `${sessionId}.jsonl`);
}
