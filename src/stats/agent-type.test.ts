/**
 * v0.9.0 DoD 9.2 — `agents[].agentType`, fixture-proven, and `description`
 * proven absent.
 *
 * ## The join is the sidecar's, and it is read here off the committed bytes
 *
 * `<sessionId>/subagents/agent-<agentId>.meta.json` carries `agentType`,
 * `description` and `toolUseId`. The last is the primary key Phase 0
 * established, and it is what makes subagent attribution a JOIN rather than an
 * inference. This file reads those sidecars directly and holds the derived
 * records against them, through the PRODUCTION path — the real corpus reader,
 * the real grafter, the real `deriveStats`. Nothing here builds a tree.
 *
 * ## `description` is the control, and it is real prose
 *
 * `AgentNode.label` is `agentType + ": " + description`, so the description is
 * one string-split away from being exported at every moment. The committed
 * sidecars carry real descriptions, and they are held against every derived
 * record by the technique `redaction.test.ts` records: a value EQUAL to
 * something the engine wrote is an allow-listed identifier and what it contains
 * is not this test's question; every OTHER string must carry no run of a
 * description.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { isAgentNode, type AgentNode, type SessionState } from '../model/events.js';

import { CORPUS_READ_BUDGET_MS, readCcSessions, warmCorpus } from './corpus.testkit.js';
import { deriveStats } from './derive.js';
import type { StatsRecord } from './schema.js';
import { NAME_MAX_CHARS, validateStatsRecord } from './schema.js';

beforeAll(warmCorpus, CORPUS_READ_BUDGET_MS);

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));

interface RawSidecar {
  corpus: string;
  agentId: string;
  agentType: unknown;
  description: unknown;
  toolUseId: unknown;
}

/** Every committed CC subagent sidecar, read off the bytes. */
function readSidecars(): RawSidecar[] {
  const out: RawSidecar[] = [];
  const walkDir = (dir: string, corpus: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full, corpus);
        continue;
      }
      if (!entry.name.endsWith('.meta.json')) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      out.push({
        corpus,
        agentId: entry.name.replace(/^agent-/, '').replace(/\.meta\.json$/, ''),
        agentType: parsed['agentType'],
        description: parsed['description'],
        toolUseId: parsed['toolUseId'],
      });
    }
  };
  for (const corpus of readdirSync(FIXTURES).filter((n) => n.startsWith('cc-'))) {
    const projects = join(FIXTURES, corpus, 'projects');
    try {
      walkDir(projects, corpus);
    } catch {
      // A corpus with no projects tree contributes nothing.
    }
  }
  return out;
}

const SIDECARS = readSidecars();

// ---------------------------------------------------------------------------
// The population
// ---------------------------------------------------------------------------

describe('the committed corpus carries the sidecars this DoD rests on', () => {
  it('has real sidecars with a type, a description and a join key', () => {
    // Pinned non-empty BEFORE anything is asserted over it: a reader that
    // found nothing would otherwise make every loop below pass vacuously.
    expect(SIDECARS.length).toBeGreaterThan(0);
    expect(SIDECARS.every((s) => typeof s.agentType === 'string' && s.agentType !== '')).toBe(true);
    expect(SIDECARS.every((s) => typeof s.toolUseId === 'string' && s.toolUseId !== '')).toBe(true);
    // The control's own subject: descriptions that are prose, not empty.
    const prose = SIDECARS.map((s) => s.description).filter(
      (d): d is string => typeof d === 'string' && d.length >= 12,
    );
    expect(prose.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The join, through the production path
// ---------------------------------------------------------------------------

describe('agentType is exported from the sidecar join', () => {
  it('every derived subagent type is a type some sidecar states', async () => {
    const types = new Set(SIDECARS.map((s) => String(s.agentType)));
    let seen = 0;
    for (const state of await readCcSessions()) {
      for (const agent of deriveStats(state).agents) {
        if (agent.agentType === undefined) continue;
        seen += 1;
        expect(types, `derived agentType ${agent.agentType} is in no sidecar`).toContain(
          agent.agentType,
        );
      }
    }
    // Non-empty, or the loop proved nothing — the recorded vacuity shape.
    expect(seen, 'no derived record carried an agentType at all').toBeGreaterThan(0);
  });

  it('the type on a record equals the type on that agent’s own sidecar', async () => {
    const byAgentId = new Map(SIDECARS.map((s) => [s.agentId, s]));
    let joined = 0;
    for (const state of await readCcSessions()) {
      for (const agent of deriveStats(state).agents) {
        const sidecar = byAgentId.get(agent.agentId);
        if (sidecar === undefined) continue;
        // This is the join itself: the record's agent id names the sidecar,
        // and the type must be that sidecar's, not another's.
        expect(agent.agentType).toBe(sidecar.agentType);
        joined += 1;
      }
    }
    expect(joined, 'no record agent matched a committed sidecar').toBeGreaterThan(0);
  });

  it('main never carries a type, because it has no sidecar', async () => {
    let mains = 0;
    for (const state of await readCcSessions()) {
      for (const agent of deriveStats(state).agents) {
        if (agent.kind !== 'main') continue;
        mains += 1;
        expect(agent.agentType).toBeUndefined();
      }
    }
    expect(mains).toBeGreaterThan(0);
  });

  it('every derived record still validates', async () => {
    for (const state of await readCcSessions()) {
      expect(validateStatsRecord(deriveStats(state)).errors).toEqual([]);
    }
  });

  it('a type is never longer than the name cap', async () => {
    for (const state of await readCcSessions()) {
      for (const agent of deriveStats(state).agents) {
        if (agent.agentType === undefined) continue;
        expect(agent.agentType.length).toBeLessThanOrEqual(NAME_MAX_CHARS);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// `description` never reaches a record
// ---------------------------------------------------------------------------

describe('description is prose and never reaches a record', () => {
  const MIN_RUN = 12;

  const descriptions = SIDECARS.map((s) => s.description).filter(
    (d): d is string => typeof d === 'string' && d.length >= MIN_RUN,
  );

  /** Every string the ENGINE wrote — see `redaction.test.ts` assertion B. */
  const engineStrings = (state: SessionState): Set<string> => {
    const out = new Set<string>([state.sessionId, state.projectSlug]);
    const visit = (node: AgentNode): void => {
      out.add(node.id);
      if (node.model !== undefined) out.add(node.model);
      if (node.agentType !== undefined) out.add(node.agentType);
      for (const child of node.children) {
        if (isAgentNode(child)) {
          visit(child);
          continue;
        }
        out.add(child.toolName);
        if (child.filePath !== undefined) out.add(child.filePath);
        if (child.skillName !== undefined) out.add(child.skillName);
      }
    };
    visit(state.root);
    return out;
  };

  const stringsOf = (value: unknown, path: string, out: [string, string][]): void => {
    if (typeof value === 'string') {
      out.push([path, value]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => stringsOf(item, `${path}[${String(i)}]`, out));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) stringsOf(v, `${path}.${k}`, out);
    }
  };

  it('no string a record carries, other than one the engine wrote, holds a run of a description', async () => {
    let inspected = 0;
    for (const state of await readCcSessions()) {
      const allowed = engineStrings(state);
      const record: StatsRecord = deriveStats(state);
      const found: [string, string][] = [];
      stringsOf(record, '', found);
      for (const [path, value] of found) {
        if (allowed.has(value)) continue;
        inspected += 1;
        for (const description of descriptions) {
          for (let i = 0; i + MIN_RUN <= description.length; i += 1) {
            const run = description.slice(i, i + MIN_RUN);
            expect(
              value.includes(run),
              `description run ${JSON.stringify(run)} reached ${path}`,
            ).toBe(false);
          }
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('no subagent label reaches a record verbatim', async () => {
    // The total form: equality, no exemption. A SUBAGENT label is
    // `agentType + ": " + description`, which is exactly what exporting the
    // wrong half would produce.
    //
    // The ROOT label is deliberately not in the set. It has no sidecar and
    // no description: `labelFor` builds it from the transcript title or the
    // first user text, and falls back to the SESSION ID when a transcript
    // states neither — so a root label can legitimately equal a value the
    // record carries, and flagging it would be flagging `sessionId`.
    for (const state of await readCcSessions()) {
      const labels = new Set<string>();
      const visit = (node: AgentNode): void => {
        if (node.kind === 'subagent') labels.add(node.label);
        for (const child of node.children) if (isAgentNode(child)) visit(child);
      };
      visit(state.root);
      const found: [string, string][] = [];
      stringsOf(deriveStats(state), '', found);
      for (const [path, value] of found) {
        // A label that is exactly an agentType is not a label leak: it is a
        // subagent whose sidecar states no description, where `labelFor`
        // returns the type alone. That value is allow-listed on its own.
        if (!labels.has(value)) continue;
        const isBareType = SIDECARS.some((s) => s.agentType === value);
        expect(isBareType, `label reached ${path} verbatim: ${JSON.stringify(value)}`).toBe(true);
      }
    }
  });

  it('the scan can fail — a planted run is found', async () => {
    const state = (await readCcSessions())[0];
    if (state === undefined) throw new Error('no cc session');
    const found: [string, string][] = [];
    stringsOf({ ...deriveStats(state), planted: descriptions[0] }, '', found);
    const run = String(descriptions[0]).slice(0, MIN_RUN);
    expect(found.some(([, v]) => v.includes(run))).toBe(true);
  });
});
