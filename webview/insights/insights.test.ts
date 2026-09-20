// @vitest-environment jsdom
/**
 * v0.9.0 DoD 9.6 — the Insights tab.
 *
 * Through the MOUNTED app, from the shipped bundle, with the records arriving
 * as the `statsStore` message the host really sends. The recorded D4 lesson is
 * that a prop with one production assignment site is untested until something
 * drives it the way production does — and this surface has three such props
 * (the records, the installed flag, the rotation counter).
 *
 * ## What is a golden here, and what is not
 *
 * The COUNTS and the ROTATION are goldens: exact text, exact order, taken from
 * records this file derives rather than from numbers it made up. The CSS is
 * not — jsdom computes no layout, so nothing here claims anything about how it
 * looks.
 *
 * ## The privacy leg
 *
 * The three examples SHIP IN THE BUNDLE. Their paths and ids are synthetic, and
 * "synthetic" is CHECKED rather than asserted, two ways: by SHAPE (no absolute
 * path, no `toolu_` id, no uuid) and by SEARCHING every committed corpus for
 * each example string.
 *
 * The sweep reaches the same strings at their SOURCE — `webview/insights/
 * layout.ts` is tracked — and not in `dist/`, which is gitignored and which
 * the sweep deliberately does not walk. An earlier version of this paragraph
 * claimed the latter; a verifier round measured the sweep and found it
 * unchanged in this release.
 *
 * The advice scan drives the MOUNTED component and reads rendered
 * `textContent` across five states, so a shipped string that never renders is
 * not scanned by it. `forbidden-words.mjs`, which reads this directory as of
 * v0.9.0, is what covers those.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { StatsRecord } from '../../src/stats/schema.js';
import { STATS_SCHEMA_VERSION } from '../../src/stats/schema.js';
import type { WebviewToHostMessage } from '../../src/model/events.js';
import { TESTID } from '../canvas-contract.js';
import type { Store } from '../store.js';
import { INSIGHTS_COMMAND } from '../store.js';
import type { WebviewHarness } from '../testkit.js';
import { all, loadHarness, one, press } from '../testkit.js';
import {
  ALL_ZERO_LINE,
  EXAMPLES,
  EXAMPLE_LABEL,
  IDLE_RESUME_MS,
  PRODUCT_SENTENCE,
  exampleAt,
  insightsLayout,
} from './layout.js';

let harness: WebviewHarness;
beforeAll(async () => {
  harness = await loadHarness();
}, 120_000);

interface Panel {
  container: HTMLElement;
  store: Store;
  sent: WebviewToHostMessage[];
  dispose: () => void;
}

const mounted: Panel[] = [];

function render(): Panel {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sent: WebviewToHostMessage[] = [];
  const started = harness.start(container, { postMessage: (m) => sent.push(m) });
  const panel: Panel = {
    container,
    store: started.store,
    sent,
    dispose: () => {
      started.dispose();
      container.remove();
    },
  };
  mounted.push(panel);
  return panel;
}

function send(message: unknown): void {
  harness.flushSync(() => {
    globalThis.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

function click(element: Element): void {
  harness.flushSync(() => {
    press(element);
  });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** A record with nothing in it. Every count starts at zero. */
function record(sessionId: string, over: Partial<StatsRecord> = {}): StatsRecord {
  return {
    statsSchemaVersion: STATS_SCHEMA_VERSION,
    sessionId,
    engine: 'cc',
    projectSlug: 'c--ws-example',
    startedAt: 1_000,
    coverage: 'full',
    agents: [],
    files: [],
    tools: [],
    loops: [],
    churn: [],
    contextChurn: [],
    compactions: [],
    stalls: [],
    skills: [],
    timing: {},
    totals: { prompt: 0, output: 0, compactions: 0, subagents: 0, silentSubagents: 0, stalls: 0 },
    params: { loopMin: 3 },
    unavailable: [],
    ...over,
  };
}

/** Records that produce 2 compactions, 1 idle resume, 1 re-read loop, 3 errors. */
function busyRecords(): StatsRecord[] {
  return [
    record('s1', {
      totals: { prompt: 0, output: 0, compactions: 2, subagents: 0, silentSubagents: 0, stalls: 0 },
      timing: { longestGapMs: IDLE_RESUME_MS + 1 },
      loops: [{ agentId: 'a', toolName: 'Read', class: 'read', count: 3, ordinals: [0, 1, 2] }],
      tools: [{ toolName: 'Read', class: 'read', calls: 9, errors: 3 }],
    }),
    record('s2'),
  ];
}

function open(panel: Panel, records: StatsRecord[], installed = false): void {
  send({ type: 'settings', canvasAutoFit: true, tweaks: {}, insightsInstalled: installed });
  send({ type: 'statsStore', records, enabled: true });
  click(one(panel.container, TESTID.insightsToggle));
}

const countsOf = (panel: Panel): string[] =>
  all(panel.container, TESTID.insightsCount).map(
    (el) => `${el.dataset['id'] ?? ''}=${el.dataset['count'] ?? ''}`,
  );

// ---------------------------------------------------------------------------
// The layout, pure
// ---------------------------------------------------------------------------

describe('the counts are over this user’s own records', () => {
  it('counts each of the four from its own field', () => {
    const layout = insightsLayout(busyRecords());
    expect(layout.all.map((c) => `${c.id}=${String(c.count)}`)).toStrictEqual([
      'compactions=2',
      'idleResumes=1',
      'rereadLoops=1',
      'failedCalls=3',
    ]);
    expect(layout.sessions).toBe(2);
    expect(layout.allZero).toBe(false);
  });

  it('hides a zero and keeps the declared order', () => {
    const layout = insightsLayout([
      record('s1', {
        totals: { prompt: 0, output: 0, compactions: 4, subagents: 0, silentSubagents: 0, stalls: 0 },
        tools: [{ toolName: 'Read', class: 'read', calls: 1, errors: 1 }],
      }),
    ]);
    expect(layout.shown.map((c) => c.id)).toStrictEqual(['compactions', 'failedCalls']);
    expect(layout.all).toHaveLength(4);
  });

  it('a gap BELOW the threshold is not an idle resume; at the threshold it is', () => {
    // Both sides of the bound, so a comparison written the wrong way round is
    // visible rather than plausible.
    const below = insightsLayout([record('s', { timing: { longestGapMs: IDLE_RESUME_MS - 1 } })]);
    const at = insightsLayout([record('s', { timing: { longestGapMs: IDLE_RESUME_MS } })]);
    expect(below.all.find((c) => c.id === 'idleResumes')?.count).toBe(0);
    expect(at.all.find((c) => c.id === 'idleResumes')?.count).toBe(1);
  });

  it('skips an excluded record rather than counting its empty tables as zeroes', () => {
    const layout = insightsLayout([
      record('good', {
        totals: { prompt: 0, output: 0, compactions: 5, subagents: 0, silentSubagents: 0, stalls: 0 },
      }),
      record('bad', { coverage: 'excluded:parked' }),
    ]);
    expect(layout.sessions).toBe(1);
    expect(layout.all.find((c) => c.id === 'compactions')?.count).toBe(5);
  });

  it('a tool stating no errors adds nothing — absent is not zero', () => {
    // Codex's row. A 0 here would be an artefact of the grafter's rule.
    const layout = insightsLayout([
      record('s', { tools: [{ toolName: 'exec', class: 'shell', calls: 4 }] }),
    ]);
    expect(layout.all.find((c) => c.id === 'failedCalls')?.count).toBe(0);
  });

  it('only a READ loop is a re-read loop', () => {
    const layout = insightsLayout([
      record('s', {
        loops: [
          { agentId: 'a', toolName: 'Read', class: 'read', count: 3, ordinals: [0, 1, 2] },
          { agentId: 'a', toolName: 'Bash', class: 'shell', count: 3, ordinals: [3, 4, 5] },
        ],
      }),
    ]);
    expect(layout.all.find((c) => c.id === 'rereadLoops')?.count).toBe(1);
  });

  it('the command literal matches the host’s, so the two cannot part', () => {
    // `webview/store.ts` writes the id rather than importing it from
    // `src/extension.ts` — the webview reaches no host module. This is the
    // check that keeps the two literals equal: two agreeing literals is not
    // a contract unless something compares them.
    const host = readFileSync(resolve('src/extension.ts'), 'utf8');
    expect(host).toContain(`export const INSIGHTS_COMMAND = '${INSIGHTS_COMMAND}';`);
  });


  it('the idle threshold is the shipped livenessThresholdMs default', () => {
    // BOUND to the manifest, not written down twice.
    const manifest = JSON.parse(
      readFileSync(resolve('package.json'), 'utf8'),
    ) as { contributes?: { configuration?: { properties?: Record<string, { default?: number }> } } };
    const shipped = manifest.contributes?.configuration?.properties?.['agentDeck.livenessThresholdMs']
      ?.default;
    expect(shipped).toBe(IDLE_RESUME_MS);
  });
});

// ---------------------------------------------------------------------------
// The rotation
// ---------------------------------------------------------------------------

describe('the example rotation', () => {
  it('is 1 -> 2 -> 3 -> 1, by the open count', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => exampleAt(n).id)).toStrictEqual([
      'compaction',
      'cache-miss',
      'reread-loop',
      'compaction',
      'cache-miss',
      'reread-loop',
      'compaction',
    ]);
  });

  it('answers with the first example for a counter that cannot arise', () => {
    // A defined answer rather than a throw: an illustration is not worth a
    // crashed panel.
    expect(exampleAt(-1).id).toBe('compaction');
    expect(exampleAt(1.5).id).toBe('compaction');
  });

  it('there are exactly three, and the DoD names all three', () => {
    expect(EXAMPLES.map((e) => e.id)).toStrictEqual(['compaction', 'cache-miss', 'reread-loop']);
  });
});

// ---------------------------------------------------------------------------
// Through the mounted panel
// ---------------------------------------------------------------------------

describe('the Insights tab, through the mounted app', () => {
  it('shows only the non-zero counts, in order — a DOM golden', () => {
    const panel = render();
    open(panel, busyRecords());
    expect(countsOf(panel)).toStrictEqual([
      'compactions=2',
      'idleResumes=1',
      'rereadLoops=1',
      'failedCalls=3',
    ]);
    expect(all(panel.container, TESTID.insightsAllZero)).toHaveLength(0);
  });

  it('hides the zero ones — a DOM golden', () => {
    const panel = render();
    open(panel, [
      record('s1', {
        totals: { prompt: 0, output: 0, compactions: 7, subagents: 0, silentSubagents: 0, stalls: 0 },
      }),
    ]);
    expect(countsOf(panel)).toStrictEqual(['compactions=7']);
  });

  it('all zero is ONE plain fact line and no counts line', () => {
    const panel = render();
    open(panel, [record('s1'), record('s2')]);
    expect(all(panel.container, TESTID.insightsCounts)).toHaveLength(0);
    const line = one(panel.container, TESTID.insightsAllZero);
    expect(line.textContent?.trim()).toBe(ALL_ZERO_LINE);
  });

  it('no records at all is the same plain fact line', () => {
    const panel = render();
    open(panel, []);
    expect(one(panel.container, TESTID.insightsAllZero).textContent?.trim()).toBe(ALL_ZERO_LINE);
  });

  it('states the product sentence once', () => {
    const panel = render();
    open(panel, busyRecords());
    const sentences = all(panel.container, TESTID.insightsSentence);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.textContent?.trim()).toBe(PRODUCT_SENTENCE);
  });

  it('rotates the example on each OPEN — 1, 2, 3, 1 — a golden', () => {
    /*
     * THE SPEC’S OWN WORDS: "three static examples, ONE SHOWN PER OPEN,
     * rotating 1->2->3->1 by a webview-local counter".
     *
     * Until a verifier round caught it, the counter advanced only when the
     * "See an example" button was pressed, so opening the tab three times
     * showed example 1 three times — while the code's own identifiers
     * (`insightsOpenCount`, "the first open shows the first example")
     * asserted the behaviour that was missing. The press golden below was
     * green throughout, because it asserts a different sequence.
     */
    const panel = render();
    send({ type: 'settings', canvasAutoFit: true, tweaks: {}, insightsInstalled: false });
    send({ type: 'statsStore', records: busyRecords(), enabled: true });

    const shown = (): string =>
      one(panel.container, TESTID.insightsExample).dataset['example'] ?? '';

    const seen: string[] = [];
    for (let open = 0; open < 4; open += 1) {
      // In through the panel's own control, and out again — the real path.
      click(one(panel.container, TESTID.insightsToggle));
      seen.push(shown());
      click(one(panel.container, TESTID.insightsToggle));
    }
    expect(seen).toStrictEqual(['compaction', 'cache-miss', 'reread-loop', 'compaction']);
  });

  it('a session that never leaves the tab sees one example until it presses', () => {
    // The other side of the same rule: the counter advances on LEAVING, so
    // re-rendering inside one open does not move it. Without this, a counter
    // that advanced on every notify would pass the test above by accident.
    const panel = render();
    send({ type: 'settings', canvasAutoFit: true, tweaks: {}, insightsInstalled: false });
    send({ type: 'statsStore', records: busyRecords(), enabled: true });
    click(one(panel.container, TESTID.insightsToggle));

    const shown = (): string =>
      one(panel.container, TESTID.insightsExample).dataset['example'] ?? '';
    expect(shown()).toBe('compaction');

    // Two more store messages: re-renders, not opens.
    send({ type: 'statsStore', records: busyRecords(), enabled: true });
    send({ type: 'statsStore', records: busyRecords(), enabled: true });
    expect(shown()).toBe('compaction');
  });

  it('rotates the example on each press, and labels every one — a golden', () => {
    const panel = render();
    open(panel, busyRecords());
    const shown = (): string => one(panel.container, TESTID.insightsExample).dataset['example'] ?? '';
    const labelled = (): string =>
      one(panel.container, TESTID.insightsExampleLabel).textContent?.trim() ?? '';

    const seen: string[] = [shown()];
    expect(labelled()).toBe(EXAMPLE_LABEL);
    for (let i = 0; i < 3; i += 1) {
      click(one(panel.container, TESTID.insightsExampleButton));
      seen.push(shown());
      expect(labelled()).toBe(EXAMPLE_LABEL);
    }
    expect(seen).toStrictEqual(['compaction', 'cache-miss', 'reread-loop', 'compaction']);
  });

  it('NOT installed: the button offers to get it, and running it posts the command', () => {
    const panel = render();
    open(panel, busyRecords(), false);
    const button = one(panel.container, TESTID.insightsAction);
    expect(button.dataset['action']).toBe('get');
    expect(button.textContent?.trim()).toBe('Get Insights');

    click(button);
    expect(panel.sent).toContainEqual({ type: 'runCommand', command: 'agentDeck.insights' });
  });

  it('INSTALLED: the same one button opens it', () => {
    const panel = render();
    open(panel, busyRecords(), true);
    const buttons = all(panel.container, TESTID.insightsAction);
    // ONE button, not two — the DoD says "one button that runs its panel
    // command", and a second one beside it would be the upsell staying put.
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.dataset['action']).toBe('open');
    expect(buttons[0]?.textContent?.trim()).toBe('Open Insights');

    click(buttons[0] as Element);
    expect(panel.sent).toContainEqual({ type: 'runCommand', command: 'agentDeck.insights' });
  });

  it('defaults to NOT installed before any settings message arrives', () => {
    // The safe direction: offering to get it is recoverable, running a command
    // that does not exist is not.
    const panel = render();
    send({ type: 'statsStore', records: busyRecords(), enabled: true });
    click(one(panel.container, TESTID.insightsToggle));
    expect(one(panel.container, TESTID.insightsAction).dataset['action']).toBe('get');
  });

  it('the surface says which fields it counted', () => {
    const panel = render();
    open(panel, busyRecords());
    const params = one(panel.container, TESTID.insightsParams).textContent ?? '';
    for (const field of ['totals.compactions', 'timing.longestGapMs', 'loops[].class', 'tools[].errors']) {
      expect(params, `params line does not name ${field}`).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// No advice, and nothing real in the examples
// ---------------------------------------------------------------------------

describe('the tab states facts and never advises', () => {
  /** The text a user can actually read on this surface. */
  function surfaceText(): string {
    const panel = render();
    open(panel, busyRecords(), false);
    const shown = [one(panel.container, TESTID.insightsView).textContent ?? ''];
    for (let i = 0; i < EXAMPLES.length; i += 1) {
      click(one(panel.container, TESTID.insightsExampleButton));
      shown.push(one(panel.container, TESTID.insightsView).textContent ?? '');
    }
    const installed = render();
    open(installed, busyRecords(), true);
    shown.push(one(installed.container, TESTID.insightsView).textContent ?? '');
    const zero = render();
    open(zero, [], false);
    shown.push(one(zero.container, TESTID.insightsView).textContent ?? '');
    return shown.join('\n');
  }

  it('carries no advice vocabulary and no second person, in any state', () => {
    const text = surfaceText().toLowerCase();
    // The population, pinned non-empty first: a scan over an empty string
    // reports the same clean pass.
    expect(text.length).toBeGreaterThan(200);
    for (const banned of [
      'you should',
      'you can',
      'you may',
      'try ',
      'consider ',
      'recommend',
      'suggest',
      'ought',
      'need to',
      'must ',
      'better',
      'worse',
      'improve',
      'optimi',
      'fix ',
      'avoid ',
      'too many',
      'too much',
    ]) {
      expect(text.includes(banned), `the Insights tab says ${JSON.stringify(banned)}`).toBe(false);
    }
  });

  it('the scan can fail — a planted phrase is found', () => {
    const text = `${surfaceText()} you should consider this`.toLowerCase();
    expect(text.includes('you should')).toBe(true);
  });

  it('no example string appears anywhere in the committed corpora', () => {
    /*
     * The check the header claims, and until a verifier round did not run.
     *
     * If an example id or path appeared in a captured corpus it would BE a
     * real one, however synthetic it looks. This walks every file under
     * `fixtures/` and searches for each distinctive token.
     *
     * The tokens are the distinctive parts, not whole sentences: a sentence
     * would never match and the search would pass while reading nothing.
     */
    const TOKENS = [
      'ses_example01',
      'ses_example02',
      'a_example03',
      'repo/src/config.ts',
      'repo/docs/schema.md',
    ];
    // Every token really is in an example, or the search below is vacuous.
    const exampleBody = EXAMPLES.flatMap((e) => [e.title, ...e.lines]).join('\n');
    for (const token of TOKENS) {
      expect(exampleBody, `${token} is in no example`).toContain(token);
    }

    let filesRead = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        // Binary corpora (the OpenCode databases) are read as latin1, which
        // cannot throw and preserves byte positions for an ASCII needle.
        const text = readFileSync(full).toString('latin1');
        filesRead += 1;
        for (const token of TOKENS) {
          expect(text.includes(token), `${token} appears in ${full}`).toBe(false);
        }
      }
    };
    walk(resolve('fixtures'));
    // The population, pinned non-empty: a walk that found nothing would
    // report the same clean pass.
    expect(filesRead).toBeGreaterThan(50);
  }, 120_000);

  it('every example path and id is synthetic in SHAPE too', () => {
    // The other half: a string can be absent from every corpus and still be
    // shaped like a real path or a real id.
    const exampleText = EXAMPLES.flatMap((e) => [e.title, ...e.lines]).join('\n');

    // Nothing that looks like an absolute path on any platform.
    expect(exampleText).not.toMatch(/[A-Za-z]:\\/u);
    expect(exampleText).not.toMatch(/(?:^|\s)\/(?:home|Users|var|etc)\//u);
    // Nothing that looks like a real Claude Code tool-use id or a uuid.
    expect(exampleText).not.toMatch(/toolu_[A-Za-z0-9]{10,}/u);
    expect(exampleText).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u,
    );
    // The ids it DOES carry are the declared synthetic shapes.
    expect(exampleText).toContain('ses_example');
    expect(exampleText).toContain('a_example');
  });
});
