// @vitest-environment jsdom
//
// DoD 4.9d — "waiting on you" for the DOCUMENTED interactive tools.
//
// Same derivation, different label: the status is still `stalled`, the chip
// is still amber, the elapsed time still shows, the agent's badge still
// counts it. Only the WORD changes, and only for a tool on the named list —
// `format.ts:INTERACTIVE_TOOL_NAMES` — never by a heuristic over the name.
// `src/model/stall.ts` is untouched, which the source assertion at the end
// pins.
//
// Mounts the REAL bundle through `testkit.ts`, in the list view where the
// status chip is rendered, over a `stalled` node the host would have derived.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState, WebviewToHostMessage } from '../src/model/events.js';
import type { WebviewHarness } from './testkit.js';
import { all, loadHarness } from './testkit.js';
import {
  INTERACTIVE_TOOL_NAMES,
  WAITING_ON_YOU_LABEL,
  isInteractiveTool,
  statusLabel,
} from './format.js';
import { liveSession, tool } from './testdata.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

interface Mounted {
  container: HTMLElement;
  dispose: () => void;
}

const mounted: Mounted[] = [];

function renderList(state: SessionState): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });
  harness.flushSync(() => {
    started.store.setViewMode('list');
  });
  harness.flushSync(() => {
    globalThis.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', sessions: [state] } }));
  });
  mounted.push({
    container,
    dispose: () => {
      started.dispose();
      container.remove();
    },
  });
  return container;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

/** A session whose root holds one stalled call of `toolName`, and one stalled Bash beside it. */
function stalledSession(toolName: string): SessionState {
  const state = liveSession();
  state.root.children = [
    tool({ id: 'ask', toolName, status: 'stalled', stalledSinceMs: 1_000, inputPreview: '{"question":"?"}' }),
    tool({ id: 'sh', toolName: 'Bash', status: 'stalled', stalledSinceMs: 1_000, inputPreview: '{"command":"x"}' }),
  ];
  return state;
}

describe('the list is data, and it is short', () => {
  it('names the two documented interactive tools and nothing else', () => {
    expect([...INTERACTIVE_TOOL_NAMES].sort()).toStrictEqual(['AskUserQuestion', 'ExitPlanMode']);
    expect(WAITING_ON_YOU_LABEL).toBe('waiting on you');
  });

  it('matches by exact name only — never a heuristic over the name (G3)', () => {
    expect(isInteractiveTool('AskUserQuestion')).toBe(true);
    expect(isInteractiveTool('askuserquestion')).toBe(false);
    expect(isInteractiveTool('AskUserQuestions')).toBe(false);
    expect(isInteractiveTool('mcp__ask_user')).toBe(false);
    expect(isInteractiveTool('Bash')).toBe(false);
  });

  it('statusLabel relabels ONLY the stalled state, and only for a listed tool', () => {
    expect(statusLabel('stalled', 'AskUserQuestion')).toBe(WAITING_ON_YOU_LABEL);
    expect(statusLabel('stalled', 'ExitPlanMode')).toBe(WAITING_ON_YOU_LABEL);
    expect(statusLabel('stalled', 'Bash')).toBe('stalled');
    expect(statusLabel('stalled')).toBe('stalled');
    // The other three states never read "waiting on you", listed tool or not.
    expect(statusLabel('running', 'AskUserQuestion')).toBe('running');
    expect(statusLabel('done', 'AskUserQuestion')).toBe('done');
    expect(statusLabel('error', 'AskUserQuestion')).toBe('error');
  });
});

describe('the rendered chip', () => {
  it.each(INTERACTIVE_TOOL_NAMES)('%s: same status, amber chip, elapsed time — the word is "waiting on you"', (name) => {
    const container = renderList(stalledSession(name));
    const chips = all(container, 'status-chip').filter((c) => c.dataset['status'] === 'stalled');
    expect(chips).toHaveLength(2);
    const [ask, bash] = chips;
    expect(ask?.dataset['label']).toBe(WAITING_ON_YOU_LABEL);
    expect(ask?.textContent).toContain(WAITING_ON_YOU_LABEL);
    expect(ask?.classList.contains('chip-stalled')).toBe(true);
    expect(all(ask as HTMLElement, 'stalled-for')).toHaveLength(1);
    // The undocumented tool beside it keeps the word.
    expect(bash?.dataset['label']).toBe('stalled');
    expect(bash?.textContent).toContain('stalled');
    expect(bash?.textContent).not.toContain(WAITING_ON_YOU_LABEL);
    // The agent's badge counts BOTH: the state is unchanged, only the word moved.
    expect(all(container, 'stalled-badge')[0]?.textContent).toBe('2 stalled');
  });
});

describe('the stall rule is untouched', () => {
  it('src/model/stall.ts knows nothing of tool names or of the label', () => {
    const source = readFileSync(resolve('src/model/stall.ts'), 'utf8');
    expect(source).not.toContain('waiting on you');
    expect(source).not.toContain('AskUserQuestion');
    expect(source).not.toContain('INTERACTIVE');
  });
});
