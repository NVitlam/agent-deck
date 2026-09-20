/**
 * v0.9.0 DoD 9.6, as amended by DoD 9.14 — the Insights SECTION.
 *
 * ## What moved, and what this file is now
 *
 * The tab was a webview surface until spec `Amendment 2026-09-20 — Clean
 * windows`; it is a section of the native sidebar tree now. So the DOM half
 * of this file — mounting the shipped bundle, pressing the example button,
 * reading rendered `textContent` — has no surface to drive, and it moved to
 * `src/sidebar/tree.test.ts`, which drives the same facts through the same
 * layout module and the real provider.
 *
 * What is LEFT here is the pure half, unchanged in substance: the four counts,
 * each from its own field; the rotation; and the privacy legs.
 *
 * ## The privacy leg
 *
 * The three examples SHIP IN THE BUNDLE. Their paths and ids are synthetic,
 * and "synthetic" is CHECKED rather than asserted, two ways: by SHAPE (no
 * absolute path, no `toolu_` id, no uuid) and by SEARCHING every committed
 * corpus for each example string.
 *
 * The sweep reaches the same strings at their SOURCE — `src/insights/layout.ts`
 * is tracked — and not in `dist/`, which is gitignored and which the sweep
 * deliberately does not walk.
 *
 * ## The advice scan
 *
 * It reads the DATA a reader can see: the counts line, the product sentence,
 * the all-zero line, every example's title and lines. That is the whole of
 * what the section renders, and it is the same text `forbidden-words.mjs`
 * reads this directory for.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { StatsRecord } from '../stats/schema.js';
import { STATS_SCHEMA_VERSION } from '../stats/schema.js';
import { INSIGHTS_COMMAND } from '../extension.js';
import {
  ALL_ZERO_LINE,
  EXAMPLES,
  EXAMPLE_LABEL,
  IDLE_RESUME_MS,
  PRODUCT_SENTENCE,
  exampleAt,
  insightsLayout,
} from './layout.js';

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
// No advice, and nothing real in the examples
// ---------------------------------------------------------------------------

describe('the tab states facts and never advises', () => {
  /**
   * The text a user can actually read on this section.
   *
   * Built from the DATA the tree renders rather than from a DOM, because the
   * surface is a native tree: the counts line, the all-zero line, the product
   * sentence, the label and every example's title and lines. Missing one of
   * them would make the scan below vacuous about it, so the assertion under
   * it pins the length first.
   */
  function surfaceText(): string {
    const layout = insightsLayout(busyRecords());
    const shown = [
      layout.shown.map((row) => `${String(row.count)} ${row.label}`).join(' · '),
      ALL_ZERO_LINE,
      PRODUCT_SENTENCE,
      EXAMPLE_LABEL,
    ];
    for (const example of EXAMPLES) {
      shown.push(example.title, ...example.lines);
    }
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
