/**
 * `src/release/codex-golden.test.ts` - the guard on PLAN.md DoD 1.5.
 *
 * Four things, and the first two are the reason the file exists:
 *
 *   1. DETERMINISM. The golden is generated twice, into two temp directories,
 *      and the bytes must be identical - and once more with the transcript
 *      directory listing DELIBERATELY REVERSED, which is the only leg that can
 *      catch a generator resting on filesystem order. A golden that is not
 *      reproducible cannot be the thing Phase 2 reproduces.
 *
 *   2. FRESHNESS. The committed `golden.json` must equal what the generator
 *      produces from the committed corpus TODAY. Without this the golden rots
 *      silently: a later harvest changes the corpus, nothing regenerates, and
 *      Phase 2 reproduces a description of a corpus that no longer exists.
 *
 *   3. INDEPENDENCE. `scripts/codex-golden.mjs` must import nothing but
 *      `node:` builtins. If Phase 2's engine and the generator ever agree
 *      because they share a module, the golden has stopped being evidence.
 *      The import list is PARSED, not substring-searched.
 *
 *   4. CONTENT. Every claim the golden makes is re-derived here from the
 *      corpus by a second reader written for this file, and compared. Nothing
 *      below asserts a number copied out of the golden - a test that pins the
 *      generator's own output against itself passes forever while proving
 *      nothing, which is this repository's most-recorded defect class.
 *
 * The generator is a `.mjs` imported dynamically. If that import throws,
 * vitest reports the suite as SKIPPED with a healthy-looking totals line, so
 * the failure is CAUGHT and asserted rather than allowed to propagate, and the
 * shebang guard reads the file's first two BYTES rather than importing it.
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'fixtures');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'codex-golden.mjs');

/** Narrow away `undefined` with a message, so a miss reads as a failure not a crash. */
function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing: ${what}`);
  return value;
}

/** The `{present, value}` shape the golden uses for absent-versus-null. */
interface Optional<T> {
  present: boolean;
  value: T | null;
}

interface GoldenThread {
  thread_id: string;
  thread_source: string;
  cli_version: string;
  agent_path: Optional<string>;
  parent_thread_id: Optional<string>;
  spawn_depth: Optional<number>;
  spawn_agent_path: Optional<string>;
  owning_file: string | null;
}

interface GoldenSpawn {
  call_id: string;
  namespace: Optional<string>;
  argument_keys: string[];
  requested_task_name: string | null;
  item_id: string | null;
  output_task_name: string | null;
  output_agent_id: string | null;
  refused: boolean;
  refusal_text: string | null;
  child_thread_id: string | null;
  child_resolved_by: string;
}

interface GoldenToolCall {
  file: string;
  ordinal: number | null;
  kind: string;
  name: string;
  call_id: string;
  item_id: string | null;
  id_relation: string;
}

interface GoldenAgent {
  agent_id: string;
  subagent_stop_count: number;
  turn_ids: string[];
}

interface GoldenRun {
  run: string;
  dialect: string;
  dialect_source: string;
  dialect_evidence: {
    turn_context_multi_agent_version: string[];
    session_meta_multi_agent_version: string[];
    spawn_namespaces: string[];
    exec_toolsets: string[];
    models: string[];
  };
  transcripts: { file: string; bytes: number; records: number; malformed_lines: number }[];
  threads: GoldenThread[];
  thread_summary: { count: number; max_depth: number | null };
  spawns: GoldenSpawn[];
  spawn_summary: { count: number; refused: number; resolved_to_child: number };
  tool_calls: GoldenToolCall[];
  hook_join: {
    records_with_tool_use_id: number;
    resolves_call_id: number;
    resolves_item_id: number;
    resolves_both: number;
    resolves_neither: number;
    resolves_union: number;
  };
  liveness: { agents: GoldenAgent[]; agents_with_multiple_stops: number };
  redaction: {
    reasoning_response_items: number;
    ciphertext_sites: { field_path: string; count: number; bytes: number }[];
    ciphertext_strings: number;
    spawn_messages_encrypted: number;
    encrypted_bytes_copied_into_golden: number;
  };
  sizes: { longest_record_bytes: number };
}

interface GoldenSummary {
  dialects: Record<string, number>;
  dialect_sources: Record<string, number>;
  max_depth: number;
  spawns_refused: number;
  hook_records_with_tool_use_id: number;
  hook_resolves_union: number;
  agents_with_multiple_stops: number;
  reasoning_response_items: number;
  ciphertext_strings: number;
  longest_record_bytes: number;
}

interface GoldenFile {
  schema: string;
  corpus: string;
  anchor_cli_version: string;
  generator: string;
  runs: GoldenRun[];
  summary: GoldenSummary;
}

interface GeneratorModule {
  generate: (corpusName: string, fixturesDir?: string, listFiles?: (dir: string) => string[]) => string;
  goldenPath: (corpusName: string, fixturesDir?: string) => string;
  listCorpora: (fixturesDir?: string) => string[];
  listRuns: (corpusDir: string) => string[];
}

/* ================================================================== *
 * A SECOND READER. Deliberately not the generator's code and not its
 * shape: a flat scan that answers each question directly, so an
 * agreement between the two is evidence rather than a tautology.
 * ================================================================== */

interface RawRecord {
  type?: string;
  ordinal?: number;
  payload?: Record<string, unknown>;
}

interface HookRecord {
  eventName?: string;
  agentId?: string;
  toolUseId?: string;
  raw?: Record<string, unknown>;
}

function jsonlLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function jsonlRecords(file: string): RawRecord[] {
  return jsonlLines(file).map((line) => JSON.parse(line) as RawRecord);
}

function hookRecords(file: string): HookRecord[] {
  return jsonlLines(file).map((line) => JSON.parse(line) as HookRecord);
}

function transcriptFiles(runDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(path.join(runDir, 'home'));
  return out.sort();
}

function runDirNames(corpusDir: string): string[] {
  return fs
    .readdirSync(corpusDir)
    .filter((name) => fs.statSync(path.join(corpusDir, name)).isDirectory())
    .filter((name) => fs.existsSync(path.join(corpusDir, name, 'hook-stream.jsonl')))
    .sort();
}

/** `source.subagent.thread_spawn`, or undefined. */
function threadSpawn(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = payload['source'];
  if (source === null || typeof source !== 'object') return undefined;
  const subagent = (source as Record<string, unknown>)['subagent'];
  if (subagent === null || typeof subagent !== 'object') return undefined;
  const spawn = (subagent as Record<string, unknown>)['thread_spawn'];
  if (spawn === null || typeof spawn !== 'object') return undefined;
  return spawn as Record<string, unknown>;
}

let mod: GeneratorModule | null = null;
let loadError: unknown = null;
let corpusNames: string[] = [];
let corpusName = '';
let corpusDir = '';
let golden: GoldenFile | null = null;
let goldenBytes = '';
let committedBytes: string | null = null;

beforeAll(async () => {
  try {
    mod = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as GeneratorModule;
  } catch (error) {
    loadError = error;
    return;
  }
  corpusNames = mod.listCorpora(FIXTURES);
  const first = corpusNames[0];
  if (first === undefined) return;
  corpusName = first;
  corpusDir = path.join(FIXTURES, corpusName);
  goldenBytes = mod.generate(corpusName, FIXTURES);
  golden = JSON.parse(goldenBytes) as GoldenFile;
  const committed = mod.goldenPath(corpusName, FIXTURES);
  committedBytes = fs.existsSync(committed) ? fs.readFileSync(committed, 'utf8') : null;
}, 120_000);

function theGolden(): GoldenFile {
  return need(golden, 'the generated golden (see suite 0)');
}

function theRuns(): GoldenRun[] {
  return theGolden().runs;
}

function theModule(): GeneratorModule {
  return need(mod, 'scripts/codex-golden.mjs (see suite 0)');
}

/* ================================================================== *
 * 0. The suite can run at all
 * ================================================================== */
describe('0 · the generator is loadable', () => {
  it('has no shebang - a `#!` breaks vitest collection in a CRLF checkout only', () => {
    // Read the BYTES. A guard against an import failure must not itself import
    // the module it is guarding.
    const head = fs.readFileSync(SCRIPT).subarray(0, 2).toString('latin1');
    expect(head).not.toBe('#!');
  });

  it('imports without throwing', () => {
    expect(loadError, `importing ${SCRIPT} threw: ${String(loadError)}`).toBeNull();
    expect(mod).not.toBeNull();
  });

  it('finds a Codex corpus, and every corpus it found is on disk with runs', () => {
    // Derived from the directory, never a count written down: a later harvest
    // adds a corpus and this must not read as a regression.
    expect(corpusNames.length).toBeGreaterThan(0);
    for (const name of corpusNames) {
      expect(fs.existsSync(path.join(FIXTURES, name))).toBe(true);
      expect(theModule().listRuns(path.join(FIXTURES, name)).length).toBeGreaterThan(0);
    }
  });

  it('names the corpus and its anchor version after the directory', () => {
    const g = theGolden();
    expect(g.corpus).toBe(corpusName);
    expect(`codex-${g.anchor_cli_version}`).toBe(corpusName);
    expect(g.generator).toBe('scripts/codex-golden.mjs');
  });
});

/* ================================================================== *
 * 1. Independence - the rule that makes this a golden, not a restatement
 * ================================================================== */
describe('1 · the generator is independent of the code it will check', () => {
  const source = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf8') : '';

  /**
   * Parsed, not substring-searched. This file and the generator both DISCUSS
   * the engine's source tree in prose, and a loose search would fail on the
   * documentation of the very rule it enforces.
   */
  function importSpecifiers(text: string): string[] {
    const patterns = [
      /^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm,
      /^\s*import\s+['"]([^'"]+)['"]/gm,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    const found: string[] = [];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const spec = match[1];
        if (spec !== undefined) found.push(spec);
      }
    }
    return found;
  }

  it('imports at least one thing (a vacuity control on the two tests below)', () => {
    expect(importSpecifiers(source).length).toBeGreaterThan(0);
  });

  it('imports only node: builtins', () => {
    for (const spec of importSpecifiers(source)) {
      expect(spec, `generator must not import ${spec}`).toMatch(/^node:/);
    }
  });

  it('imports nothing from src/, webview/, lab/ or scripts/', () => {
    for (const spec of importSpecifiers(source)) {
      expect(spec, `generator must not import ${spec}`).not.toMatch(/(^|\/)src\//);
      expect(spec, `generator must not import ${spec}`).not.toMatch(/(^|\/)webview\//);
      expect(spec, `generator must not import ${spec}`).not.toMatch(/(^|\/)lab\//);
      expect(spec, `generator must not import ${spec}`).not.toMatch(/(^|\/)scripts\//);
    }
  });

  it('says out loud that the Phase 2 engine must not import it', () => {
    // The constraint is a review obligation as much as a mechanical one, so the
    // reason has to survive in the file a reader opens.
    expect(source).toMatch(/MUST NEVER MAKE `src\/codex\/` IMPORT THIS FILE/);
  });

  it('writes nothing but the golden (G1)', () => {
    const writes = [
      ...source.matchAll(/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync|createWriteStream)\b/g),
    ].map((m) => m[1]);
    expect([...new Set(writes)]).toEqual(['writeFileSync']);
  });
});

/* ================================================================== *
 * 2. Determinism - DoD 1.5's stated test
 * ================================================================== */
describe('2 · the golden is byte-identical across runs', () => {
  it('generates identical bytes into two temp directories', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-golden-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-golden-b-'));
    try {
      const fileA = path.join(a, 'golden.json');
      const fileB = path.join(b, 'golden.json');
      fs.writeFileSync(fileA, theModule().generate(corpusName, FIXTURES), 'utf8');
      fs.writeFileSync(fileB, theModule().generate(corpusName, FIXTURES), 'utf8');
      expect(fs.readFileSync(fileA).length).toBeGreaterThan(0);
      expect(fs.readFileSync(fileB)).toEqual(fs.readFileSync(fileA));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('generates identical bytes with the directory listing REVERSED', () => {
    // The only leg that can catch a generator resting on filesystem order.
    // Two calls with the same listing agree by construction.
    const reversed = (dir: string): string[] => [...fs.readdirSync(dir)].reverse();
    expect(theModule().generate(corpusName, FIXTURES, reversed)).toBe(goldenBytes);
  });

  it('serialises with sorted keys at every depth, 2-space indent, LF, trailing newline', () => {
    expect(goldenBytes.endsWith('\n')).toBe(true);
    expect(goldenBytes.includes('\r')).toBe(false);
    expect(goldenBytes).toContain('\n  "corpus"');
    let objects = 0;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      objects += 1;
      const keys = Object.keys(value as Record<string, unknown>);
      expect(keys).toEqual([...keys].sort());
      for (const key of keys) walk((value as Record<string, unknown>)[key]);
    };
    walk(JSON.parse(goldenBytes));
    expect(objects).toBeGreaterThan(1);
  });
});

/* ================================================================== *
 * 3. The committed golden is current
 * ================================================================== */
describe('3 · the committed golden is what the generator produces today', () => {
  it('exists', () => {
    expect(committedBytes, `${theModule().goldenPath(corpusName, FIXTURES)} is missing`).not.toBeNull();
  });

  it('is byte-for-byte what the corpus produces', () => {
    expect(committedBytes).toBe(goldenBytes);
  });
});

/* ================================================================== *
 * 4. Content - every claim re-derived from the corpus
 * ================================================================== */
describe('4 · the golden describes the corpus', () => {
  it('covers exactly the runs on disk, with their transcripts and record counts', () => {
    expect(theRuns().map((r) => r.run)).toEqual(runDirNames(corpusDir));
    for (const run of theRuns()) {
      const onDisk = transcriptFiles(path.join(corpusDir, run.run));
      expect(run.transcripts.map((t) => t.file).sort()).toEqual(onDisk.map((f) => path.basename(f)).sort());
      for (const full of onDisk) {
        const entry = need(
          run.transcripts.find((t) => t.file === path.basename(full)),
          `${run.run}/${path.basename(full)} in the golden`,
        );
        expect(entry.records).toBe(jsonlRecords(full).length);
        expect(entry.bytes).toBe(fs.statSync(full).size);
        expect(entry.malformed_lines).toBe(0);
      }
    }
  });

  it('records every distinct thread the corpus declares', () => {
    for (const run of theRuns()) {
      const declared = new Set<string>();
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        for (const record of jsonlRecords(file)) {
          if (record.type !== 'session_meta' || record.payload === undefined) continue;
          declared.add(String(record.payload['id']));
        }
      }
      expect(new Set(run.threads.map((t) => t.thread_id))).toEqual(declared);
      expect(run.thread_summary.count).toBe(declared.size);
    }
  });

  it('preserves agent_path ABSENT distinctly from agent_path NULL', () => {
    // A v2 subagent has a top-level `agent_path` string. A v1 subagent has NO
    // top-level key at all and a nested `agent_path: null`. Collapsing the last
    // two renders a v1 subagent as if Codex had said the path was empty.
    let sawAbsentTopLevel = false;
    let sawNestedNull = false;
    let sawStringPath = false;

    for (const run of theRuns()) {
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        for (const record of jsonlRecords(file)) {
          if (record.type !== 'session_meta' || record.payload === undefined) continue;
          const payload = record.payload;
          const id = String(payload['id']);
          const thread = run.threads.find((t) => t.thread_id === id);
          if (thread === undefined || thread.owning_file !== path.basename(file)) continue;

          const topPresent = Object.prototype.hasOwnProperty.call(payload, 'agent_path');
          expect(thread.agent_path.present, `${id} top-level agent_path presence`).toBe(topPresent);
          if (topPresent) {
            expect(thread.agent_path.value).toBe(payload['agent_path']);
            if (typeof payload['agent_path'] === 'string') sawStringPath = true;
          } else {
            sawAbsentTopLevel = true;
          }

          const spawn = threadSpawn(payload);
          const nestedPresent =
            spawn !== undefined && Object.prototype.hasOwnProperty.call(spawn, 'agent_path');
          expect(thread.spawn_agent_path.present, `${id} nested agent_path presence`).toBe(nestedPresent);
          if (nestedPresent && spawn !== undefined) {
            expect(thread.spawn_agent_path.value).toBe(spawn['agent_path']);
            if (spawn['agent_path'] === null) sawNestedNull = true;
          }
        }
      }
    }

    // Vacuity controls: the loop above proves nothing if the corpus contains
    // none of the three states.
    expect(sawStringPath, 'corpus has no populated agent_path').toBe(true);
    expect(sawAbsentTopLevel, 'corpus has no ABSENT agent_path').toBe(true);
    expect(sawNestedNull, 'corpus has no NULL agent_path').toBe(true);
  });

  it('records the depth-2 chain, derived from the corpus', () => {
    const chains: { run: string; child: string; parent: string; depth: number }[] = [];
    for (const run of theRuns()) {
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        for (const record of jsonlRecords(file)) {
          if (record.type !== 'session_meta' || record.payload === undefined) continue;
          const spawn = threadSpawn(record.payload);
          if (spawn === undefined || typeof spawn['depth'] !== 'number') continue;
          if (spawn['depth'] < 2) continue;
          chains.push({
            run: run.run,
            child: String(record.payload['id']),
            parent: String(spawn['parent_thread_id']),
            depth: spawn['depth'],
          });
        }
      }
    }
    expect(chains.length, 'corpus has no depth >= 2 subagent').toBeGreaterThan(0);

    for (const chain of chains) {
      const run = need(theRuns().find((r) => r.run === chain.run), chain.run);
      const child = need(run.threads.find((t) => t.thread_id === chain.child), chain.child);
      expect(child.spawn_depth.value).toBe(chain.depth);
      expect(child.parent_thread_id.value).toBe(chain.parent);
      // The parent is itself a subagent, which is what makes it a CHAIN rather
      // than two roots that happen to be numbered.
      const parent = need(run.threads.find((t) => t.thread_id === chain.parent), chain.parent);
      expect(parent.thread_source).toBe('subagent');
      expect(parent.spawn_depth.value).toBe(chain.depth - 1);
      expect(run.thread_summary.max_depth).not.toBeNull();
      expect(run.thread_summary.max_depth ?? 0).toBeGreaterThanOrEqual(chain.depth);
    }
    expect(theGolden().summary.max_depth).toBe(Math.max(...chains.map((c) => c.depth)));
  });

  it('records the duplicate-path refusal with the engine own bytes', () => {
    // Derived: a spawn whose `function_call_output` is NOT JSON is a refusal.
    const refusals: { call_id: string; text: string }[] = [];
    for (const run of theRuns()) {
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        const records = jsonlRecords(file);
        const spawnCalls = new Set(
          records
            .filter((r) => r.type === 'response_item' && r.payload?.['type'] === 'function_call')
            .filter((r) => r.payload?.['name'] === 'spawn_agent')
            .map((r) => String(r.payload?.['call_id'])),
        );
        for (const record of records) {
          const payload = record.payload;
          if (record.type !== 'response_item' || payload === undefined) continue;
          if (payload['type'] !== 'function_call_output') continue;
          const callId = String(payload['call_id']);
          if (!spawnCalls.has(callId)) continue;
          const output = payload['output'];
          if (typeof output !== 'string') continue;
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(output);
          } catch {
            parsed = null;
          }
          if (parsed === null || typeof parsed !== 'object') refusals.push({ call_id: callId, text: output });
        }
      }
    }
    expect(refusals.length, 'corpus contains no spawn refusal').toBeGreaterThan(0);

    const goldenRefusals = theRuns().flatMap((r) => r.spawns.filter((s) => s.refused));
    expect(goldenRefusals.map((s) => s.call_id).sort()).toEqual(refusals.map((r) => r.call_id).sort());
    for (const refusal of refusals) {
      const spawn = need(goldenRefusals.find((s) => s.call_id === refusal.call_id), refusal.call_id);
      expect(spawn.refusal_text).toBe(refusal.text);
      expect(spawn.child_thread_id).toBeNull();
      expect(spawn.child_resolved_by).toBe('refused');
      // The refused call gets NO SubAgentActivity item: absence is the second
      // witness, and it is what an engine keyed only on the item would miss.
      expect(spawn.item_id).toBeNull();
    }
    expect(theGolden().summary.spawns_refused).toBe(refusals.length);
  });

  it('records the spawn to child join in whichever key the dialect uses', () => {
    for (const run of theRuns()) {
      for (const spawn of run.spawns) {
        if (spawn.refused) continue;
        expect(spawn.child_thread_id, `${spawn.call_id} did not resolve`).not.toBeNull();
        const child = need(
          run.threads.find((t) => t.thread_id === spawn.child_thread_id),
          `child of ${spawn.call_id}`,
        );
        expect(child.thread_source).toBe('subagent');
        if (spawn.child_resolved_by === 'output_task_name_equals_agent_path') {
          expect(child.agent_path.value).toBe(spawn.output_task_name);
        } else {
          expect(spawn.child_resolved_by).toBe('output_agent_id_equals_thread_id');
          expect(spawn.output_agent_id).toBe(child.thread_id);
        }
      }
    }
    // Both join keys are exercised by this corpus - a v2 run joins on the agent
    // path, a v1 run on the agent id.
    const keys = new Set(
      theRuns().flatMap((r) => r.spawns.filter((s) => !s.refused).map((s) => s.child_resolved_by)),
    );
    expect([...keys].sort()).toEqual([
      'output_agent_id_equals_thread_id',
      'output_task_name_equals_agent_path',
    ]);
  });

  it('records BOTH dialects, and every dialect evidence list matches the corpus', () => {
    for (const run of theRuns()) {
      const namespaces = new Set<string>();
      const turnContext = new Set<string>();
      const sessionMeta = new Set<string>();
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        for (const record of jsonlRecords(file)) {
          const declared = record.payload?.['multi_agent_version'];
          if (record.type === 'turn_context' && typeof declared === 'string') turnContext.add(declared);
          if (record.type === 'session_meta' && typeof declared === 'string') sessionMeta.add(declared);
          if (record.type !== 'response_item') continue;
          const ns = record.payload?.['namespace'];
          if (typeof ns === 'string') namespaces.add(ns);
        }
      }
      expect(run.dialect_evidence.spawn_namespaces).toEqual([...namespaces].sort());
      expect(run.dialect_evidence.turn_context_multi_agent_version).toEqual([...turnContext].sort());
      expect(run.dialect_evidence.session_meta_multi_agent_version).toEqual([...sessionMeta].sort());
    }
    const dialects = new Set(theRuns().map((r) => r.dialect));
    expect(dialects.has('v1'), 'corpus exercises no v1 run').toBe(true);
    expect(dialects.has('v2'), 'corpus exercises no v2 run').toBe(true);
  });

  it('resolves every dialect from a DECLARED field, and leaves the undetermined bucket empty', () => {
    // The engine states its own dialect on `turn_context`, on every record of
    // every run here - so nothing has to be inferred from a namespace, a spawn
    // or a model name, and nothing has to open `models_cache.json`. Precedence
    // is turn_context, then session_meta, then the namespace as a last resort.
    let runsWithNoSpawnRecord = 0;

    for (const run of theRuns()) {
      const turnContext = new Set<string>();
      const sessionMeta = new Set<string>();
      const namespaces = new Set<string>();
      let spawnRecords = 0;
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        for (const record of jsonlRecords(file)) {
          const declared = record.payload?.['multi_agent_version'];
          if (record.type === 'turn_context' && typeof declared === 'string') turnContext.add(declared);
          if (record.type === 'session_meta' && typeof declared === 'string') sessionMeta.add(declared);
          if (record.type !== 'response_item') continue;
          if (record.payload?.['name'] === 'spawn_agent') spawnRecords += 1;
          const ns = record.payload?.['namespace'];
          if (typeof ns === 'string') namespaces.add(ns);
        }
      }

      const declaredOnly = (set: Set<string>): string[] => [...set].filter((v) => v === 'v1' || v === 'v2');
      const fromTurnContext = declaredOnly(turnContext);
      const fromSessionMeta = declaredOnly(sessionMeta);
      const namespaceDialects: string[] = [];
      for (const ns of namespaces) {
        if (ns === 'collaboration') namespaceDialects.push('v2');
        if (ns === 'multi_agent_v1') namespaceDialects.push('v1');
      }
      const fromNamespace = [...new Set(namespaceDialects)];

      if (fromTurnContext.length === 1) {
        expect(run.dialect_source, `${run.run} source`).toBe('turn_context.multi_agent_version');
        expect(run.dialect, `${run.run} dialect`).toBe(fromTurnContext[0]);
      } else if (fromSessionMeta.length === 1) {
        expect(run.dialect_source, `${run.run} source`).toBe('session_meta.multi_agent_version');
        expect(run.dialect, `${run.run} dialect`).toBe(fromSessionMeta[0]);
      } else if (fromNamespace.length === 1) {
        expect(run.dialect_source, `${run.run} source`).toBe('spawn_namespace');
        expect(run.dialect, `${run.run} dialect`).toBe(fromNamespace[0]);
      } else {
        expect(run.dialect_source, `${run.run} source`).toBe('none');
        expect(run.dialect, `${run.run} dialect`).toBe('undetermined');
      }

      // THE CASE THIS TEST EXISTS FOR: a run that spawns nothing has no
      // namespace and no subagent `session_meta`, so the first two sources are
      // the only ones that can answer - and `turn_context` does.
      if (spawnRecords === 0) {
        runsWithNoSpawnRecord += 1;
        expect(run.dialect_evidence.spawn_namespaces, `${run.run} spawn namespaces`).toEqual([]);
        expect(run.dialect_evidence.session_meta_multi_agent_version, `${run.run} session_meta`).toEqual([]);
        expect(run.dialect_source, `${run.run} source`).toBe('turn_context.multi_agent_version');
        expect(['v1', 'v2']).toContain(run.dialect);
      }
    }

    // Vacuity control: without such a run the paragraph above proves nothing.
    expect(runsWithNoSpawnRecord, 'corpus has no run without a spawn record').toBeGreaterThan(0);

    // The bucket must still EXIST in the classifier - deleting it would make a
    // future undeclared corpus get guessed at - and must be EMPTY here.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("dialect: 'undetermined'");
    expect(theGolden().summary.dialects['undetermined']).toBeUndefined();
    expect(theGolden().summary.dialect_sources['none']).toBeUndefined();
    expect(theRuns().every((r) => r.dialect === 'v1' || r.dialect === 'v2')).toBe(true);
  });

  it('records the v1 spawn arguments as the corpus states them - no task_name', () => {
    const v1 = theRuns().filter((r) => r.dialect === 'v1').flatMap((r) => r.spawns);
    const v2 = theRuns().filter((r) => r.dialect === 'v2').flatMap((r) => r.spawns);
    expect(v1.length).toBeGreaterThan(0);
    expect(v2.length).toBeGreaterThan(0);
    for (const spawn of v1) {
      expect(spawn.argument_keys).not.toContain('task_name');
      expect(spawn.requested_task_name).toBeNull();
      expect(spawn.namespace.value).toBe('multi_agent_v1');
    }
    for (const spawn of v2) {
      expect(spawn.argument_keys).toContain('task_name');
      expect(spawn.requested_task_name).not.toBeNull();
      expect(spawn.namespace.value).toBe('collaboration');
    }
  });

  it('records both tool-call id namespaces, and which calls use which', () => {
    for (const run of theRuns()) {
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        const records = jsonlRecords(file);
        const itemIds = new Set<string>();
        for (const record of records) {
          if (record.type !== 'event_msg' || record.payload?.['type'] !== 'item_completed') continue;
          const item = record.payload['item'];
          if (item !== null && typeof item === 'object') {
            itemIds.add(String((item as Record<string, unknown>)['id']));
          }
        }
        for (const record of records) {
          const payload = record.payload;
          if (record.type !== 'response_item' || payload === undefined) continue;
          const kind = payload['type'];
          if (kind !== 'function_call' && kind !== 'custom_tool_call' && kind !== 'tool_search_call') continue;
          const callId = String(payload['call_id']);
          const entry = need(
            run.tool_calls.find(
              (c) => c.file === path.basename(file) && c.call_id === callId && c.ordinal === record.ordinal,
            ),
            `${callId} in the golden`,
          );
          expect(entry.kind).toBe(kind);
          expect(entry.name).toBe(String(payload['name'] ?? ''));
          if (itemIds.has(callId)) {
            expect(entry.id_relation).toBe('item_id_equals_call_id');
            expect(entry.item_id).toBe(callId);
          } else if (entry.item_id !== null) {
            expect(entry.id_relation).toBe('item_id_distinct_from_call_id');
            expect(entry.item_id).not.toBe(callId);
            expect(itemIds.has(entry.item_id)).toBe(true);
          } else {
            expect(entry.id_relation).toBe('no_item');
          }
        }
      }
    }
    // Vacuity control: the branch that matters is the DISTINCT one - a shell
    // command whose item id is `exec-<uuid>` and whose call id is unrelated.
    const distinct = theRuns().flatMap((r) =>
      r.tool_calls.filter((c) => c.id_relation === 'item_id_distinct_from_call_id'),
    );
    expect(distinct.length, 'corpus exercises no distinct-id tool call').toBeGreaterThan(0);
    for (const call of distinct) {
      expect(call.call_id.startsWith('call_')).toBe(true);
      expect(need(call.item_id, 'item id').startsWith('exec-')).toBe(true);
    }
  });

  it('reports the hook join totals against BOTH id namespaces', () => {
    let unionTotal = 0;
    let withToolUseId = 0;
    for (const run of theRuns()) {
      const callIds = new Set<string>();
      const itemIds = new Set<string>();
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        for (const record of jsonlRecords(file)) {
          const payload = record.payload;
          if (payload === undefined) continue;
          if (record.type === 'response_item' && typeof payload['call_id'] === 'string') {
            callIds.add(payload['call_id']);
          }
          if (record.type === 'event_msg' && payload['type'] === 'item_completed') {
            const item = payload['item'];
            if (item !== null && typeof item === 'object') {
              itemIds.add(String((item as Record<string, unknown>)['id']));
            }
          }
        }
      }
      let n = 0;
      let byCall = 0;
      let byItem = 0;
      let byBoth = 0;
      let byNeither = 0;
      for (const record of hookRecords(path.join(corpusDir, run.run, 'hook-stream.jsonl'))) {
        const id = record.toolUseId;
        if (typeof id !== 'string') continue;
        n += 1;
        const inCalls = callIds.has(id);
        const inItems = itemIds.has(id);
        if (inCalls) byCall += 1;
        if (inItems) byItem += 1;
        if (inCalls && inItems) byBoth += 1;
        if (!inCalls && !inItems) byNeither += 1;
      }
      expect(run.hook_join.records_with_tool_use_id).toBe(n);
      expect(run.hook_join.resolves_call_id).toBe(byCall);
      expect(run.hook_join.resolves_item_id).toBe(byItem);
      expect(run.hook_join.resolves_both).toBe(byBoth);
      expect(run.hook_join.resolves_neither).toBe(byNeither);
      expect(run.hook_join.resolves_union).toBe(byCall + byItem - byBoth);
      unionTotal += byCall + byItem - byBoth;
      withToolUseId += n;
    }
    expect(theGolden().summary.hook_resolves_union).toBe(unionTotal);
    expect(theGolden().summary.hook_records_with_tool_use_id).toBe(withToolUseId);
    expect(withToolUseId, 'no hook record carries a tool_use_id').toBeGreaterThan(0);

    // The finding this exists to pin: the item namespace resolves strictly more
    // than the call namespace, and the UNION more than either - so a join
    // written against `call_id` alone silently drops calls and reads as a Codex
    // deficiency rather than as a bug in the question.
    const byItemTotal = theRuns().reduce((acc, r) => acc + r.hook_join.resolves_item_id, 0);
    const byCallTotal = theRuns().reduce((acc, r) => acc + r.hook_join.resolves_call_id, 0);
    expect(byItemTotal).toBeGreaterThan(byCallTotal);
    expect(unionTotal).toBeGreaterThan(byItemTotal);
  });

  it('records the agent with two SubagentStops under different turn_ids', () => {
    const stops = new Map<string, { run: string; agentId: string; count: number; turns: Set<string> }>();
    for (const run of theRuns()) {
      for (const record of hookRecords(path.join(corpusDir, run.run, 'hook-stream.jsonl'))) {
        if (record.eventName !== 'SubagentStop') continue;
        const agentId = String(record.agentId);
        const key = `${run.run}::${agentId}`;
        const entry = stops.get(key) ?? { run: run.run, agentId, count: 0, turns: new Set<string>() };
        entry.count += 1;
        const turn = record.raw?.['turn_id'];
        if (typeof turn === 'string') entry.turns.add(turn);
        stops.set(key, entry);
      }
    }
    const multi = [...stops.values()].filter((e) => e.count > 1);
    expect(multi.length, 'corpus has no agent with two SubagentStops').toBeGreaterThan(0);

    for (const entry of multi) {
      const run = need(theRuns().find((r) => r.run === entry.run), entry.run);
      const agent = need(run.liveness.agents.find((a) => a.agent_id === entry.agentId), entry.agentId);
      expect(agent.subagent_stop_count).toBe(entry.count);
      // Two stops under ONE turn_id would be a repeat; two turn_ids is a
      // RESUMED agent, and an engine that marks it dead on the first kills a
      // live agent.
      expect(agent.turn_ids.length).toBe(entry.turns.size);
      expect(agent.turn_ids.length).toBeGreaterThan(1);
      expect(agent.turn_ids).toEqual([...agent.turn_ids].sort());
      expect(run.liveness.agents_with_multiple_stops).toBeGreaterThan(0);
    }
    expect(theGolden().summary.agents_with_multiple_stops).toBe(multi.length);
  });

  it('counts the redaction surface without copying a byte of it (G4)', () => {
    let reasoning = 0;
    let ciphertext = 0;
    for (const run of theRuns()) {
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        for (const record of jsonlRecords(file)) {
          if (record.type === 'response_item' && record.payload?.['type'] === 'reasoning') reasoning += 1;
          const seen = JSON.stringify(record.payload ?? null).match(/gAAAAAB/g);
          if (seen !== null) ciphertext += seen.length;
        }
      }
    }
    expect(reasoning, 'corpus carries no reasoning record').toBeGreaterThan(0);
    expect(theGolden().summary.reasoning_response_items).toBe(reasoning);

    // A walk over the PARSED record never descends into a tool call's
    // `arguments`, which is a JSON string - and that is where the v2 dialect
    // puts its spawn and send_message ciphertext. Equality with the raw
    // occurrence count is what makes the G4 count provable rather than
    // asserted: an accounting that missed those would be short by a fifth and
    // would still look thorough.
    expect(theGolden().summary.ciphertext_strings).toBe(ciphertext);
    const argumentSites = theRuns().flatMap((r) =>
      r.redaction.ciphertext_sites.filter((s) => s.field_path.includes('.arguments{')),
    );
    expect(argumentSites.length, 'no ciphertext counted inside a tool call arguments string')
      .toBeGreaterThan(0);
    const inSpawnArgs = theRuns().reduce((acc, r) => acc + r.redaction.spawn_messages_encrypted, 0);
    expect(inSpawnArgs).toBeGreaterThan(0);

    // And none of it is in the file.
    expect(goldenBytes).not.toContain('gAAAAAB');
    for (const run of theRuns()) {
      expect(run.redaction.encrypted_bytes_copied_into_golden).toBe(0);
    }
  });

  it('records the longest single record per run, derived from the corpus', () => {
    for (const run of theRuns()) {
      let longest = 0;
      for (const file of transcriptFiles(path.join(corpusDir, run.run))) {
        for (const line of jsonlLines(file)) {
          longest = Math.max(longest, Buffer.byteLength(line, 'utf8'));
        }
      }
      expect(run.sizes.longest_record_bytes).toBe(longest);
    }
    // The inline-output ceiling run: Codex stores large tool output WHOLE and
    // inline, so one record runs to hundreds of kilobytes. It is a real
    // property of the format, and Phase 2's reader has to survive it.
    const max = Math.max(...theRuns().map((r) => r.sizes.longest_record_bytes));
    expect(theGolden().summary.longest_record_bytes).toBe(max);
    expect(max).toBeGreaterThan(200_000);
  });

  it('carries no absolute path and no home directory', () => {
    expect(goldenBytes).not.toMatch(/[A-Za-z]:\\\\/);
    expect(goldenBytes).not.toMatch(/\/(?:home|Users)\/[^"\\/]+/);
  });

  it('anchors every thread on the cli_version the corpus directory names', () => {
    for (const run of theRuns()) {
      for (const thread of run.threads) {
        expect(thread.cli_version).toBe(theGolden().anchor_cli_version);
      }
    }
  });
});
