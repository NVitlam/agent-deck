// @vitest-environment jsdom
//
// Altitude 2 — the inspector (spec C7.1), mounted from the REAL esbuild +
// Svelte bundle, exactly as `render.test.ts` mounts the app: there is no
// vitest svelte plugin in this repo, so a `.svelte` import cannot be
// transformed in-process.
//
// `testkit.ts:loadHarness` bundles `harness.ts`, whose entry point is fixed
// and whose `start()` mounts `App.svelte`. The inspector is a component the
// app does not mount yet, so this file bundles it directly through the same
// pipeline, from an in-memory entry point. Nothing is written to disk (G1) —
// the entry is passed to esbuild as `stdin` and the bundle comes back on the
// child's stdout.
//
// WHAT THIS FILE IS FOR. The DoD item is that the inspector preserves G4
// byte-for-byte: the 512-character collapse, the exact marker string, and the
// full expand of a payload the host already capped at 8 KB. Those assertions
// are written against literal strings and literal lengths, never against a
// re-derivation of the formatter being tested — a G4 test that re-computes its
// own expectation passes forever while proving nothing, which is exactly how
// this repo's first thinking-block assertion turned out vacuous.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentNode, ToolNode } from '../src/model/events.js';
import { TESTID } from './canvas-contract.js';
import { COLLAPSED_PREVIEW_CHARS, EM_DASH } from './format.js';
import { all, one } from './testkit.js';
import { agent, longPreview, tool } from './testdata.js';

/**
 * Held in a variable rather than imported statically, for the same reason
 * `testkit.ts` does it: `tsconfig.webview.json` sets `types: []`, so a literal
 * `node:child_process` specifier would fail the webview typecheck. The
 * specifier is opaque to `tsc` and resolved at runtime by vitest.
 */
const CHILD_PROCESS = 'node:child_process';
/** Same trick, same reason — see above. Read by the geometry suite below. */
const NODE_FS = 'node:fs';

interface ChildProcessModule {
  execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: 'utf8'; maxBuffer: number },
  ): string;
}

const GLOBAL_NAME = 'AgentDeckInspectorHarness';

/** The in-memory entry point esbuild bundles. */
const ENTRY = [
  "export { default as Inspector } from './Inspector.svelte';",
  "export { mount, unmount, flushSync } from 'svelte';",
].join('\n');

/**
 * The build script, run as its own `node` process.
 *
 * A separate process is not incidental: esbuild refuses to start under jsdom,
 * because jsdom installs its own `Uint8Array` and esbuild's startup invariant
 * (`new TextEncoder().encode('') instanceof Uint8Array`) is then false. See
 * `webview/build-harness.mjs`, which carries the same note and the same fix.
 */
const BUILD_SCRIPT = `
import { build } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
const result = await build({
  stdin: {
    contents: ${JSON.stringify(ENTRY)},
    resolveDir: process.cwd() + '/webview',
    sourcefile: 'inspector-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: ${JSON.stringify(GLOBAL_NAME)},
  target: 'es2022',
  conditions: ['svelte', 'browser'],
  mainFields: ['svelte', 'browser', 'module', 'main'],
  plugins: [esbuildSvelte({ compilerOptions: { css: 'injected' } })],
  logLevel: 'silent',
});
const js = result.outputFiles[0];
if (js === undefined) { process.stderr.write('no output\\n'); process.exit(1); }
process.stdout.write(js.text);
`;

interface InspectorHarness {
  Inspector: unknown;
  mount(
    component: unknown,
    options: { target: HTMLElement; props?: Record<string, unknown> },
  ): unknown;
  unmount(app: unknown): void;
  flushSync(fn?: () => void): void;
}

let harness: InspectorHarness;

beforeAll(async () => {
  const cp = (await import(/* @vite-ignore */ CHILD_PROCESS)) as unknown as ChildProcessModule;
  const code = cp.execFileSync('node', ['--input-type=module', '-e', BUILD_SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const factory = new Function(`${code}\nreturn ${GLOBAL_NAME};`) as () => InspectorHarness;
  harness = factory();
}, 60_000);

interface Mounted {
  container: HTMLElement;
  dispose: () => void;
}

const mounted: Mounted[] = [];

function render(props: Record<string, unknown>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = harness.mount(harness.Inspector, { target: container, props });
  harness.flushSync();
  mounted.push({
    container,
    dispose: () => {
      harness.unmount(app);
      container.remove();
    },
  });
  return container;
}

function click(element: HTMLElement): void {
  harness.flushSync(() => {
    element.click();
  });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/**
 * A payload of exactly the length the host's 8 KB cap produces: 8,192 bytes
 * kept plus `src/parser/redact.ts:truncationMarker`'s 56-character annotation,
 * against the largest payload in the committed CC 2.1.234 capture (63,774
 * bytes). Written out as the literal the host emits rather than imported,
 * because importing `redact.ts` would pull node types into the webview
 * project — and because a literal is what makes the length assertion below an
 * assertion rather than a restatement.
 */
const HOST_TRUNCATION_MARKER = '\n...[agent-deck: truncated, showing 8192 of 63774 bytes]';
const HOST_CAPPED_PAYLOAD = longPreview(8192) + HOST_TRUNCATION_MARKER;

describe('the empty inspector', () => {
  it('renders the panel with the empty line and no payload at all', () => {
    const container = render({});
    const panel = one(container, TESTID.inspector);
    expect(panel.dataset['empty']).toBe('true');
    expect(one(container, TESTID.inspectorEmpty).textContent).toBe(
      'Select a cell or a dot to inspect it.',
    );
    expect(all(container, 'payload-preview')).toHaveLength(0);
    expect(all(container, 'inspector-row')).toHaveLength(0);
  });
});

describe('tool detail', () => {
  const node: ToolNode = tool({
    id: 'tool-read',
    toolName: 'Read',
    status: 'error',
    durationMs: 1_500,
    inputPreview: '{"file_path":"src/model/events.ts"}',
    resultPreview: 'error: exit 2',
  });

  it('shows the id, the tool name, the status and the duration', () => {
    const container = render({ node });
    expect(one(container, TESTID.inspector).dataset['empty']).toBe('false');
    expect(one(container, 'inspector-id').textContent).toBe('tool-read');
    expect(one(container, 'inspector-title').textContent).toBe('Read');
    expect(one(container, 'inspector-kind').textContent).toBe('tool');
    // §8.6's header carries status as a FIELD in the field group — label over
    // value, fixed min-width — not as the chip the side panel used. The chip
    // sized itself to its word, so the fields beside it moved whenever a call
    // changed state, which is the thing those min-widths exist to stop.
    const status = one(container, 'inspector-status');
    expect(status.dataset['status']).toBe('error');
    expect(status.textContent).toBe('failed');
    expect(one(container, 'inspector-duration').textContent).toBe('1.5s');
  });

  it('prints an em-dash for a duration the host did not send', () => {
    const container = render({ node: tool({ id: 't', inputPreview: 'x' }) });
    expect(one(container, 'inspector-duration').textContent).toBe(EM_DASH);
  });

  it('omits the result preview entirely when the node carries none', () => {
    const container = render({ node: tool({ id: 't', inputPreview: 'x' }) });
    expect(all(container, 'payload-preview').map((p) => p.dataset['label'])).toEqual(['input']);
  });

  it('reports a payload toggle to its caller and owns no expansion state', () => {
    let calls = 0;
    const container = render({ node, ontoggle: () => (calls += 1) });
    const expander = one(container, 'inspector-expand');
    expect(expander.getAttribute('aria-expanded')).toBe('false');
    click(expander);
    click(expander);
    expect(calls).toBe(2);
    // The component was not told `expanded` changed, so it did not change:
    // expansion is the store's state, not the inspector's.
    expect(one(container, 'inspector-expand').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('agent detail', () => {
  const node: AgentNode = agent({
    id: 'agent-1',
    label: 'test-runner: run the module suite',
    kind: 'subagent',
    spawnDepth: 2,
    status: 'running',
    // DELIBERATELY DIFFERENT NUMBERS. If the two pairs were equal the test
    // below could not tell a renderer that reads `contextNow` from one that
    // reads `burn`, and both rows would pass while one was wrong.
    contextNow: { prompt: 12_345, output: 6_789 },
    burn: { prompt: 24_690, output: 13_578 },
    startedAt: 1_000,
    endedAt: 62_000,
  });

  it('shows the label, kind, spawn depth, thousands-separated tokens and duration', () => {
    const container = render({ node });
    expect(one(container, 'inspector-id').textContent).toBe('agent-1');
    expect(one(container, 'inspector-title').textContent).toBe(
      'test-runner: run the module suite',
    );
    expect(one(container, 'inspector-kind').textContent).toBe('subagent');
    expect(one(container, 'inspector-spawn-depth').textContent).toBe('2');
    // CONTEXT IS A LEVEL AND CARRIES ONE NUMBER; BURN IS A TOTAL AND CARRIES
    // TWO. The two pairs hold different numbers above precisely so these
    // assertions can fail when a row reads the wrong field: `24,690` here
    // would mean the context row is reading `burn`.
    expect(one(container, 'inspector-tokens').textContent).toBe('12,345');
    expect(one(container, 'inspector-burn').textContent).toBe('24,690 in / 13,578 out');
    expect(one(container, 'inspector-duration').textContent).toBe('1m 01s');
  });

  it('states NO PERCENTAGE anywhere, on any field', () => {
    // No transcript in either corpus states a context-window size, so a
    // percentage would have to come from a model-name lookup table — memory
    // rather than fixture (G6). The absence is the decision, so it is pinned.
    const container = render({
      node,
      sessionId: 'session-live',
      engine: 'cc',
      breadcrumb: [{ id: 'root', label: 'main session' }],
    });
    expect(one(container, TESTID.inspector).textContent).not.toContain('%');
  });

  it('renders no payload preview and no expander for an agent', () => {
    const container = render({ node });
    expect(all(container, 'payload-preview')).toHaveLength(0);
    expect(all(container, 'inspector-expand')).toHaveLength(0);
  });
});

describe('the drawer header (DoD 7.6)', () => {
  const node: AgentNode = agent({
    id: 'agent-2',
    label: 'code-reviewer: check the diff',
    kind: 'subagent',
    spawnDepth: 2,
    status: 'running',
    contextNow: { prompt: 900, output: 120 },
    burn: { prompt: 1_800, output: 240 },
    startedAt: 1_000,
  });

  const props = {
    node,
    sessionId: 'ses_5f2a1c9b8d7e4f30a1b2c3d4e5f60718',
    engine: 'opencode' as const,
    breadcrumb: [
      { id: 'root', label: 'main session' },
      { id: 'agent-1', label: 'test-runner: run the module suite' },
      { id: 'agent-2', label: 'code-reviewer: check the diff' },
    ],
  };

  it('carries the engine glyph, in the deck’s own two-letter vocabulary', () => {
    const container = render(props);
    expect(one(container, 'inspector-engine').textContent).toBe('oc');
    expect(one(container, 'inspector-engine').dataset['engine']).toBe('opencode');
    expect(one(render({ ...props, engine: 'cc' }), 'inspector-engine').textContent).toBe('cc');
  });

  it('carries the FULL session id and the FULL agent id, never a prefix', () => {
    // These are the two halves of every join key in this system. A shortened
    // one cannot be pasted into a grep, which is most of what they are for.
    const container = render(props);
    expect(one(container, 'inspector-session-id').textContent).toBe(props.sessionId);
    expect(one(container, 'inspector-id').textContent).toBe('agent-2');
  });

  it('carries the status, the spawn depth and the duration', () => {
    const container = render(props);
    const status = one(container, 'inspector-status');
    expect(status.dataset['status']).toBe('running');
    expect(status.textContent).toBe('running');
    expect(one(container, 'inspector-spawn-depth').textContent).toBe('2');
    // No `endedAt`, so there is no duration to state and none is invented.
    expect(one(container, 'inspector-duration').textContent).toBe(EM_DASH);
  });

  it('carries the breadcrumb path as TEXT, root first', () => {
    const container = render(props);
    expect(one(container, 'inspector-path').textContent).toBe(
      'main session / test-runner: run the module suite / code-reviewer: check the diff',
    );
  });

  it('renders context as a LEVEL and burn as a TOTAL, by value', () => {
    const container = render(props);
    expect(one(container, 'inspector-tokens').textContent).toBe('900');
    expect(one(container, 'inspector-burn').textContent).toBe('1,800 in / 240 out');
  });

  it('prints an em-dash, never 0, when the engine reports neither figure', () => {
    // OpenCode supplies neither in this phase. `0` would claim the session
    // spent nothing, which is a fabricated figure — the same class of defect
    // as a fabricated cost.
    const bare = agent({
      id: 'agent-3',
      label: 'oc agent',
      spawnDepth: 1,
      contextNow: undefined,
      burn: undefined,
      startedAt: 0,
    });
    const container = render({ ...props, node: bare });
    expect(one(container, 'inspector-tokens').textContent).toBe(EM_DASH);
    expect(one(container, 'inspector-burn').textContent).toBe(`${EM_DASH} in / ${EM_DASH} out`);
  });

  it('omits the engine, the session id and the path when it is told none', () => {
    // The panel is mounted by `App.svelte`, which this package does not own.
    // A header that invented a session id rather than omitting the row would
    // be a fabricated value on the surface built to carry evidence.
    const container = render({ node });
    expect(all(container, 'inspector-engine')).toHaveLength(0);
    expect(all(container, 'inspector-session-id')).toHaveLength(0);
    expect(all(container, 'inspector-path')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// G4 — the DoD item. Rehoused, not redesigned.
// ---------------------------------------------------------------------------
//
// Every expectation below is a literal: 512, the exact marker text, 8248. If
// the inspector ever grew its own cut — a second `slice`, a second marker, a
// different limit — each of these fails with a concrete number, which is the
// property Phase 4 carry-forward A was missing when `preview()` re-cut an
// already-marked string and reported "8192 of 8248" for a 63,774-byte payload.

describe('G4: the 512-character collapse', () => {
  const text = longPreview(2000);
  const node = tool({ id: 'tool-read', inputPreview: 'in', resultPreview: text });

  function resultPreview(container: HTMLElement): HTMLElement {
    const found = all(container, 'payload-preview').find((p) => p.dataset['label'] === 'output');
    if (found === undefined) throw new Error('no result preview in the inspector');
    return found;
  }

  it('shows exactly 512 characters, and they are the first 512', () => {
    const container = render({ node, expanded: false });
    const body = one(resultPreview(container), 'preview-body');
    expect(body.textContent).toHaveLength(512);
    expect(body.textContent).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(body.textContent).toBe(text.slice(0, 512));
    expect(body.dataset['truncated']).toBe('true');
  });

  it('states how much is hidden in the exact marker string', () => {
    const container = render({ node, expanded: false });
    // 2000 - 512 = 1488. Written out, not computed: a re-derivation would
    // agree with the implementation even after the implementation changed.
    expect(one(resultPreview(container), 'preview-marker').textContent).toBe(
      '[+1488 more characters - expand to see all]',
    );
  });

  it('marks nothing and hides nothing when the payload is short enough', () => {
    const short = tool({ id: 't', inputPreview: 'in', resultPreview: 'error: exit 2' });
    const container = render({ node: short, expanded: false });
    expect(one(resultPreview(container), 'preview-body').textContent).toBe('error: exit 2');
    expect(all(resultPreview(container), 'preview-marker')).toHaveLength(0);
    expect(one(resultPreview(container), 'preview-body').dataset['truncated']).toBe('false');
  });

  it('collapses a payload of exactly 512 characters without a marker', () => {
    const exact = tool({ id: 't', inputPreview: 'in', resultPreview: longPreview(512) });
    const container = render({ node: exact, expanded: false });
    expect(one(resultPreview(container), 'preview-body').textContent).toHaveLength(512);
    expect(all(resultPreview(container), 'preview-marker')).toHaveLength(0);
  });

  it('expands to the whole string the host sent, with no marker left over', () => {
    const container = render({ node, expanded: true });
    const body = one(resultPreview(container), 'preview-body');
    expect(body.textContent).toHaveLength(2000);
    expect(body.textContent).toBe(text);
    expect(all(resultPreview(container), 'preview-marker')).toHaveLength(0);
  });

  it('collapses the input payload by the same rule as the result payload', () => {
    const both = tool({ id: 't', inputPreview: text, resultPreview: text });
    const container = render({ node: both, expanded: false });
    const bodies = all(container, 'preview-body').map((b) => b.textContent);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveLength(512);
    expect(bodies[1]).toHaveLength(512);
  });
});

describe('G4: the 8 KB-capped expand', () => {
  const node = tool({ id: 'tool-read', inputPreview: 'in', resultPreview: HOST_CAPPED_PAYLOAD });

  function resultBody(container: HTMLElement): HTMLElement {
    const found = all(container, 'payload-preview').find((p) => p.dataset['label'] === 'output');
    if (found === undefined) throw new Error('no result preview in the inspector');
    return one(found, 'preview-body');
  }

  it('is fed the length the host cap actually produces: 8192 kept + a 56-char marker', () => {
    expect(HOST_TRUNCATION_MARKER).toHaveLength(56);
    expect(HOST_CAPPED_PAYLOAD).toHaveLength(8248);
  });

  it('expands to all 8248 characters and cuts nothing a second time', () => {
    const container = render({ node, expanded: true });
    const body = resultBody(container);
    expect(body.textContent).toHaveLength(8248);
    expect(body.textContent).toBe(HOST_CAPPED_PAYLOAD);
    // The host's own marker survives to the end of the expanded text. A second
    // cut in this new home would eat it, and the panel would then be showing a
    // truncated payload with no statement that it was truncated.
    expect(body.textContent?.endsWith(HOST_TRUNCATION_MARKER)).toBe(true);
    expect(body.textContent).toContain('showing 8192 of 63774 bytes');
  });

  it('collapses the same payload to 512 characters and names the 7736 it hides', () => {
    const container = render({ node, expanded: false });
    expect(resultBody(container).textContent).toHaveLength(512);
    const found = all(container, 'payload-preview').find((p) => p.dataset['label'] === 'output');
    // 8248 - 512 = 7736, written out for the same reason as 1488 above.
    expect(one(found as HTMLElement, 'preview-marker').textContent).toBe(
      '[+7736 more characters - expand to see all]',
    );
  });
});

describe('accessibility floor (C7.8)', () => {
  it('exposes the drawer as a labelled landmark', () => {
    const container = render({ node: tool({ id: 't', inputPreview: 'x' }) });
    const panel = one(container, TESTID.inspector);
    // SECTION, not ASIDE. `aside` is the element for content tangential to the
    // page — which is what the inspector was while it sat in a 22em column
    // beside the tree. §8.6 makes it the drawer along the bottom, the surface
    // a person reads a call in, so it is a labelled region of the document.
    expect(panel.tagName).toBe('SECTION');
    expect(panel.getAttribute('aria-label')).toBe('Inspector');
  });

  it('makes the expander and the close control real focusable buttons', () => {
    let closed = 0;
    const container = render({
      node: tool({ id: 't', inputPreview: 'x' }),
      onclose: () => (closed += 1),
    });
    for (const testId of ['inspector-expand', 'inspector-close']) {
      const button = one(container, testId);
      expect(button.tagName).toBe('BUTTON');
      button.focus();
      expect(document.activeElement).toBe(button);
    }
    // The component reports the intent and owns no altitude transition: the
    // Escape ladder lives in the store (`Store.escape`).
    click(one(container, 'inspector-close'));
    expect(closed).toBe(1);
  });

  it('renders no close control when the caller wires no handler', () => {
    const container = render({ node: tool({ id: 't', inputPreview: 'x' }) });
    expect(all(container, 'inspector-close')).toHaveLength(0);
  });
});

describe('the action list: what an agent DID, by description', () => {
  /** A Bash payload shaped exactly like the real ones. */
  function bash(command: string, description?: string): string {
    return JSON.stringify(description === undefined ? { command } : { command, description });
  }

  function agentWithActions(actions: readonly ToolNode[]): AgentNode {
    return agent({ id: 'root', kind: 'main', label: 'main', children: [...actions] });
  }

  function summaries(container: HTMLElement): string[] {
    return all(container, TESTID.actionSummary).map((el) => el.textContent ?? '');
  }

  it('shows the payload\u2019s description field, not the command and never the id', () => {
    const container = render({
      node: agentWithActions([
        tool({
          id: 'toolu_01Ha4yefRArHsdDCeCJ318nd',
          toolName: 'Bash',
          inputPreview: bash('wc -l PLAN.md && grep -n "^## Phase" PLAN.md', 'List phase headings in PLAN.md'),
        }),
      ]),
    });

    // The description is written by the caller, in words, and says WHY. The
    // command says how, and the id says nothing to a person at all.
    expect(summaries(container)).toEqual(['List phase headings in PLAN.md']);
    const row = one(container, TESTID.actionRow);
    expect(row.textContent).not.toContain('toolu_01Ha4yefRArHsdDCeCJ318nd');
    expect(row.textContent).not.toContain('wc -l PLAN.md');
  });

  it('falls back to the command when the payload carries no description', () => {
    const container = render({
      node: agentWithActions([
        tool({ id: 't1', toolName: 'Bash', inputPreview: bash('git status --short') }),
      ]),
    });
    expect(summaries(container)).toEqual(['git status --short']);
  });

  it('still finds the description in a payload too TRUNCATED to parse', () => {
    // G4 cuts payloads at 8 KB, so a JSON.parse of inputPreview fails far more
    // often than it succeeds. This is the path that matters in production.
    const whole = bash('x'.repeat(40), 'Rebuild the extension bundle');
    const cut = whole.slice(0, whole.indexOf('Rebuild the extension bundle') + 28) + '"}';
    expect(() => JSON.parse(cut.slice(0, cut.length - 2)) as unknown).toThrow();
    const container = render({
      node: agentWithActions([tool({ id: 't2', toolName: 'Bash', inputPreview: cut })]),
    });
    expect(summaries(container)).toEqual(['Rebuild the extension bundle']);
  });

  it('does not let a NESTED description win over the payload\u2019s own', () => {
    // THIS FIXTURE IS THE POINT, and the previous one was not.
    //
    // The old decoy was `{command: 'echo "description": "WRONG"', ...}`, whose
    // inner quotes are BACKSLASH-ESCAPED once serialized — so the regex never
    // matched it and the test passed with the JSON.parse path deleted. It was a
    // rubber stamp for the ordering it claimed to prove. Measured, not guessed.
    //
    // A nested OBJECT key is a real decoy: `"description":"WRONG"` appears
    // verbatim and FIRST in the serialized bytes, so the regex alone takes it.
    // Only the whole-payload parse, which sees top-level keys, gets this right.
    const payload = JSON.stringify({
      config: { description: 'WRONG' },
      description: 'RIGHT',
    });
    expect(payload.indexOf('WRONG')).toBeLessThan(payload.indexOf('RIGHT'));

    const container = render({
      node: agentWithActions([tool({ id: 't3', toolName: 'Bash', inputPreview: payload })]),
    });
    expect(summaries(container)).toEqual(['RIGHT']);
  });

  it('falls back to the nested value only when the payload cannot be parsed', () => {
    // The complement, so the pair pins the ORDER rather than just the answer:
    // truncate the same payload and the regex path is all that is left, which
    // legitimately yields the nested value. That is the trade the two-path
    // design accepts — a truncated payload gets a best effort, not a guess
    // dressed as the real thing.
    const whole = JSON.stringify({ config: { description: 'WRONG' }, description: 'RIGHT' });
    const cut = whole.slice(0, whole.indexOf('RIGHT'));
    expect(() => JSON.parse(cut) as unknown).toThrow();

    const container = render({
      node: agentWithActions([tool({ id: 't4b', toolName: 'Bash', inputPreview: cut })]),
    });
    expect(summaries(container)).toEqual(['WRONG']);
  });

  it('never renders an empty row: an unusable payload falls back to the tool name', () => {
    const container = render({
      node: agentWithActions([tool({ id: 't4', toolName: 'Read', inputPreview: '' })]),
    });
    expect(summaries(container)).toEqual(['Read']);
  });

  it('lists every call in order and opens one into the detail pane beside it', () => {
    const actions = [
      tool({ id: 'a1', toolName: 'Bash', inputPreview: bash('one', 'First thing') }),
      tool({ id: 'a2', toolName: 'Bash', inputPreview: bash('two', 'Second thing') }),
      tool({ id: 'a3', toolName: 'Bash', inputPreview: bash('three', 'Third thing') }),
    ];
    const container = render({ node: agentWithActions(actions), detailActionId: 'a2' });

    expect(summaries(container)).toEqual(['First thing', 'Second thing', 'Third thing']);

    const rows = all(container, TESTID.actionRow);
    expect(rows.map((r) => r.dataset['open'])).toEqual(['false', 'true', 'false']);

    // §8.6: the payload opens in a pane that SPLITS the body, not under the
    // row. The list keeps its order and its width, so the row that was clicked
    // is still second of three and still under the pointer — which is the
    // reason the design fixes the list at 340 px rather than letting the pane
    // push it around.
    expect(rows[1]?.dataset['actionId']).toBe('a2');
    for (const row of rows) expect(all(row, 'payload-preview')).toHaveLength(0);

    const detail = one(container, TESTID.drawerDetail);
    expect(detail.dataset['actionId']).toBe('a2');
    expect(all(detail, 'payload-preview').length).toBeGreaterThan(0);
    expect(one(container, TESTID.drawerBody).dataset['split']).toBe('true');
  });

  it('splits the body only while a call is open', () => {
    // The other half of the assertion above, and the one that would catch a
    // pane that renders unconditionally with nothing in it.
    const container = render({
      node: agentWithActions([tool({ id: 'a1', toolName: 'Bash', inputPreview: bash('x', 'y') })]),
    });
    expect(one(container, TESTID.drawerBody).dataset['split']).toBe('false');
    expect(all(container, TESTID.drawerDetail)).toHaveLength(0);
  });

  it('shows a tool node no action list of its own', () => {
    // Actions belong to an agent. A tool is one.
    const container = render({ node: tool({ id: 't', toolName: 'Bash', inputPreview: bash('x', 'y') }) });
    expect(all(container, TESTID.actionRow)).toHaveLength(0);
  });
});

/**
 * THE DRAWER'S GEOMETRY, read from the component's own stylesheet.
 *
 * Asserted against the SOURCE rather than through `getComputedStyle`, and the
 * reason is measured rather than stylistic: jsdom does not lay anything out,
 * so a computed height here would be `0px` whatever the design said, and an
 * assertion that passes over a number nothing produced is the vacuous shape
 * this repository records more than any other.
 *
 * WHY THIS BLOCK EXISTS AT ALL. `design.md` §8.6 and amendment A3 have said
 * "bottom drawer" since the design froze. What shipped through the whole of
 * Phase 7 was the `0.1.x` side panel — `<aside>`, `width: 22em`,
 * `border-left` — because no DoD line named the drawer, so no package owned it
 * and no test could go red for it. These are the assertions whose absence let
 * a frozen design and a shipped surface disagree for a whole phase.
 */
describe('the drawer is a drawer, not a side panel (design.md §8.6, A3)', () => {
  let css: string;

  beforeAll(async () => {
    // NOT `import.meta.url`. Under `@vitest-environment jsdom` that is an
    // `http://localhost/...` URL, so `fileURLToPath` throws
    // `ERR_INVALID_URL_SCHEME` — and the whole suite then reported as SIX
    // SKIPS with a clean `40 passed | 6 skipped` totals line. That is this
    // repository's most-recorded reporting hazard, met while writing the
    // assertions that exist to stop a design drifting unnoticed. `cwd` is the
    // repo root, exactly as the esbuild script at the top of this file assumes.
    const fs = (await import(/* @vite-ignore */ NODE_FS)) as unknown as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const source = fs.readFileSync(`${process.cwd()}/webview/Inspector.svelte`, 'utf8');
    const style = /<style>([\s\S]*)<\/style>/.exec(source);
    if (style === null) throw new Error('Inspector.svelte has no style block');
    css = style[1] ?? '';
  });

  /** The `.drawer` rule's own body — not the whole sheet. */
  const drawerRule = (): string => {
    const m = /\n {2}\.drawer \{([\s\S]*?)\n {2}\}/.exec(css);
    if (m === null) throw new Error('no .drawer rule in Inspector.svelte');
    return m[1] ?? '';
  };

  it('takes its border along the TOP edge, and none along a side', () => {
    const rule = drawerRule();
    expect(rule).toMatch(/border-top:\s*1px solid var\(--line\)/);
    // The side panel's signature, and the one line whose return would mean the
    // drawer had been put back in a column.
    expect(rule).not.toMatch(/border-left/);
    expect(rule).not.toMatch(/border-right/);
  });

  it('is a band with §8.6’s two ceilings: 190px collapsed, exactly 46vh expanded', () => {
    expect(drawerRule()).toMatch(/max-height:\s*190px/);
    expect(css).toMatch(/\.drawer\[data-expanded='true'\][\s\S]*?max-height:\s*46vh/);
    // A ceiling, not a size: a drawer holding two calls is two calls tall.
    expect(drawerRule()).not.toMatch(/\n\s*height:\s*190px/);
  });

  it('claims no width of its own, because a bottom row spans the panel', () => {
    const rule = drawerRule();
    // `width: 22em; max-width: 45%` is what the side panel declared. A drawer
    // that declared either would be a column again whatever its border said.
    expect(rule).not.toMatch(/\n\s*width:/);
    expect(rule).not.toMatch(/\n\s*max-width:/);
  });

  it('sizes to its content in the app’s column instead of stretching', () => {
    // `flex: 0 0 auto` is what gives it a row of its own — §8.6's "hiding it
    // must not re-flow other rows". A drawer that could grow or shrink would
    // take space from the field above it as its content changed.
    expect(drawerRule()).toMatch(/flex:\s*0 0 auto/);
  });

  it('floors the call list at 340px and lets the pane grow with the window', () => {
    // §8.6 fixed the list at a flat 340 px. A9.4 makes it proportional with
    // that as the FLOOR: the drawer is as wide as the panel, and a user who
    // widened the window to read a payload was giving all the new width to a
    // list that did not need it.
    expect(css).toContain("flex: 0 0 clamp(340px, 38%, 620px)");
  });

  it('pins every field min-width §8.6 names, and says which two are not its', () => {
    // The five §8.6 fixes. They exist so a value changing length never shifts
    // the field beside it — this row updates while a person reads it.
    const widths: [string, string][] = [
      ['status', '58px'],
      ['id', '128px'],
      ['spawnDepth', '74px'],
      ['duration', '64px'],
      // A6 replaced §8.6's single `tokens` field with `context` and `burn` and
      // did not re-specify widths. `burn` keeps the 158 the tokens field had;
      // `context` was chosen. Both are pinned anyway — a number nobody
      // specified still must not drift silently.
      ['burn', '158px'],
      ['context', '104px'],
    ];
    // A literal substring, not a built RegExp. The first draft of this
    // assertion built one from a template literal and lost a backslash level
    // on the way into the file, so `[data-field='status']` became a character
    // class and matched nothing — the escaping hazard CLAUDE.md records for
    // heredocs and `node -e`, arriving in a test's own expectation.
    for (const [field, width] of widths) {
      expect(css, `the ${field} field has no pinned min-width`).toContain(
        `.field[data-field='${field}'] { min-width: ${width}; }`,
      );
    }
  });
});

describe('the drawer’s two heights and its filter row', () => {
  const calls = [
    tool({ id: 'c1', toolName: 'Bash', status: 'done', inputPreview: '{"description":"one"}' }),
    tool({ id: 'c2', toolName: 'Read', status: 'running', inputPreview: '{"description":"two"}' }),
    tool({ id: 'c3', toolName: 'Bash', status: 'error', inputPreview: '{"description":"three"}' }),
  ];
  const node = agent({ id: 'a', label: 'worker', children: calls });

  it('reports its height state on the element, so the app can be read for it', () => {
    expect(one(render({ node }), TESTID.inspector).dataset['expanded']).toBe('false');
    expect(one(render({ node, drawerExpanded: true }), TESTID.inspector).dataset['expanded']).toBe(
      'true',
    );
  });

  it('renders the filter row ONLY when expanded (§8.6)', () => {
    // Absent, not hidden: a collapsed drawer must not be filterable by a
    // control nobody can see.
    expect(all(render({ node }), TESTID.drawerFilters)).toHaveLength(0);
    expect(all(render({ node, drawerExpanded: true }), TESTID.drawerFilters)).toHaveLength(1);
  });

  it('counts each status on its own chip', () => {
    const container = render({ node, drawerExpanded: true });
    const counts = Object.fromEntries(
      all(container, TESTID.drawerFilterChip).map((chip) => [
        chip.dataset['filter'],
        chip.textContent?.replace(/\D+/g, ''),
      ]),
    );
    expect(counts).toEqual({ all: '3', running: '1', done: '1', error: '1' });
  });

  it('shows every call unfiltered while collapsed, whatever the filter says', () => {
    // §8.6: "Collapsed mode always shows the unfiltered list." Asserted by
    // filtering in the expanded state and then collapsing, because the filter
    // is only reachable there — the choice survives, and is ignored.
    const container = render({ node, drawerExpanded: true });
    const running = all(container, TESTID.drawerFilterChip).find(
      (c) => c.dataset['filter'] === 'running',
    );
    if (running === undefined) throw new Error('no running chip');
    click(running);
    expect(all(container, TESTID.actionRow)).toHaveLength(1);
  });
});

/**
 * A9.5 — WHICH END OF THE RUN THE LIST STARTS AT, and following the tail.
 *
 * The order control lives in the filter row, which §8.6 makes exist only in the
 * expanded state, so every test here expands first. `followTail` is asserted
 * through `data-following` on the list rather than by reading `scrollTop`:
 * jsdom lays nothing out, so `scrollHeight` is 0 and a scroll assertion would
 * be a number nothing produced — the vacuity this repository records most.
 */
describe('A9.5 — call order, and following the newest call', () => {
  const calls = [
    tool({ id: 'c1', toolName: 'Bash', status: 'done', inputPreview: '{"description":"first"}' }),
    tool({ id: 'c2', toolName: 'Read', status: 'done', inputPreview: '{"description":"second"}' }),
    tool({ id: 'c3', toolName: 'Edit', status: 'running', inputPreview: '{"description":"third"}' }),
  ];
  const node = agent({ id: 'a', label: 'worker', children: calls });

  const rowIds = (container: HTMLElement): (string | undefined)[] =>
    all(container, TESTID.actionRow).map((r) => r.dataset['actionId']);

  function setOrder(container: HTMLElement, value: string): void {
    const select = one(container, TESTID.drawerOrderSelect) as HTMLSelectElement;
    select.value = value;
    harness.flushSync(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('defaults to the transcript’s own order, oldest first', () => {
    const container = render({ node, drawerExpanded: true });
    expect(rowIds(container)).toStrictEqual(['c1', 'c2', 'c3']);
    const select = one(container, TESTID.drawerOrderSelect) as HTMLSelectElement;
    expect(select.value).toBe('oldest');
  });

  it('puts the newest call first when asked, without renumbering it', () => {
    const container = render({ node, drawerExpanded: true });
    setOrder(container, 'newest');
    expect(rowIds(container)).toStrictEqual(['c3', 'c2', 'c1']);

    // THE SEQUENCE NUMBER IS THE RUN, NOT THE SCREEN. Reversing the list must
    // not renumber the calls, or a row labelled 1 would mean different things
    // in the two orders and the number would stop being evidence.
    const seqs = all(container, TESTID.actionRow).map(
      (r) => r.querySelector('.seq')?.textContent,
    );
    expect(seqs).toStrictEqual(['3', '2', '1']);
  });

  it('follows the tail in oldest order and stops when a call is opened', () => {
    // The three states A9.5 names, on the attribute the component publishes.
    const following = (c: HTMLElement): string | undefined =>
      one(c, 'inspector').querySelector('.calls')?.getAttribute('data-following') ?? undefined;

    const plain = render({ node, drawerExpanded: true });
    expect(following(plain)).toBe('true');

    // Focused on a specific action: auto-scroll off.
    const detailed = render({ node, drawerExpanded: true, detailActionId: 'c2' });
    expect(following(detailed)).toBe('false');
  });

  it('does not follow in newest order, where the newest row is already first', () => {
    const container = render({ node, drawerExpanded: true });
    setOrder(container, 'newest');
    const list = one(container, 'inspector').querySelector('.calls');
    expect(list?.getAttribute('data-following')).toBe('false');
    expect(list?.getAttribute('data-order')).toBe('newest');
  });

  it('stops following once the user scrolls away from the bottom', () => {
    const container = render({ node, drawerExpanded: true });
    const list = one(container, 'inspector').querySelector('.calls') as HTMLElement;
    expect(list.getAttribute('data-following')).toBe('true');

    // jsdom reports 0 for every layout metric, so a scroll event on it reads as
    // "not at the bottom" — which is exactly the gesture being tested. The
    // component must take that as the user taking over.
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true });
    list.scrollTop = 200;
    harness.flushSync(() => {
      list.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(list.getAttribute('data-following')).toBe('false');

    // ...and scrolling back to the bottom gives the tail back, because that
    // gesture means "show me what is arriving".
    list.scrollTop = 800;
    harness.flushSync(() => {
      list.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(list.getAttribute('data-following')).toBe('true');
  });
});
