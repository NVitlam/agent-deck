// R6 — the wire corpus, the replay, and the theater's isolation.
//
// Four separable obligations, one file, one section each:
//
//   1. `scripts/record-wire.mjs` regenerates the committed corpus
//      DETERMINISTICALLY: run it twice, compare bytes.
//   2. Replaying the corpus through the REAL store converges on the model's
//      own final snapshot — which is what makes the recording trustworthy
//      rather than merely plausible.
//   3. `node esbuild.config.mjs --theater` builds the dev-only page.
//   4. The theater is UNREACHABLE from `webview/main.ts`, asserted against the
//      real import graph rather than asserted in a comment.
//
// A node suite, not a jsdom one, for two reasons. `scripts/record-wire.mjs`
// and `webview/theater/import-graph.mjs` both run esbuild, and esbuild refuses
// to start in a jsdom realm (see `webview/build-harness.mjs`) — so they are
// spawned as their own processes here, and `record-wire.mjs` is also IMPORTED
// for its validation rules, which would drag esbuild into this realm under
// jsdom. And nothing below needs a DOM: the store is a pure reducer.
//
// Node builtins are imported by their real specifiers. `tsconfig.webview.json`
// sets `types: []`, which removes node's GLOBALS (`process`, `Buffer`) from
// this project but does not stop an explicit `node:*` import resolving — the
// same arrangement `capture.test.ts` uses. That is why paths below are
// resolved with `resolve()` against the process working directory, which
// vitest sets to the repo root.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TOUCH: `dist/webview/main.js`.
// `webview/bundle.test.ts` rebuilds and reads that exact path, and vitest runs
// files in parallel, so a second suite reading it would race and fail for a
// reason that has nothing to do with either test. The shipped bundle being
// byte-unchanged by the `--theater` target is verified outside the suite, by
// building `--webview` from the previous revision of `esbuild.config.mjs` and
// from this one and comparing digests; `--theater` emits only into
// `dist/theater/`, which nothing else writes.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HostToWebviewMessage, SessionState } from '../src/model/events.js';
import { isAgentNode } from '../src/model/events.js';
import { SYNTHETIC_CORPUS_PREFIX, WIRE_CORPUS_DIR } from './canvas-contract.js';
import { createStore } from './store.js';
import type { WebviewView } from './store.js';
import type { WireCorpus } from './theater/corpus-types.js';
import { replayAll } from './theater/replay.js';

const REPO_ROOT = resolve('.');
const RECORDER = 'scripts/record-wire.mjs';
/** The same script, as an import specifier `tsc` will not try to resolve. */
const RECORDER_MODULE = '../scripts/record-wire.mjs';
const GRAPH_TOOL = 'webview/theater/import-graph.mjs';
const COMMITTED = resolve(WIRE_CORPUS_DIR);
const CAPTURED_FIXTURES = resolve('fixtures/cc-2.1.234/projects');
const THEATER_DIR = resolve('dist/theater');

/** One recorder run's files, keyed by name, byte-exact as latin1 strings. */
type Run = Map<string, string>;

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * latin1 maps one byte to one code point, so string equality IS byte equality
 * — without naming `Buffer`, which this project has no types for.
 */
async function readRun(dir: string, encoding: 'latin1' | 'utf8' = 'latin1'): Promise<Run> {
  const out: Run = new Map();
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith('.json')) continue;
    out.set(name, await readFile(join(dir, name), encoding));
  }
  return out;
}

async function record(outDir: string): Promise<Run> {
  run('node', [RECORDER, '--out', outDir]);
  return readRun(outDir);
}

/**
 * `.gitattributes` marks everything outside `fixtures/**` as text and
 * `core.autocrlf=true` is set on the dev machine, so a fresh CHECKOUT can hand
 * the committed corpus back with CRLF while the recorder always writes LF.
 * That is a checkout artifact, not a recorder defect, and normalising here is
 * what keeps the staleness assertion about the recorder. The run-twice
 * comparison does NOT normalise: both sides came from the recorder, so any
 * difference there is real.
 */
function lf(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

interface Graph {
  entry: string;
  inputs: string[];
}

function importGraph(entry: string): Graph {
  return JSON.parse(run('node', [GRAPH_TOOL, entry])) as Graph;
}

let tempRoot: string;
let runA: Run;
let runB: Run;
let committed: Run;
/** The first run, decoded as UTF-8 and parsed. Every content assertion uses it. */
let corpora: WireCorpus[];
let theaterBundle: string;
let mainGraph: Graph;
let theaterGraph: Graph;

beforeAll(async () => {
  // Under `dist/` (gitignored, inside the repo) rather than the OS temp
  // directory: this package writes nothing outside the repo (G1).
  await mkdir(resolve('dist'), { recursive: true });
  tempRoot = await mkdtemp(resolve('dist', 'wire-test-'));
  runA = await record(join(tempRoot, 'a'));
  runB = await record(join(tempRoot, 'b'));
  committed = await readRun(COMMITTED);

  const text = await readRun(join(tempRoot, 'a'), 'utf8');
  corpora = [...text.values()].map((body) => JSON.parse(body) as WireCorpus);

  run('node', ['esbuild.config.mjs', '--theater']);
  theaterBundle = await readFile(join(THEATER_DIR, 'main.js'), 'utf8');

  mainGraph = importGraph('webview/main.ts');
  theaterGraph = importGraph('webview/theater/main.ts');
}, 180_000);

afterAll(async () => {
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
});

/** The one fixture-derived corpus this recorder produces. */
function recorded(): WireCorpus {
  const found = corpora.find((c) => c.kind === 'recorded');
  if (found === undefined) throw new Error('the recorder produced no recorded corpus');
  return found;
}

// ---------------------------------------------------------------------------
// 1. Determinism
// ---------------------------------------------------------------------------

describe('the recorder is deterministic', () => {
  it('writes the same file set twice', () => {
    expect([...runB.keys()]).toStrictEqual([...runA.keys()]);
    expect(runA.size).toBeGreaterThan(0);
  });

  it('writes byte-identical bytes twice, with no code change in between', () => {
    for (const [name, bytes] of runA) {
      const other = runB.get(name);
      expect(other, `${name} missing from the second run`).toBeDefined();
      expect(
        other?.length,
        `${name} differs in LENGTH between two runs of an unchanged recorder`,
      ).toBe(bytes.length);
      expect(other, `${name} differs BYTE-FOR-BYTE between two runs`).toBe(bytes);
    }
  });

  it('writes LF only, and no raw control byte', () => {
    for (const [name, bytes] of runA) {
      // A CR in the recorder's own output would make byte-identity depend on
      // the platform, and `.gitattributes` cannot be relied on to hide it.
      expect(bytes.indexOf('\r'), `${name} contains a CR`).toBe(-1);
      // A literal control byte makes a tracked file BINARY to git — no
      // reviewable diff ever again, and it defeats the `grep -a` privacy
      // sweep. `JSON.stringify` escapes everything below 0x20; this is the
      // measurement that says so.
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(bytes), `${name} has a control byte`).toBe(
        false,
      );
    }
  });

  it('carries no wall clock in its own metadata', () => {
    // The message payloads are fixture CONTENT and are not normalised — tool
    // inputs in the captured transcripts contain absolute paths, and stripping
    // them would make the corpus stop being a recording of the real wire. What
    // must not carry a clock is the recorder's own framing: offsets are
    // relative, and `simulatedEpochMs` is a fixed constant, not a record time.
    for (const corpus of corpora) {
      expect(corpus.events[0]?.atMs).toBe(0);
      let previous = -1;
      for (const event of corpus.events) {
        expect(Number.isInteger(event.atMs)).toBe(true);
        expect(event.atMs).toBeGreaterThanOrEqual(previous);
        previous = event.atMs;
      }
      expect(corpus.durationMs).toBe(previous);
      expect(JSON.stringify(corpus.steps)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    }
  });

  it('matches what is committed under the corpus directory', () => {
    // Staleness detection. If this fails the committed corpus describes code
    // that no longer exists: re-run `node scripts/record-wire.mjs` and commit.
    // It is NOT a renderer regression on its own.
    for (const [name, bytes] of runA) {
      expect(
        committed.has(name),
        `${WIRE_CORPUS_DIR}/${name} is missing — run \`node ${RECORDER}\``,
      ).toBe(true);
      expect(
        lf(committed.get(name) ?? ''),
        `${WIRE_CORPUS_DIR}/${name} is stale — re-run \`node ${RECORDER}\``,
      ).toBe(lf(bytes));
    }
  });

  it('leaves a synthetic corpus in the directory alone', () => {
    // The recorder deletes only the files it is about to write. A synthetic
    // stress corpus is produced by a different generator into the same
    // directory and must survive a re-record.
    for (const name of committed.keys()) {
      if (!name.startsWith(SYNTHETIC_CORPUS_PREFIX)) continue;
      expect(runA.has(name), `${name} was clobbered by the recorder`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. What the corpus is
// ---------------------------------------------------------------------------

describe('the corpus is a recording of the real wire', () => {
  it('names itself recorded, without the synthetic prefix', () => {
    // The prefix is the only thing that keeps "replayed from fixtures" and
    // "invented" distinguishable on disk forever.
    for (const [name] of runA) {
      const corpus = corpora.find((c) => `${c.id}.json` === name);
      expect(corpus, `${name} does not name itself`).toBeDefined();
      expect(name.startsWith(SYNTHETIC_CORPUS_PREFIX)).toBe(corpus?.kind === 'synthetic');
    }
    expect(recorded().recordedFrom).toBe('fixtures/cc-2.1.234/projects');
  });

  it('carries both wire paths: snapshots and diffs', () => {
    const types = recorded().events.map((e) => e.message.type);
    expect(types.filter((t) => t === 'snapshot').length).toBeGreaterThanOrEqual(2);
    expect(types.filter((t) => t === 'diff').length).toBeGreaterThan(0);
    expect(types).toContain('schemaMismatch');
    expect(types).toContain('degraded');
  });

  it('ends on diffs, so convergence is not a snapshot re-statement', () => {
    // If the last event were a full snapshot, "replay converges on the final
    // state" would hold whether or not one patch applied correctly. The arc is
    // ordered so the reload sits in the middle; this is the property that says
    // so, checked rather than trusted.
    const types = recorded().events.map((e) => e.message.type);
    const lastSnapshot = types.lastIndexOf('snapshot');
    expect(types.slice(lastSnapshot + 1)).toContain('diff');
  });

  it('G4: no thinking signature bytes survive into the corpus', async () => {
    // CC's thinking blocks are EMPTY on disk and the `signature` field carries
    // the bytes, so asserting that thinking TEXT does not leak is vacuous. The
    // signatures are read out of the fixtures at test time; pinning a literal
    // here would rot on the next harvest.
    const slugs = (await readdir(CAPTURED_FIXTURES, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const signatures: string[] = [];
    for (const slug of slugs) {
      const dir = join(CAPTURED_FIXTURES, slug);
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const text = await readFile(join(dir, name), 'utf8');
        for (const match of text.matchAll(/"signature":"([^"\\]{40,})"/g)) {
          const value = match[1];
          if (value !== undefined) signatures.push(value);
        }
      }
    }
    expect(signatures.length).toBeGreaterThan(0);

    for (const [name, body] of runA) {
      for (const signature of signatures) {
        expect(body.includes(signature.slice(0, 64)), `${name} carries a signature`).toBe(false);
      }
      expect(body).not.toContain('"thinking"');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Replay through the REAL store equals the direct-snapshot golden
// ---------------------------------------------------------------------------

/** The store's own view, after feeding it a list of messages in order. */
function viewOf(messages: readonly HostToWebviewMessage[]): WebviewView {
  const store = createStore();
  for (const message of messages) store.handleMessage(message);
  return store.getView();
}

/**
 * The golden: the host's FINAL belief handed to a fresh store directly, in the
 * order the bridge would send it (snapshot, then mismatches, then degraded).
 *
 * `final.sessions` comes from `SessionEmission.sessions` — the model's own
 * snapshot — and NOT from applying the recorded diffs. That independence is
 * the whole point of the comparison below.
 */
function goldenMessages(corpus: WireCorpus): HostToWebviewMessage[] {
  const messages: HostToWebviewMessage[] = [
    { type: 'snapshot', sessions: corpus.final.sessions },
  ];
  for (const sessionId of corpus.final.schemaMismatchSessionIds) {
    messages.push({ type: 'schemaMismatch', sessionId });
  }
  const { degraded, reason } = corpus.final.degraded;
  messages.push(
    degraded && reason !== undefined
      ? { type: 'degraded', degraded: true, reason }
      : { type: 'degraded', degraded },
  );
  return messages;
}

function countNodes(state: SessionState): number {
  let n = 0;
  const visit = (node: SessionState['root'] | SessionState['root']['children'][number]): void => {
    n += 1;
    if (isAgentNode(node)) for (const child of node.children) visit(child);
  };
  visit(state.root);
  return n;
}

describe('replaying the corpus through the real store', () => {
  it('lands on a view equal to the direct-snapshot golden', () => {
    const corpus = recorded();

    const replayed = createStore();
    replayAll(corpus, (message) => {
      replayed.handleMessage(message);
    });

    // The real reducer, not a second one written for the theater: the store
    // here is `webview/store.ts`'s, and so is the one the theater drives.
    expect(replayed.getView()).toStrictEqual(viewOf(goldenMessages(corpus)));
  });

  it('applies every patch: nothing was skipped or half-applied', () => {
    const corpus = recorded();
    const replayed = createStore();
    replayAll(corpus, (message) => {
      replayed.handleMessage(message);
    });
    const view = replayed.getView();

    // A failed patch leaves the last good state on screen and records why.
    // Without this the equality above could pass because both sides stalled.
    expect(view.patchFailure).toBeUndefined();
    expect(view.sessions.length).toBe(corpus.final.sessions.length);
    expect(view.selected).toBeDefined();
    // Not an empty tree, so nothing above is vacuous.
    const nodes = corpus.final.sessions.map(countNodes);
    expect(Math.max(...nodes)).toBeGreaterThan(1);
  });

  it('the diffs carry information: mid-arc is not the final view', () => {
    // If the trailing diffs were no-ops, "converges on the final state" would
    // be true of the last snapshot alone. Replay up to and including the last
    // snapshot and the view must DIFFER from the final one.
    const corpus = recorded();
    const types = corpus.events.map((e) => e.message.type);
    const lastSnapshot = types.lastIndexOf('snapshot');
    const partial = viewOf(corpus.events.slice(0, lastSnapshot + 1).map((e) => e.message));
    const final = viewOf(goldenMessages(corpus));

    expect(partial.sessions.map((s) => s.liveness)).not.toStrictEqual(
      final.sessions.map((s) => s.liveness),
    );
  });

  it('the refused session renders as refused on both paths', () => {
    // G3 through the wire: a session the fingerprint refused reaches the store
    // as `schemaOk: false` plus a `schemaMismatch`, and the store must mark it.
    const corpus = recorded();
    const refusedIds = corpus.final.sessions.filter((s) => !s.schemaOk).map((s) => s.sessionId);
    expect(refusedIds.length).toBeGreaterThan(0);

    const replayed = createStore();
    replayAll(corpus, (message) => {
      replayed.handleMessage(message);
    });
    for (const view of [replayed.getView(), viewOf(goldenMessages(corpus))]) {
      for (const id of refusedIds) {
        expect(view.sessions.find((s) => s.sessionId === id)?.refused).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The theater builds, and is unreachable from `main.ts`
// ---------------------------------------------------------------------------

describe('the --theater esbuild target', () => {
  it('emits a page and a script into dist/theater', async () => {
    const emitted = (await readdir(THEATER_DIR)).sort();
    expect(emitted).toContain('index.html');
    expect(emitted).toContain('main.js');
    expect(theaterBundle.length).toBeGreaterThan(1000);
  });

  it('embeds the committed corpus rather than fetching it', () => {
    // The theater is opened as a `file://` page; a fetch would fail there.
    for (const corpus of corpora) {
      expect(theaterBundle).toContain(corpus.id);
    }
    expect(theaterBundle).not.toMatch(/\bfetch\s*\(/);
  });

  it('drives the real renderer, not a copy of it', () => {
    // A marker only the shipped components emit. If the theater ever stopped
    // importing `webview/main.ts` this is what would notice.
    expect(theaterBundle).toContain('cost not computed');
  });
});

describe('the theater is unreachable from the shipped webview', () => {
  it('does not appear in webview/main.ts import graph', () => {
    // The real graph, walked by esbuild with the shipped build's resolution —
    // not a naming convention and not a comment.
    const leaked = mainGraph.inputs.filter(
      (p) =>
        p.startsWith('webview/theater/') ||
        p.startsWith(`${WIRE_CORPUS_DIR}/`) ||
        p.startsWith('wire-corpus:'),
    );
    expect(leaked).toStrictEqual([]);
    // The graph is a real one: it contains the entry and the store.
    expect(mainGraph.inputs).toContain('webview/main.ts');
    expect(mainGraph.inputs).toContain('webview/store.ts');
  });

  it('does not reach the harness or the testkit either', () => {
    // Same rule, same tool, for the dev-only modules that predate the theater.
    for (const devOnly of ['webview/harness.ts', 'webview/testkit.ts']) {
      expect(mainGraph.inputs).not.toContain(devOnly);
    }
  });

  it('positive control: the tool DOES see the theater from its own entry', () => {
    // Without this, a graph tool that had stopped reporting theater modules
    // would make the assertion above pass while proving nothing.
    expect(theaterGraph.inputs).toContain('webview/theater/main.ts');
    expect(theaterGraph.inputs).toContain('webview/theater/replay.ts');
    expect(theaterGraph.inputs.some((p) => p.startsWith('wire-corpus:'))).toBe(true);
    // ...and the theater reaches the renderer, which is the direction that is
    // allowed. The edge that must never exist is the reverse one.
    expect(theaterGraph.inputs).toContain('webview/main.ts');
  });
});

// ---------------------------------------------------------------------------
// 5. The theater actually drives the renderer
// ---------------------------------------------------------------------------

/**
 * jsdom, reached through an opaque specifier.
 *
 * The same dodge `testkit.ts` documents: a literal `import ... from 'jsdom'`
 * would put jsdom's node-typed declarations into `tsconfig.webview.json`,
 * which sets `types: []` precisely so the webview project cannot see node.
 *
 * A hand-built DOM rather than vitest's jsdom ENVIRONMENT, because every
 * esbuild call in this file is a child process and esbuild refuses to start in
 * a jsdom realm — running the whole file under jsdom would break the other
 * four sections to smoke-test this one.
 */
const JSDOM_MODULE = 'jsdom';

interface TheaterWindow {
  document: Document;
  Event: typeof Event;
  eval(code: string): unknown;
  close(): void;
}

interface JsdomModule {
  JSDOM: new (
    html: string,
    options: { runScripts: 'outside-only'; pretendToBeVisual: boolean },
  ) => { window: TheaterWindow };
}

/** Let Svelte's scheduler run. The transport's seek is synchronous; mount is not. */
async function settle(): Promise<void> {
  await new Promise<void>((done) => {
    setTimeout(done, 50);
  });
}

describe('the built theater page', () => {
  it('scrubs the corpus into the real renderer, and rewinds by rebuilding', async () => {
    // A theater that builds and is dead on arrival satisfies "builds" and
    // nothing else. This is the seam between the two packages — the class of
    // bug that produced `#agent-deck-root` — so it is measured, not assumed.
    const { JSDOM } = (await import(/* @vite-ignore */ JSDOM_MODULE)) as unknown as JsdomModule;
    const html = await readFile(join(THEATER_DIR, 'index.html'), 'utf8');
    // `runScripts: 'outside-only'` never fetches the page's own <script>, so
    // the bundle is evaluated explicitly below and nothing loads off disk.
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    try {
      window.eval(theaterBundle);
      const doc = window.document;
      const query = (selector: string): number => doc.querySelectorAll(selector).length;

      expect(query('.theater-transport')).toBe(1);
      expect(query('.theater-scrubber')).toBe(1);
      expect(query('.theater-speed')).toBe(1);
      expect(
        [...doc.querySelectorAll('.theater-corpus option')].map((o) => (o as HTMLOptionElement).value),
      ).toStrictEqual(corpora.map((c) => c.id).sort());

      // G7 at position zero: a fresh store holds nothing until the host speaks.
      expect(query('[data-testid="tree-node"]')).toBe(0);

      const scrubber = doc.querySelector<HTMLInputElement>('.theater-scrubber');
      expect(scrubber).not.toBeNull();
      if (scrubber === null) return;

      const corpus = recorded();
      scrubber.value = String(corpus.events.length);
      scrubber.dispatchEvent(new window.Event('input'));
      await settle();

      // The whole arc has played: the rail holds every session the host sent
      // and the tree is drawn from the corpus, not from anything hand-made.
      expect(query('[data-testid="rail-item"]')).toBe(corpus.final.sessions.length);
      expect(query('[data-testid="tree-node"]')).toBeGreaterThan(1);
      const app = doc.querySelector('[data-testid="app"]');
      expect(app?.getAttribute('data-liveness')).toBe(
        corpus.final.sessions[0]?.liveness ?? 'missing',
      );

      // Rewinding cannot subtract a patch, so the transport throws the store
      // away and replays from zero. Back at zero the panel is blank again.
      scrubber.value = '0';
      scrubber.dispatchEvent(new window.Event('input'));
      await settle();
      expect(query('[data-testid="tree-node"]')).toBe(0);
    } finally {
      window.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 6. The rule the next package inherits
// ---------------------------------------------------------------------------

describe('the synthetic/recorded distinction is enforced, not documented', () => {
  it('refuses to write a synthetic corpus without the prefix, and vice versa', async () => {
    // Opaque specifier, the dodge `testkit.ts` documents: a literal would make
    // `tsc` demand a declaration file for a `.mjs` build script that neither
    // tsconfig project includes. Resolved at runtime by vitest.
    const { corpusFileName } = (await import(/* @vite-ignore */ RECORDER_MODULE)) as {
      corpusFileName(corpus: { id: string; kind: string }): Promise<string>;
    };

    await expect(corpusFileName({ id: 'invented-stress', kind: 'synthetic' })).rejects.toThrow(
      /prefix/,
    );
    await expect(
      corpusFileName({ id: `${SYNTHETIC_CORPUS_PREFIX}arc`, kind: 'recorded' }),
    ).rejects.toThrow(/prefix/);
    await expect(corpusFileName({ id: 'arc', kind: 'guessed' })).rejects.toThrow(/kind/);

    // The two valid shapes go through.
    await expect(corpusFileName({ id: 'arc', kind: 'recorded' })).resolves.toBe('arc.json');
    await expect(
      corpusFileName({ id: `${SYNTHETIC_CORPUS_PREFIX}stress`, kind: 'synthetic' }),
    ).resolves.toBe(`${SYNTHETIC_CORPUS_PREFIX}stress.json`);
  });
});
