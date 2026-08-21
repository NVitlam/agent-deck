/**
 * The replay theater (R6, `docs/ui/ui-canvas-redesign.md` §7 Tier 3).
 *
 * A dev-only page that loads a recorded wire corpus and drives THE REAL
 * RENDERER with it — `start()` from `webview/main.ts`, the same function VS
 * Code calls, fed through the same `window` 'message' event the real webview
 * listens on. A nine-minute session arc becomes a thirty-second visual review,
 * replayable infinitely, offline, deterministic.
 *
 * NOT SHIPPED. Built only by `node esbuild.config.mjs --theater`, which is not
 * part of `npm run build`, so the VSIX never contains it. Nothing in
 * `webview/main.ts` imports this file — asserted against the real import graph
 * in `webview/wire.test.ts`, exactly as `harness.ts` is.
 *
 * The dependency direction is what keeps that true and is worth stating: the
 * theater imports the renderer, never the reverse. Any edge back would put a
 * corpus into the shipped bundle and would fail the import-graph assertion
 * rather than quietly bloating the panel.
 */

import corpora from 'virtual:wire-corpus';

import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/model/events.js';
import { start } from '../main.js';
import type { WireCorpus, WireEvent } from './corpus-types.js';
import { createReplay } from './replay.js';
import type { ReplayController } from './replay.js';

/** The one id shared with `index.html`. A missing element fails loudly. */
const ROOT_ID = 'theater-root';

/** Speeds the slider steps through. 1 = real time. */
const SPEEDS = [1, 2, 5, 10, 20, 60, 240] as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `mm:ss.mmm` of a simulated offset. Never a date: this is elapsed time. */
function clock(atMs: number): string {
  const minutes = Math.floor(atMs / 60_000);
  const seconds = Math.floor((atMs % 60_000) / 1000);
  const millis = atMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function describe(message: HostToWebviewMessage): string {
  switch (message.type) {
    case 'snapshot':
      return `snapshot (${message.sessions.length} sessions)`;
    case 'diff':
      return `diff ${message.sessionId}`;
    case 'schemaMismatch':
      return `schemaMismatch ${message.sessionId}`;
    case 'degraded':
      return message.degraded ? `degraded (${message.reason ?? 'unknown'})` : 'degraded: no';
  }
}

interface Mount {
  dispose(): void;
}

function boot(root: HTMLElement): void {
  const ids = Object.keys(corpora).sort();

  const transport = el('div', 'theater-transport');
  const stage = el('div', 'theater-stage');
  root.replaceChildren(transport, stage);

  if (ids.length === 0) {
    transport.append(
      el(
        'p',
        'theater-empty',
        'No wire corpus is committed. Run `node scripts/record-wire.mjs`, then rebuild ' +
          'with `node esbuild.config.mjs --theater`.',
      ),
    );
    return;
  }

  // --- controls ------------------------------------------------------------
  const corpusPicker = el('select', 'theater-corpus');
  for (const id of ids) {
    const option = el('option');
    option.value = id;
    option.textContent = id;
    corpusPicker.append(option);
  }

  const playButton = el('button', 'theater-play', 'Play');
  const scrubber = el('input', 'theater-scrubber');
  scrubber.type = 'range';
  scrubber.min = '0';
  scrubber.step = '1';

  const speedSlider = el('input', 'theater-speed');
  speedSlider.type = 'range';
  speedSlider.min = '0';
  speedSlider.max = String(SPEEDS.length - 1);
  speedSlider.step = '1';
  speedSlider.value = String(SPEEDS.indexOf(10));

  const speedLabel = el('span', 'theater-speed-label');
  const positionLabel = el('span', 'theater-position');
  const stepLabel = el('span', 'theater-step');
  const titleLabel = el('span', 'theater-title');
  const intentLabel = el('span', 'theater-intent', 'no intent yet');

  transport.append(
    corpusPicker,
    playButton,
    scrubber,
    positionLabel,
    el('span', 'theater-sep', '·'),
    speedSlider,
    speedLabel,
    el('span', 'theater-sep', '·'),
    stepLabel,
    titleLabel,
    intentLabel,
  );

  // --- the renderer, and the wiring the theater re-creates on rewind -------
  let mount: Mount | undefined;
  let controller: ReplayController | undefined;

  const mountRenderer = (): void => {
    mount?.dispose();
    stage.replaceChildren();
    const container = el('div', 'theater-panel');
    stage.append(container);
    const started = start(container, {
      postMessage: (message: WebviewToHostMessage) => {
        intentLabel.textContent = `intent: ${message.type} ${
          'nodeId' in message ? message.nodeId : message.sessionId
        }`;
      },
    });
    mount = { dispose: started.dispose };
  };

  /**
   * The real delivery path: a `window` 'message' event, which is what
   * `webview/main.ts` listens on. Calling `store.handleMessage` directly would
   * skip `isHostMessage` and make the theater prove less than it appears to.
   */
  const deliver = (message: HostToWebviewMessage, event: WireEvent): void => {
    stepLabel.textContent = `${event.label}: ${describe(message)}`;
    globalThis.dispatchEvent(new MessageEvent('message', { data: message }));
  };

  const load = (id: string): void => {
    controller?.dispose();
    const corpus = corpora[id];
    if (corpus === undefined) return;
    titleLabel.textContent = corpus.title;
    scrubber.max = String(corpus.events.length);
    scrubber.value = '0';
    mountRenderer();
    controller = createReplay(corpus as WireCorpus, {
      restart: mountRenderer,
      deliver,
      onPosition: (index, atMs) => {
        scrubber.value = String(index);
        positionLabel.textContent = `${clock(atMs)}  ${index}/${corpus.events.length}`;
        playButton.textContent = controller?.playing() === true ? 'Pause' : 'Play';
      },
    });
    controller.setSpeed(SPEEDS[Number(speedSlider.value)] ?? 10);
    speedLabel.textContent = `${controller.speed()}×`;
    positionLabel.textContent = `${clock(0)}  0/${corpus.events.length}`;
    stepLabel.textContent = 'ready';
  };

  playButton.addEventListener('click', () => {
    if (controller === undefined) return;
    if (controller.playing()) controller.pause();
    else controller.play();
    playButton.textContent = controller.playing() ? 'Pause' : 'Play';
  });

  scrubber.addEventListener('input', () => {
    controller?.pause();
    playButton.textContent = 'Play';
    controller?.seek(Number(scrubber.value));
  });

  speedSlider.addEventListener('input', () => {
    const speed = SPEEDS[Number(speedSlider.value)] ?? 10;
    controller?.setSpeed(speed);
    speedLabel.textContent = `${speed}×`;
  });

  corpusPicker.addEventListener('change', () => {
    load(corpusPicker.value);
  });

  const firstId = ids[0];
  if (firstId !== undefined) load(firstId);
}

const root = document.getElementById(ROOT_ID);
if (root === null) {
  throw new Error(`the theater page has no #${ROOT_ID}; index.html and main.ts disagree`);
}
boot(root);
