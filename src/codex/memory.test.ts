/**
 * Agent Deck — the Codex engine must not exhaust the extension host's heap
 * (HOTFIX-0.6.1 DoD H.1 and H.6).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE SPAWNS A CHILD PROCESS
 * ---------------------------------------------------------------------------
 * The defect this file exists for is an OUT-OF-MEMORY crash of the VS Code
 * extension host, reported by an external Codex user with a 3.11 GB
 * `~/.codex/sessions` folder and seven host dumps. There is no assertion that
 * can express "this did not exhaust the heap" from inside the process doing
 * the exhausting: by the time it is true, the process is gone and vitest has
 * no reporter left to report with.
 *
 * So the engine runs in a CHILD process under an explicit
 * `--max-old-space-size=128`, and the assertion is on the child's EXIT CODE.
 * A heap the host cannot grow is the only faithful model of the condition
 * being fixed, and 128 MB is two orders of magnitude below what any of these
 * corpora would need if read the way `v0.6.0` reads them.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE RED RUN LOOKED LIKE
 * ---------------------------------------------------------------------------
 * `docs/evidence/hotfix-0.6.1/RED.md` holds this file's output against
 * unmodified `v0.6.0` code, captured before any fix existed. Both cases died
 * with `JavaScript heap out of memory` and a V8 stack, at exit code 134. That
 * document is the reason this file's assertions are believable: a test that
 * has never been seen to fail is a test whose subject has never been shown to
 * exist.
 *
 * ---------------------------------------------------------------------------
 * THE CORPORA ARE GENERATED, NEVER COMMITTED, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * 300 MiB of synthetic transcript is not fixture material — G6 says fixtures
 * are captured from real sessions, and nothing here is. These files exist for
 * the duration of one run and are removed. They are written under `dist/`,
 * which is gitignored AND denied in `.vscodeignore` (rule 20: two doors), the
 * same place `webview/wire.test.ts` puts its scratch and for the same reason:
 * a test writes nothing outside the repository.
 *
 * The SHAPE is copied from `fixtures/codex-0.151.0-alpha.7.2` — a real
 * `session_meta` at ordinal 0 and real `response_item` record framing — so
 * that what is measured is the engine's ingestion of a Codex-shaped file
 * rather than its rejection of a malformed one. The BULK is padding, and the
 * test says so rather than pretending otherwise.
 */

import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PINNED_CODEX_VERSION } from './fingerprint.js';

const CODEX_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * The heap ceiling the child runs under.
 *
 * Not a tuning knob: it is the claim. 80 MiB of JSONL cannot be held as a
 * buffer, then as a string, then as a parsed object graph inside 128 MB of old
 * space — which is precisely what `v0.6.0` attempts, once per file, once per
 * second. Measured against unmodified `v0.6.0` before this file's assertions
 * were written; `docs/evidence/hotfix-0.6.1/RED.md` is the output.
 */
const HEAP_CAP_MB = 128;

const MIB = 1024 * 1024;

/**
 * `readCodexEngine`, bundled to one file so a child `node` can run it.
 *
 * Built from `stdin` with `resolveDir` pointing at this directory rather than
 * from a scratch `.ts` file: a generated entry point inside `src/` would be a
 * file the privacy sweep, the packager and `tsc` all have to be told about,
 * and it would be there for exactly as long as nobody crashed mid-run.
 */
const RUNNER_SOURCE = `
import { readCodexEngine } from './index.js';

const root = process.argv[2];
const outcome = await readCodexEngine({ root });
if (outcome.kind !== 'ok') {
  process.stdout.write('NOTOK ' + outcome.kind + '\\n');
  process.exit(2);
}
const result = outcome.result;
const skipped = result.skipped === undefined ? [] : result.skipped;
const partial = result.partialTranscripts === undefined ? [] : result.partialTranscripts;
process.stdout.write(
  'OK sessions=' + result.sessions.length +
  ' threads=' + result.threads.length +
  ' refused=' + result.refused.length +
  ' skipped=' + skipped.length +
  ' partial=' + partial.length +
  ' read=' + partial.reduce((sum, one) => sum + one.readBytes, 0) +
  ' rss=' + Math.round(process.memoryUsage().rss / (1024 * 1024)) + 'MiB\\n',
);
`;

let scratch = '';
let runnerPath = '';

/** One synthetic Codex data root: `<dir>/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
interface Corpus {
  readonly root: string;
  readonly dayDir: string;
}

async function makeCorpus(name: string): Promise<Corpus> {
  const root = resolve(scratch, name);
  const dayDir = resolve(root, 'sessions', '2026', '09', '05');
  await mkdir(dayDir, { recursive: true });
  return { root, dayDir };
}

function sessionMetaLine(threadId: string, cwd: string): string {
  return JSON.stringify({
    timestamp: '2026-09-05T00:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: threadId,
      id: threadId,
      timestamp: '2026-09-05T00:00:00.000Z',
      cwd,
      originator: 'codex_exec',
      cli_version: PINNED_CODEX_VERSION,
      source: 'exec',
      thread_source: 'user',
      model_provider: 'openai',
    },
  });
}

/**
 * A `response_item` / `message` record with `bytes` of padding.
 *
 * `message` rather than `function_call` on purpose: `fingerprint.ts` requires
 * a `call_id` on every `function_call` and `custom_tool_call`, and a corpus
 * that refused at the fingerprint would prove nothing about ingestion. The
 * padding is one repeated character so the generator costs nothing; what is
 * being measured is bytes through the reader, not entropy.
 */
function bulkLine(ordinal: number, padding: string): string {
  return JSON.stringify({
    timestamp: '2026-09-05T00:00:01.000Z',
    ordinal,
    type: 'response_item',
    payload: {
      type: 'message',
      id: `msg_${String(ordinal)}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: padding }],
    },
  });
}

/**
 * Write a Codex-shaped transcript of at least `targetBytes`.
 *
 * Streamed rather than assembled: building 80 MiB of string in the TEST
 * process to prove something about memory in the CHILD would be its own
 * small joke.
 */
async function writeTranscript(path: string, cwd: string, targetBytes: number): Promise<number> {
  const threadId = '01a06400-0000-7000-8000-000000000001';
  const padding = 'x'.repeat(8 * 1024);
  const stream = createWriteStream(path, { encoding: 'utf8' });
  // ONE error listener for the whole file, not one per chunk. Registering it
  // inside the loop below adds ten thousand of them and Node says so —
  // `MaxListenersExceededWarning`, on stderr, in the middle of a test whose
  // subject is memory.
  let failure: Error | null = null;
  stream.on('error', (error: Error) => {
    failure = error;
  });
  const write = (text: string): Promise<void> =>
    new Promise((done, fail) => {
      if (failure !== null) {
        fail(failure);
        return;
      }
      if (stream.write(text)) {
        done();
        return;
      }
      stream.once('drain', done);
    });

  let written = 0;
  const head = `${sessionMetaLine(threadId, cwd)}\n`;
  await write(head);
  written += Buffer.byteLength(head, 'utf8');

  let ordinal = 1;
  while (written < targetBytes) {
    const line = `${bulkLine(ordinal, padding)}\n`;
    await write(line);
    written += Buffer.byteLength(line, 'utf8');
    ordinal += 1;
  }
  await new Promise<void>((done) => {
    stream.end(() => {
      done();
    });
  });
  if (failure !== null) throw failure;
  return written;
}

/**
 * A transcript whose declared size is `targetBytes` but whose CONTENT stops
 * after the head.
 *
 * `truncate` extends the file without writing it, which is what makes a
 * 276 MiB corpus affordable in a unit test.
 *
 * **WHAT THIS FILE DOES NOT PROVE, STATED RATHER THAN IMPLIED.** Its tail is
 * NUL bytes, so an engine that reads it takes one enormous allocation and then
 * DROPS the result at `CODEX_MAX_PARTIAL_BYTES` — measured on `v0.6.0`, which
 * read all 276 MiB of it and survived at 629 MiB RSS. So the crash is not what
 * makes this case fail on unfixed code; the exact counts are. `threads` and
 * `skipped` are asserted to the unit, and `v0.6.0` answers `threads=3
 * skipped=0` where a gated engine answers `threads=2 skipped=1`. A test whose
 * only evidence is a crash it cannot cause would be worse than no test.
 */
async function writeOversize(path: string, cwd: string, targetBytes: number): Promise<number> {
  const threadId = '01a06400-0000-7000-8000-0000000000ff';
  const handle = await open(path, 'w');
  try {
    await handle.write(`${sessionMetaLine(threadId, cwd)}\n`);
    await handle.truncate(targetBytes);
  } finally {
    await handle.close();
  }
  return (await stat(path)).size;
}

interface ChildRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runEngineUnderCap(root: string): ChildRun {
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${String(HEAP_CAP_MB)}`, runnerPath, root],
    { encoding: 'utf8', timeout: 240_000 },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Everything a failure needs to be diagnosable from the reporter alone. */
function describeRun(run: ChildRun): string {
  return [
    `status=${String(run.status)}`,
    `signal=${String(run.signal)}`,
    `stdout=${run.stdout.trim()}`,
    `stderr=${run.stderr.trim().slice(0, 1200)}`,
  ].join('\n');
}

beforeAll(async () => {
  await mkdir(resolve('dist'), { recursive: true });
  scratch = await mkdtemp(resolve('dist', 'codex-memory-'));
  runnerPath = resolve(scratch, 'run-engine.mjs');
  buildSync({
    stdin: { contents: RUNNER_SOURCE, resolveDir: CODEX_DIR, loader: 'ts', sourcefile: 'run.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: runnerPath,
    logLevel: 'silent',
  });
  // A bundle that did not bundle is a green run that measured a different
  // engine. Cheap, and it has caught worse.
  execFileSync(process.execPath, ['--check', runnerPath], { stdio: 'pipe' });
}, 300_000);

afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
});

describe('H.1 — one oversized transcript does not exhaust the host heap', () => {
  let root = '';
  let bytes = 0;

  beforeAll(async () => {
    const corpus = await makeCorpus('h1');
    root = corpus.root;
    bytes = await writeTranscript(
      resolve(corpus.dayDir, 'rollout-2026-09-05T00-00-00-01a06400-0000-7000-8000-000000000001.jsonl'),
      resolve(scratch, 'workspace'),
      80 * MIB,
    );
  }, 300_000);

  it('reads an 80 MiB Codex data root under a 128 MB heap and exits 0', () => {
    // The corpus is smaller than the cap and still unreadable inside it: a
    // buffer, a decoded string and a parsed object graph of the same bytes do
    // not coexist in 128 MB. Pinned so a generator that silently wrote less
    // than it promised cannot make this pass.
    expect(bytes).toBeGreaterThan(79 * MIB);
    expect(bytes).toBeLessThan(HEAP_CAP_MB * MIB);
    const run = runEngineUnderCap(root);
    expect(run.stderr, describeRun(run)).not.toMatch(/heap out of memory/i);
    expect(run.status, describeRun(run)).toBe(0);
    expect(run.stdout, describeRun(run)).toMatch(/^OK /);
    /*
     * SAY WHY IT SURVIVED, AND THE ANSWER CHANGED IN v0.8.0 DoD 7.7.
     *
     * 80 MiB is over the shipped 64 MiB default. It used to be measured from
     * `stat` and never opened, and this test asserted `threads=0 skipped=1`.
     * It is now read as 256 KiB of head plus the last 16 MiB — so the engine
     * DOES open it, DOES parse 16.25 MiB of it, and still has to finish under
     * a 128 MB heap. That is a strictly harder claim than the one this test
     * made before, and a green that did not name its own mechanism would pass
     * just as well if the engine had read the file whole and got lucky.
     */
    expect(run.stdout, describeRun(run)).toMatch(/skipped=0(?![0-9])/);
    expect(run.stdout, describeRun(run)).toMatch(/threads=1(?![0-9])/);
    expect(run.stdout, describeRun(run)).toMatch(/partial=1(?![0-9])/);
    // THE BYTES, so "partial" cannot be satisfied by a read of nothing:
    // 256 KiB + 16 MiB, exactly, against 80 MiB on disk.
    const read = /read=(\d+)/.exec(run.stdout)?.[1];
    expect(Number(read), describeRun(run)).toBe(256 * 1024 + 16 * MIB);
  }, 300_000);
});

describe('H.6 — a 300 MiB data root with one oversize transcript', () => {
  let root = '';
  let total = 0;

  beforeAll(async () => {
    const corpus = await makeCorpus('h6');
    root = corpus.root;
    const cwd = resolve(scratch, 'workspace');
    const a = await writeTranscript(
      resolve(corpus.dayDir, 'rollout-2026-09-05T00-00-01-01a06400-0000-7000-8000-00000000000a.jsonl'),
      cwd,
      12 * MIB,
    );
    const b = await writeTranscript(
      resolve(corpus.dayDir, 'rollout-2026-09-05T00-00-02-01a06400-0000-7000-8000-00000000000b.jsonl'),
      cwd,
      12 * MIB,
    );
    const giant = await writeOversize(
      resolve(corpus.dayDir, 'rollout-2026-09-05T00-00-03-01a06400-0000-7000-8000-0000000000ff.jsonl'),
      cwd,
      300 * MIB - a - b,
    );
    // 12 + 12 + 276. The two under the 64 MiB limit are read whole; the third
    // is read as a head plus its last 16 MiB (DoD 7.7).
    total = a + b + giant;
  }, 300_000);

  it('reads all three under a 128 MB heap and exits 0', () => {
    expect(total).toBeGreaterThanOrEqual(300 * MIB);
    const run = runEngineUnderCap(root);
    expect(run.stderr, describeRun(run)).not.toMatch(/heap out of memory/i);
    expect(run.status, describeRun(run)).toBe(0);
    // All three produce a thread — a green that came only from skipping
    // everything would be a green about nothing.
    expect(run.stdout, describeRun(run)).toMatch(/threads=3\b/);
    expect(run.stdout, describeRun(run)).toMatch(/skipped=0\b/);
    // The 276 MiB one, and only it, is partial. Its tail is NUL bytes with no
    // newline in them, so it yields no record beyond its head — which is a
    // fact about `writeOversize`'s corpus rather than about the engine, and is
    // why the byte figures below are the assertion and a record count is not.
    expect(run.stdout, describeRun(run)).toMatch(/partial=1\b/);
    const read = /read=(\d+)/.exec(run.stdout)?.[1];
    expect(Number(read), describeRun(run)).toBe(256 * 1024 + 16 * MIB);
  }, 300_000);
});
