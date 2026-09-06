// Agent Deck — generator for `fixtures/synthetic-liveness/` (v0.7.0 DoD 0c.5).
//
// Two hand-made CC-shaped sessions that isolate the two ends of a stall's
// life, neither of which any captured corpus contains as a clean pair:
//
//   stall-then-resume   a tool goes quiet past the threshold, then its result
//                       ARRIVES. The tool must read `running` -> `stalled` ->
//                       `done` with no reset path called.
//   stall-until-ended   a tool goes quiet and its result NEVER arrives, and
//                       the session ends around it. The tool must stay
//                       `stalled` rather than being quietly resolved.
//
// WHY GENERATED RATHER THAN HAND-TYPED
// ------------------------------------
// The timestamps are the fixture's whole content, and a hand-typed set that
// drifts by a second stops testing the boundary it was written for. Here the
// offsets are declared once as constants and every line is derived from them,
// so the corpus and the test can quote the SAME numbers.
//
// G6: everything written is SYNTHETIC and says so in its slug directory name,
// its `cwd` and its message text, per this repository's convention for
// `synthetic-*` trees. Nothing here was captured from anyone's machine.
//
// Run: node scripts/make-stall-fixtures.mjs

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'fixtures', 'synthetic-liveness');
const SLUG = 'SYNTHETIC-hand-mutated-not-captured';

/** The version the corpus claims. In-window, so these must be ACCEPTED. */
const VERSION = '2.1.260';
/** `agentDeck.livenessThresholdMs`. Quoted, never redefined. */
export const THRESHOLD_MS = 120_000;

const T0 = Date.parse('2026-09-05T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** Offsets from T0, in ms. The test imports these rather than re-deriving. */
export const OFFSETS = {
  sessionStart: 0,
  toolStart: 1_000,
  /** Last activity in both fixtures: the tool call itself. */
  lastActivity: 1_000,
  /** Exactly at the threshold — must NOT be stalled. */
  atThreshold: 1_000 + THRESHOLD_MS,
  /** One past it — must be stalled. */
  pastThreshold: 1_000 + THRESHOLD_MS + 1,
  /** `stall-then-resume` only: the result lands here. */
  resume: 1_000 + THRESHOLD_MS + 300_000,
};

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function line(fields) {
  return JSON.stringify(fields);
}

function head(sessionId) {
  return [
    line({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      uuid: uuid(1),
      timestamp: iso(T0 + OFFSETS.sessionStart),
      sessionId,
      version: VERSION,
      cwd: 'C:\\SYNTHETIC',
      gitBranch: 'synthetic',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'SYNTHETIC FIXTURE — stall detection' }],
      },
    }),
    line({
      parentUuid: uuid(1),
      isSidechain: false,
      type: 'assistant',
      uuid: uuid(2),
      timestamp: iso(T0 + OFFSETS.toolStart),
      sessionId,
      version: VERSION,
      cwd: 'C:\\SYNTHETIC',
      gitBranch: 'synthetic',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_SYNTHETICSTALL000000001',
            name: 'Bash',
            input: { command: 'synthetic-long-running-command' },
          },
        ],
      },
    }),
  ];
}

function resultLine(sessionId, atMs) {
  return line({
    parentUuid: uuid(2),
    isSidechain: false,
    type: 'user',
    uuid: uuid(3),
    timestamp: iso(atMs),
    sessionId,
    version: VERSION,
    cwd: 'C:\\SYNTHETIC',
    gitBranch: 'synthetic',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_SYNTHETICSTALL000000001',
          content: 'SYNTHETIC result — the command finally returned',
        },
      ],
    },
  });
}

const CASES = {
  'stall-then-resume': {
    sessionId: 'deadbeef-0000-4000-8000-00000000c001',
    build(id) {
      // The result ARRIVES, well past the threshold. Replaying the whole file
      // must end `done`; replaying only the head must be `stalled` past the
      // threshold. One corpus, both arms.
      return [...head(id), resultLine(id, T0 + OFFSETS.resume)];
    },
  },
  'stall-until-ended': {
    sessionId: 'deadbeef-0000-4000-8000-00000000c002',
    build(id) {
      // No result, ever. The tool must STAY stalled rather than being
      // resolved by the session going quiet — silence is not an outcome.
      return head(id);
    },
  },
};

rmSync(CORPUS, { recursive: true, force: true });

for (const [name, def] of Object.entries(CASES)) {
  const dir = join(CORPUS, name, SLUG);
  mkdirSync(dir, { recursive: true });
  const text = `${def.build(def.sessionId).join('\n')}\n`;
  writeFileSync(join(dir, `${def.sessionId}.jsonl`), text, 'utf8');
  console.log(`${name}: ${String(text.split('\n').filter(Boolean).length)} lines`);
}

console.log(`\nthreshold ${String(THRESHOLD_MS)} ms; offsets ${JSON.stringify(OFFSETS)}`);
