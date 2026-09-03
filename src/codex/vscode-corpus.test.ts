/**
 * `fixtures/codex-vscode-*` — the WITNESS corpus for a Codex session started
 * from the VS Code extension, and the D1 regression it was harvested to pin.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CORPUS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Every transcript in the anchor corpus was produced by `codex exec`. The user
 * ran the shipped `release/0.6.0` build against the VS Code Codex extension
 * (`session_meta.payload.originator === "codex_vscode"`) and reported, by own
 * eyes, a terra session rendering a cell with no tool rows and no context
 * number where a `gpt-5.5` session rendered both.
 *
 * **The model was a red herring and this file records that, because the wrong
 * fix was available and cheap.** Measured across today's live root, 11 threads:
 * `custom_tool_call` (terra's shell shape) and `function_call` (`gpt-5.5`'s)
 * are BOTH already handled, both dialects graft, and a terra+vscode root
 * renders 13 tool rows and its context perfectly well - which is the first two
 * tests below. What the two sessions the user compared actually differed in
 * was whether the turn had recorded any usage at all before it ended.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY BROKEN (D1)
 * ---------------------------------------------------------------------------
 *
 * `model_context_window` is stated in TWO places and `readUsage` read one:
 *
 *   - `event_msg` `task_started`, top level. On every transcript, always.
 *   - `event_msg` `token_count`, under `info` — and **`info` can be `null`**.
 *
 * The terra session the user compared hit the account's usage limit
 * (`task_complete.error.codex_error_info === "usage_limit_exceeded"`). Its one
 * `token_count` carries `info: null`, so Context and Burn are correctly ABSENT
 * — there is no usage in the transcript to show, and an em dash is the
 * contract. But the window WAS stated, at ordinal 1, and the deck showed an em
 * dash for it too. That is the defect, and it is not model-specific: any turn
 * that ends before usage is recorded hits it.
 *
 * The vacuity controls below read the fixture's own bytes and assert that
 * `info` really is `null` and that `task_started` really does carry the
 * window — without them the regression test would pass on a corpus that had
 * simply stopped exhibiting the case.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { SessionState, TreeNode } from '../model/events.js';
import { readCodexEngine } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '..', 'fixtures');

/**
 * The witness corpora, derived rather than named: the version moves with a
 * re-harvest and a hard-coded directory reads as a regression when it does.
 *
 * It is distinguished from the ANCHOR corpus by carrying no `golden.json` —
 * the same property `golden.test.ts` and `egress.test.ts` already filter on,
 * so adding this corpus cannot pull either of them onto it.
 */
function witnessCorpora(): string[] {
  if (!existsSync(FIXTURES)) return [];
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('codex-vscode-'))
    .map((e) => e.name)
    .sort();
}

const CORPUS = witnessCorpora()[0];

/** Every run directory of the corpus, and the `.codex` root inside each. */
function runRoots(corpus: string): string[] {
  return readdirSync(join(FIXTURES, corpus), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(FIXTURES, corpus, e.name, 'home', '.codex'))
    .filter((p) => existsSync(p))
    .sort();
}

function transcripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  const sessions = join(root, 'sessions');
  if (existsSync(sessions)) walk(sessions);
  return out.sort();
}

interface Record_ {
  readonly type: string;
  readonly ordinal: number;
  readonly payload: Record<string, unknown>;
}

function records(file: string): Record_[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record_);
}

function countTools(node: TreeNode, acc = { agents: 0, tools: 0 }): { agents: number; tools: number } {
  if ('toolName' in node) {
    acc.tools += 1;
    return acc;
  }
  acc.agents += 1;
  for (const child of node.children) countTools(child, acc);
  return acc;
}

async function readCorpus(): Promise<SessionState[]> {
  if (CORPUS === undefined) throw new Error('no fixtures/codex-vscode-* corpus on disk');
  const sessions: SessionState[] = [];
  for (const root of runRoots(CORPUS)) {
    const outcome = await readCodexEngine({ root });
    if (outcome.kind !== 'ok') throw new Error(`engine did not read ${root}: ${outcome.kind}`);
    sessions.push(...outcome.result.sessions);
  }
  return sessions;
}

describe('fixtures/codex-vscode-*: the corpus is what it claims to be', () => {
  it('exists, and every transcript in it is an extension-originated terra session', () => {
    expect(CORPUS, 'no codex-vscode-* witness corpus on disk').toBeDefined();
    const files = runRoots(CORPUS as string).flatMap(transcripts);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const metas = records(file).filter((r) => r.type === 'session_meta');
      expect(metas.length, `${file} has no session_meta`).toBeGreaterThan(0);
      // The one fact that makes this corpus a WITNESS rather than a copy of the
      // anchor: `codex exec` wrote every anchor transcript, and none of these.
      expect(metas[0]?.payload['originator']).toBe('codex_vscode');
    }
  });

  it('carries no golden.json, which is what keeps the anchor-corpus suites off it', () => {
    // Not decoration: `golden.test.ts` and `egress.test.ts` both select a
    // corpus by `existsSync(golden.json)`. If this corpus ever grows one, both
    // start iterating it and the reason will not be obvious from their failure.
    expect(existsSync(join(FIXTURES, CORPUS as string, 'golden.json'))).toBe(false);
  });
});

describe('D1: a terra session from the VS Code extension renders its rows and numbers', () => {
  it('renders tool-call rows, and as many as the transcript carries', async () => {
    const sessions = await readCorpus();
    const withTools = sessions.filter((s) => countTools(s.root).tools > 0);
    expect(withTools.length, 'no session in the witness corpus rendered a tool row').toBeGreaterThan(0);

    // Derived, never written down: the tree's tool rows must equal the
    // transcript's own tool-call records. `custom_tool_call` is terra's shell
    // shape and `function_call` its spawn shape; both count.
    const files = runRoots(CORPUS as string).flatMap(transcripts);
    const declared = files
      .flatMap(records)
      .filter((r) => r.type === 'response_item')
      .filter((r) => {
        const t = r.payload['type'];
        return t === 'function_call' || t === 'custom_tool_call' || t === 'tool_search_call';
      }).length;
    const rendered = sessions.reduce((n, s) => n + countTools(s.root).tools, 0);
    expect(rendered).toBe(declared);
    expect(declared).toBeGreaterThan(0);
  });

  it('renders a context number and a burn number for the session that has usage', async () => {
    const sessions = await readCorpus();
    const withUsage = sessions.filter((s) => s.contextNow !== undefined);
    expect(withUsage.length, 'no session rendered a context number').toBeGreaterThan(0);
    for (const session of withUsage) {
      expect(session.contextNow?.prompt).toBeGreaterThan(0);
      expect(session.burn, 'a session with context must carry burn too').toBeDefined();
    }
  });

  it('tags every session `codex` and refuses none of them', async () => {
    const sessions = await readCorpus();
    for (const session of sessions) {
      expect(session.engine).toBe('codex');
      expect(session.schemaOk, `${session.sessionId} was refused`).toBe(true);
    }
  });
});

describe('D1 regression: the window survives a turn that recorded no usage', () => {
  /** The session whose only `token_count` carries `info: null`. */
  function usageLimitedFile(): string {
    const files = runRoots(CORPUS as string).flatMap(transcripts);
    const found = files.find((f) =>
      records(f).some(
        (r) =>
          r.type === 'event_msg' &&
          r.payload['type'] === 'token_count' &&
          r.payload['info'] === null,
      ),
    );
    if (found === undefined) throw new Error('no transcript with a null token_count.info');
    return found;
  }

  it('vacuity control: the fixture really does carry `info: null` and a window on `task_started`', () => {
    const recs = records(usageLimitedFile());

    const tokenCounts = recs.filter(
      (r) => r.type === 'event_msg' && r.payload['type'] === 'token_count',
    );
    expect(tokenCounts.length).toBeGreaterThan(0);
    // EVERY one, not merely one of them: a single populated `info` anywhere in
    // the file would make the regression test below pass by the old code path.
    for (const record of tokenCounts) expect(record.payload['info']).toBeNull();

    const started = recs.filter(
      (r) => r.type === 'event_msg' && r.payload['type'] === 'task_started',
    );
    expect(started.length).toBeGreaterThan(0);
    expect(typeof started[0]?.payload['model_context_window']).toBe('number');
  });

  it('vacuity control: that turn ended on the account usage limit', () => {
    const recs = records(usageLimitedFile());
    const complete = recs.find(
      (r) => r.type === 'event_msg' && r.payload['type'] === 'task_complete',
    );
    const error = complete?.payload['error'] as { codex_error_info?: unknown } | undefined;
    expect(error?.codex_error_info).toBe('usage_limit_exceeded');
  });

  it('reports windowTokens from `task_started` when `token_count.info` is null', async () => {
    const recs = records(usageLimitedFile());
    const stated = recs.find(
      (r) => r.type === 'event_msg' && r.payload['type'] === 'task_started',
    )?.payload['model_context_window'];

    const sessions = await readCorpus();
    const session = sessions.find((s) => s.contextNow === undefined && s.burn === undefined);
    expect(session, 'no usage-free session in the corpus').toBeDefined();

    // The defect: this was `undefined`, so the deck showed an em dash for a
    // number the transcript states plainly.
    expect(session?.windowTokens).toBe(stated);
    expect(session?.windowTokens).toBeGreaterThan(0);
  });

  it('leaves context and burn ABSENT for that session, because the transcript has none', async () => {
    // The other half of the same ruling, and it is not a defect: a zero here
    // would be a wrong number rather than a missing one (G3).
    const sessions = await readCorpus();
    const session = sessions.find((s) => s.windowTokens !== undefined && s.contextNow === undefined);
    expect(session).toBeDefined();
    expect(session?.contextNow).toBeUndefined();
    expect(session?.burn).toBeUndefined();
  });
});
