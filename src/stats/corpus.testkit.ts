/**
 * Every committed session of every engine, read THROUGH THE PRODUCTION PATH —
 * v0.7.0 Phase 1.
 *
 * Test-only. Named `.testkit.ts` rather than `.test.ts` deliberately: vitest
 * collects `src/**\/*.test.ts`, so this file is a helper and never a suite of
 * its own. `webview/testkit.ts` sets the precedent, and the privacy sweep's
 * `tests-and-testdata` rule recognises the suffix.
 *
 * ## Why the sweep is over DIRECTORIES rather than over a list
 *
 * A hard-coded corpus list goes stale on the next harvest and reads as a
 * regression — the recorded rule against asserting fixture-set sizes. Every
 * reader below discovers its corpora from disk, so a new capture is picked up
 * with no edit here.
 *
 * The cost is that a discovery bug makes every caller iterate nothing and pass.
 * That is this repository's most-recorded defect class, so each reader THROWS
 * when it finds no corpus rather than returning an empty array, and the callers
 * additionally assert a non-empty population.
 *
 * ## Production path, not a shortcut
 *
 * `graftSession`, `readOpenCodeEngine` and `readCodexEngine` are the same
 * entry points the extension host calls. Nothing here re-implements a parse: a
 * field asserted on these states is a field the product really produces, which
 * is the whole difference between DoD 1.4/1.5 and a component test.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionState } from '../model/events.js';
import { graftSession } from '../model/graft.js';
import { readCodexEngine } from '../codex/index.js';
import { readOpenCodeEngine } from '../opencode/index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

function corpusDirs(prefix: string, marker: (dir: string) => boolean): string[] {
  const dirs = fs
    .readdirSync(FIXTURES)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(FIXTURES, name))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .filter(marker)
    .sort();
  if (dirs.length === 0) throw new Error(`no ${prefix}* corpus found under ${FIXTURES}`);
  return dirs;
}

/** Every `.jsonl` directly under a corpus's slug directory — the MAIN transcripts. */
function mainTranscripts(corpusDir: string): string[] {
  const projects = path.join(corpusDir, 'projects');
  if (!fs.existsSync(projects)) return [];
  const out: string[] = [];
  for (const slug of fs.readdirSync(projects)) {
    const slugDir = path.join(projects, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(slugDir)) {
      // Subagent transcripts live one level down, under `<sessionId>/subagents/`,
      // and are grafted in by `graftSession` rather than read as sessions.
      if (entry.endsWith('.jsonl')) out.push(path.join(slugDir, entry));
    }
  }
  return out.sort();
}

/**
 * Every Claude Code session of every `fixtures/cc-*` corpus.
 *
 * A session the fingerprint REFUSES is skipped rather than thrown on: a corpus
 * may legitimately hold a refusal fixture, and this helper's job is to supply
 * the sessions that render, not to re-assert the version window.
 */
export async function readCcSessions(): Promise<SessionState[]> {
  const states: SessionState[] = [];
  for (const dir of corpusDirs('cc-', (d) => fs.existsSync(path.join(d, 'projects')))) {
    for (const transcript of mainTranscripts(dir)) {
      const result = await graftSession(transcript);
      if (!result.ok) continue;
      states.push(result.snapshot as unknown as SessionState);
    }
  }
  if (states.length === 0) throw new Error('no CC session grafted from any cc-* corpus');
  return states;
}

/** Every OpenCode session of every committed store. */
export async function readOpenCodeSessions(): Promise<SessionState[]> {
  const states: SessionState[] = [];
  for (const dir of corpusDirs('opencode-', () => true)) {
    // `opencode-1.18.25` keeps its store a level down, in `moved-project/`. A
    // root-only test silently skipped it once already (Phase 0 records the
    // fail-open), so the store is searched for rather than assumed.
    for (const dbPath of findStores(dir)) {
      const outcome = readOpenCodeEngine({ dbPath, immutable: true });
      if (outcome.kind !== 'ok') continue;
      states.push(...outcome.result.sessions);
    }
  }
  if (states.length === 0) throw new Error('no OpenCode session read from any opencode-* corpus');
  return await Promise.resolve(states);
}

function findStores(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (entry === 'opencode.db') out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Every Codex thread of every committed run, as `SessionState`s. */
export async function readCodexSessions(): Promise<SessionState[]> {
  const states: SessionState[] = [];
  // Selected by the presence of a golden, which is what separates an ANCHOR
  // corpus from a witness — never by sort order, which a differently named
  // corpus would break silently.
  for (const dir of corpusDirs('codex-', (d) => fs.existsSync(path.join(d, 'golden.json')))) {
    for (const run of fs.readdirSync(dir)) {
      const root = path.join(dir, run, 'home', '.codex');
      if (!fs.existsSync(root)) continue;
      const outcome = await readCodexEngine({ root });
      if (outcome.kind !== 'ok') continue;
      states.push(...outcome.result.sessions);
    }
  }
  if (states.length === 0) throw new Error('no Codex session read from any codex-* corpus');
  return states;
}
