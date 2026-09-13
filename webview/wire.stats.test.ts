// R6 — the R8 stats corpora (v0.7.0 Phase 4, DoD 4.8).
//
// `scripts/record-wire.mjs --stats` writes one `synthetic-stats-<id>.json`
// per committed R8 fixture. This file proves the recorder is deterministic
// for them, that the committed files are current, that a replay through the
// REAL store lands the record in `statsLive` beside the session it describes,
// and that the theater's corpus plugin would embed them (it reads every
// `*.json` in the directory — asserted on the listing rather than by
// rebuilding the theater, which `wire.test.ts` already does and which two
// files must not race on).
//
// A node suite, for the reasons `wire.test.ts` gives.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SYNTHETIC_CORPUS_PREFIX, WIRE_CORPUS_DIR } from './canvas-contract.js';
import { createStore } from './store.js';
import type { WireCorpus } from './theater/corpus-types.js';
import { replayAll } from './theater/replay.js';

const REPO_ROOT = resolve('.');
const RECORDER = 'scripts/record-wire.mjs';
const COMMITTED = resolve(WIRE_CORPUS_DIR);
const FIXTURES = resolve('fixtures/synthetic-stats');
const PREFIX = `${SYNTHETIC_CORPUS_PREFIX}stats-`;

type Run = Map<string, string>;

async function readRun(dir: string): Promise<Run> {
  const out: Run = new Map();
  for (const name of (await readdir(dir)).sort()) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.json')) continue;
    out.set(name, await readFile(join(dir, name), 'latin1'));
  }
  return out;
}

function lf(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

let scratch: string;
let runA: Run;
let runB: Run;
let committed: Run;
let fixtureIds: string[];

beforeAll(async () => {
  scratch = await mkdtemp(join(REPO_ROOT, 'dist', 'wire-stats-test-'));
  const dirA = join(scratch, 'a');
  const dirB = join(scratch, 'b');
  for (const dir of [dirA, dirB]) {
    execFileSync('node', [RECORDER, '--stats', '--out', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  }
  runA = await readRun(dirA);
  runB = await readRun(dirB);
  committed = await readRun(COMMITTED);
  fixtureIds = (await readdir(FIXTURES))
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.replace(/\.json$/u, ''))
    .sort();
}, 180_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('the --stats recorder', () => {
  it('writes one corpus per committed R8 fixture, all fourteen, byte-identical twice', () => {
    /*
     * FOURTEEN as of v0.8.0 Phase 7 (DoD 7.4): `14-aborted-spawn` joined
     * `src/stats/synthetic.testkit.ts` for F15. `fixtureIds` is read off
     * `fixtures/synthetic-stats/` and the recorder reads the same directory, so
     * this pin goes red until the phase's single regeneration writes that
     * fixture and its wire corpus. It is a LITERAL rather than a count derived
     * from the directory, because the two being equal is satisfied by a
     * regeneration that wrote neither.
     */
    expect(fixtureIds).toHaveLength(14);
    expect([...runA.keys()]).toStrictEqual(fixtureIds.map((id) => `${PREFIX}${id}.json`));
    expect([...runB.keys()]).toStrictEqual([...runA.keys()]);
    for (const [name, bytes] of runA) expect(runB.get(name), name).toBe(bytes);
  });

  it('matches what is committed', () => {
    for (const [name, bytes] of runA) {
      expect(committed.has(name), `${name} is missing — run \`node ${RECORDER} --stats\``).toBe(true);
      expect(lf(committed.get(name) ?? ''), `${name} is stale — re-run \`node ${RECORDER} --stats\``).toBe(lf(bytes));
    }
  });

  it('writes LF only and no raw control byte', () => {
    for (const [name, bytes] of runA) {
      expect(bytes.indexOf('\r'), `${name} contains a CR`).toBe(-1);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(bytes), `${name} has a control byte`).toBe(false);
    }
  });
});

describe('each corpus, replayed through the real store', () => {
  it('lands the session on the deck and its record in statsLive, with matching ids', () => {
    let checked = 0;
    for (const [name, bytes] of runA) {
      const corpus = JSON.parse(bytes) as WireCorpus;
      expect(corpus.kind).toBe('synthetic');
      expect(corpus.id).toBe(name.replace(/\.json$/u, ''));
      expect(corpus.producedBy).toBe(`${RECORDER} --stats`);
      const types = corpus.events.map((e) => e.message.type);
      expect(types[0]).toBe('snapshot');
      expect(types).toContain('statsSnapshot');
      expect(types).toContain('statsStore');

      const store = createStore();
      replayAll(corpus, (message) => {
        store.handleMessage(message);
      });
      const view = store.getView();
      expect(view.sessions.map((s) => s.sessionId)).toStrictEqual(corpus.final.sessions.map((s) => s.sessionId));
      expect(view.statsLive).toHaveLength(1);
      expect(view.statsLive[0]?.sessionId).toBe(corpus.final.sessions[0]?.sessionId);
      // The corpus-level engine claim agrees with the session and the record.
      expect(view.statsLive[0]?.engine).toBe(corpus.engine ?? 'cc');
      expect(corpus.final.sessions[0]?.engine ?? 'cc').toBe(corpus.engine ?? 'cc');
      expect(view.patchFailure).toBeUndefined();
      checked += 1;
    }
    // Fourteen from v0.8.0 Phase 7 — see the pin above for why this is a
    // literal and when it goes green.
    expect(checked).toBe(14);
  });

  it('the excluded fixture arrives excluded, and the refused one refused, on the wire', () => {
    const parked = JSON.parse(runA.get(`${PREFIX}05-excluded-parked.json`) ?? '{}') as WireCorpus;
    const store = createStore();
    replayAll(parked, (m) => {
      store.handleMessage(m);
    });
    expect(store.getView().statsLive[0]?.coverage).toBe('excluded:parked');
  });
});

describe('the theater embeds them', () => {
  it('the corpus plugin reads every *.json under the corpus directory, and these are there', async () => {
    const names = (await readdir(COMMITTED)).filter((n) => n.endsWith('.json'));
    for (const id of fixtureIds) expect(names).toContain(`${PREFIX}${id}.json`);
    const plugin = await readFile(resolve('webview/theater/corpus-plugin.mjs'), 'utf8');
    expect(plugin).toContain("n.endsWith('.json')");
  });
});
