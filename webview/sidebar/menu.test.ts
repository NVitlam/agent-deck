// @vitest-environment jsdom
//
// The activity-bar sidebar's menu — v0.7.0 Phase 4, DoD 4.6b, the webview
// half: "clicking an entry executes the command (harness)". This half proves
// a click posts exactly one `runCommand` naming the entry's command; the host
// half (`src/sidebar/provider.test.ts`, `src/extension.test.ts`) proves that
// message runs the registered command.
//
// Mounts the REAL bundle through `testkit.ts` — the SAME bundle the panel
// loads, which is the "same single bundle" rule (spec §G2) made literal:
// `startSidebar` is an export of `webview/main.ts`, not a second entry point.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WebviewToHostMessage } from '../../src/model/events.js';
import { SIDEBAR_MENU } from '../../src/sidebar/menu.js';
import type { WebviewHarness } from '../testkit.js';
import { all, loadHarness, one } from '../testkit.js';
import { TESTID } from '../canvas-contract.js';

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
}, 60_000);

interface Mounted {
  container: HTMLElement;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Mounted[] = [];

function render(): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.startSidebar(container, { postMessage: (m) => sent.push(m) });
  const record: Mounted = {
    container,
    sent,
    dispose: () => {
      started.dispose();
      container.remove();
    },
  };
  mounted.push(record);
  return record;
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

describe('the sidebar menu', () => {
  it('renders every entry of src/sidebar/menu.ts, in order, with its label', () => {
    const { container } = render();
    one(container, TESTID.sidebarMenu);
    const entries = all(container, TESTID.sidebarEntry);
    expect(entries.map((e) => e.dataset['command'])).toStrictEqual(SIDEBAR_MENU.map((e) => e.command));
    expect(entries.map((e) => e.textContent?.trim())).toStrictEqual(SIDEBAR_MENU.map((e) => e.label));
    // The locked order, spelled out so a re-sort of the data goes red here too.
    expect(entries.map((e) => e.textContent?.trim())).toStrictEqual([
      'Open Deck',
      'Open Statistics',
      'Show Diagnostics',
      'Settings',
      'Clear Stats History',
    ]);
  });

  it('a click posts exactly one runCommand naming that entry, and nothing else', () => {
    const { container, sent } = render();
    for (const entry of all(container, TESTID.sidebarEntry)) {
      sent.length = 0;
      click(entry);
      expect(sent).toStrictEqual([{ type: 'runCommand', command: entry.dataset['command'] }]);
    }
  });

  it('every entry is a real button (Enter and Space activate it), and none carries an id as its text', () => {
    const { container } = render();
    for (const entry of all(container, TESTID.sidebarEntry)) {
      expect(entry.tagName).toBe('BUTTON');
      expect(entry.textContent).not.toContain('agentDeck.');
    }
  });

  it('posts nothing on mount: the menu is buttons, not a subscriber', () => {
    const { sent } = render();
    expect(sent).toStrictEqual([]);
  });
});
