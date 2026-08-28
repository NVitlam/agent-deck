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
// TWO ENGINES, AS OF PHASE 7 (DoD 7.10)
// --------------------------------------
// A default run writes ONE corpus PER OBSERVATION ENGINE:
//
//   cc-<version>-session-arc.json         the Claude Code arc (buildCapturedCorpus)
//   opencode-<version>-session-arc.json   the OpenCode arc    (buildOpenCodeCorpus)
//
// The theater embeds every `*.json` under the corpus directory, so writing the
// second one here is what puts an OpenCode session in front of the real
// renderer. Both go through the same `createRecorder` and the same
// `SessionBridge`; what differs is the host half that produces the emissions —
// `SessionModel` for CC, the shipped `OpenCodeEnginePath` for OpenCode. Neither
// arc's schedule is the other's, and neither is invented: see
// `recordCapturedArc`'s seven moments and `opencodeSchedule`'s derivation.
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
//   node scripts/record-wire.mjs             write both corpora into WIRE_CORPUS_DIR
//   node scripts/record-wire.mjs --out <dir> write them somewhere else (tests)
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
 * **2 (the 0.1.3 token contract):** `AgentNode.tokens: { in, out }` is gone and
 * `contextNow` / `burn` (`{ prompt, output }`) replace it;
 * `SessionState.totals` lost `inputTokens` / `outputTokens` and kept only
 * `costUsd`, with session-level `contextNow` / `burn` beside it.
 *
 * The version is the thing that has to fail loudly, and this is why: a
 * version-1 corpus replayed through the version-2 store yields nodes with no
 * token fields at all, and `formatTokens(undefined)` renders an em-dash. That
 * is a corpus quietly displaying "no data" on every node rather than raising
 * anything - indistinguishable, to a reader, from a session that genuinely has
 * no numbers. `assertCorpusShape` below refuses on the version instead.
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
    // The OpenCode half (DoD 7.10). `OpenCodeEnginePath` is the SHIPPED host
    // class - the same one `activate()` constructs - so the second engine's
    // corpus is recorded off production code rather than off a second
    // implementation written for the recorder.
    "export { OpenCodeEnginePath } from './src/extension.js';",
    "export { readOpenCodeEngine } from './src/opencode/index.js';",
    "export { PINNED_OPENCODE_VERSION } from './src/opencode/fingerprint.js';",
    [
      'export { OcLivenessEngine, DEFAULT_OC_LIVENESS_THRESHOLD_MS }',
      "from './src/opencode/liveness.js';",
    ].join(' '),
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
    /*
     * `vscode` HAS NO PACKAGE ON DISK, and this is the same stand-in the whole
     * suite already uses.
     *
     * `src/extension.ts` imports it at module scope; the extension host injects
     * it at runtime and `esbuild.config.mjs` keeps it external for exactly that
     * reason, so a plain node process cannot resolve it. `vitest.config.ts`
     * aliases it to `test/vscode-mock.ts` for every test of that file and this
     * is the same alias, spelled for esbuild.
     *
     * What it does NOT weaken: the OpenCode host path touches no `vscode` API
     * at all - discovery, the content read, the cursor and the diff are pure
     * node - so the mock is load-bearing for the IMPORT and for nothing that is
     * recorded. If that stops being true, the recording would start depending
     * on a test double and this comment is the place that says so.
     */
    alias: { vscode: join(REPO_ROOT, 'test', 'vscode-mock.ts') },
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

// ---------------------------------------------------------------------------
// The SECOND ENGINE: OpenCode (Phase 7, DoD 7.10)
// ---------------------------------------------------------------------------

/**
 * WHY THIS MODE EXISTS.
 *
 * Until Phase 7 every corpus in `webview/wire/` came from the Claude Code
 * engine, so the theater - the one place this project can watch the panel work
 * without a VS Code host - had never rendered an OpenCode session. A renderer
 * surface that has only ever been fed one engine's states is a surface with an
 * untested half, and the two engines disagree about exactly the fields a card
 * and a node row read: OpenCode reports no `contextNow` and no `burn` at all,
 * which is the difference between an em-dash and a number on every row.
 *
 * WHAT IS REAL HERE, WHICH IS EVERYTHING EXCEPT THE SCHEDULE.
 *
 *   - The content read is `readOpenCodeEngine`, reached through
 *     `OpenCodeEnginePath` - the shipped host class, unmodified, with no
 *     `read` override. Its own doc says production never passes one and this
 *     does not.
 *   - Liveness is the real `OcLivenessEngine`, cursored on
 *     `event_sequence.seq`, driven by an INJECTED clock and an INJECTED poll
 *     trigger. No wall clock and no timer.
 *   - The diffs are `OpenCodeEnginePath.emit()`'s, which is `diffSessionState`
 *     - the same single diff implementation the CC half uses.
 *   - The messages are a real `SessionBridge`'s.
 *
 * The SCHEDULE is this file's, exactly as `recordCapturedArc`'s seven moments
 * are, and it is DERIVED FROM THE STORE rather than written down: each step
 * lands one millisecond after a root session's own recency threshold expires,
 * so every transition below is produced by the engine rather than asserted by
 * the recorder. A store whose rows move produces a different arc without an
 * edit here.
 *
 * THE CLOCK IS ANCHORED ON THE STORE, not on `SIMULATED_EPOCH_MS`. The captured
 * database's newest row is dated long after that fixed instant, so anchoring on
 * it would place the whole recording BEFORE its own data - every age negative,
 * every session `live` forever, and not one transition to record. The anchor is
 * the OLDEST root session's `timeUpdated`, read off the engine's own snapshot,
 * so the arc opens with the newest sessions still live and watches each one
 * cross the threshold in turn.
 */

/** Deterministic per-arc constant: the reload lands 1 ms after the first quiet. */
const OC_RELOAD_GAP_MS = 1;

/**
 * The committed OpenCode corpus the engine is ANCHORED on.
 *
 * Named from `PINNED_OPENCODE_VERSION` rather than written down, on the
 * `src/parser/corpus.test.ts` precedent: the anchor names the release whose
 * capture proved the structure, so the corpus that is replayed is the corpus
 * the engine claims to have been verified against. Move the anchor without
 * harvesting and this throws instead of quietly recording the witness.
 */
function opencodeFixtureDir(host) {
  return join(REPO_ROOT, 'fixtures', `opencode-${host.PINNED_OPENCODE_VERSION}`);
}

/**
 * Where the arc's simulated clock starts, and where each step lands.
 *
 * A throwaway `OcLivenessEngine` with `now: () => 0` and no poll trigger: the
 * engine reads the store once and reports every session's `timeUpdated`. That
 * is a READ of the same database the recording is about, taken to derive the
 * recording's own INPUTS - which is why it is allowed to be a second open and
 * why nothing it returns reaches the corpus.
 */
function opencodeSchedule(host, dbPath) {
  let snapshots = [];
  const probe = new host.OcLivenessEngine({
    dbPath,
    now: () => 0,
    onUpdate: (taken) => {
      snapshots = taken;
    },
  });
  probe.start();
  probe.poll();
  probe.dispose();

  const roots = snapshots.filter((s) => s.parentId === null);
  if (roots.length === 0) throw new Error('the OpenCode corpus holds no root session');

  const thresholdMs = host.DEFAULT_OC_LIVENESS_THRESHOLD_MS;
  const epochMs = Math.min(...roots.map((s) => s.timeUpdated));
  // One millisecond PAST the threshold, so the crossing has happened rather
  // than being exactly on the boundary - `recent` is a comparison and a step
  // that lands on the equality tests the tie rather than the transition.
  const crossings = [
    ...new Set(roots.map((s) => s.timeUpdated + thresholdMs + 1 - epochMs)),
  ]
    .filter((at) => at > 0)
    .sort((a, b) => a - b);

  const steps = [
    { atMs: 0, label: 'discover', what: 'the store is read once and every root session lands' },
  ];
  crossings.forEach((atMs, i) => {
    steps.push({
      atMs,
      label: `quiets-${String(i)}`,
      what: `a root session passes the ${String(thresholdMs)} ms recency threshold`,
    });
    // The panel reload sits in the MIDDLE for the reason `recordCapturedArc`'s
    // does: a corpus that ends on a full snapshot would satisfy "replay
    // converges on the model's final state" whether or not a patch applied.
    if (i === 0 && crossings.length > 1) {
      steps.push({
        atMs: atMs + OC_RELOAD_GAP_MS,
        label: 'panel-reload',
        what: 'the webview is reloaded and re-snapshotted',
      });
    }
  });

  return { epochMs, thresholdMs, steps };
}

async function recordOpenCodeArc(host) {
  const fixtureDir = opencodeFixtureDir(host);
  const dbPath = join(fixtureDir, 'opencode.db');

  /*
   * WHICH WORKSPACE IS OPEN, derived rather than named.
   *
   * `OpenCodeEnginePath` needs the folders VS Code has open so it can filter
   * `project.worktree`, and a host path written into this file would be both a
   * privacy leak and wrong on the next harvest. `workspaceMatcher` compares
   * `slugFromWorktree(path)` with `slugFromWorktree(project.worktree)`, and
   * `slugifyWorkspace` only replaces `[:\\/]` - so a string containing none of
   * those three characters IS its own slug. The session's own `projectSlug` is
   * such a string, which makes passing it exact rather than a trick. The same
   * argument `recordTimedSession` makes for its staged slug.
   */
  const probe = host.readOpenCodeEngine({ dbPath });
  if (probe.kind !== 'ok') {
    throw new Error(`the OpenCode corpus did not read: ${probe.kind}`);
  }
  const workspacePaths = [...new Set(probe.result.sessions.map((s) => s.projectSlug))].sort();

  const { epochMs, thresholdMs, steps } = opencodeSchedule(host, dbPath);

  let offsetMs = 0;
  const now = () => epochMs + offsetMs;
  const recorder = createRecorder(host);
  // The hook tap is the CLAUDE CODE listener and it is panel-wide, so a panel
  // showing OpenCode sessions alone still reports whatever it reports. Driven
  // by the real engine rather than asserted: whatever `degradedState()` says
  // here is what the shipped host would say.
  const hooks = new host.LivenessEngine({ now });

  let firePoll = null;
  const path = new host.OpenCodeEnginePath({
    dbPath,
    workspacePaths,
    thresholdMs,
    onChange: () => {},
    now,
    // The trigger is CAPTURED, not scheduled: this recorder advances the clock
    // and then polls by hand, so there is no timer anywhere in the recording.
    pollTrigger: (run) => {
      firePoll = run;
      return { stop() {} };
    },
    // No WAL watch. The committed corpus is journal-mode `delete` and has no
    // WAL to wake on, and a real `fs.watch` would put this machine's
    // filesystem into a corpus that must be byte-identical everywhere.
    walWatchFactory: () => ({ close() {} }),
    log: () => {},
  });

  let final = { sessions: [] };
  const publish = () => {
    const emission = path.emit();
    final = emission;
    recorder.bridge.publish(emission);
    recorder.bridge.publishDegraded(hooks.degradedState());
    return emission;
  };

  for (const step of steps) {
    offsetMs = step.atMs;
    recorder.step(step.atMs, step.label, step.what);
    if (step.label === 'discover') {
      path.start();
    } else if (step.label === 'panel-reload') {
      recorder.bridge.reset();
    } else if (firePoll !== null) {
      firePoll();
    }
    publish();
  }

  const diagnostics = path.diagnostics;
  path.dispose();

  return { recorder, hooks, final, fixtureDir, epochMs, diagnostics };
}

const OPENCODE_DESCRIPTION = [
  'Every message a real SessionBridge put on the wire while the SHIPPED OpenCodeEnginePath -',
  'the same class activate() constructs - read the committed OpenCode store and chained the',
  'real OcLivenessEngine over a simulated clock. The clock is anchored on the OLDEST root',
  "session's own time_updated, so each step lands one millisecond after that session's",
  'recency threshold expires and every liveness transition below is the engine’s rather',
  "than the recorder's. `final` is the host's own last emission, not the diffs replayed.",
].join(' ');

async function buildOpenCodeCorpus(host) {
  const { recorder, hooks, final, fixtureDir, epochMs, diagnostics } =
    await recordOpenCodeArc(host);

  // The corpus id names the fixture directory it came from, derived rather
  // than written down - the same rule the captured arc's id follows.
  const captureName = repoRelative(fixtureDir).split('/')[1];

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
    title: `${captureName} — the second engine, live through idle, on its own clock`,
    description: OPENCODE_DESCRIPTION,
    producedBy: 'scripts/record-wire.mjs',
    recordedFrom: repoRelative(fixtureDir),
    engine: 'opencode',
    simulatedEpochMs: epochMs,
    // The host's own account of the read, so a reader can tell a corpus
    // recorded off a healthy store from one recorded off a degraded one
    // without replaying it. Counters only - never a path.
    hostDiagnostics: {
      contentReads: diagnostics.contentReads,
      contentFailures: diagnostics.contentFailures,
      schemaMismatches: diagnostics.schemaMismatches,
      degradedReads: diagnostics.degradedReads,
      livenessPolls: diagnostics.livenessPolls,
      livenessDegraded: diagnostics.livenessDegraded,
      emissions: diagnostics.emissions,
      sessions: diagnostics.sessions,
    },
    durationMs: lastEvent === undefined ? 0 : lastEvent.atMs,
    steps: recorder.steps,
    events: recorder.events,
    final: {
      sessions: JSON.parse(JSON.stringify(final.sessions)),
      degraded: hooks.degradedState(),
      schemaMismatchSessionIds,
    },
  };
}

// ---------------------------------------------------------------------------
// Timed replay of a REAL captured session (PLAN.md Phase 5.5, DoD 5.5.5)
// ---------------------------------------------------------------------------

/**
 * WHAT THIS MODE IS FOR, and what the arc above could not do.
 *
 * `buildCapturedCorpus` records a HAND-AUTHORED arc: seven labelled moments
 * over eight simulated minutes, chosen to exercise liveness transitions. It is
 * the right shape for what it was built for and the wrong shape for the
 * question `AUDIT-2026-08-27` left open — *does the store survive hundreds of
 * back-to-back diffs on a large tree?* Ten events over three sessions cannot
 * answer that, and the audit said so: "timed replay of an arbitrary session is
 * NOT supported", with a list of what was missing.
 *
 * This mode is that list, implemented. It takes a real captured session, reads
 * the append schedule OUT OF THE TRANSCRIPTS' OWN `timestamp` fields, and
 * replays prefixes of the files through the real `graftSession`,
 * `SessionModel` and `SessionBridge` — so the recorded traffic is the traffic,
 * with the timing the session actually had.
 *
 * DETERMINISM, same rules as the arc recorder and for the same reasons:
 *
 *   * **No wall clock.** `atMs` is derived from the transcript's own first
 *     timestamp. `Date.now()` appears nowhere.
 *   * **No host paths.** `recordedFrom` is repo-relative with forward slashes.
 *   * **Sorted everything.** Subagent discovery sorts; steps are emitted in
 *     timestamp order with a stable tiebreak on the file path.
 *   * **Content-addressed.** Each source transcript's sha256 is recorded, so a
 *     test can tell a stale corpus from a fresh one without re-recording it —
 *     which matters here because re-recording is minutes of work, not
 *     milliseconds.
 *
 * COST IS WHY `--max-steps` EXISTS. Every step re-grafts the whole session,
 * because that is what the production path does on every append (see
 * `AgentDeckDataPath.#graft`). Stepping once per line on this corpus would be
 * ~700 whole-session re-reads of 3 MB. The default of 120 steps keeps a
 * recording under a minute while still driving the store through more than an
 * order of magnitude more diffs than the arc corpus does.
 */
const TIMED_MAX_STEPS = 120;

/** sha256 of a file's bytes, as hex. Content addressing for staleness. */
async function digestOf(path) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * Every transcript of one captured session, main first, subagents sorted.
 *
 * Read off the directory rather than named, exactly as `fixtures()` does: a
 * corpus that gains a subagent must not need an edit here.
 */
async function timedSources(projectsRoot) {
  const slugs = (await readdir(projectsRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const slug = slugs[0];
  if (slug === undefined) throw new Error(`no project slug under ${projectsRoot}`);
  const slugDir = join(projectsRoot, slug);

  const mains = (await readdir(slugDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name)
    .sort();
  const mainName = mains[0];
  if (mainName === undefined) throw new Error(`no main transcript under ${slugDir}`);
  const sessionId = mainName.slice(0, -'.jsonl'.length);
  const mainPath = join(slugDir, mainName);

  const subagentsDir = join(slugDir, sessionId, 'subagents');
  let subagents = [];
  try {
    subagents = (await readdir(subagentsDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => join(subagentsDir, e.name))
      .sort();
  } catch {
    // No subagents is a normal session, not an error.
  }

  return { slug, slugDir, sessionId, mainPath, subagents };
}

/** Split a transcript into lines, keeping each line's own timestamp. */
function timedLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let stamp = null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.timestamp === 'string') {
        const ms = Date.parse(parsed.timestamp);
        if (Number.isFinite(ms)) stamp = ms;
      }
    } catch {
      // A malformed line still occupies a position in the file; the parser's
      // own counter is what reports it. Here it simply inherits the previous
      // line's time, below.
    }
    out.push({ raw, stamp });
  }
  // Forward-fill: a line with no timestamp of its own belongs to the moment
  // the line before it was written. Never backwards, so the schedule stays
  // non-decreasing, which `writeCorpus` requires of `atMs`.
  let last = null;
  for (const line of out) {
    if (line.stamp === null) line.stamp = last;
    else last = line.stamp;
  }
  const first = out.find((l) => l.stamp !== null)?.stamp ?? 0;
  for (const line of out) if (line.stamp === null) line.stamp = first;
  return out;
}

/**
 * Record one real session's arc, at its own timing.
 *
 * Returns the recorder plus the model's final emission, exactly as
 * `recordCapturedArc` does, so `writeCorpus` and `wire.test.ts` see one shape.
 */
async function recordTimedSession(host, sourceDir, options = {}) {
  const { mkdtemp, cp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const projectsRoot = join(sourceDir, 'projects');
  const src = await timedSources(projectsRoot);
  const maxSteps = options.maxSteps ?? TIMED_MAX_STEPS;

  const files = [src.mainPath, ...src.subagents];
  const contents = new Map();
  for (const file of files) contents.set(file, timedLines(await readFile(file, 'utf8')));

  // The schedule: every line of every file, in timestamp order, with the file
  // path as a stable tiebreak so two lines written in the same millisecond
  // always order the same way.
  const schedule = [];
  for (const file of files) {
    const lines = contents.get(file) ?? [];
    for (let i = 0; i < lines.length; i += 1) {
      schedule.push({ file, index: i, stamp: lines[i]?.stamp ?? 0 });
    }
  }
  schedule.sort((a, b) => a.stamp - b.stamp || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.index - b.index));
  if (schedule.length === 0) throw new Error('the session has no lines');

  const epochMs = schedule[0].stamp;
  // Coarsen to at most `maxSteps` cut points, always including the last line.
  const stride = Math.max(1, Math.ceil(schedule.length / maxSteps));
  const cuts = [];
  for (let i = stride - 1; i < schedule.length; i += stride) cuts.push(i);
  if (cuts[cuts.length - 1] !== schedule.length - 1) cuts.push(schedule.length - 1);

  const stage = await mkdtemp(join(tmpdir(), 'agent-deck-timed-'));
  const stagedProjects = join(stage, 'projects');
  const stagedSlug = join(stagedProjects, src.slug);
  const stagedSessionDir = join(stagedSlug, src.sessionId);
  await mkdir(join(stagedSessionDir, 'subagents'), { recursive: true });
  // `tool-results/` is whole-file content, not appended line by line, so it is
  // staged once up front. Withholding it would make every preview in the
  // recording a stub and the corpus would measure the wrong thing.
  try {
    await cp(join(src.slugDir, src.sessionId, 'tool-results'), join(stagedSessionDir, 'tool-results'), {
      recursive: true,
    });
  } catch {
    // A session with no offloaded payloads is normal.
  }
  /**
   * Stage a subagent's SIDECAR at the moment its transcript first has a line.
   *
   * NOT up front, and the difference is the whole recording. `fingerprintSession`
   * refuses a session whose `subagents/` holds an `agent-<id>.meta.json` with no
   * matching `agent-<id>.jsonl` — the F1 window this repo has measured at
   * +0.080 to +0.120 s on real spawns. Staging every sidecar before any
   * transcript exists stretches that 100 ms window across the entire replay:
   * the first version of this recorder did exactly that and produced **two
   * events over 109 steps**, because the session was refused at all but the
   * last one.
   */
  const stageSidecarFor = async (sub) => {
    const meta = `${sub.slice(0, -'.jsonl'.length)}.meta.json`;
    try {
      await cp(meta, join(stagedSessionDir, 'subagents', meta.split(/[\\/]/).pop()));
    } catch {
      // A transcript with no sidecar refuses the whole session by design
      // (`subagentMetaMissing`); that is the fingerprint's call, not ours.
    }
  };

  const stagedPathFor = (file) =>
    file === src.mainPath
      ? join(stagedSlug, `${src.sessionId}.jsonl`)
      : join(stagedSessionDir, 'subagents', file.split(/[\\/]/).pop());

  const recorder = createRecorder(host);
  // The clock is the TRANSCRIPT's, advanced per step below. No `Date.now()`:
  // a liveness state that depends on when the recording ran would make the
  // corpus a measurement of this machine's afternoon.
  let offsetMs = 0;
  const engine = new host.LivenessEngine({ now: () => SIMULATED_EPOCH_MS + offsetMs });
  // The staged copy is the workspace, so `workspaceMatch` is true for the one
  // session under test rather than an accident of where the repo lives.
  /*
   * THE WORKSPACE IS THE SLUG ITSELF, and that is exact rather than a trick.
   *
   * `SessionModel` slug-encodes `workspacePath` and compares the result with
   * the session's `projectSlug`. `slugifyWorkspace` strips trailing separators
   * and replaces `[:\\/]`; a string containing none of those three characters
   * is therefore its own slug. The corpus's slug directory name is such a
   * string, so passing it yields `workspaceMatch: true` by construction.
   *
   * The obvious alternative — read `cwd` out of the transcripts, as the arc
   * recorder does — is WRONG HERE and would fail silently: `redact-paths.mjs`
   * has rewritten every `cwd` to `<HOME>`-relative form, so the derived slug
   * would not match the directory, `snapshot()` would drop the session as
   * foreign, and the recording would come out empty. Measured, not reasoned:
   * that is exactly what the first run produced.
   */
  const model = new host.SessionModel({ workspacePath: src.slug, liveness: engine });

  let taken = 0;
  let final = { sessions: [] };
  const written = new Map(files.map((f) => [f, 0]));

  for (const cut of cuts) {
    // Materialise every file's prefix as of this cut.
    const upto = new Map(files.map((f) => [f, 0]));
    for (let i = 0; i <= cut; i += 1) {
      const item = schedule[i];
      if (item === undefined) continue;
      upto.set(item.file, (upto.get(item.file) ?? 0) + 1);
    }
    for (const file of files) {
      const want = upto.get(file) ?? 0;
      if (want === written.get(file)) continue;
      // A transcript with no lines yet does not exist on disk at all. Creating
      // it empty would be a file CC never wrote.
      if (want === 0) continue;
      const lines = (contents.get(file) ?? []).slice(0, want).map((l) => l.raw);
      // First appearance: its sidecar lands with it. See `stageSidecarFor`.
      if ((written.get(file) ?? 0) === 0 && file !== src.mainPath) await stageSidecarFor(file);
      await writeFile(stagedPathFor(file), `${lines.join('\n')}\n`, 'utf8');
      written.set(file, want);
    }

    const atMs = (schedule[cut]?.stamp ?? epochMs) - epochMs;
    taken += 1;
    offsetMs = atMs;
    recorder.step(atMs, `t${String(taken)}`, `${String(cut + 1)} of ${String(schedule.length)} lines on disk`);

    const result = await host.graftSession(join(stagedSlug, `${src.sessionId}.jsonl`), {
      previewBytes: 8192,
    });
    model.ingestGraftResult(src.sessionId, src.slug, result);
    const emission = model.emit();
    final = emission;
    recorder.bridge.publish(emission);
    recorder.bridge.publishDegraded(engine.degradedState());
  }

  const digests = {};
  for (const file of files) digests[repoRelative(file)] = await digestOf(file);

  return { recorder, engine, final, src, digests, lines: schedule.length, steps: taken, stage };
}

const TIMED_DESCRIPTION = [
  'Every message a real SessionBridge put on the wire while the real SessionModel was driven',
  'over a REAL captured session, at the timing the session itself recorded: `atMs` is the',
  "line's own transcript timestamp, relative to the first line. Recorded to answer the",
  'question AUDIT-2026-08-27 section 7.4 left open - whether the store survives hundreds of',
  'back-to-back diffs on a large tree - which the hand-authored ten-event arc cannot.',
].join(' ');

async function buildTimedCorpus(host, sourceDir, options = {}) {
  const recorded = await recordTimedSession(host, sourceDir, options);
  const { recorder, engine, final, digests } = recorded;
  const lastEvent = recorder.events[recorder.events.length - 1];
  // The corpus id, and a naming collision worth recording rather than working
  // around silently. The fixture directory is `fixtures/synthetic-dropped-actions/`
  // - the name DoD 5.5.5 gives it - but the corpus is REAL captured evidence,
  // and `corpusFileName` refuses a `recorded` corpus whose id carries the
  // `synthetic-` prefix. That guard is right and it fired here on the first
  // run: the prefix exists precisely so invented states cannot be mistaken for
  // observations. The DIRECTORY keeps its name because the DoD names it; the
  // CORPUS drops the prefix because the corpus is not synthetic.
  const corpusName = repoRelative(sourceDir).split('/')[1].replace(/^synthetic-/, '');

  const schemaMismatchSessionIds = [
    ...new Set(
      recorder.events.filter((e) => e.message.type === 'schemaMismatch').map((e) => e.message.sessionId),
    ),
  ].sort();

  return {
    corpus: {
      formatVersion: WIRE_FORMAT_VERSION,
      id: `${corpusName}-timed`,
      kind: 'recorded',
      title: `${corpusName} — a real session replayed at its own timing`,
      description: TIMED_DESCRIPTION,
      producedBy: 'scripts/record-wire.mjs --timed',
      recordedFrom: repoRelative(sourceDir),
      sourceDigests: digests,
      sourceLines: recorded.lines,
      simulatedEpochMs: SIMULATED_EPOCH_MS,
      durationMs: lastEvent === undefined ? 0 : lastEvent.atMs,
      steps: recorder.steps,
      events: recorder.events,
      final: {
        sessions: JSON.parse(JSON.stringify(final.sessions)),
        degraded: engine.degradedState(),
        schemaMismatchSessionIds,
      },
    },
    stage: recorded.stage,
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

  // DoD 5.5.5: `--timed <dir>` records a REAL session at its own timing instead
  // of the hand-authored arc. Separate rather than additive because the two
  // answer different questions and a recording of the timed corpus takes
  // minutes, which is not something an ordinary re-record should pay for.
  const timedAt = argv.indexOf('--timed');
  if (timedAt !== -1) {
    const dir = argv[timedAt + 1];
    if (dir === undefined || dir === '') throw new Error('--timed needs a fixture directory');
    const stepsAt = argv.indexOf('--max-steps');
    const options = {};
    if (stepsAt !== -1) {
      const n = Number(argv[stepsAt + 1]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--max-steps needs a positive integer');
      options.maxSteps = n;
    }
    const { corpus, stage } = await buildTimedCorpus(host, resolve(dir), options);
    await mkdir(outDir, { recursive: true });
    await writeCorpus(outDir, corpus);
    await rm(stage, { recursive: true, force: true });
    process.stdout.write(
      `recorded ${await corpusFileName(corpus)}: ${corpus.events.length} events over ` +
        `${corpus.steps.length} steps and ${corpus.durationMs} ms of transcript time\n`,
    );
    return;
  }

  // BOTH ENGINES (DoD 7.10). The theater embeds every corpus in this
  // directory, so adding the second one here is what puts an OpenCode session
  // in front of the real renderer.
  const corpora = [await buildCapturedCorpus(host), await buildOpenCodeCorpus(host)];

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
