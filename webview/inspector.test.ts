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

  it('shows the id, the tool name, the status chip and the duration', () => {
    const container = render({ node });
    expect(one(container, TESTID.inspector).dataset['empty']).toBe('false');
    expect(one(container, 'inspector-id').textContent).toBe('tool-read');
    expect(one(container, 'inspector-title').textContent).toBe('Read');
    expect(one(container, 'inspector-kind').textContent).toBe('tool');
    expect(one(container, 'status-chip').dataset['status']).toBe('error');
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
    contextNow: { prompt: 12_345, output: 6_789 },
    burn: { prompt: 12_345, output: 6_789 },
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
    expect(one(container, 'inspector-tokens').textContent).toBe('12,345 in ctx / 6,789 out');
    expect(one(container, 'inspector-duration').textContent).toBe('1m 01s');
  });

  it('renders no payload preview and no expander for an agent', () => {
    const container = render({ node });
    expect(all(container, 'payload-preview')).toHaveLength(0);
    expect(all(container, 'inspector-expand')).toHaveLength(0);
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
    const found = all(container, 'payload-preview').find((p) => p.dataset['label'] === 'result');
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
    const found = all(container, 'payload-preview').find((p) => p.dataset['label'] === 'result');
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
    const found = all(container, 'payload-preview').find((p) => p.dataset['label'] === 'result');
    // 8248 - 512 = 7736, written out for the same reason as 1488 above.
    expect(one(found as HTMLElement, 'preview-marker').textContent).toBe(
      '[+7736 more characters - expand to see all]',
    );
  });
});

describe('accessibility floor (C7.8)', () => {
  it('exposes the panel as a labelled landmark', () => {
    const container = render({ node: tool({ id: 't', inputPreview: 'x' }) });
    const panel = one(container, TESTID.inspector);
    expect(panel.tagName).toBe('ASIDE');
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

  it('lists every action in order and expands one downward in place', () => {
    const actions = [
      tool({ id: 'a1', toolName: 'Bash', inputPreview: bash('one', 'First thing') }),
      tool({ id: 'a2', toolName: 'Bash', inputPreview: bash('two', 'Second thing') }),
      tool({ id: 'a3', toolName: 'Bash', inputPreview: bash('three', 'Third thing') }),
    ];
    const container = render({ node: agentWithActions(actions), toggled: ['a2'] });

    expect(summaries(container)).toEqual(['First thing', 'Second thing', 'Third thing']);

    const rows = all(container, TESTID.actionRow);
    expect(rows.map((r) => r.dataset['open'])).toEqual(['false', 'true', 'false']);

    // Expanding opens the payload UNDER its own row, so the list stays the
    // frame of reference: the open row still sits second of three.
    const open = rows[1];
    expect(open?.dataset['actionId']).toBe('a2');
    expect(all(open as HTMLElement, 'payload-preview').length).toBeGreaterThan(0);
    expect(all(rows[0] as HTMLElement, 'payload-preview')).toHaveLength(0);
  });

  it('shows a tool node no action list of its own', () => {
    // Actions belong to an agent. A tool is one.
    const container = render({ node: tool({ id: 't', toolName: 'Bash', inputPreview: bash('x', 'y') }) });
    expect(all(container, TESTID.actionRow)).toHaveLength(0);
  });
});
