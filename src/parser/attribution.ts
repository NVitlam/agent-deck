/**
 * Agent Deck — subagent attribution: the primary-key join, and its absence.
 *
 * Each `<sessionId>/subagents/agent-<id>.meta.json` sidecar carries a
 * `toolUseId` naming the exact `tool_use` block that spawned the agent. That
 * makes attribution a JOIN on a primary key, not an inference from timestamps,
 * ordering, or "there is only one candidate left". This module does the join
 * and nothing else.
 *
 * Measured against the committed capture (`fixtures/cc-2.1.234/`, 2 sessions,
 * 5 sidecars, 22 `tool_use` blocks of which 4 are named `Agent`):
 *
 *   toolu_017Pp1K6YSjX4SBuJDcmMsKs  main 05c5482d…  -> agent a69e0f453d5ca5f43  depth 1
 *   toolu_01MiUaF4vR8zVMp5nL8njJH6  main 05c5482d…  -> agent a32b33ebf1b92e214  depth 1
 *   toolu_015U2QmdfzyqUd6DrCmCxfFB  main 05c5482d…  -> agent a1a53f42c5eca8824  depth 1
 *   toolu_012xCBtQH1ejFcfwn9E1pkAw  agent a1a53f42… -> agent a3ecf86bbfb853726  depth 2
 *   toolu_018fbDjBX1ah7FTXs727doeC  main 4299490e…  -> agent a5e718f3cb731b607  depth 1
 *
 * Every id occurs exactly once as a `tool_use` id across the whole capture, so
 * all 5 resolve, 0 are ambiguous and 0 are unresolved. The depth-2 agent's
 * parent is another *agent* transcript, not the main one.
 *
 * Grounding constraints this module is held to:
 *
 *   G1  Read-only. {@link attributeSubagents} does no I/O at all;
 *       {@link loadSessionForAttribution} opens transcripts with `readFile`
 *       and writes nothing, anywhere.
 *   G3  Refuse, don't guess. This is the whole module. A key that matches
 *       nothing yields `unresolved`; a key that matches twice yields
 *       `ambiguous`. There is deliberately no nearest-match, no timestamp
 *       proximity, no "last remaining candidate", and no fallback to the main
 *       transcript. A wrong parent looks exactly like a right one once the
 *       tree is drawn, so a guess here is unrecoverable corruption.
 *   G5  Zero egress. Node built-ins only.
 *   G6  Fixtures are law. The counts above were measured from the committed
 *       capture, and `attribution.test.ts` re-derives them from the files
 *       rather than trusting this comment.
 *   G7  In-memory only. Nothing is cached or persisted between calls.
 *
 * SCOPE: the join only. No tree is built, no `AgentNode`/`SessionState` is
 * emitted, and out-of-order live arrivals are not re-joined — that is the
 * Phase 2 stitcher. Everything here is a pure function of its input except the
 * one clearly-marked loader.
 */

import { readFile } from 'node:fs/promises';

import type { SubagentMeta, TranscriptEntry } from '../model/events.js';
import type { SessionFingerprint } from './fingerprint.js';
import type { ParseOptions } from './parse.js';
import { parseLines } from './parse.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One transcript file's parsed entries. The main transcript is one of these. */
export interface TranscriptSource {
  kind: 'main' | 'subagent';
  /** Absolute path of the file the entries came from. Identifies the source. */
  path: string;
  /** The agent that owns the file. Required when `kind` is `'subagent'`. */
  agentId?: string;
  entries: readonly TranscriptEntry[];
}

/**
 * One `agent-<id>.meta.json` sidecar as offered to the join.
 *
 * `meta` is absent when the sidecar could not be read or parsed. That is not an
 * error here — it is the missing-join-key case, and it produces an explicit
 * `unresolved` result rather than an attempt to work around it.
 */
export interface SubagentSource {
  agentId: string;
  metaPath: string;
  meta?: SubagentMeta;
  /** Why `meta` is absent. Recorded verbatim in the unresolved reason. */
  metaFailure?: string;
}

export interface AttributionInput {
  transcripts: readonly TranscriptSource[];
  subagents: readonly SubagentSource[];
}

// ---------------------------------------------------------------------------
// The tool_use index
// ---------------------------------------------------------------------------

/** One `tool_use` block, located precisely enough to name it as a parent. */
export interface ToolUseSite {
  toolUseId: string;
  /** `name` from the block, e.g. `Agent`. `''` when the block omitted it. */
  toolName: string;
  transcriptKind: 'main' | 'subagent';
  transcriptPath: string;
  /** The agent that owns the transcript, or `undefined` for the main file. */
  agentId?: string;
  /** Index into `TranscriptSource.entries`. */
  entryIndex: number;
}

function contentBlocksOf(entry: TranscriptEntry): readonly unknown[] {
  const message = entry['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/**
 * Index every `tool_use` block in every supplied transcript by its id.
 *
 * ALL `tool_use` blocks are indexed, not just the `Agent` ones. Restricting the
 * index to spawn-shaped tools would hide a collision between an `Agent` id and
 * some other tool's id — and a hidden collision resolves to a single confident
 * wrong answer, which is the failure this module exists to prevent.
 *
 * `tool_result` blocks carry the same id in `tool_use_id` and are deliberately
 * NOT indexed: they are the reply, not the call site, and counting both would
 * make every well-formed session ambiguous.
 */
export function indexToolUses(
  transcripts: readonly TranscriptSource[],
): ReadonlyMap<string, readonly ToolUseSite[]> {
  const index = new Map<string, ToolUseSite[]>();
  for (const source of transcripts) {
    for (let entryIndex = 0; entryIndex < source.entries.length; entryIndex++) {
      const entry = source.entries[entryIndex];
      if (entry === undefined) continue;
      for (const block of contentBlocksOf(entry)) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as { type?: unknown; id?: unknown; name?: unknown };
        if (b.type !== 'tool_use') continue;
        if (typeof b.id !== 'string' || b.id.trim() === '') continue;
        const site: ToolUseSite = {
          toolUseId: b.id,
          toolName: typeof b.name === 'string' ? b.name : '',
          transcriptKind: source.kind,
          transcriptPath: source.path,
          entryIndex,
        };
        if (source.agentId !== undefined) site.agentId = source.agentId;
        const existing = index.get(b.id);
        if (existing === undefined) index.set(b.id, [site]);
        else existing.push(site);
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Machine-readable reasons a join produced no single parent. */
export type UnresolvedCode =
  /** The sidecar itself was unreadable/unparseable, so there is no key at all. */
  | 'sidecarUnusable'
  /** `toolUseId` is absent, not a string, or empty/whitespace-only. */
  | 'missingJoinKey'
  /** The key is well-formed but no `tool_use` block anywhere carries it. */
  | 'noMatchingToolUse'
  /** `parentAgentId` names an agent with no transcript and no sidecar. */
  | 'parentAgentMissing'
  /** The key resolved somewhere other than the transcript `parentAgentId` names. */
  | 'parentAgentContradiction';

/** Why a resolved agent's depth could not be computed from the parent chain. */
export type DepthUnknownReason = 'chainIncomplete' | 'chainCycle';

export interface DepthMismatch {
  agentId: string;
  /** `spawnDepth` as written in the sidecar. */
  recorded: number;
  /** Depth obtained by walking the resolved parent chain to the main transcript. */
  computed: number;
}

export interface ResolvedAttribution {
  status: 'resolved';
  agentId: string;
  toolUseId: string;
  parent: ToolUseSite;
  recordedDepth: number;
  /** Absent when the chain could not be walked; see {@link depthUnknown}. */
  computedDepth?: number;
  depthUnknown?: DepthUnknownReason;
  /** Set only when `computedDepth` exists and differs from `recordedDepth`. */
  depthMismatch?: DepthMismatch;
}

export interface AmbiguousAttribution {
  status: 'ambiguous';
  agentId: string;
  toolUseId: string;
  /** Every site the key matched. Length is always >= 2. */
  candidates: readonly ToolUseSite[];
  reason: string;
}

export interface UnresolvedAttribution {
  status: 'unresolved';
  agentId: string;
  code: UnresolvedCode;
  /** The key as read, when there was one worth quoting. */
  toolUseId?: string;
  reason: string;
}

export type Attribution = ResolvedAttribution | AmbiguousAttribution | UnresolvedAttribution;

export interface AttributionCounts {
  resolved: number;
  ambiguous: number;
  unresolved: number;
  depthMismatches: number;
}

export interface AttributionReport {
  /** One entry per input subagent, in input order. */
  attributions: readonly Attribution[];
  /**
   * Keyed by `agentId`. The layout convention gives one file per agent, so
   * these are unique; on a duplicate the last entry wins.
   */
  byAgentId: ReadonlyMap<string, Attribution>;
  depthMismatches: readonly DepthMismatch[];
  counts: AttributionCounts;
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

function usableKey(meta: SubagentMeta): string | undefined {
  const raw = (meta as { toolUseId?: unknown }).toolUseId;
  if (typeof raw !== 'string') return undefined;
  // Whitespace-only is not a key. `fingerprint.ts` accepts any string for the
  // field's *type*; a key you cannot join on is still a missing key here.
  return raw.trim() === '' ? undefined : raw;
}

function describeSite(site: ToolUseSite): string {
  return site.transcriptKind === 'main'
    ? `main transcript ${site.transcriptPath}`
    : `agent ${String(site.agentId)} transcript ${site.transcriptPath}`;
}

/**
 * Join each subagent sidecar to the `tool_use` block that spawned it.
 *
 * Pure: no I/O, no clock, no mutation of the input. Never throws.
 *
 * The three outcomes are exhaustive and mutually exclusive:
 *
 *   resolved    exactly one `tool_use` block anywhere carries the key, and it
 *               does not contradict `parentAgentId`;
 *   ambiguous   two or more blocks carry it — reported, never silently
 *               narrowed to the first, the earliest, or the nearest;
 *   unresolved  no block carries it, or there is no usable key, or the key
 *               contradicts `parentAgentId`.
 *
 * `spawnDepth` is CHECKED, not trusted and not corrected: the depth recorded in
 * the sidecar is compared with the depth obtained by walking the resolved
 * parent chain, and a disagreement is reported alongside a still-resolved
 * attribution. Rewriting either number would destroy the evidence that the two
 * sources disagree.
 */
export function attributeSubagents(input: AttributionInput): AttributionReport {
  const index = indexToolUses(input.transcripts);

  // An agent is "known" if it has a transcript or a sidecar. Both are keyed by
  // the same agentId, which is what the layout convention guarantees.
  const knownAgents = new Set<string>();
  for (const t of input.transcripts) {
    if (t.kind === 'subagent' && t.agentId !== undefined) knownAgents.add(t.agentId);
  }
  for (const s of input.subagents) knownAgents.add(s.agentId);

  const attributions: Attribution[] = [];

  for (const source of input.subagents) {
    const { agentId } = source;

    if (source.meta === undefined) {
      attributions.push({
        status: 'unresolved',
        agentId,
        code: 'sidecarUnusable',
        reason: `sidecar ${source.metaPath} is unusable, so there is no join key: ${source.metaFailure ?? 'no reason recorded'}`,
      });
      continue;
    }

    const key = usableKey(source.meta);
    if (key === undefined) {
      attributions.push({
        status: 'unresolved',
        agentId,
        code: 'missingJoinKey',
        reason: `sidecar ${source.metaPath} has no usable \`toolUseId\`; attribution would have to be guessed`,
      });
      continue;
    }

    const sites = index.get(key) ?? [];
    if (sites.length === 0) {
      attributions.push({
        status: 'unresolved',
        agentId,
        code: 'noMatchingToolUse',
        toolUseId: key,
        reason: `no \`tool_use\` block in any supplied transcript carries id ${key}`,
      });
      continue;
    }
    if (sites.length > 1) {
      attributions.push({
        status: 'ambiguous',
        agentId,
        toolUseId: key,
        candidates: sites,
        reason: `id ${key} matches ${sites.length} \`tool_use\` blocks: ${sites.map(describeSite).join('; ')}`,
      });
      continue;
    }

    const site = sites[0];
    if (site === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess

    const declaredParent = source.meta.parentAgentId;
    if (typeof declaredParent === 'string' && declaredParent !== '') {
      if (!knownAgents.has(declaredParent)) {
        // The sidecar names a parent that is not in this session. Falling back
        // to whatever the key happened to match — the main transcript, most
        // likely — would invent a parent-child edge out of thin air.
        attributions.push({
          status: 'unresolved',
          agentId,
          code: 'parentAgentMissing',
          toolUseId: key,
          reason: `sidecar names parentAgentId ${declaredParent}, which has no transcript and no sidecar in this session`,
        });
        continue;
      }
      if (site.transcriptKind !== 'subagent' || site.agentId !== declaredParent) {
        attributions.push({
          status: 'unresolved',
          agentId,
          code: 'parentAgentContradiction',
          toolUseId: key,
          reason: `sidecar names parentAgentId ${declaredParent} but ${key} resolves to ${describeSite(site)}`,
        });
        continue;
      }
    }

    attributions.push({
      status: 'resolved',
      agentId,
      toolUseId: key,
      parent: site,
      recordedDepth: source.meta.spawnDepth,
    });
  }

  // --- depth check, over the resolved subset ---------------------------------
  const resolvedByAgent = new Map<string, ResolvedAttribution>();
  for (const a of attributions) if (a.status === 'resolved') resolvedByAgent.set(a.agentId, a);

  const depthMismatches: DepthMismatch[] = [];
  for (const a of resolvedByAgent.values()) {
    const walked = walkDepth(a.agentId, resolvedByAgent);
    if (walked.depth === undefined) {
      a.depthUnknown = walked.reason;
      continue;
    }
    a.computedDepth = walked.depth;
    if (walked.depth !== a.recordedDepth) {
      const mismatch: DepthMismatch = {
        agentId: a.agentId,
        recorded: a.recordedDepth,
        computed: walked.depth,
      };
      a.depthMismatch = mismatch;
      depthMismatches.push(mismatch);
    }
  }

  const byAgentId = new Map<string, Attribution>();
  for (const a of attributions) byAgentId.set(a.agentId, a);

  return {
    attributions,
    byAgentId,
    depthMismatches,
    counts: {
      resolved: attributions.filter((a) => a.status === 'resolved').length,
      ambiguous: attributions.filter((a) => a.status === 'ambiguous').length,
      unresolved: attributions.filter((a) => a.status === 'unresolved').length,
      depthMismatches: depthMismatches.length,
    },
  };
}

/**
 * Depth of `agentId` obtained by following resolved parents to the main
 * transcript: a child of the main transcript is depth 1, a child of a depth-1
 * agent is depth 2, and so on.
 *
 * Returns no depth when an ancestor is not resolved (`chainIncomplete`) or when
 * the chain loops (`chainCycle`). Both are refusals: an unwalkable chain does
 * not license trusting the sidecar's own number.
 */
function walkDepth(
  agentId: string,
  resolved: ReadonlyMap<string, ResolvedAttribution>,
): { depth: number } | { depth: undefined; reason: DepthUnknownReason } {
  const seen = new Set<string>();
  let current = agentId;
  let depth = 0;
  for (;;) {
    if (seen.has(current)) return { depth: undefined, reason: 'chainCycle' };
    seen.add(current);
    const node = resolved.get(current);
    if (node === undefined) return { depth: undefined, reason: 'chainIncomplete' };
    depth += 1;
    if (node.parent.transcriptKind === 'main') return { depth };
    const parentAgent = node.parent.agentId;
    if (parentAgent === undefined) return { depth: undefined, reason: 'chainIncomplete' };
    current = parentAgent;
  }
}

// ---------------------------------------------------------------------------
// Loader — the only part that touches the disk
// ---------------------------------------------------------------------------

/**
 * How the tailer hands lines to the parser, replayed over a whole file.
 *
 * Mirrors `FileTail#consume` exactly: split on `\n`, drop a single trailing
 * `\r`, and skip blank separators (which are not records and must not be
 * counted as malformed). Kept in step with `tailer.ts` deliberately — the live
 * path and the whole-file path must not disagree about what a line is.
 */
export function splitTranscript(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split('\n')) {
    const content = part.endsWith('\r') ? part.slice(0, -1) : part;
    if (content.trim() === '') continue;
    out.push(content);
  }
  return out;
}

export interface LoadedSession {
  input: AttributionInput;
  /** Per-file malformed/parsed line counts, keyed by absolute path. */
  perFile: ReadonlyMap<string, { parsedLines: number; malformedLines: number }>;
  malformedLines: number;
  parsedLines: number;
  /** Files that could not be read at all. */
  unreadable: readonly { path: string; reason: string }[];
}

/**
 * Read a fingerprinted session's transcripts and assemble the join input.
 *
 * Read-only (`readFile` only, G1) and non-throwing (G3): a transcript that
 * cannot be opened is recorded in `unreadable` and contributes no entries,
 * which makes its agent `unresolved` rather than mis-parented.
 *
 * Sidecars are taken from the fingerprint, which has already parsed and
 * type-checked them; this function does not re-read them.
 */
export async function loadSessionForAttribution(
  fingerprint: SessionFingerprint,
  options: ParseOptions = {},
): Promise<LoadedSession> {
  const transcripts: TranscriptSource[] = [];
  const perFile = new Map<string, { parsedLines: number; malformedLines: number }>();
  const unreadable: { path: string; reason: string }[] = [];
  let malformedLines = 0;
  let parsedLines = 0;

  const ingest = async (path: string, kind: 'main' | 'subagent', agentId?: string) => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error: unknown) {
      unreadable.push({
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const batch = parseLines(splitTranscript(text), options);
    perFile.set(path, {
      parsedLines: batch.diagnostics.parsedLines,
      malformedLines: batch.diagnostics.malformedLines,
    });
    parsedLines += batch.diagnostics.parsedLines;
    malformedLines += batch.diagnostics.malformedLines;
    const source: TranscriptSource = {
      kind,
      path,
      entries: batch.ok ? batch.value.entries : [],
    };
    if (agentId !== undefined) source.agentId = agentId;
    transcripts.push(source);
  };

  await ingest(fingerprint.mainTranscript, 'main');
  for (const sub of fingerprint.subagents) {
    await ingest(sub.transcriptPath, 'subagent', sub.agentId);
  }

  const subagents: SubagentSource[] = fingerprint.subagents.map((sub) => ({
    agentId: sub.agentId,
    metaPath: sub.metaPath,
    meta: sub.meta,
  }));

  return {
    input: { transcripts, subagents },
    perFile,
    malformedLines,
    parsedLines,
    unreadable,
  };
}
