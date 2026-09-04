/**
 * D1 — the context window has TWO sources, and `token_count.info` is nullable.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS REPORTED, AND WHY THE REPORT POINTED AT THE WRONG THING
 * ---------------------------------------------------------------------------
 *
 * The user ran the shipped `release/0.6.0` build against the VS Code Codex
 * extension and reported, by own eyes, a `gpt-5.6-terra` session rendering a
 * cell with no tool rows and no context number where a `gpt-5.5` session
 * rendered both.
 *
 * **The model was a red herring, and this file records that because the wrong
 * fix was available and cheap.** Measured across the live root, 11 threads:
 * `custom_tool_call` (terra's shell shape) and `function_call` are BOTH already
 * handled, both dialects graft, and a terra session started from the extension
 * renders 13 tool rows and its context perfectly well. `originator` —
 * `codex_vscode` against `codex_exec` — differs in nothing the engine reads.
 * What the two compared sessions actually differed in was whether the turn had
 * recorded any usage at all before it ended: one had hit the account usage
 * limit.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY BROKEN
 * ---------------------------------------------------------------------------
 *
 * `model_context_window` is stated in TWO places and `readUsage` read one:
 *
 *   - `event_msg` `task_started`, at the payload's TOP level. On every
 *     transcript in both committed corpora.
 *   - `event_msg` `token_count`, under `info` — and **`info` can be `null`**,
 *     which is not the same as absent and which `asObject(null)` cannot tell
 *     apart from it.
 *
 * A turn that ends before any usage exists — interrupted, or killed by the
 * account limit — leaves `info: null`. Context and Burn are then correctly
 * ABSENT (there is no usage to show, and an em dash is the contract, G3), but
 * the WINDOW was stated and the deck showed an em dash for it too. Not
 * model-specific: any engine, any model, any turn that ends early.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TESTS A MUTATION AND NOT A HARVESTED FIXTURE
 * ---------------------------------------------------------------------------
 *
 * The case was first pinned by a witness corpus harvested from the session the
 * user actually saw. **That corpus was withdrawn by user ruling on 2026-09-04**
 * and lives under `lab/` only: it was captured with the extension open on THIS
 * repository, so its `cwd` is the agent-deck checkout rather than the dedicated
 * `codex-probe/scratch` subject G8 requires, and a fixture carrying this
 * repository's own cwd does not cross into `fixtures/`.
 *
 * So the input is built here instead, by MUTATING a run of the anchor corpus —
 * whose cwd is `codex-probe/scratch` — in the one field the defect is about.
 * That is a strictly stronger test than the withdrawn one, because it holds
 * BOTH arms of the comparison against otherwise identical bytes: the same run,
 * unmutated, must render a context number, and mutated must still render the
 * window. A harvested fixture could only ever show one arm.
 *
 * The real capture is still owed: PLAN.md Phase 4 carries a DoD line to
 * re-harvest this case from `codex-probe/scratch` once the account's usage
 * limit lifts (2026-10-03), which is what makes the null-`info` shape a
 * measured Codex behaviour rather than one this file asserts about itself. The
 * vacuity control below is what keeps that honest in the meantime: it reads the
 * unmutated bytes and asserts the anchor corpus contains NO null `info`, so the
 * mutation is provably doing the work.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import type { SessionState, TreeNode } from '../model/events.js';
import { readCodexEngine } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '..', 'fixtures');

/**
 * The anchor corpus, derived rather than named: the version moves with a
 * re-harvest and a hard-coded directory reads as a regression when it does.
 * The anchor is the one carrying a `golden.json` — the same property
 * `golden.test.ts` and `graft.test.ts` select on, rather than sort order, so a
 * future witness corpus cannot pull this file onto itself.
 */
function anchorCorpus(): string {
  const found = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('codex-'))
    .map((e) => e.name)
    .filter((name) => existsSync(join(FIXTURES, name, 'golden.json')))
    .sort();
  const first = found[0];
  if (first === undefined) throw new Error('no codex anchor corpus (none carries golden.json)');
  return first;
}

const CORPUS = anchorCorpus();

/**
 * The run this file mutates. `baseline` is chosen because it is the simplest
 * thing in the corpus that exhibits every quantity under test at once: shell
 * tool calls, recorded usage, and a `task_started` window.
 */
const RUN = 'baseline';

const staged: string[] = [];

afterAll(async () => {
  for (const dir of staged) await rm(dir, { recursive: true, force: true });
});

/**
 * Copy the run's `.codex` root into a temp directory, optionally rewriting each
 * transcript record on the way through, and answer the staged root.
 *
 * `realpathSync.native()` first, and it is not cosmetic: libuv ABORTS the
 * process — no failing assertion, no summary line — when a watched path has an
 * 8.3 short component, and `os.tmpdir()` on a Windows runner is exactly that
 * shape.
 */
async function stage(
  transform?: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const dir = await mkdtemp(join(realpathSync.native(tmpdir()), 'agent-deck-codex-window-'));
  staged.push(dir);
  const source = join(FIXTURES, CORPUS, RUN, 'home', '.codex');
  const root = join(dir, '.codex');
  await cp(source, root, { recursive: true });
  if (transform === undefined) return root;

  for (const file of transcriptsUnder(root)) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    const out = lines.map((line) =>
      line.trim() === '' ? line : JSON.stringify(transform(JSON.parse(line) as Record<string, unknown>)),
    );
    await writeFile(file, out.join('\n'), 'utf8');
  }
  return root;
}

function transcriptsUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  const sessions = join(root, 'sessions');
  if (existsSync(sessions)) walk(sessions);
  return out.sort();
}

interface Record_ {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function records(root: string): Record_[] {
  return transcriptsUnder(root).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record_),
  );
}

const isEvent = (r: Record_, type: string): boolean =>
  r.type === 'event_msg' && r.payload['type'] === type;

/** Null every `token_count.info`, and touch nothing else. */
function nullUsage(record: Record<string, unknown>): Record<string, unknown> {
  const payload = record['payload'];
  if (record['type'] !== 'event_msg' || payload === null || typeof payload !== 'object') {
    return record;
  }
  const body = payload as Record<string, unknown>;
  if (body['type'] !== 'token_count') return record;
  return { ...record, payload: { ...body, info: null } };
}

async function read(root: string): Promise<SessionState[]> {
  const outcome = await readCodexEngine({ root });
  if (outcome.kind !== 'ok') throw new Error(`engine did not read ${root}: ${outcome.kind}`);
  return [...outcome.result.sessions];
}

function toolRows(node: TreeNode): number {
  if ('toolName' in node) return 1;
  return node.children.reduce((n, child) => n + toolRows(child), 0);
}

const totalToolRows = (sessions: readonly SessionState[]): number =>
  sessions.reduce((n, s) => n + toolRows(s.root), 0);

/** The window the transcript states on `task_started`. Derived, never written down. */
function statedWindow(root: string): number {
  const started = records(root).filter((r) => isEvent(r, 'task_started'));
  const value = started[0]?.payload['model_context_window'];
  if (typeof value !== 'number') throw new Error('no task_started window in the staged run');
  return value;
}

describe('the anchor run, unmutated: the control arm', () => {
  it('renders tool rows, a context number and the stated window', async () => {
    const root = await stage();
    const sessions = await read(root);

    expect(sessions.length).toBeGreaterThan(0);
    expect(totalToolRows(sessions)).toBeGreaterThan(0);

    const withUsage = sessions.filter((s) => s.contextNow !== undefined);
    expect(withUsage.length, 'the control arm must have usage to be a control').toBeGreaterThan(0);
    for (const session of withUsage) {
      expect(session.contextNow?.prompt).toBeGreaterThan(0);
      expect(session.burn, 'a session with context carries burn too').toBeDefined();
      expect(session.windowTokens).toBe(statedWindow(root));
    }
  });

  it('vacuity control: the corpus carries NO null `token_count.info`', async () => {
    // The mutation below is only doing work while this holds. If a later
    // harvest brings a genuinely usage-limited transcript into the anchor
    // corpus, this goes red — and the right response is to point the
    // regression at the real bytes and delete the mutation, not to relax it.
    const root = await stage();
    const counts = records(root).filter((r) => isEvent(r, 'token_count'));
    expect(counts.length).toBeGreaterThan(0);
    for (const record of counts) expect(record.payload['info']).not.toBeNull();
  });
});

describe('D1: the window survives a turn that recorded no usage', () => {
  it('vacuity control: the mutant really does carry `info: null`, and a window', async () => {
    const root = await stage(nullUsage);

    const counts = records(root).filter((r) => isEvent(r, 'token_count'));
    expect(counts.length).toBeGreaterThan(0);
    // EVERY one, not merely one of them: a single surviving populated `info`
    // would make the regression below pass by the old code path.
    for (const record of counts) expect(record.payload['info']).toBeNull();

    const started = records(root).filter((r) => isEvent(r, 'task_started'));
    expect(started.length).toBeGreaterThan(0);
    expect(typeof started[0]?.payload['model_context_window']).toBe('number');
  });

  it('reports windowTokens from `task_started` when every `token_count.info` is null', async () => {
    const root = await stage(nullUsage);
    const sessions = await read(root);
    expect(sessions.length).toBeGreaterThan(0);

    // The defect: this was `undefined`, so the deck showed an em dash for a
    // number the transcript states plainly, at ordinal 1, on every model.
    for (const session of sessions) {
      expect(session.windowTokens).toBe(statedWindow(root));
      expect(session.windowTokens).toBeGreaterThan(0);
    }
  });

  it('leaves context and burn ABSENT, because the transcript now has none', async () => {
    // The other half of the same ruling, and it is not a defect: a zero here
    // would be a wrong number rather than a missing one (G3).
    const root = await stage(nullUsage);
    for (const session of await read(root)) {
      expect(session.contextNow).toBeUndefined();
      expect(session.burn).toBeUndefined();
    }
  });

  it('renders the same tool rows with usage absent as with usage present', async () => {
    // D1 was REPORTED as missing tool rows. It never was — and the only way to
    // say so with evidence is to hold the two arms against each other rather
    // than to assert a number this file made up.
    const control = totalToolRows(await read(await stage()));
    const mutant = totalToolRows(await read(await stage(nullUsage)));
    expect(control).toBeGreaterThan(0);
    expect(mutant).toBe(control);
  });

  it('tags every session `codex` and refuses none of them', async () => {
    for (const session of await read(await stage(nullUsage))) {
      expect(session.engine).toBe('codex');
      expect(session.schemaOk, `${session.sessionId} was refused`).toBe(true);
    }
  });
});
