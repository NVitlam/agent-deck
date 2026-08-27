// R6, half one: freeze the host's timed `postMessage` sequence as JSON.
//
// WHAT THIS IS
// ------------
// `docs/ui/ui-canvas-redesign.md` §7 Tier 3: replay the committed fixtures
// through the REAL host model — the same `hostRun` path
// `webview/fixture-render.test.ts` uses — and record every message the real
// `SessionBridge` puts on the wire, stamped with a simulated offset. The
// theater (`webview/theater/`) then replays that file through the real store
// at whatever speed a human wants, so a nine-minute session arc is reviewed in
// half a minute, offline and identically every time.
//
// Nothing here reimplements anything. `graftSession`, `SessionModel`,
// `LivenessEngine` and `SessionBridge` are imported from `src/`, which is why
// the recorded traffic IS the traffic rather than a plausible reconstruction —
// and why `webview/wire.test.ts` can assert that replaying it converges on the
// model's own final snapshot.
//
// DETERMINISM IS THE PRODUCT
// --------------------------
// A committed corpus that changes when nothing changed is noise, and every
// future diff against it is a false positive. So, in the order they bite:
//
//   * NO WALL CLOCK. The liveness engine is driven by a SIMULATED clock this
//     file advances by hand, and event stamps are RELATIVE offsets (`atMs`)
//     from the start of the arc — never `Date.now()`. `simulatedEpochMs` below
//     is a fixed constant, the same instant `fixture-render.test.ts` and
//     `scripts/capture-states.mjs` already pin.
//   * NO stat(). Transcript mtimes are supplied to `observeJsonl`, not read
//     off the disk, so a fresh checkout does not shift liveness.
//   * NO HOST PATHS. Nothing absolute reaches the file; `recordedFrom` is
//     repo-relative with forward slashes. `webview/wire.test.ts` greps for
//     drive letters and home paths anyway, because a structural argument is
//     not a measurement.
//   * NO MAP/SET ITERATION ORDER. `SessionModel.emit()` sorts its snapshot by
//     session id; fixture discovery sorts every `readdir`; events are written
//     in the order the bridge emitted them.
//   * LF ONLY. `JSON.stringify(..., 2)` emits `\n` and this writes utf8, so
//     the bytes do not depend on the platform. `.gitattributes` marks
//     everything outside `fixtures/**` as text and `core.autocrlf=true` is set
//     on the dev machine, so a CHECKOUT can still hand the committed file back
//     with CRLF — that is a checkout artifact, and `wire.test.ts` normalises
//     for the staleness comparison only, never for the run-twice one.
//   * NO RAW CONTROL BYTES. `JSON.stringify` escapes everything below 0x20,
//     so a payload containing a NUL cannot make the corpus binary to git.
//
// NEVER THE REAL HOME DIRECTORY. Fixtures are addressed by an explicit path
// under the repo. `graftSession` takes a transcript path, so nothing here
// consults `os.homedir()`, `HOME` or `USERPROFILE` — which is the failure
// CLAUDE.md records as a green, confident, completely false pass.
//
// G1: writes only into the corpus directory (inside the repo). G5: no network.
//
// USAGE
//   node scripts/record-wire.mjs             write the corpus into WIRE_CORPUS_DIR
//   node scripts/record-wire.mjs --out <dir> write it somewhere else (tests)
//
// BUILDING A SYNTHETIC CORPUS ON TOP OF THIS
// ------------------------------------------
// The stress corpus (`synthetic-`, R5) needs no change to this file. Import it:
//
//   import { loadHostModules, createRecorder, writeCorpus, WIRE_FORMAT_VERSION }
//     from './record-wire.mjs';
//
//   const host = await loadHostModules();          // real src/ classes
//   const rec = createRecorder(host);              // wraps a real SessionBridge
//   rec.step(0, 'spawn-storm');
//   rec.bridge.publish({ sessions, diffs: [], addedSessionIds: ids,
//                        removedSessionIds: [], schemaMismatchSessionIds: [] });
//   await writeCorpus(dir, { id: 'synthetic-stress', kind: 'synthetic', ... ,
//                            events: rec.events, final: { ... } });
//
// `writeCorpus` REFUSES an id whose `synthetic-` prefix disagrees with its
// `kind`, so an invented corpus cannot be committed looking like evidence
// about Claude Code. That rule is `SYNTHETIC_CORPUS_PREFIX`'s whole job.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { loadCanvasContract, REPO_ROOT, wireCorpusDir } from '../webview/theater/contract.mjs';

/**
 * Bumped when the corpus shape changes in a way a reader must notice.
 *
 * **2 (0.1.3):** the token contract. `AgentNode.tokens: { in, out }` is gone
 * and `contextNow` / `burn` (`{ prompt, output }`) replace it;
 * `SessionState.totals` lost `inputTokens` / `outputTokens` and kept only
 * `costUsd`, with session-level `contextNow` / `burn` beside it. A version-1
 * corpus replayed through the version-2 store yields nodes with no context
 * figures at all, which renders as zeros rather than as an error - so the
 * version is the thing that has to fail loudly, and it does.
 */
export const WIRE_FORMAT_VERSION = 2;

/**
 * The simulated instant the arc starts at. Fixed, and the same value
 * `webview/fixture-render.test.ts` and `scripts/capture-states.mjs` use, so
 * the three pieces of committed evidence describe the same clock.
 */
const SIMULATED_EPOCH_MS = 1_700_000_060_000;

// The captured root is named the way `fixture-render.test.ts` and
// `capture-states.mjs` name it. The slug directory, the session ids and the
// workspace are all DISCOVERED underneath it — no fixture-set size and no
// session id is written down anywhere in this file.
const CAPTURED_ROOT = join(REPO_ROOT, 'fixtures', 'cc-2.1.234', 'projects');
const LAYOUT_ROOT = join(REPO_ROOT, 'fixtures', 'synthetic-layout');

// ---------------------------------------------------------------------------
// The real host modules
// ---------------------------------------------------------------------------

/**
 * `src/`'s real classes, bundled for node and evaluated in this process.
 *
 * An in-memory entry point that RE-EXPORTS: nothing below is reimplemented.
 * `packages: 'external'` leaves `node:*` and every dependency as `require(...)`
 * resolved against the repo's own `node_modules`.
 */
export async function loadHostModules() {
  const entry = [
    "export { graftSession } from './src/model/graft.js';",
    "export { SessionModel } from './src/model/session.js';",
    "export { LivenessEngine } from './src/model/liveness.js';",
    "export { SessionBridge } from './src/bridge/messages.js';",
    "export { isAgentNode } from './src/model/events.js';",
  ].join('\n');

  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: REPO_ROOT,
      sourcefile: 'record-wire-host-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  });

  const js = result.outputFiles[0];
  if (js === undefined) throw new Error('host bundle produced no javascript');

  const require = createRequire(join(REPO_ROOT, 'package.json'));
  const mod = { exports: {} };
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', js.text);
  factory(require, mod, mod.exports, join(REPO_ROOT, 'record-wire-host.cjs'), REPO_ROOT);
  return mod.exports;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * A real `SessionBridge` whose port appends to an event log instead of
 * reaching a webview.
 *
 * Every message is JSON round-tripped on the way in, for the same reason
 * `fixture-render.test.ts` does it: VS Code's `postMessage` is a
 * structured-clone hop, so the webview never receives the host's own object,
 * and the round trip also proves nothing unserialisable escapes.
 */
export function createRecorder(host) {
  const events = [];
  const steps = [];
  let atMs = 0;
  let label = 'start';

  const bridge = new host.SessionBridge({
    postMessage: (message) => {
      events.push({ atMs, label, message: JSON.parse(JSON.stringify(message)) });
    },
  });

  return {
    bridge,
    events,
    steps,
    /** Move the simulated clock and name what happens next. */
    step(nextAtMs, nextLabel, what) {
      if (!Number.isInteger(nextAtMs) || nextAtMs < atMs) {
        throw new Error(`step ${nextLabel}: atMs must be a non-decreasing integer`);
      }
      atMs = nextAtMs;
      label = nextLabel;
      steps.push({ atMs, label, what });
    },
    get atMs() {
      return atMs;
    },
  };
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

/** The canonical bytes of a corpus. LF, two-space indent, trailing newline. */
export function serializeCorpus(corpus) {
  return JSON.stringify(corpus, null, 2) + '\n';
}

/**
 * The file a corpus is written to, and the one place the synthetic/recorded
 * distinction is enforced.
 */
export async function corpusFileName(corpus) {
  const { SYNTHETIC_CORPUS_PREFIX } = await loadCanvasContract();
  const synthetic = corpus.kind === 'synthetic';
  const prefixed = corpus.id.startsWith(SYNTHETIC_CORPUS_PREFIX);
  if (corpus.kind !== 'synthetic' && corpus.kind !== 'recorded') {
    throw new Error(`corpus ${corpus.id}: kind must be "recorded" or "synthetic"`);
  }
  if (synthetic !== prefixed) {
    throw new Error(
      `corpus ${corpus.id}: kind "${corpus.kind}" and the "${SYNTHETIC_CORPUS_PREFIX}" ` +
        'prefix disagree. The prefix is what keeps invented states distinguishable ' +
        'from evidence about Claude Code on disk; fix the id or the kind.',
    );
  }
  return `${corpus.id}.json`;
}

/** Write one corpus into `outDir`, validating it first. Returns the filename. */
export async function writeCorpus(outDir, corpus) {
  if (corpus.formatVersion !== WIRE_FORMAT_VERSION) {
    throw new Error(`corpus ${corpus.id}: formatVersion must be ${WIRE_FORMAT_VERSION}`);
  }
  if (!Array.isArray(corpus.events) || corpus.events.length === 0) {
    throw new Error(`corpus ${corpus.id}: no events`);
  }
  let previous = -1;
  for (const event of corpus.events) {
    if (!Number.isInteger(event.atMs) || event.atMs < previous) {
      throw new Error(`corpus ${corpus.id}: event offsets must be non-decreasing integers`);
    }
    previous = event.atMs;
  }
  const name = await corpusFileName(corpus);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, name), serializeCorpus(corpus), 'utf8');
  return name;
}

// ---------------------------------------------------------------------------
// Fixture discovery — read off the directory, never named
// ---------------------------------------------------------------------------

let capturedCache;

async function fixtures() {
  if (capturedCache !== undefined) return capturedCache;
  const dirs = (await readdir(CAPTURED_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const slug = dirs[0];
  if (slug === undefined) throw new Error('no slug directory under the captured root');
  const slugDir = join(CAPTURED_ROOT, slug);

  const sessionIds = (await readdir(slugDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name.replace(/\.jsonl$/, ''))
    .sort();
  if (sessionIds.length === 0) throw new Error('no transcripts in the captured slug directory');

  // The workspace the capture was taken in, read from the transcripts' own
  // `cwd`, so a re-harvest on another machine needs no edit here.
  let workspacePath = '';
  for (const sessionId of sessionIds) {
    const text = await readFile(join(slugDir, `${sessionId}.jsonl`), 'utf8');
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
    if (match === null || match[1] === undefined) continue;
    const decoded = JSON.parse(`"${match[1]}"`);
    if (decoded !== '') {
      workspacePath = decoded;
      break;
    }
  }
  if (workspacePath === '') throw new Error('no cwd found in the captured transcripts');

  capturedCache = { slug, slugDir, sessionIds, workspacePath };
  return capturedCache;
}

/**
 * The first `fixtures/synthetic-layout` case `graftSession` actually refuses —
 * found by asking it, not by naming a case expected to fail.
 */
async function refusedLayout(host) {
  const cases = (await readdir(LAYOUT_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const caseName of cases) {
    const caseDir = join(LAYOUT_ROOT, caseName);
    const slugs = (await readdir(caseDir, { withFileTypes: true })).filter((e) => e.isDirectory());
    for (const slugEntry of slugs) {
      const slugDir = join(caseDir, slugEntry.name);
      const transcripts = (await readdir(slugDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name)
        .sort();
      for (const name of transcripts) {
        const path = join(slugDir, name);
        const result = await host.graftSession(path);
        if (!result.ok) return { path, sessionId: name.replace(/\.jsonl$/, ''), caseName };
      }
    }
  }
  throw new Error('no synthetic-layout case produced a refusal');
}

// ---------------------------------------------------------------------------
// The arc
// ---------------------------------------------------------------------------

/** A main-thread hook event: `agent_id` ABSENT, never the string "main". */
function mainEvent(sessionId, eventName, receivedAt, seq) {
  return {
    seq,
    receivedAt,
    eventName,
    eventNameConfirmed: true,
    sessionId,
    isMainThread: true,
    raw: { hook_event_name: eventName, session_id: sessionId },
  };
}

/**
 * The nine minutes of simulated session the corpus records.
 *
 * Offsets are chosen against the liveness engine's 120 s recency threshold so
 * that each transition is produced BY THE ENGINE rather than asserted:
 *
 *   0 s    discovery. Every captured session grafted, plus the one layout the
 *          fingerprint refuses. Transcript mtime is now, no hook events have
 *          arrived yet -> `live`, and the hook tap is degraded (`noHookEvents`).
 *   30 s   the user pastes the hook block: a PreToolUse arrives -> not degraded.
 *   90 s   work continues; a second PreToolUse and a fresh transcript mtime.
 *   150 s  the panel is reloaded: `bridge.reset()`, then a fresh snapshot.
 *          VS Code re-runs the bundle on visibility restore and the new
 *          document holds nothing, so this is a production path, not a device.
 *   240 s  150 s since the last activity, past the threshold -> `idle`.
 *   300 s  a Stop HOOK event. There is no `stop` ENTRY type in any committed
 *          transcript; Stop is a hook event on the other tap. Still `idle`,
 *          because the Stop itself is recent activity.
 *   480 s  180 s later, nothing running and nothing recent -> `ended`.
 *
 * THE RELOAD SITS IN THE MIDDLE ON PURPOSE. It has to be in the arc — it is
 * the second `snapshot` and the only forced one — but if it came last, every
 * diff before it would be overwritten by a full re-statement and
 * "replay converges on the model's final snapshot" would hold whether or not
 * a single patch applied correctly. Ending on diffs is what makes that
 * assertion mean something; `webview/wire.test.ts` checks the ordering
 * property itself rather than trusting this comment.
 */
const ARC = [
  { atMs: 0, label: 'discover', what: 'sessions grafted; transcripts fresh; no hook events yet' },
  { atMs: 30_000, label: 'hooks-arrive', what: 'the first PreToolUse reaches the listener' },
  { atMs: 90_000, label: 'working', what: 'a second PreToolUse and a fresh transcript mtime' },
  { atMs: 150_000, label: 'panel-reload', what: 'the webview is reloaded and re-snapshotted' },
  { atMs: 240_000, label: 'goes-quiet', what: 'past the recency threshold with nothing new' },
  { atMs: 300_000, label: 'stop', what: 'a Stop hook event' },
  { atMs: 480_000, label: 'settles', what: 'nothing running and nothing recent' },
];

function stepAt(label) {
  const found = ARC.find((s) => s.label === label);
  if (found === undefined) throw new Error(`no arc step named ${label}`);
  return found;
}

async function recordCapturedArc(host) {
  const { slug, slugDir, sessionIds, workspacePath } = await fixtures();
  const layout = await refusedLayout(host);

  // The simulated clock. Everything time-dependent in the host reads this.
  let offsetMs = 0;
  const engine = new host.LivenessEngine({ now: () => SIMULATED_EPOCH_MS + offsetMs });
  const model = new host.SessionModel({ workspacePath, liveness: engine });
  const recorder = createRecorder(host);

  const go = (label) => {
    const step = stepAt(label);
    offsetMs = step.atMs;
    recorder.step(step.atMs, step.label, step.what);
  };
  const now = () => SIMULATED_EPOCH_MS + offsetMs;
  const publish = () => {
    const emission = model.emit();
    recorder.bridge.publish(emission);
    recorder.bridge.publishDegraded(engine.degradedState());
    return emission;
  };

  // --- 0 s: discovery -------------------------------------------------------
  go('discover');
  for (const sessionId of sessionIds) {
    model.ingestGraftResult(sessionId, slug, await host.graftSession(join(slugDir, `${sessionId}.jsonl`)));
    model.liveness.observeJsonl(sessionId, { mtimeMs: now() });
  }
  // Registered under the CAPTURED workspace's slug so the model treats it as
  // this workspace's session; the refusal itself comes from `graftSession`
  // reading the hand-mutated layout on disk. Present from the first snapshot
  // rather than arriving later, so the store's default selection (the first
  // session in id order) cannot depend on when it showed up.
  model.ingestGraftResult(layout.sessionId, slug, await host.graftSession(layout.path));
  publish();

  // --- 30 s: the hook tap starts speaking ----------------------------------
  go('hooks-arrive');
  for (const sessionId of sessionIds) {
    model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', now(), 1));
    model.liveness.observeJsonl(sessionId, { mtimeMs: now() });
  }
  publish();

  // --- 90 s: still working -------------------------------------------------
  go('working');
  for (const sessionId of sessionIds) {
    model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', now(), 2));
    model.liveness.observeJsonl(sessionId, { mtimeMs: now() });
  }
  publish();

  // --- 150 s: the panel is reloaded ----------------------------------------
  go('panel-reload');
  recorder.bridge.reset();
  publish();

  // --- 240 s: quiet long enough to stop counting as live -------------------
  go('goes-quiet');
  publish();

  // --- 300 s: the turn ends ------------------------------------------------
  go('stop');
  for (const sessionId of sessionIds) {
    model.ingestHookEvent(mainEvent(sessionId, 'Stop', now(), 3));
  }
  publish();

  // --- 480 s: nothing running, nothing recent ------------------------------
  go('settles');
  const final = publish();

  return { recorder, engine, model, final, slug, layout };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** A repo-relative path with forward slashes — never a host path. */
function repoRelative(absolute) {
  return absolute.slice(REPO_ROOT.length + 1).split('\\').join('/');
}

const DESCRIPTION = [
  'Every message a real SessionBridge put on the wire while the real SessionModel and',
  'LivenessEngine were driven over the committed CC 2.1.234 fixtures against a simulated',
  'clock. `atMs` is a RELATIVE offset from the start of the arc, not a wall-clock stamp.',
  '`final` is the model\u2019s own last snapshot, taken from SessionEmission.sessions rather',
  'than by applying the diffs \u2014 which is what lets webview/wire.test.ts assert that a',
  'store fed the events converges on it.',
].join(' ');

async function buildCapturedCorpus(host) {
  const { recorder, engine, final, layout } = await recordCapturedArc(host);

  // The corpus id names the fixture set it came from, derived from the
  // directory rather than written down: a new capture directory yields a new
  // corpus name without an edit here.
  const captureName = repoRelative(CAPTURED_ROOT).split('/')[1];

  const schemaMismatchSessionIds = [
    ...new Set(
      recorder.events
        .filter((e) => e.message.type === 'schemaMismatch')
        .map((e) => e.message.sessionId),
    ),
  ].sort();

  const lastEvent = recorder.events[recorder.events.length - 1];

  return {
    formatVersion: WIRE_FORMAT_VERSION,
    id: `${captureName}-session-arc`,
    kind: 'recorded',
    title: `${captureName} \u2014 one session arc, live through ended, with a refused layout`,
    description: DESCRIPTION,
    producedBy: 'scripts/record-wire.mjs',
    recordedFrom: repoRelative(CAPTURED_ROOT),
    refusedLayoutCase: layout.caseName,
    simulatedEpochMs: SIMULATED_EPOCH_MS,
    durationMs: lastEvent === undefined ? 0 : lastEvent.atMs,
    steps: recorder.steps,
    events: recorder.events,
    final: {
      sessions: JSON.parse(JSON.stringify(final.sessions)),
      degraded: engine.degradedState(),
      schemaMismatchSessionIds,
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const requested = outAt === -1 ? undefined : argv[outAt + 1];
  // `resolve('')` returns the working directory, so an empty `--out` would
  // silently target the repo root rather than failing.
  if (outAt !== -1 && (requested === undefined || requested === '')) {
    throw new Error('--out needs a directory');
  }
  const outDir = requested === undefined ? await wireCorpusDir() : resolve(requested);

  const host = await loadHostModules();
  const corpora = [await buildCapturedCorpus(host)];

  await mkdir(outDir, { recursive: true });
  // Clear only what THIS script generates. A synthetic corpus written by
  // another generator lives in the same directory and must survive a re-record.
  const written = [];
  for (const corpus of corpora) written.push(await corpusFileName(corpus));
  for (const entry of await readdir(outDir)) {
    if (written.includes(entry)) await rm(join(outDir, entry));
  }
  for (const corpus of corpora) await writeCorpus(outDir, corpus);

  // Filenames only, no directory: `--out` can point anywhere, and a host path
  // on stdout would end up quoted into a report as though it were evidence.
  for (const corpus of corpora) {
    process.stdout.write(
      `recorded ${await corpusFileName(corpus)}: ${corpus.events.length} events over ` +
        `${corpus.durationMs} ms of simulated time\n`,
    );
  }
}

// Run only when this file IS the process entry. Imported — which is how a
// synthetic generator reuses `createRecorder` and `writeCorpus` — it defines
// and does nothing.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
