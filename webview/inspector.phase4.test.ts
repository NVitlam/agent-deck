// @vitest-environment jsdom
//
// The drawer's two Phase 4 items, on the real component through the same
// in-memory esbuild bundle `inspector.test.ts` builds:
//
//   DoD 4.9b — follow the latest call; an expanded entry PINS the drawer (no
//              auto-scroll, no re-render of the pinned entry); closing it
//              resumes.
//   DoD 4.9c — the "+N characters, click to expand" affordance did nothing.
//              Reproduced RED against the shipped `<span>` (the first test's
//              header records the pre-fix measurement), fixed, and pinned:
//              click → the full payload; click again → collapsed.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TESTID } from './canvas-contract.js';
import { COLLAPSED_PREVIEW_CHARS } from './format.js';
import { all, one, spawnBundle } from './testkit.js';
import { agent, longPreview, tool } from './testdata.js';


const GLOBAL_NAME = 'AgentDeckInspectorHarness4';

const ENTRY = [
  "export { default as Inspector } from './Inspector.svelte';",
  "export { default as InspectorRig } from './rigs/InspectorRig.svelte';",
  "export { mount, unmount, flushSync } from 'svelte';",
].join('\n');

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
  // 'error', not 'silent': a child that says nothing turns a lost spawn into a
  // failed suite with no reason. See spawnBundle in webview/testkit.ts -- and
  // no backticks in here: this comment lives inside a template literal.
  logLevel: 'error',
});
const js = result.outputFiles[0];
if (js === undefined) { process.stderr.write('no output\\n'); process.exit(1); }
process.stdout.write(js.text);
`;

interface InspectorHarness {
  Inspector: unknown;
  InspectorRig: unknown;
  mount(
    component: unknown,
    options: { target: HTMLElement; props?: Record<string, unknown> },
  ): unknown;
  unmount(app: unknown): void;
  flushSync(fn?: () => void): void;
}

let harness: InspectorHarness;

beforeAll(async () => {
  const code = await spawnBundle(
    ['--input-type=module', '-e', BUILD_SCRIPT],
    'the Phase 4 inspector harness bundle',
  );
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

/* ------------------------------------------------------------------------ *
 * DoD 4.9c — the expand affordance
 * ------------------------------------------------------------------------ */

describe('DoD 4.9c — "+N characters, click to expand" on a drawer entry', () => {
  const text = longPreview(2000);
  const calls = [
    tool({ id: 'c1', toolName: 'Bash', status: 'done', inputPreview: '{"description":"first"}', resultPreview: text }),
    tool({ id: 'c2', toolName: 'Read', status: 'done', inputPreview: '{"description":"second"}' }),
  ];
  const node = agent({ id: 'a', label: 'worker', children: calls });

  function outputPreview(container: HTMLElement): HTMLElement {
    const found = all(container, 'payload-preview').find((p) => p.dataset['label'] === 'output');
    if (found === undefined) throw new Error('no output preview in the detail pane');
    return found;
  }

  it('the marker on a detail pane is a CONTROL, and clicking it renders the whole payload', () => {
    /*
     * MEASURED RED BEFORE THE FIX. With `PayloadPreview.svelte`'s marker a
     * `<span>`, this test's first two expectations held (the marker existed,
     * with its exact text) and the third failed: after the click the body was
     * still 512 characters and `data-truncated` still "true", because nothing
     * in the drawer's detail pane — which passes `expanded={false}` and offers
     * no toggle — handled the click. That is the defect the user reported.
     */
    const container = render({ node, drawerExpanded: true, detailActionId: 'c1' });
    const preview = outputPreview(container);
    const marker = one(preview, 'preview-marker');
    expect(marker.tagName).toBe('BUTTON');
    expect(marker.textContent).toBe('[+1488 more characters - expand to see all]');
    expect(one(preview, 'preview-body').textContent).toHaveLength(COLLAPSED_PREVIEW_CHARS);

    click(marker);
    const body = one(preview, 'preview-body');
    expect(body.textContent).toBe(text);
    expect(body.textContent).toHaveLength(2000);
    expect(body.dataset['truncated']).toBe('false');
    expect(all(preview, 'preview-marker')).toHaveLength(0);
    expect(preview.dataset['open']).toBe('true');
  });

  it('bounded by what the host sent: the expanded text is the capped payload, marker and all', () => {
    const capped = longPreview(8192) + '\n...[agent-deck: truncated, showing 8192 of 63774 bytes]';
    const big = agent({
      id: 'b',
      label: 'w',
      children: [tool({ id: 'c9', toolName: 'Read', inputPreview: 'in', resultPreview: capped })],
    });
    const container = render({ node: big, drawerExpanded: true, detailActionId: 'c9' });
    click(one(outputPreview(container), 'preview-marker'));
    // The host's own cap is the only bound: 8,192 kept plus its 56-byte marker.
    expect(one(outputPreview(container), 'preview-body').textContent).toHaveLength(8248);
    expect(one(outputPreview(container), 'preview-body').textContent?.endsWith('63774 bytes]')).toBe(true);
  });

  it('click again → collapsed, with the same marker back', () => {
    const container = render({ node, drawerExpanded: true, detailActionId: 'c1' });
    click(one(outputPreview(container), 'preview-marker'));
    const collapse = one(outputPreview(container), 'preview-collapse');
    expect(collapse.tagName).toBe('BUTTON');
    click(collapse);
    const preview = outputPreview(container);
    expect(one(preview, 'preview-body').textContent).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(one(preview, 'preview-body').dataset['truncated']).toBe('true');
    expect(one(preview, 'preview-marker').textContent).toBe('[+1488 more characters - expand to see all]');
    expect(preview.dataset['open']).toBe('false');
  });

  it('a short payload has no marker to click, and nothing invents one', () => {
    const container = render({ node, drawerExpanded: true, detailActionId: 'c2' });
    const input = all(container, 'payload-preview').find((p) => p.dataset['label'] === 'input');
    expect(input).toBeDefined();
    expect(all(input as HTMLElement, 'preview-marker')).toHaveLength(0);
    expect(all(input as HTMLElement, 'preview-collapse')).toHaveLength(0);
  });

  it('a parent that expands everything still expands everything (the tool-node solo pane)', () => {
    const container = render({ node: calls[0], expanded: true });
    const preview = outputPreview(container);
    expect(one(preview, 'preview-body').textContent).toBe(text);
    expect(all(preview, 'preview-marker')).toHaveLength(0);
    // No local collapse control either: the parent owns this state.
    expect(all(preview, 'preview-collapse')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ *
 * DoD 4.9b — pin while expanded, resume on close
 * ------------------------------------------------------------------------ */

describe('DoD 4.9b — the drawer follows the latest call, pins while an entry is expanded, resumes on close', () => {
  const calls = [
    tool({ id: 'c1', toolName: 'Bash', status: 'done', inputPreview: '{"description":"first"}' }),
    tool({ id: 'c2', toolName: 'Read', status: 'done', inputPreview: '{"description":"second"}' }),
    tool({ id: 'c3', toolName: 'Edit', status: 'running', inputPreview: '{"description":"third"}' }),
  ];
  const node = agent({ id: 'a', label: 'worker', children: calls });

  const list = (c: HTMLElement): HTMLElement => {
    const el = one(c, TESTID.inspector).querySelector('.calls');
    if (el === null) throw new Error('no call list');
    return el as HTMLElement;
  };

  it('follows by default, in BOTH orders — the newest call is followed wherever the list grows', () => {
    const container = render({ node, drawerExpanded: true });
    expect(list(container).getAttribute('data-following')).toBe('true');
    expect(list(container).getAttribute('data-pinned')).toBe('false');

    const select = one(container, TESTID.drawerOrderSelect) as HTMLSelectElement;
    select.value = 'newest';
    harness.flushSync(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(list(container).getAttribute('data-order')).toBe('newest');
    expect(list(container).getAttribute('data-following')).toBe('true');
  });

  /** Mount through the rig, so props can change after mounting. */
  function rig(initial: Record<string, unknown>): { container: HTMLElement; update: (next: Record<string, unknown>) => void } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = harness.mount(harness.InspectorRig, { target: container, props: { initial } }) as {
      update: (next: Record<string, unknown>) => void;
    };
    harness.flushSync();
    mounted.push({
      container,
      dispose: () => {
        harness.unmount(app);
        container.remove();
      },
    });
    return {
      container,
      update: (next) => {
        harness.flushSync(() => {
          app.update(next);
        });
      },
    };
  }

  it('an expanded entry PINS: no following, and the pinned entry is NOT re-rendered when a call arrives', () => {
    const { container, update } = rig({ node, drawerExpanded: true, detailActionId: 'c2' });
    expect(list(container).getAttribute('data-pinned')).toBe('true');
    expect(list(container).getAttribute('data-following')).toBe('false');

    const detailBefore = one(container, TESTID.drawerDetail);
    const rowBefore = all(container, TESTID.actionRow).find((r) => r.dataset['actionId'] === 'c2');
    expect(detailBefore.dataset['actionId']).toBe('c2');

    // A fourth call arrives: the component is re-rendered with a longer list,
    // the way a store update re-renders it.
    const grown = agent({
      id: 'a',
      label: 'worker',
      children: [...calls, tool({ id: 'c4', toolName: 'Grep', status: 'running', inputPreview: '{"description":"fourth"}' })],
    });
    update({ node: grown });
    expect(all(container, TESTID.actionRow)).toHaveLength(4);
    // The pinned entry — its row and its detail pane — is the SAME element:
    // not torn down and rebuilt, which is what "no re-render of the pinned
    // entry" means on a DOM.
    expect(one(container, TESTID.drawerDetail)).toBe(detailBefore);
    expect(all(container, TESTID.actionRow).find((r) => r.dataset['actionId'] === 'c2')).toBe(rowBefore);
    expect(list(container).getAttribute('data-pinned')).toBe('true');
    expect(list(container).getAttribute('data-following')).toBe('false');
  });

  it('closing the expanded entry resumes following', () => {
    const { container, update } = rig({ node, drawerExpanded: true, detailActionId: 'c2' });
    expect(list(container).getAttribute('data-following')).toBe('false');
    update({ detailActionId: undefined });
    expect(list(container).getAttribute('data-pinned')).toBe('false');
    expect(list(container).getAttribute('data-following')).toBe('true');
  });

  it('a user scroll away from the growing end stops following, and returning restarts it — in newest order too', () => {
    const container = render({ node, drawerExpanded: true });
    const select = one(container, TESTID.drawerOrderSelect) as HTMLSelectElement;
    select.value = 'newest';
    harness.flushSync(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const el = list(container);
    Object.defineProperty(el, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
    // In newest order the growing end is the TOP: scrolling down is leaving it.
    el.scrollTop = 300;
    harness.flushSync(() => {
      el.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(el.getAttribute('data-following')).toBe('false');
    el.scrollTop = 0;
    harness.flushSync(() => {
      el.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(el.getAttribute('data-following')).toBe('true');
  });
});
