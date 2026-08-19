/**
 * Tests for the subagent attribution join.
 *
 * Two fixture trees, never mixed up:
 *
 *   fixtures/cc-2.1.234/      captured from real CC 2.1.234 sessions. Ground
 *                             truth (G6): if the resolver disagrees with it,
 *                             the resolver is wrong. The expected parents are
 *                             DERIVED from the files here, not copied from a
 *                             prompt or a comment.
 *   fixtures/synthetic-graft/ hand-made, invented. Evidence about *our*
 *                             behaviour when the join key is broken.
 *
 * Every graft case is asserted by its own expected outcome and its own reason
 * code. "It did not resolve" is not an assertion — a case that failed to
 * resolve for the wrong reason would pass it.
 *
 * Nothing is written inside the repo, and one test hashes the captured tree
 * before and after the whole file to prove it (G1).
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AmbiguousAttribution,
  Attribution,
  AttributionReport,
  ResolvedAttribution,
  UnresolvedAttribution,
  UnresolvedCode,
} from './attribution.js';
import {
  attributeSubagents,
  indexToolUses,
  loadSessionForAttribution,
  splitTranscript,
} from './attribution.js';
import { fingerprintSession, fingerprintSlugDirectory } from './fingerprint.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CAPTURED_SLUG = fileURLToPath(
  new URL(
    '../../fixtures/cc-2.1.234/projects/c--Users-dev-projects-agent-deck',
    import.meta.url,
  ),
);
const GRAFT_ROOT = fileURLToPath(new URL('../../fixtures/synthetic-graft', import.meta.url));
const GRAFT_SLUG = 'SYNTHETIC-hand-mutated-not-captured';
const GRAFT_SESSION = 'deadbeef-0000-4000-8000-0000000000a1';
const GRAFT_A1 = 'agraft0000000001';
const GRAFT_A2 = 'agraft0000000002';

const CAPTURED_SESSION_WITH_SUBAGENTS = '05c5482d-5568-44ce-97fe-bc9a6c15afc4';
const CAPTURED_SESSION_SINGLE = '4299490e-4a09-46a0-a544-7ffb0429e7e7';

function graftMain(caseName: string): string {
  return join(GRAFT_ROOT, caseName, GRAFT_SLUG, `${GRAFT_SESSION}.jsonl`);
}

/** Fingerprint + load + join, the whole pipeline as production would run it. */
async function attributeCase(mainTranscript: string): Promise<AttributionReport> {
  const fp = await fingerprintSession(mainTranscript);
  if (!fp.ok) {
    throw new Error(
      `fingerprint refused ${mainTranscript}: ${fp.mismatch.code} ${fp.mismatch.reason}`,
    );
  }
  const loaded = await loadSessionForAttribution(fp.value);
  expect(loaded.unreadable).toEqual([]);
  expect(loaded.malformedLines).toBe(0);
  return attributeSubagents(loaded.input);
}

function attributionOf(report: AttributionReport, agentId: string): Attribution {
  const found = report.byAgentId.get(agentId);
  if (found === undefined) throw new Error(`no attribution for agent ${agentId}`);
  return found;
}

function expectResolved(report: AttributionReport, agentId: string): ResolvedAttribution {
  const a = attributionOf(report, agentId);
  if (a.status !== 'resolved') {
    throw new Error(
      `expected ${agentId} resolved, got ${a.status}: ${a.status === 'unresolved' ? a.code : ''} ${a.reason}`,
    );
  }
  return a;
}

function expectUnresolved(
  report: AttributionReport,
  agentId: string,
  code: UnresolvedCode,
): UnresolvedAttribution {
  const a = attributionOf(report, agentId);
  if (a.status !== 'resolved') {
    if (a.status === 'ambiguous') {
      throw new Error(`expected ${agentId} unresolved/${code}, got ambiguous: ${a.reason}`);
    }
    expect(a.code).toBe(code);
    expect(a.reason.length).toBeGreaterThan(0);
    return a;
  }
  throw new Error(
    `expected ${agentId} unresolved/${code}, got RESOLVED to ${a.parent.transcriptPath} — a guess`,
  );
}

function expectAmbiguous(report: AttributionReport, agentId: string): AmbiguousAttribution {
  const a = attributionOf(report, agentId);
  if (a.status !== 'ambiguous') {
    throw new Error(`expected ${agentId} ambiguous, got ${a.status}`);
  }
  expect(a.candidates.length).toBeGreaterThanOrEqual(2);
  return a;
}

interface Snapshot {
  path: string;
  size: number;
  sha256: string;
}

/** Content hash of every file under `root`, for the read-only assertion. */
async function snapshot(root: string): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const body = await readFile(full);
      out.push({
        path: relative(root, full).split(sep).join('/'),
        size: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    }
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

let capturedBefore: Snapshot[];

beforeAll(async () => {
  capturedBefore = await snapshot(CAPTURED_SLUG);
});

afterAll(async () => {
  // G1: nothing in this file may write to the captured tree, byte for byte.
  expect(await snapshot(CAPTURED_SLUG)).toEqual(capturedBefore);
});

// ---------------------------------------------------------------------------
// Positive pin — the captured tree is ground truth
// ---------------------------------------------------------------------------

describe('captured CC 2.1.234 fixtures: the join is a primary key', () => {
  /**
   * Independent oracle: re-read the sidecars and transcripts off disk with
   * nothing but `JSON.parse`, and work out where each `toolUseId` occurs. If
   * this disagrees with the resolver, one of them is wrong — and the files are
   * the referee.
   */
  async function groundTruth(): Promise<
    Map<string, { sessionId: string; occurrences: string[]; spawnDepth: number }>
  > {
    const out = new Map<string, { sessionId: string; occurrences: string[]; spawnDepth: number }>();
    const sessions = [CAPTURED_SESSION_WITH_SUBAGENTS, CAPTURED_SESSION_SINGLE];

    // Where does every tool_use id live? path -> ids
    const sites = new Map<string, string[]>();
    const scan = async (path: string) => {
      const ids: string[] = [];
      for (const line of splitTranscript(await readFile(path, 'utf8'))) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const message = (raw as { message?: unknown }).message;
        if (typeof message !== 'object' || message === null) continue;
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as { type?: unknown; id?: unknown };
          if (b.type === 'tool_use' && typeof b.id === 'string') ids.push(b.id);
        }
      }
      sites.set(path, ids);
    };

    for (const sessionId of sessions) {
      await scan(join(CAPTURED_SLUG, `${sessionId}.jsonl`));
      const subagentsDir = join(CAPTURED_SLUG, sessionId, 'subagents');
      for (const name of await readdir(subagentsDir)) {
        if (name.endsWith('.jsonl')) await scan(join(subagentsDir, name));
      }
    }

    for (const sessionId of sessions) {
      const subagentsDir = join(CAPTURED_SLUG, sessionId, 'subagents');
      for (const name of await readdir(subagentsDir)) {
        if (!name.endsWith('.meta.json')) continue;
        const agentId = name.slice('agent-'.length, -'.meta.json'.length);
        const meta = JSON.parse(await readFile(join(subagentsDir, name), 'utf8')) as {
          toolUseId: string;
          spawnDepth: number;
        };
        const occurrences: string[] = [];
        for (const [path, ids] of sites) {
          for (const id of ids) if (id === meta.toolUseId) occurrences.push(path);
        }
        out.set(agentId, { sessionId, occurrences, spawnDepth: meta.spawnDepth });
      }
    }
    return out;
  }

  it('every captured sidecar key occurs exactly once, in one file', async () => {
    const truth = await groundTruth();
    expect(truth.size).toBe(5);
    for (const [agentId, info] of truth) {
      expect(`${agentId}: ${info.occurrences.length}`).toBe(`${agentId}: 1`);
    }
    // 4 keys live in a main transcript, 1 lives in an agent transcript.
    const inAgentFile = [...truth.values()].filter((i) =>
      i.occurrences[0]?.includes(`${sep}subagents${sep}`),
    );
    expect(inAgentFile).toHaveLength(1);
    expect(inAgentFile[0]?.spawnDepth).toBe(2);
  });

  it('resolves all 5 captured subagents, 0 ambiguous, 0 unresolved, 0 depth mismatches', async () => {
    const truth = await groundTruth();
    const slug = await fingerprintSlugDirectory(CAPTURED_SLUG);
    if (!slug.ok) throw new Error(`slug refused: ${slug.mismatch.reason}`);

    let resolved = 0;
    let mainParents = 0;
    let agentParents = 0;
    for (const session of slug.value.sessions) {
      const report = await attributeCase(session.mainTranscript);
      expect(report.counts.ambiguous).toBe(0);
      expect(report.counts.unresolved).toBe(0);
      expect(report.counts.depthMismatches).toBe(0);
      for (const a of report.attributions) {
        const expected = truth.get(a.agentId);
        if (expected === undefined) throw new Error(`unexpected agent ${a.agentId}`);
        if (a.status !== 'resolved') throw new Error(`${a.agentId} is ${a.status}`);
        resolved += 1;
        // The parent is the file the oracle found the key in — not a guess.
        expect(a.parent.transcriptPath).toBe(expected.occurrences[0]);
        expect(a.parent.toolName).toBe('Agent');
        expect(a.computedDepth).toBe(expected.spawnDepth);
        expect(a.recordedDepth).toBe(expected.spawnDepth);
        expect(a.depthMismatch).toBeUndefined();
        if (a.parent.transcriptKind === 'main') mainParents += 1;
        else agentParents += 1;
      }
    }
    expect(resolved).toBe(5);
    expect(mainParents).toBe(4);
    expect(agentParents).toBe(1);
  });

  it('the depth-2 agent is parented to another agent transcript, not to main', async () => {
    const report = await attributeCase(
      join(CAPTURED_SLUG, `${CAPTURED_SESSION_WITH_SUBAGENTS}.jsonl`),
    );
    const nested = report.attributions.filter(
      (a): a is ResolvedAttribution => a.status === 'resolved' && a.recordedDepth === 2,
    );
    expect(nested).toHaveLength(1);
    const only = nested[0];
    expect(only?.parent.transcriptKind).toBe('subagent');
    // The parent agent is itself one of this session's subagents.
    const parentAgentId = only?.parent.agentId;
    expect(parentAgentId).toBeDefined();
    expect(report.byAgentId.has(String(parentAgentId))).toBe(true);
    // …and the parent's own attribution points at the main transcript.
    expect(expectResolved(report, String(parentAgentId)).parent.transcriptKind).toBe('main');
    expect(only?.computedDepth).toBe(2);
  });

  it('a session with one subagent resolves it against the main transcript', async () => {
    const report = await attributeCase(join(CAPTURED_SLUG, `${CAPTURED_SESSION_SINGLE}.jsonl`));
    expect(report.counts).toEqual({
      resolved: 1,
      ambiguous: 0,
      unresolved: 0,
      depthMismatches: 0,
    });
    const only = report.attributions[0];
    expect(only?.status).toBe('resolved');
    expect(only && only.status === 'resolved' && only.parent.transcriptKind).toBe('main');
  });

  it('tool_result blocks are not indexed as call sites', async () => {
    // Every captured tool_use id also appears in a tool_result block's
    // `tool_use_id`. Indexing those too would make every session ambiguous.
    const fp = await fingerprintSession(
      join(CAPTURED_SLUG, `${CAPTURED_SESSION_WITH_SUBAGENTS}.jsonl`),
    );
    if (!fp.ok) throw new Error('captured session must fingerprint');
    const loaded = await loadSessionForAttribution(fp.value);
    const index = indexToolUses(loaded.input.transcripts);
    let toolResults = 0;
    for (const source of loaded.input.transcripts) {
      for (const entry of source.entries) {
        const message = entry['message'];
        if (typeof message !== 'object' || message === null) continue;
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (typeof block === 'object' && block !== null) {
            if ((block as { type?: unknown }).type === 'tool_result') toolResults += 1;
          }
        }
      }
    }
    expect(toolResults).toBeGreaterThan(0);
    for (const [, sites] of index) expect(sites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Synthetic graft cases — each asserted by its own expected outcome
// ---------------------------------------------------------------------------

describe('synthetic-graft: the control, so every mutation is one edit from valid', () => {
  it('00-valid-control resolves both agents at the right depths', async () => {
    const report = await attributeCase(graftMain('00-valid-control'));
    expect(report.counts).toEqual({
      resolved: 2,
      ambiguous: 0,
      unresolved: 0,
      depthMismatches: 0,
    });
    const depth1 = expectResolved(report, GRAFT_A1);
    expect(depth1.parent.transcriptKind).toBe('main');
    expect(depth1.computedDepth).toBe(1);
    expect(depth1.recordedDepth).toBe(1);

    const depth2 = expectResolved(report, GRAFT_A2);
    expect(depth2.parent.transcriptKind).toBe('subagent');
    expect(depth2.parent.agentId).toBe(GRAFT_A1);
    expect(depth2.computedDepth).toBe(2);
    expect(depth2.recordedDepth).toBe(2);
    expect(depth2.depthMismatch).toBeUndefined();
  });
});

describe('synthetic-graft: absence produces UNRESOLVED, never a guess', () => {
  it('01 a key that matches nothing is unresolved, though a plausible parent exists', async () => {
    const report = await attributeCase(graftMain('01-tool-use-id-matches-nothing'));
    const a = expectUnresolved(report, GRAFT_A1, 'noMatchingToolUse');
    expect(a.toolUseId).toBe('toolu_GRAFT00000000000ABSENT');
    // The trap: the session does contain an unclaimed Agent tool_use.
    const fp = await fingerprintSession(graftMain('01-tool-use-id-matches-nothing'));
    if (!fp.ok) throw new Error('control must fingerprint');
    const index = indexToolUses((await loadSessionForAttribution(fp.value)).input.transcripts);
    expect(index.size).toBe(1);
    expect(report.counts.resolved).toBe(0);
  });

  it('02 a whitespace-only key is unresolved even when it is the only candidate', async () => {
    const main = graftMain('02-tool-use-id-whitespace');
    const report = await attributeCase(main);
    expectUnresolved(report, GRAFT_A1, 'missingJoinKey');
    expect(report.counts.resolved).toBe(0);

    // Load-bearing detail: exactly one Agent tool_use and exactly one subagent.
    // A resolver that took "the only candidate left" would be confidently wrong.
    const fp = await fingerprintSession(main);
    if (!fp.ok) throw new Error('case 02 must fingerprint (the key type-checks)');
    expect(fp.value.subagents).toHaveLength(1);
    const index = indexToolUses((await loadSessionForAttribution(fp.value)).input.transcripts);
    expect(index.size).toBe(1);
  });

  it('03 a key present in two transcripts is ambiguous, not the first match', async () => {
    const report = await attributeCase(graftMain('03-tool-use-id-duplicated'));
    expect(report.counts).toEqual({
      resolved: 1,
      ambiguous: 1,
      unresolved: 0,
      depthMismatches: 0,
    });
    const ambiguous = expectAmbiguous(report, GRAFT_A2);
    expect(ambiguous.candidates).toHaveLength(2);
    const kinds = ambiguous.candidates.map((c) => c.transcriptKind).sort();
    expect(kinds).toEqual(['main', 'subagent']);
    expect(ambiguous.reason).toContain(ambiguous.toolUseId);
    // The agent whose own key is unique is unaffected.
    expect(expectResolved(report, GRAFT_A1).parent.transcriptKind).toBe('main');
  });

  it('04 a missing parentAgentId is unresolved and is NOT reattached to main', async () => {
    const report = await attributeCase(graftMain('04-parent-agent-missing'));
    const a = expectUnresolved(report, GRAFT_A2, 'parentAgentMissing');
    expect(a.reason).toContain('aghostagent00001');
    expect(report.counts.resolved).toBe(0);

    // The tempting wrong answer really is available: the key DOES match a
    // tool_use block in the main transcript.
    const fp = await fingerprintSession(graftMain('04-parent-agent-missing'));
    if (!fp.ok) throw new Error('case 04 must fingerprint');
    const loaded = await loadSessionForAttribution(fp.value);
    const index = indexToolUses(loaded.input.transcripts);
    const sites = index.get('toolu_GRAFT000000000000002');
    expect(sites).toHaveLength(1);
    expect(sites?.[0]?.transcriptKind).toBe('main');
  });

  it('05 a spawnDepth that contradicts the chain stays resolved and is reported', async () => {
    const report = await attributeCase(graftMain('05-spawn-depth-contradicts-chain'));
    expect(report.counts.resolved).toBe(2);
    expect(report.counts.depthMismatches).toBe(1);

    const liar = expectResolved(report, GRAFT_A2);
    expect(liar.parent.transcriptKind).toBe('subagent');
    expect(liar.parent.agentId).toBe(GRAFT_A1);
    expect(liar.recordedDepth).toBe(1);
    expect(liar.computedDepth).toBe(2);
    expect(liar.depthMismatch).toEqual({ agentId: GRAFT_A2, recorded: 1, computed: 2 });
    // Neither number is rewritten: the report carries both.
    expect(report.depthMismatches).toEqual([{ agentId: GRAFT_A2, recorded: 1, computed: 2 }]);
    // The honest agent has no mismatch.
    expect(expectResolved(report, GRAFT_A1).depthMismatch).toBeUndefined();
  });

  it('06 one broken key does not poison the agents whose keys are sound', async () => {
    const report = await attributeCase(graftMain('06-one-resolves-one-does-not'));
    expect(report.counts).toEqual({
      resolved: 1,
      ambiguous: 0,
      unresolved: 1,
      depthMismatches: 0,
    });
    const good = expectResolved(report, GRAFT_A1);
    expect(good.parent.transcriptKind).toBe('main');
    expect(good.computedDepth).toBe(1);
    expectUnresolved(report, GRAFT_A2, 'noMatchingToolUse');
  });
});

// ---------------------------------------------------------------------------
// Unit-level refusals that need no fixture tree
// ---------------------------------------------------------------------------

describe('the join refuses in memory too', () => {
  const mainSource = {
    kind: 'main' as const,
    path: '/synthetic/main.jsonl',
    entries: [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_MEM1', name: 'Agent', input: {} }],
        },
      },
    ],
  };

  it('an unusable sidecar is unresolved, never attached to the sole candidate', () => {
    const report = attributeSubagents({
      transcripts: [mainSource],
      subagents: [
        {
          agentId: 'amem000000000001',
          metaPath: '/synthetic/agent-amem000000000001.meta.json',
          metaFailure: 'sidecar is not valid JSON: Unexpected end of JSON input',
        },
      ],
    });
    const a = report.attributions[0];
    expect(a?.status).toBe('unresolved');
    expect(a && a.status === 'unresolved' && a.code).toBe('sidecarUnusable');
    expect(a && a.status === 'unresolved' && a.reason).toContain('not valid JSON');
    expect(report.counts.resolved).toBe(0);
  });

  it('a key that contradicts parentAgentId is unresolved, not resolved to the match', () => {
    const report = attributeSubagents({
      transcripts: [
        mainSource,
        {
          kind: 'subagent',
          path: '/synthetic/agent-amem000000000002.jsonl',
          agentId: 'amem000000000002',
          entries: [],
        },
      ],
      subagents: [
        {
          agentId: 'amem000000000001',
          metaPath: '/synthetic/agent-amem000000000001.meta.json',
          meta: {
            agentType: 'general-purpose',
            description: 'contradicted',
            toolUseId: 'toolu_MEM1',
            parentAgentId: 'amem000000000002',
            spawnDepth: 2,
          },
        },
      ],
    });
    const a = report.attributions[0];
    expect(a && a.status === 'unresolved' && a.code).toBe('parentAgentContradiction');
  });

  it('a parent chain cycle yields no computed depth rather than looping forever', () => {
    // Two agents whose keys resolve into each other's transcripts.
    const report = attributeSubagents({
      transcripts: [
        {
          kind: 'subagent',
          path: '/synthetic/agent-acyc000000000001.jsonl',
          agentId: 'acyc000000000001',
          entries: [
            {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_CYC2', name: 'Agent', input: {} }],
              },
            },
          ],
        },
        {
          kind: 'subagent',
          path: '/synthetic/agent-acyc000000000002.jsonl',
          agentId: 'acyc000000000002',
          entries: [
            {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_CYC1', name: 'Agent', input: {} }],
              },
            },
          ],
        },
      ],
      subagents: [
        {
          agentId: 'acyc000000000001',
          metaPath: '/synthetic/a1.meta.json',
          meta: {
            agentType: 'g',
            description: 'cycle a',
            toolUseId: 'toolu_CYC1',
            spawnDepth: 1,
          },
        },
        {
          agentId: 'acyc000000000002',
          metaPath: '/synthetic/a2.meta.json',
          meta: {
            agentType: 'g',
            description: 'cycle b',
            toolUseId: 'toolu_CYC2',
            spawnDepth: 1,
          },
        },
      ],
    });
    expect(report.counts.resolved).toBe(2);
    expect(report.counts.depthMismatches).toBe(0);
    for (const a of report.attributions) {
      expect(a.status === 'resolved' && a.computedDepth).toBeUndefined();
      expect(a.status === 'resolved' && a.depthUnknown).toBe('chainCycle');
    }
  });

  it('an empty input yields an empty report rather than throwing', () => {
    const report = attributeSubagents({ transcripts: [], subagents: [] });
    expect(report.attributions).toEqual([]);
    expect(report.counts).toEqual({
      resolved: 0,
      ambiguous: 0,
      unresolved: 0,
      depthMismatches: 0,
    });
  });

  it('splitTranscript drops blank separators and trailing CR, like the tailer', () => {
    expect(splitTranscript('{"a":1}\r\n\n  \n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });
});
