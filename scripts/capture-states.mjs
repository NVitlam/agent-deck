// Capture the TEST DOUBLE's rendering of the five UI states, as a committed
// artifact a human can hold beside a screenshot of a real VS Code window.
//
// WHY THIS EXISTS
// ---------------
// PLAN Phase 4 DoD 4 asks for the five UI states as "real-window-vs-double
// evidence". `webview/states.test.ts` already proves the double renders all
// five and renders them distinguishably — but those assertions live inside a
// test process and vanish when it exits. There is therefore nothing for the
// human's screenshots to be compared AGAINST. "It looked right" is a report;
// this file produces the record.
//
// The output is the DOUBLE half of that comparison, and only that half. The
// real-window half is a human's job and is not claimed anywhere in here.
//
// WHAT IT DRIVES
// --------------
// The SHIPPED renderer bundle, produced by `webview/build-harness.mjs` — the
// same esbuild + esbuild-svelte pipeline `npm run build` runs. Capturing from
// `.svelte` sources instead would prove the wrong artifact.
//
// The states are computed by the REAL host pipeline over the REAL committed
// fixtures, not set by hand:
//
//   fixtures/cc-2.1.234/** -> graftSession -> SessionModel -> LivenessEngine
//     -> SessionBridge -> JSON round trip -> window 'message' -> Svelte bundle
//
// `webview/fixture-render.test.ts` established that path; the five recipes
// below are the same ones it uses. The single exception is
// `unsupported-with-tree`, which needs a session whose model DOES carry a
// tree that is nonetheless refused — see the comment on that recipe.
//
// DETERMINISM IS THE PRODUCT
// --------------------------
// Committed evidence that changes on every run is noise, and every future
// diff against it is a false positive. So: no wall clock (the liveness engine
// is given a fixed `now`, and transcript mtimes are supplied rather than
// stat()ed), no random, no run ids, no host paths, no machine names, fixed
// key order, `\n` line endings written explicitly.
//
// Payload preview TEXT is normalised out. Two reasons, both load-bearing:
//   1. G4. Normalising the payload bodies away means this evidence cannot
//      carry thinking-block content or `signature` bytes even in principle.
//      `webview/capture.test.ts` still greps for the literal signature bytes
//      in the capture, because a structural argument is not a measurement.
//   2. The truncation-marker defect (HANDOVER carry-forward A) is being fixed
//      in this same phase. Preview byte counts move with that fix, and an
//      evidence file pinned to them would go red for a reason that has
//      nothing to do with UI state.
//
// Styles are not captured. `build-harness.mjs` injects CSS into the bundle
// and this records structure and text only — so a colour change does not
// invalidate the evidence, and neither does it prove anything about it. That
// is what the human's screenshots are for.
//
// G1: writes only under the output directory (default `docs/evidence/ui-states`,
// inside the repo). G5: no network.
//
// Usage:  node scripts/capture-states.mjs [--out <dir>]

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(REPO_ROOT, 'docs', 'evidence', 'ui-states');
const HARNESS_GLOBAL = 'AgentDeckHarness';

/**
 * A fixed instant. Liveness moves with the clock, so a capture reading the
 * real one would pin its result to the second it ran. Same value
 * `webview/fixture-render.test.ts` uses.
 */
const NOW = 1_700_000_060_000;
/** Comfortably inside the liveness engine's recency threshold. */
const RECENT = NOW - 1_000;
/** Comfortably outside it. */
const STALE = NOW - 600_000;

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

/**
 * The shipped renderer, as an iife string.
 *
 * Delegated to `webview/build-harness.mjs` rather than re-specifying esbuild
 * options here: the point of the capture is that it drives the same bytes the
 * component tests drive, and two copies of a build config is exactly the
 * "two agreeing literals" seam this repo has already been bitten by.
 */
function bundleRenderer() {
  return execFileSync('node', ['webview/build-harness.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The host modules and the webview's own state builders, bundled for node.
 *
 * An in-memory entry point rather than a file on disk: this re-exports, it
 * does not reimplement. Every builder below is imported from the module that
 * owns it. `packages: 'external'` leaves `node:*` and any dependency as
 * `require(...)`, resolved against the repo's own `node_modules`.
 *
 * Runs BEFORE any JSDOM exists. esbuild asserts at startup that
 * `new TextEncoder().encode('') instanceof Uint8Array`, and a DOM realm that
 * installs its own `Uint8Array` breaks that — see `build-harness.mjs`. A
 * `new JSDOM()` does not replace this realm's globals, but ordering the work
 * so the question cannot arise is cheaper than relying on that.
 */
async function bundleHost() {
  const entry = [
    "export { graftSession } from './src/model/graft.js';",
    "export { SessionModel } from './src/model/session.js';",
    "export { LivenessEngine } from './src/model/liveness.js';",
    "export { SessionBridge } from './src/bridge/messages.js';",
    "export { isAgentNode } from './src/model/events.js';",
    "export { unsupportedSession } from './webview/testdata.js';",
  ].join('\n');

  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: REPO_ROOT,
      sourcefile: 'capture-host-entry.ts',
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
  factory(require, mod, mod.exports, join(REPO_ROOT, 'capture-host.cjs'), REPO_ROOT);
  return mod.exports;
}

// ---------------------------------------------------------------------------
// Fixture discovery — read off the directory, never named
// ---------------------------------------------------------------------------

const CAPTURED_ROOT = join(REPO_ROOT, 'fixtures', 'cc-2.1.234', 'projects');
const LAYOUT_ROOT = join(REPO_ROOT, 'fixtures', 'synthetic-layout');

let capturedCache;

/**
 * The captured slug directory, its transcripts, and the workspace they were
 * taken in. Nothing here is a hard-coded name or count: a re-harvest on
 * another machine needs no edit to this file, and no fixture-set SIZE is
 * asserted anywhere.
 */
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
 * The first `fixtures/synthetic-layout` case that `graftSession` actually
 * refuses — found by asking it, not by naming a case that is expected to fail.
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
// The host half, assembled from the real classes
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
 * Build the host side from the fixtures and publish it through a real
 * `SessionBridge` into `dispatch`.
 *
 * `configure` runs after every session is grafted and before the emission, so
 * a recipe can drive liveness with hook events the way the listener does.
 */
async function hostRun(host, dispatch, configure) {
  const { slug, slugDir, sessionIds, workspacePath } = await fixtures();
  const engine = new host.LivenessEngine({ now: () => NOW });
  const model = new host.SessionModel({ workspacePath, liveness: engine });

  for (const sessionId of sessionIds) {
    model.ingestGraftResult(sessionId, slug, await host.graftSession(join(slugDir, `${sessionId}.jsonl`)));
  }

  await configure?.({ model, engine, slug, slugDir, sessionIds });

  const wire = [];
  const bridge = new host.SessionBridge({
    postMessage: (message) => {
      wire.push(message);
      // VS Code's postMessage is a structured-clone hop, so the webview never
      // receives the host's own object. A JSON round trip is the closest
      // faithful stand-in and proves nothing unserialisable escapes.
      dispatch(JSON.parse(JSON.stringify(message)));
    },
  });

  const emission = model.emit();
  bridge.publish(emission);
  bridge.publishDegraded(engine.degradedState());

  const states = new Map();
  for (const state of emission.sessions) states.set(state.sessionId, state);
  return { model, engine, slug, sessionIds, states, wire };
}

/** Nodes in a `SessionState`, counted from the model rather than the DOM. */
function countStateNodes(host, state) {
  let n = 0;
  const visit = (node) => {
    n += 1;
    if (host.isAgentNode(node)) for (const child of node.children) visit(child);
  };
  visit(state.root);
  return n;
}

// ---------------------------------------------------------------------------
// DOM normalisation
// ---------------------------------------------------------------------------

/** Attributes that carry no state and would only add noise. */
const SKIPPED_ATTRS = new Set(['class', 'id', 'data-testid', 'style']);

/**
 * Text this capture must not carry verbatim.
 *
 * `preview-body` is a tool payload: G4 territory, and its length moves with
 * the truncation fix in flight this phase. `preview-marker` states a
 * character count off that same payload, so its digits are normalised to `N`
 * while its wording — which IS a UI fact worth comparing — is kept.
 */
function normaliseText(testId, text) {
  if (testId === 'preview-body') return '«payload»';
  if (testId === 'preview-marker') return text.replace(/\d+/g, 'N');
  return text;
}

/**
 * Direct text-node children only, whitespace collapsed, with each child
 * ELEMENT's position marked `{}`.
 *
 * The marker is not decoration. The refusal screen reads "…the transcript
 * layout for <code>id</code>, so it is not…"; dropping the child silently
 * yields "…layout for , so it is not…", which looks like a rendering bug in a
 * file whose whole job is to be read as ground truth by a human.
 */
function ownText(el) {
  let out = '';
  let hasText = false;
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? '';
      if (value.trim() !== '') hasText = true;
      out += value;
    } else if (node.nodeType === 1) {
      out += '{}';
    }
  }
  // An element with only element children has no text of its own; emitting
  // "{}{}" for it would put a line's worth of noise on every wrapper div.
  if (!hasText) return '';
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * One line per element:
 *
 *   tag #id [testid] .class attr=value "text"
 *
 * Chosen over a raw HTML dump because a human comparing this to a screenshot
 * needs to answer specific questions — which badge text, which state classes,
 * which element carries them — and an HTML dump buries all three in markup.
 * Attribute order is alphabetical so the file is stable under any DOM change
 * that does not change the attributes themselves.
 */
function outline(el, depth, lines) {
  const parts = [`${'  '.repeat(depth)}${el.tagName.toLowerCase()}`];
  if (el.id !== '') parts.push(`#${el.id}`);
  const testId = el.getAttribute('data-testid');
  if (testId !== null) parts.push(`[${testId}]`);
  // `svelte-<hash>` is the compiler's CSS scoping token. It changes whenever a
  // component's stylesheet changes, which would churn every file in this
  // directory for an edit that alters no state. Styles are out of scope here
  // (see the README); the semantic classes — `liveness-live`, `chip-error`,
  // `selected` — are the ones a screenshot comparison turns on, and they stay.
  for (const cls of [...el.classList]) {
    if (!cls.startsWith('svelte-')) parts.push(`.${cls}`);
  }

  const attrs = [...el.attributes]
    .filter((a) => !SKIPPED_ATTRS.has(a.name))
    .map((a) => [a.name, a.value])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, value] of attrs) parts.push(`${name}=${JSON.stringify(value)}`);

  const text = ownText(el);
  if (text !== '') parts.push(JSON.stringify(normaliseText(testId, text)));

  lines.push(parts.join(' '));
  for (const child of el.children) outline(child, depth + 1, lines);
  return lines;
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

const all = (root, testId) => [...root.querySelectorAll(`[data-testid="${testId}"]`)];
const first = (root, testId) => all(root, testId)[0];
const textOf = (el) => (el === undefined ? null : (el.textContent ?? '').replace(/\s+/g, ' ').trim());
const attr = (el, name) => (el === undefined ? null : el.getAttribute(name));
/**
 * An element's text with one descendant's text removed, addressed by
 * `data-testid` so this never grows a second selector for an element the
 * components already name.
 */
const textExcluding = (el, testId) => {
  if (el === undefined) return null;
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 1 && node.getAttribute('data-testid') === testId) continue;
    out += node.textContent ?? '';
  }
  return out.replace(/\s+/g, ' ').trim();
};
/** Classes with meaning, i.e. everything but the compiler's CSS scoping token. */
const semanticClasses = (el) =>
  el === undefined ? null : [...el.classList].filter((c) => !c.startsWith('svelte-'));

/**
 * The per-state fact summary — the double's column of the comparison table.
 *
 * Every field here is something a human can read off a screenshot of the real
 * window without a debugger, except the `data-*` attributes, which need the
 * webview developer tools. Both are named in the README's checklist.
 */
function factsFor(container, meta) {
  const app = first(container, 'app');
  const header = first(container, 'session-header');
  const headerLiveness = first(container, 'header-liveness');
  const banner = first(container, 'degraded-banner');
  const refusal = first(container, 'refusal-screen');

  return {
    panel: {
      dataLiveness: attr(app, 'data-liveness'),
      dataRefused: attr(app, 'data-refused'),
      dataDegraded: attr(app, 'data-degraded'),
    },
    counts: {
      // The G3 row. `unsupported` must show 0 here while `modelNodes` is
      // non-zero: a refusal renders no tree at all, not a tree with a warning.
      treeNodes: all(container, 'tree-node').length,
      modelNodesInSelectedSession: meta.modelNodes,
      sessionHeaders: all(container, 'session-header').length,
      refusalScreens: all(container, 'refusal-screen').length,
      degradedBanners: all(container, 'degraded-banner').length,
      livenessInferredMarkers: all(container, 'header-liveness-inferred').length,
      statusChips: all(container, 'status-chip').length,
      payloadPreviews: all(container, 'payload-preview').length,
      railItems: all(container, 'rail-item').length,
    },
    header:
      header === undefined
        ? { present: false }
        : {
            present: true,
            livenessText: textOf(headerLiveness),
            livenessTitle: attr(headerLiveness, 'title'),
            livenessClasses: semanticClasses(headerLiveness),
            dataLivenessInferred: attr(header, 'data-liveness-inferred'),
            inferredMarkerText: textOf(first(container, 'header-liveness-inferred')),
            // RENAMED WITH THE MEANING, 0.1.3: the header shows `context`
            // (the last message's prompt) and `burn` (the running total), not
            // in/out. This script kept querying the old ids for one commit and
            // faithfully recorded `null` on all four states - a capture that
            // succeeds while capturing nothing, which is why `facts.json` is
            // committed and diffed rather than trusted.
            contextNow: textOf(first(container, 'header-context')),
            burn: textOf(first(container, 'header-burn')),
            cost: textOf(first(container, 'header-cost')),
            costTitle: attr(first(container, 'header-cost'), 'title'),
          },
    banner:
      banner === undefined
        ? { present: false }
        : {
            present: true,
            dataReason: attr(banner, 'data-reason'),
            // The banner's own message, with the dismiss button's label taken
            // out: `textContent` swallows the button, and "…hook block.
            // Dismiss" reads as part of the sentence in a checklist cell.
            text: textExcluding(banner, 'degraded-dismiss'),
            dismissButton: textOf(first(container, 'degraded-dismiss')),
          },
    refusalScreen:
      refusal === undefined
        ? { present: false }
        : {
            present: true,
            dataLiveness: attr(refusal, 'data-liveness'),
            role: attr(refusal, 'role'),
            heading: textOf(refusal.querySelector('h2')),
            sessionIdShown: textOf(first(container, 'refusal-session-id')),
            cause: textOf(first(container, 'refusal-cause')),
          },
    rail: all(container, 'rail-item').map((item) => {
      const liveness = first(item, 'rail-liveness');
      return {
        selected: item.getAttribute('data-selected'),
        dataLiveness: item.getAttribute('data-liveness'),
        dataRefused: item.getAttribute('data-refused'),
        livenessText: textOf(liveness),
        livenessTitle: attr(liveness, 'title'),
        livenessClasses: semanticClasses(liveness),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Mount the shipped bundle, run `drive`, and return the normalised DOM plus
 * the fact summary. The renderer is disposed before returning, so no capture
 * can see another capture's messages.
 */
function capture(window, harness, drive) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const intents = [];
  const started = harness.start(container, { postMessage: (m) => intents.push(m) });

  // Drive the LIST surface explicitly.
  //
  // Phase 4.5 made the canvas the default view, and these recipes reach for
  // rail items and tree nodes — so without this the `unsupported` recipe threw
  // "the refused session never reached the rail" and the whole capture died
  // before writing a file. The evidence is unchanged by this line: it captured
  // the list renderer when it was the default and it captures the same one now.
  //
  // WHAT THIS EVIDENCE THEREFORE DOES NOT COVER, stated because a silent gap in
  // an evidence directory is worse than a missing one: the canvas surface has
  // NO captures here. Its five states are asserted in `webview/states.test.ts`
  // against the built bundle in both views, which is a stronger check than a
  // DOM-text capture — but it is a different artifact, and the human's
  // real-window pass (Phase 4 DoD 4) still has only the list column to compare
  // against.
  harness.flushSync(() => {
    started.store.setViewMode('list');
  });

  const dispatch = (message) => {
    harness.flushSync(() => {
      window.dispatchEvent(new window.MessageEvent('message', { data: message }));
    });
  };
  const click = (el) => {
    harness.flushSync(() => {
      el.click();
    });
  };

  // `drive` may be sync or async; `Promise.resolve` takes both without the
  // capture having to care which recipe it is running.
  return Promise.resolve(drive({ dispatch, click, container, store: started.store })).then(
    (meta) => {
      const dom = outline(container, 0, []).join('\n') + '\n';
      const facts = factsFor(container, meta);
      started.dispose();
      container.remove();
      return { dom, facts, intents };
    },
  );
}

// ---------------------------------------------------------------------------
// The five states
// ---------------------------------------------------------------------------

function recipes(host) {
  return [
    {
      id: 'live',
      what: 'A supported session the host believes is running, with recent transcript activity.',
      howProduced:
        'Real fixtures grafted by graftSession, then one PreToolUse hook event and a recent transcript mtime per session, against a fixed clock.',
      async drive({ dispatch }) {
        const run = await hostRun(host, dispatch, ({ model, sessionIds }) => {
          for (const sessionId of sessionIds) {
            model.liveness.observeJsonl(sessionId, { mtimeMs: RECENT });
            model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', RECENT, 1));
          }
        });
        return selectedMeta(host, run);
      },
    },
    {
      id: 'idle',
      what: 'Something is still believed to be running, but nothing recent has happened — so neither extreme is claimed.',
      howProduced:
        'As live, but the transcript mtime and the hook event are both outside the recency threshold.',
      async drive({ dispatch }) {
        const run = await hostRun(host, dispatch, ({ model, sessionIds }) => {
          for (const sessionId of sessionIds) {
            model.liveness.observeJsonl(sessionId, { mtimeMs: STALE });
            model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', STALE, 1));
          }
        });
        return selectedMeta(host, run);
      },
    },
    {
      id: 'ended',
      what: 'Nothing is believed to be running and there has been no recent activity.',
      howProduced:
        'As idle, plus a Stop HOOK event. There is no `stop` entry type in any committed transcript; Stop is a hook event on the other tap.',
      async drive({ dispatch }) {
        const run = await hostRun(host, dispatch, ({ model, sessionIds }) => {
          for (const sessionId of sessionIds) {
            model.liveness.observeJsonl(sessionId, { mtimeMs: STALE });
            model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', STALE, 1));
            model.ingestHookEvent(mainEvent(sessionId, 'Stop', STALE, 2));
          }
        });
        return selectedMeta(host, run);
      },
    },
    {
      id: 'unsupported',
      what: 'G3, refuse don’t guess: a transcript layout the real fingerprint refused. No tree is drawn, and no header either.',
      howProduced:
        'The first fixtures/synthetic-layout case graftSession actually refuses, registered under the captured workspace slug and then selected in the rail by clicking it. The neighbouring captured sessions are driven live so that this capture varies ONE thing against the live capture — the refusal — and so the rail shows that a refusal costs only its own session.',
      async drive({ dispatch, click, container }) {
        const layout = await refusedLayout(host);
        const run = await hostRun(host, dispatch, async ({ model, slug, sessionIds }) => {
          for (const sessionId of sessionIds) {
            model.liveness.observeJsonl(sessionId, { mtimeMs: RECENT });
            model.ingestHookEvent(mainEvent(sessionId, 'PreToolUse', RECENT, 1));
          }
          model.ingestGraftResult(layout.sessionId, slug, await host.graftSession(layout.path));
        });
        const item = all(container, 'rail-item').find(
          (i) => i.getAttribute('data-session-id') === layout.sessionId,
        );
        if (item === undefined) throw new Error('the refused session never reached the rail');
        click(item);
        const state = run.states.get(layout.sessionId);
        if (state === undefined) throw new Error('the refused session was not emitted');
        return { modelNodes: countStateNodes(host, state) };
      },
    },
    {
      id: 'unsupported-with-tree',
      what: 'The same state, on a session whose MODEL carries a full tree. This is the row that proves the refusal suppresses a tree rather than merely lacking one: modelNodes is non-zero and treeNodes is 0.',
      howProduced:
        "webview/testdata.ts's unsupportedSession() — the one hand-built state in this capture, because no committed fixture both parses into a full tree and is refused. Delivered as a normal snapshot message.",
      drive({ dispatch }) {
        const state = host.unsupportedSession();
        dispatch({ type: 'snapshot', sessions: [JSON.parse(JSON.stringify(state))] });
        return { modelNodes: countStateNodes(host, state) };
      },
    },
    {
      id: 'degraded',
      what: 'G2: the hook tap is silent. The banner appears, the tree keeps rendering, and the liveness value is marked as inferred.',
      howProduced:
        'Real fixtures with a recent transcript mtime and NO hook events at all — the state a user who has not pasted the hook block is in. The degraded flag comes from the engine, not from a hand-written message.',
      async drive({ dispatch }) {
        const run = await hostRun(host, dispatch, ({ model, sessionIds }) => {
          for (const sessionId of sessionIds) {
            model.liveness.observeJsonl(sessionId, { mtimeMs: RECENT });
          }
        });
        return selectedMeta(host, run);
      },
    },
  ];
}

/** Node count of whichever session the store selected by default (the first). */
function selectedMeta(host, run) {
  const firstId = run.sessionIds[0];
  const state = firstId === undefined ? undefined : run.states.get(firstId);
  return { modelNodes: state === undefined ? 0 : countStateNodes(host, state) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const README_PROSE = `# UI state evidence — the test double's half

**Generated by \`node scripts/capture-states.mjs\`. Do not edit this file.** \`webview/capture.test.ts\`
re-runs the capture and compares it byte-for-byte with what is committed here, so a hand edit reads as
a regression. **Record real-window results in a new file beside this one** — e.g.
\`real-window-result.md\`. The capture leaves files it did not generate alone.

## What this is, and what it is not

PLAN Phase 4 DoD 4 wants the five UI states as **real-window-vs-double evidence**. This directory is
the **double's column only**. Every fact below was produced by driving the shipped webview bundle
(the same esbuild + esbuild-svelte pipeline \`npm run build\` runs) inside jsdom, fed by the real host
pipeline — \`graftSession\` → \`SessionModel\` → \`LivenessEngine\` → \`SessionBridge\` → a JSON round trip
→ a \`window\` message — over the real committed fixtures.

**The real-window column is unfilled. That pass has not been run.** Nothing in this directory asserts
anything about a real VS Code window, and nothing here should be read as though it had been checked
against one.

## Files

- \`facts.json\` — the per-state fact summary, machine-readable. The checklist below is generated from
  it, so the two cannot drift apart.
- \`<state>.dom.txt\` — the normalised DOM. One line per element:
  \`tag #id [data-testid] .class attr="value" "own text"\`, attributes alphabetical, \`{}\` marking where a
  child element sits inside its parent's text. Chosen over a raw HTML dump because the questions a
  human needs answered are specific — which badge text, which state classes, which element carries
  them — and markup buries all three.

There are six files for five states. \`unsupported-with-tree\` is not a sixth state: it is the
\`unsupported\` state on a session whose *model* carries a full tree, which is the only way to show that
the refusal **suppresses** a tree rather than merely happening to have none. Compare its
\`treeNodes\` (0) with its \`modelNodesInSelectedSession\` (non-zero). That is the G3 row.

## What is deliberately normalised away, and why

- **Tool payload text** renders as \`«payload»\` and the truncation marker's
  digits as \`N\`. Two reasons. G4: the evidence then cannot carry thinking-block content or
  \`signature\` bytes even in principle — though \`webview/capture.test.ts\` still greps this directory
  for the literal signature bytes in the fixtures, because a structural argument is not a
  measurement. And the truncation-marker defect recorded in \`PLAN.md\` is being fixed in this same
  phase; evidence pinned to preview byte counts would go red for a reason unrelated to UI state.
- **Svelte's \`svelte-<hash>\` CSS scoping classes.** They change whenever a component's stylesheet
  changes, which would churn every file here for an edit that alters no state. The semantic classes
  — \`liveness-live\`, \`chip-error\`, \`selected\` — are what a screenshot comparison turns on and they
  are kept.
- **Styles themselves.** Structure and text only. A colour change neither invalidates this evidence
  nor is proven by it. That is what the screenshots are for.
- **Time.** The liveness engine is given a fixed clock and transcript mtimes are supplied rather than
  \`stat()\`ed, so re-running the capture against unchanged code is byte-identical.

## The comparison checklist

Open the panel in a real VS Code window (*Agent Deck: Open Session Deck*), drive it into each state,
and fill the **real window** column. \`data-*\` values need the webview developer tools (*Developer:
Open Webview Developer Tools*); everything else is readable off the screen. Node counts and session
ids will differ — the real window shows the human's own sessions, not these fixtures. What must match
is the **shape**: which markers appear, what they say, and which elements carry them.

\`unsupported\` does not occur on demand; it needs a session the fingerprint refuses.

A mismatch on any row **re-opens the UX package rather than being patched over** — that is the
answered open question in \`PLAN.md\` on sequencing, and the reason this directory exists.
`;

/** Escape a checklist value for a markdown table cell. */
function cell(value) {
  return String(value).replace(/\|/g, '\\|');
}

function readme(results) {
  const lines = [README_PROSE];
  for (const { id, facts } of results) {
    lines.push(`### ${id}`);
    lines.push('');
    lines.push(facts.what);
    lines.push('');
    lines.push(`*Double produced by:* ${facts.howProduced}`);
    lines.push('');
    lines.push('| fact | double | real window |');
    lines.push('| --- | --- | --- |');
    for (const [label, value] of checklistRows(facts)) {
      lines.push(`| ${label} | \`${cell(value)}\` | |`);
    }
    lines.push('');
  }
  // `\n` explicitly. Committed evidence must not depend on the platform's
  // line-ending default; see `.gitattributes` and the `core.autocrlf` note in
  // CLAUDE.md for why that bites this repo in particular.
  return lines.join('\n') + '\n';
}

/** The rows of one state's checklist. Order is fixed, values come from facts. */
function checklistRows(facts) {
  const rows = [
    ['panel `data-liveness`', facts.panel.dataLiveness],
    ['panel `data-refused`', facts.panel.dataRefused],
    ['panel `data-degraded`', facts.panel.dataDegraded],
    ['tree node elements on screen', facts.counts.treeNodes],
    ['nodes in the selected session’s model', facts.counts.modelNodesInSelectedSession],
    ['session header present', facts.header.present],
    ['refusal screen present', facts.refusalScreen.present],
    ['degraded banner present', facts.banner.present],
    ['"(inferred)" markers beside liveness', facts.counts.livenessInferredMarkers],
  ];
  if (facts.header.present) {
    rows.push(['header liveness text', facts.header.livenessText]);
    rows.push(['header liveness tooltip', facts.header.livenessTitle]);
    rows.push(['header liveness classes', facts.header.livenessClasses.join(' ')]);
    rows.push(['header cost', facts.header.cost]);
  }
  if (facts.banner.present) {
    rows.push(['banner `data-reason`', facts.banner.dataReason]);
    rows.push(['banner text', facts.banner.text]);
  }
  if (facts.refusalScreen.present) {
    rows.push(['refusal heading', facts.refusalScreen.heading]);
    rows.push(['refusal cause line', facts.refusalScreen.cause]);
  }
  const selected = facts.rail.find((r) => r.selected === 'true');
  if (selected !== undefined) {
    rows.push(['selected rail row liveness text', selected.livenessText]);
    rows.push(['selected rail row `data-refused`', selected.dataRefused]);
    rows.push(['selected rail row classes', selected.livenessClasses.join(' ')]);
  }
  return rows;
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const requested = outAt === -1 ? undefined : argv[outAt + 1];
  // `resolve('')` returns the working directory, so an empty `--out` would
  // silently target the repo root rather than failing.
  if (outAt !== -1 && (requested === undefined || requested === '')) {
    throw new Error('--out needs a directory');
  }
  const outDir = requested === undefined ? DEFAULT_OUT : resolve(requested);

  const rendererCode = bundleRenderer();
  const host = await bundleHost();

  // jsdom is imported here, after every esbuild call has finished. See
  // `bundleHost` for why the ordering is deliberate.
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // The bundle opens with `"use strict"`, so its top-level `var` binding stays
  // inside the eval's own variable environment and never reaches `window`.
  // Taking the completion value is how `webview/testkit.ts` gets at it too.
  const harness = window.eval(`${rendererCode}\n${HARNESS_GLOBAL};`);
  if (harness === undefined) throw new Error(`the renderer bundle did not define ${HARNESS_GLOBAL}`);

  const results = [];
  for (const recipe of recipes(host)) {
    const { dom: outlineText, facts } = await capture(window, harness, recipe.drive);
    results.push({
      id: recipe.id,
      dom: outlineText,
      facts: { what: recipe.what, howProduced: recipe.howProduced, ...facts },
    });
  }

  await mkdir(outDir, { recursive: true });
  // Clear only what this script generates. A human's real-window results live
  // in this directory too (the README says so) and must survive a re-capture.
  for (const entry of await readdir(outDir)) {
    if (entry === 'facts.json' || entry === 'README.md' || entry.endsWith('.dom.txt')) {
      await rm(join(outDir, entry));
    }
  }

  const factsFile = {};
  for (const { id, facts } of results) factsFile[id] = facts;
  await writeFile(join(outDir, 'facts.json'), JSON.stringify(factsFile, null, 2) + '\n', 'utf8');
  for (const { id, dom: outlineText } of results) {
    await writeFile(join(outDir, `${id}.dom.txt`), outlineText, 'utf8');
  }
  await writeFile(join(outDir, 'README.md'), readme(results), 'utf8');

  window.close();
  process.stdout.write(`captured ${results.length} states into ${outDir}\n`);
}

await main();
