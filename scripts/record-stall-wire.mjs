// Agent Deck — R6 wire recording of the STALL session (v0.7.0 DoD 0c.7).
//
// Records the harvested `99f96635-…` session through the REAL host classes at
// four clock positions, so the theater can replay a tool turning amber at the
// threshold and back to running when activity resumes.
//
// WHY THIS IS ITS OWN SCRIPT
// --------------------------
// `record-wire.mjs` records a session's ARRIVAL: content lands, the tree
// grows. A stall is the opposite — nothing arrives at all, and the only thing
// that moves is the clock. There is no `step()` in the arrival recorder that
// means "an hour passed and nobody said anything", which is precisely the
// event this corpus exists to hold. It reuses that file's recorder, its
// serializer and its synthetic/recorded guard rather than reimplementing them.
//
// THE CLOCK IS INJECTED, AND THAT IS THE WHOLE TRICK. `LivenessEngine` takes
// `now`, `SessionModel` reads it through the engine, and `stall.ts` is pure.
// So four publishes against one unchanging tree differ only in `now` — which
// is the claim the corpus makes visible.
//
// G1: reads the committed fixture, writes only into the corpus directory.
// G5: no network. No `os.homedir()`, `HOME` or `USERPROFILE` is consulted.
//
// Run: node scripts/record-stall-wire.mjs [--out <dir>]

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WIRE_FORMAT_VERSION,
  createRecorder,
  loadHostModules,
  writeCorpus,
} from './record-wire.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORPUS_DIR = join(ROOT, 'webview', 'wire');
const FIXTURE = join(
  ROOT,
  'fixtures',
  'cc-2.1.260',
  'projects',
  'c--Users-dev-projects-agent-deck',
);

const SESSION_ID = '99f96635-2042-41dc-9000-bbc9f9233bc3';
const PROJECT_SLUG = 'c--Users-dev-projects-agent-deck';
const AGENT_IDS = ['a0ed8c3aae39da276', 'a7d51ba7a0fe16c4b', 'a982bfcc574017a33'];

/** Measured in DoD 0c.1 from the corpus itself, not from recollection. */
const INNER_START_MS = Date.parse('2026-09-05T09:40:27.418Z');
const NUDGE_MS = Date.parse('2026-09-05T09:54:40.711Z');
/** `agentDeck.livenessThresholdMs`. Quoted, never redefined here. */
const THRESHOLD_MS = 120_000;

async function main() {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const outDir = outAt >= 0 ? argv[outAt + 1] : CORPUS_DIR;
  if (outDir === undefined || outDir === '') throw new Error('--out needs a directory');

  const host = await loadHostModules();

  // One clock, moved by hand. Everything downstream reads it.
  let now = INNER_START_MS;
  const liveness = new host.LivenessEngine({ now: () => now });
  const model = new host.SessionModel({
    workspacePath: 'C:\\Users\\dev\\projects\\agent-deck',
    liveness,
  });
  model.registerSession({ sessionId: SESSION_ID, projectSlug: PROJECT_SLUG });

  const mainPath = join(FIXTURE, `${SESSION_ID}.jsonl`);
  const mainLines = (await readFile(mainPath, 'utf8')).split('\n').filter((l) => l.length > 0);
  const mainParsed = host.parseLines(mainLines);
  if (!mainParsed.ok) throw new Error('main transcript did not parse');
  model.ingestTranscript(SESSION_ID, PROJECT_SLUG, {
    kind: 'main',
    path: mainPath,
    entries: mainParsed.value.entries,
  });

  for (const agentId of AGENT_IDS) {
    const dir = join(FIXTURE, SESSION_ID, 'subagents');
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const metaPath = join(dir, `agent-${agentId}.meta.json`);
    const lines = (await readFile(jsonlPath, 'utf8')).split('\n').filter((l) => l.length > 0);
    const parsed = host.parseLines(lines);
    if (!parsed.ok) throw new Error(`subagent ${agentId} did not parse`);
    model.ingestTranscript(SESSION_ID, PROJECT_SLUG, {
      kind: 'subagent',
      path: jsonlPath,
      agentId,
      entries: parsed.value.entries,
    });
    const meta = host.parseSubagentMeta(await readFile(metaPath, 'utf8'), metaPath);
    model.ingestSidecar(SESSION_ID, PROJECT_SLUG, {
      agentId,
      metaPath,
      ...(meta.ok ? { meta: meta.value } : { metaFailure: 'unparsed' }),
    });
  }

  const hookAt = (receivedAt, seq, name) =>
    model.ingestHookEvent(
      host.normalizeHookEvent(
        { session_id: SESSION_ID, hook_event_name: name, tool_name: 'Bash' },
        { seq, receivedAt },
      ),
    );

  // The session's last observed activity: the hung call itself.
  hookAt(INNER_START_MS, 1, 'PreToolUse');

  const rec = createRecorder(host);
  const publish = () => {
    const state = model.sessionState(SESSION_ID);
    if (state === undefined) throw new Error('no state');
    rec.bridge.publish({
      sessions: [state],
      diffs: [],
      addedSessionIds: [SESSION_ID],
      removedSessionIds: [],
      schemaMismatchSessionIds: [],
    });
  };

  // Offsets are relative to the first frame, so the corpus is replayable
  // without knowing the absolute capture date.
  const base = INNER_START_MS;

  rec.step(0, 'in-flight', 'the tool has just been issued; nothing is stalled');
  now = INNER_START_MS;
  publish();

  rec.step(THRESHOLD_MS, 'at-threshold', 'exactly livenessThresholdMs of silence — still running');
  now = INNER_START_MS + THRESHOLD_MS;
  publish();

  rec.step(
    THRESHOLD_MS + 1,
    'stalled',
    'one millisecond past the threshold — both levels turn amber',
  );
  now = INNER_START_MS + THRESHOLD_MS + 1;
  publish();

  rec.step(
    NUDGE_MS - base,
    'nudged',
    'the user intervened here; 853,293 ms of silence by this frame',
  );
  now = NUDGE_MS;
  publish();

  // And the clearing arm, so the corpus is not only a one-way transition.
  hookAt(NUDGE_MS, 2, 'PostToolUse');
  rec.step(NUDGE_MS - base + 1, 'resumed', 'activity arrives — amber clears with no reset path');
  now = NUDGE_MS + 1;
  publish();

  const finalState = model.sessionState(SESSION_ID);
  const name = await writeCorpus(outDir, {
    formatVersion: WIRE_FORMAT_VERSION,
    id: 'cc-2.1.260-stall-arc',
    kind: 'recorded',
    producedBy: 'scripts/record-stall-wire.mjs',
    describes:
      'The harvested 99f96635 session at five clock positions. The TREE NEVER CHANGES — '
      + 'no content arrives after the first frame. Only `now` moves, so every difference '
      + 'between frames is the stall derivation and nothing else.',
    thresholdMs: THRESHOLD_MS,
    steps: rec.steps,
    events: rec.events,
    final: { liveness: finalState?.liveness },
  });
  console.log(`wrote ${name}: ${String(rec.events.length)} events, ${String(rec.steps.length)} steps`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === new URL(`file://${entry.split('\\').join('/')}`).href) {
  await main();
}
