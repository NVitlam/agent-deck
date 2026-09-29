/**
 * 0.9.2 — THE SIDECAR RACE, replayed on the clock the fingerprint reads.
 *
 * Claude Code writes a subagent as two files, `agent-<id>.jsonl` and
 * `agent-<id>.meta.json`, and on 2.1.283 the transcript usually lands FIRST
 * (17 of 24 pairs in `fixtures/cc-2.1.283`, the sidecar up to 372 ms later);
 * on 2.1.234 it was the other way round. A graft that looked inside that gap
 * refused the WHOLE session as `unsupported`, and the webview kept the refusal
 * screen after the pair completed.
 *
 * The ruling of 2026-09-29: an incomplete pair is PENDING, not refused, until
 * `PAIR_PENDING_WINDOW_MS` after the mtime of the file that exists; only a pair
 * still incomplete then refuses, with the codes that existed before. Both
 * orders. This file drives that on an injected clock, so both sides of the
 * boundary are reached exactly, with no sleep; `src/extension.test.ts` replays
 * the same race through the real data path on the real clock.
 *
 * Staged from the committed corpus into a temp root. The corpus is never
 * written (G6); only the copy loses a file.
 */
import { cp, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every test here grafts a real 600 KB session, about a second each on an idle
// machine. vitest's 5 s default is a test that passes or fails by CPU load.
vi.setConfig({ testTimeout: 30_000 });
import { agentNodes, graftSession } from './graft.js';
import type { GraftSessionResult } from './graft.js';
import { LivenessEngine } from './liveness.js';
import { SessionModel } from './session.js';
import { PAIR_PENDING_WINDOW_MS } from '../parser/fingerprint.js';
import { DEFAULT_DEBOUNCE_MS } from '../watch/watcher.js';

const SLUG = 'c--Users-dev-projects-agent-deck';
const CORPUS = fileURLToPath(new URL(`../../fixtures/cc-2.1.283/projects/${SLUG}`, import.meta.url));
const SESSION = 'd860ab28-db10-40dc-8775-ae00eeb21f23';
/** The pair with the widest measured gap: its sidecar landed 372 ms after its transcript. */
const AGENT = 'a704ec1707a92b778';
/** Another pair in the same session, for the "a real refusal still wins" case. */
const OTHER = 'a11592071f7a3b225';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Staged {
  main: string;
  subagents: string;
  transcript: string;
  meta: string;
}

async function stage(): Promise<Staged> {
  const root = await mkdtemp(join(tmpdir(), 'agent-deck-race-'));
  roots.push(root);
  const slugDir = join(root, SLUG);
  await cp(join(CORPUS, `${SESSION}.jsonl`), join(slugDir, `${SESSION}.jsonl`));
  await cp(join(CORPUS, SESSION), join(slugDir, SESSION), { recursive: true });
  const subagents = join(slugDir, SESSION, 'subagents');
  return {
    main: join(slugDir, `${SESSION}.jsonl`),
    subagents,
    transcript: join(subagents, `agent-${AGENT}.jsonl`),
    meta: join(subagents, `agent-${AGENT}.meta.json`),
  };
}

function subagentIds(result: GraftSessionResult): string[] {
  if (!result.ok) throw new Error(`not ok: ${result.mismatch.code}`);
  return agentNodes(result.snapshot.root)
    .filter((a) => a.kind === 'subagent')
    .map((a) => a.id)
    .sort();
}

const ORDERS = [
  {
    order: 'transcript first (the 2.1.283 order)',
    withhold: 'meta' as const,
    code: 'subagentMetaMissing',
  },
  {
    order: 'sidecar first (the 2.1.234 order)',
    withhold: 'transcript' as const,
    code: 'subagentTranscriptMissing',
  },
];

describe('PAIR_PENDING_WINDOW_MS', () => {
  it('is 2,000 ms: over five times the widest measured gap, and many debounces', () => {
    expect(PAIR_PENDING_WINDOW_MS).toBe(2_000);
    // 372 ms is the widest gap measured on 2.1.283 (the sidecar after the
    // transcript); 120 ms the widest on 2.1.234 (the other order).
    expect(PAIR_PENDING_WINDOW_MS).toBeGreaterThan(5 * 372);
    expect(PAIR_PENDING_WINDOW_MS).toBeGreaterThan(10 * DEFAULT_DEBOUNCE_MS);
  });
});

describe.each(ORDERS)('an incomplete pair, $order', ({ withhold, code }) => {
  async function withheld(): Promise<{ staged: Staged; mtimeMs: number; bytes: Buffer; path: string }> {
    const staged = await stage();
    const path = withhold === 'meta' ? staged.meta : staged.transcript;
    const present = withhold === 'meta' ? staged.transcript : staged.meta;
    const bytes = await readFile(path);
    await unlink(path);
    return { staged, mtimeMs: (await stat(present)).mtimeMs, bytes, path };
  }

  it('is pending 300 ms after the file that exists: no tree, no refusal, the would-be code kept', async () => {
    const { staged, mtimeMs } = await withheld();
    const result = await graftSession(staged.main, { now: () => mtimeMs + 300 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.pending).toEqual({
      agentIds: [AGENT],
      deadlineMs: mtimeMs + PAIR_PENDING_WINDOW_MS,
    });
    // The code the pair becomes if it never completes: a consumer that does
    // not know `pending` refuses with it, which is the safe direction.
    expect(result.mismatch.code).toBe(code);
    expect('snapshot' in result).toBe(false);
  });

  it('is still pending 1 ms before the deadline, and refused AT it with the existing code', async () => {
    const { staged, mtimeMs } = await withheld();
    const before = await graftSession(staged.main, {
      now: () => mtimeMs + PAIR_PENDING_WINDOW_MS - 1,
    });
    expect(!before.ok && before.pending !== undefined).toBe(true);

    const at = await graftSession(staged.main, { now: () => mtimeMs + PAIR_PENDING_WINDOW_MS });
    expect(at.ok).toBe(false);
    if (at.ok) return;
    expect(at.pending).toBeUndefined();
    expect(at.mismatch.code).toBe(code);
    expect(at.mismatch.field).toBe(AGENT);
  });

  it('grafts the whole tree once the second file lands, with no refusal in between', async () => {
    const { staged, mtimeMs, bytes, path } = await withheld();
    const pending = await graftSession(staged.main, { now: () => mtimeMs + 300 });
    expect(!pending.ok && pending.pending !== undefined).toBe(true);

    await writeFile(path, bytes);
    const whole = await graftSession(staged.main, { now: () => mtimeMs + 300 });
    const ids = subagentIds(whole);
    expect(ids).toHaveLength(12);
    expect(ids).toContain(AGENT);
    if (whole.ok) expect(whole.snapshot.parked).toEqual([]);
  });

  it('a real refusal on a COMPLETE pair still wins over a pending one', async () => {
    const { staged, mtimeMs } = await withheld();
    await writeFile(join(staged.subagents, `agent-${OTHER}.meta.json`), '{ not json');
    const result = await graftSession(staged.main, { now: () => mtimeMs + 300 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.pending).toBeUndefined();
    expect(result.mismatch.code).toBe('metaInvalidJson');
  });
});

describe('the session model keeps what the session had while a pair is pending', () => {
  function model(): SessionModel {
    return new SessionModel({
      workspacePath: 'C:\\Users\\dev\\projects\\agent-deck',
      liveness: new LivenessEngine({ now: () => 0 }),
    });
  }

  it('a pending result neither refuses nor replaces the last whole tree', async () => {
    const staged = await stage();
    const m = model();
    m.ingestGraftResult(SESSION, SLUG, await graftSession(staged.main));
    const before = m.sessionState(SESSION);
    expect(before?.schemaOk).toBe(true);
    m.emit();

    // A NEW subagent's transcript arrives without its sidecar.
    const bytes = await readFile(staged.transcript);
    await writeFile(join(staged.subagents, 'agent-a0000000000000new.jsonl'), bytes);
    const mtimeMs = (await stat(join(staged.subagents, 'agent-a0000000000000new.jsonl'))).mtimeMs;
    const pending = await graftSession(staged.main, { now: () => mtimeMs + 300 });
    expect(!pending.ok && pending.pending !== undefined).toBe(true);
    m.ingestGraftResult(SESSION, SLUG, pending);

    expect(m.refusalOf(SESSION)).toBeUndefined();
    expect(m.sessionState(SESSION)?.schemaOk).toBe(true);
    expect(m.sessionState(SESSION)?.root).toBe(before?.root);
    expect(m.emit().schemaMismatchSessionIds).toEqual([]);
  });

  it('a pending result from a first graft shows no refusal either', async () => {
    const staged = await stage();
    await unlink(staged.meta);
    const mtimeMs = (await stat(staged.transcript)).mtimeMs;
    const m = model();
    m.registerSession({ sessionId: SESSION, projectSlug: SLUG });
    m.ingestGraftResult(SESSION, SLUG, await graftSession(staged.main, { now: () => mtimeMs + 300 }));
    expect(m.refusalOf(SESSION)).toBeUndefined();
    expect(m.sessionState(SESSION)?.schemaOk).toBe(true);
    expect(m.emit().schemaMismatchSessionIds).toEqual([]);
  });

  it('the same pair past its deadline refuses, exactly as before 0.9.2', async () => {
    const staged = await stage();
    await unlink(staged.meta);
    const mtimeMs = (await stat(staged.transcript)).mtimeMs;
    const m = model();
    m.ingestGraftResult(
      SESSION,
      SLUG,
      await graftSession(staged.main, { now: () => mtimeMs + PAIR_PENDING_WINDOW_MS }),
    );
    expect(m.refusalOf(SESSION)?.mismatch).toBeDefined();
    expect(m.sessionState(SESSION)?.schemaOk).toBe(false);
    expect(m.emit().schemaMismatchSessionIds).toEqual([SESSION]);
  });
});
