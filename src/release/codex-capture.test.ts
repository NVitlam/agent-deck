/**
 * PLAN v0.6.0 Phase 1 / DoD 1.3 - the Codex capture procedure.
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * DoD 1.3 names four things: the script reads only `sessions/**` and the hook
 * stream, it refuses a non-scratch `cwd` (G8), it applies the scrub, and it
 * writes a corpus `README.md`. Its last clause is the load-bearing one:
 * "Replay from a clean checkout with `USERPROFILE`/`CODEX_HOME` faked fails
 * loudly (test)."
 *
 * Before this file existed, `grep -rln codex src --include=*.test.ts` returned
 * NOTHING: the G8 refusal had only ever been proven by hand.
 *
 * `USERPROFILE`, NOT `HOME` - AND `CODEX_HOME` ON TOP
 * ---------------------------------------------------
 * `os.homedir()` reads `USERPROFILE` on Windows, so a control faking only
 * `HOME` runs against the REAL data root and reports a confident green pass on
 * the one check whose purpose is proving we never touch it. That is recorded
 * history here (the spike's `RESOLVED 36` false pass). Codex adds a third
 * variable: `CODEX_HOME` relocates the ENTIRE surface - sessions, locks,
 * `hooks.json` and `auth.json` - so all three are faked together, and a decoy
 * test proves the control is aimed at a variable that actually decides.
 *
 * A COLLECTION FAILURE LOOKS LIKE A PASS, SO SUITE 0 EXISTS
 * ---------------------------------------------------------
 * This file imports a `.mjs` script. If that import throws, vitest's summary
 * reads "N skipped", which at a glance is indistinguishable from green - how a
 * shebang on line 1 of a script reached a merged commit with a green report
 * attached. The import is CAUGHT, not thrown, and suite 0 depends on nothing so
 * it still runs and still fails. It reads the script's first bytes with `fs`,
 * deliberately not through the import, because a guard against an import
 * failure must not itself import the broken module.
 *
 * NO SIZES ARE PINNED
 * -------------------
 * Standing repo law: a fixture-set count hard-coded against this capture breaks
 * on the next harvest and reads as a regression. Every assertion below is
 * built from a synthetic corpus this file constructs, or is a relationship
 * derived from the committed corpus rather than a count written down.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* ------------------------------------------------------------------ *
 * The slice of the capture script this suite relies on. Deliberately
 * partial: it names only what is asserted.
 * ------------------------------------------------------------------ */
interface CaptureResult {
  runs: string[];
  versions: string[];
  scrubbedTotal: number;
  foreignDroppedTotal: number;
  readme: string;
  summary: {
    run: string;
    hookKept: number | null;
    hookForeignDropped: number | null;
    models: string[];
  }[];
}

interface CaptureModule {
  capture: (opts: {
    from: string;
    out: string;
    scratch?: string;
    dryRun?: boolean;
    log?: (s: string) => void;
  }) => CaptureResult;
  classifyHookRecord: (record: unknown, ctx?: { run?: string; seq?: number | string }) => string;
  filterHooks: (
    records: unknown[],
    ctx?: { run?: string },
  ) => { kept: unknown[]; dropped: number; total: number; fraction: number };
  NEVER_OPEN: readonly string[];
  CODEX_HOOK_DISCRIMINATOR: string;
  FOREIGN_REFUSE_FRACTION: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'capture-codex.mjs');

/** The platform variable `os.homedir()` actually reads. THIS is the one to fake. */
const HOME_VAR = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
/** The one that does NOT decide the answer on this platform - the decoy. */
const DECOY_VAR = process.platform === 'win32' ? 'HOME' : 'USERPROFILE';

let mod: CaptureModule | null = null;
let loadError: unknown = null;

const tempDirs: string[] = [];

function tmp(prefix: string): string {
  // realpath: libuv aborts the PROCESS when a watched path has an 8.3 short
  // component, and CI runners hand back `RUNNER~1` paths. Nothing here watches,
  // but the same short form also breaks the path comparisons this suite makes.
  const d = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
  tempDirs.push(d);
  return d;
}

/* ------------------------------------------------------------------ *
 * Synthetic corpus builder. Everything the assertions below need is
 * planted here, so each test states its own premise instead of leaning
 * on whatever the last harvest happened to produce.
 * ------------------------------------------------------------------ */

interface PlantOpts {
  run?: string;
  cwd: string;
  cliVersion?: string;
  /** The system prompt to be scrubbed. Omit for none. */
  baseInstructions?: string;
  /** Hook records: `true` = a Codex one, `false` = a foreign (Claude Code) one. */
  hooks?: boolean[];
  /** Plant a record whose two classification signals disagree. */
  conflictingHook?: boolean;
  subagentPath?: string | null;
}

function plantRun(root: string, opts: PlantOpts): string {
  const run = opts.run ?? 'run';
  const runDir = path.join(root, run);
  const sessDir = path.join(runDir, 'home', '.codex', 'sessions', '2026', '09', '03');
  fs.mkdirSync(sessDir, { recursive: true });

  const meta: Record<string, unknown> = {
    id: '01a06400-0000-7000-0000-000000000001',
    cwd: opts.cwd,
    cli_version: opts.cliVersion ?? '0.151.0-alpha.7.2',
    thread_source: 'user',
    model: 'gpt-5.6-terra',
  };
  if (opts.baseInstructions !== undefined) {
    meta.base_instructions = { text: opts.baseInstructions };
  }

  const records: unknown[] = [
    { timestamp: '2026-09-03T00:00:00Z', ordinal: 0, type: 'session_meta', payload: meta },
    {
      timestamp: '2026-09-03T00:00:01Z',
      ordinal: 1,
      type: 'response_item',
      payload: { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'call_x' },
    },
  ];
  fs.writeFileSync(
    path.join(sessDir, 'rollout-2026-09-03T00-00-00-root.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );

  if (opts.subagentPath !== undefined) {
    const sub = {
      timestamp: '2026-09-03T00:00:02Z',
      ordinal: 0,
      type: 'session_meta',
      payload: {
        id: '01a06400-0000-7000-0000-000000000002',
        cwd: opts.cwd,
        cli_version: opts.cliVersion ?? '0.151.0-alpha.7.2',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { agent_path: opts.subagentPath, depth: 1 } } },
      },
    };
    fs.writeFileSync(
      path.join(sessDir, 'rollout-2026-09-03T00-00-02-sub.jsonl'),
      `${JSON.stringify(sub)}\n`,
      'utf8',
    );
  }

  const hooks: unknown[] = [];
  let seq = 0;
  for (const isCodex of opts.hooks ?? []) {
    seq += 1;
    hooks.push(
      isCodex
        ? {
            seq,
            eventName: 'PreToolUse',
            raw: {
              session_id: 's',
              transcript_path: 'C:\\fake\\.codex\\sessions\\x.jsonl',
              model: 'gpt-5.6-terra',
              hook_event_name: 'PreToolUse',
            },
          }
        : {
            seq,
            eventName: 'PreToolUse',
            raw: {
              session_id: 's',
              transcript_path: 'C:\\fake\\.claude\\projects\\x.jsonl',
              hook_event_name: 'PreToolUse',
            },
          },
    );
  }
  if (opts.conflictingHook) {
    seq += 1;
    hooks.push({
      seq,
      eventName: 'PreToolUse',
      // Has the Codex discriminator, but a Claude Code transcript root.
      raw: {
        transcript_path: 'C:\\fake\\.claude\\projects\\x.jsonl',
        model: 'gpt-5.6-terra',
        hook_event_name: 'PreToolUse',
      },
    });
  }
  if (hooks.length > 0) {
    fs.writeFileSync(
      path.join(runDir, 'hook-stream.jsonl'),
      `${hooks.map((h) => JSON.stringify(h)).join('\n')}\n`,
      'utf8',
    );
  }
  return runDir;
}

beforeAll(async () => {
  try {
    mod = (await import(pathToFileURL(SCRIPT).href)) as unknown as CaptureModule;
  } catch (err) {
    loadError = err;
  }
}, 120_000);

afterAll(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/* ================================================================== *
 * SUITE 0 - the script is importable at all.
 * ================================================================== */
describe('0. the capture script loads', () => {
  it('exists on disk', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  it('does not begin with a shebang', () => {
    // vite strips `#!...\n` with a regex whose `.` does not match `\r`, so a
    // shebang breaks collection in a CRLF checkout and ONLY in a CRLF checkout.
    // Read the bytes directly: a guard against an import failure must not
    // itself import the module.
    const head = fs.readFileSync(SCRIPT).subarray(0, 2).toString('latin1');
    expect(head).not.toBe('#!');
  });

  it('imported without throwing', () => {
    expect(loadError, `import failed: ${String(loadError)}`).toBeNull();
    expect(mod).not.toBeNull();
  });

  it('exports what this suite asserts against', () => {
    expect(typeof mod?.capture).toBe('function');
    expect(typeof mod?.classifyHookRecord).toBe('function');
    expect(typeof mod?.filterHooks).toBe('function');
  });
});

/* ================================================================== *
 * SUITE 1 - G8: the corpus is the scratch repo, or there is no corpus.
 * ================================================================== */
describe('1. G8 refusals', () => {
  it('refuses when any transcript cwd is not the scratch repo, and names the offender', () => {
    const from = tmp('cx-foreign-');
    const scratch = path.join(tmp('cx-scratch-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    plantRun(from, { run: 'good', cwd: scratch });
    plantRun(from, { run: 'bad', cwd: path.join(os.homedir(), 'some', 'real', 'project') });

    let thrown: Error | null = null;
    try {
      mod?.capture({ from, out: path.join(tmp('cx-out-'), 'corpus'), scratch });
    } catch (e) { thrown = e as Error; }

    expect(thrown, 'a foreign cwd must refuse').not.toBeNull();
    expect(thrown?.message).toContain('G8 REFUSAL');
    // The refusal must NAME the offending run, not merely count it.
    expect(thrown?.message).toContain('bad');
    expect(thrown?.message).toContain('Nothing was written');
  });

  it('writes nothing when it refuses', () => {
    const from = tmp('cx-nowrite-');
    const scratch = path.join(tmp('cx-scratch2-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    plantRun(from, { run: 'bad', cwd: path.join(os.homedir(), 'elsewhere') });
    const out = path.join(tmp('cx-out2-'), 'corpus');

    try { mod?.capture({ from, out, scratch }); } catch { /* expected */ }
    expect(fs.existsSync(out)).toBe(false);
  });

  it('refuses when --scratch is absent and CODEX_SCRATCH_DIR is unset', () => {
    const from = tmp('cx-noscratch-');
    plantRun(from, { run: 'r', cwd: path.join(os.homedir(), 'x') });
    const saved = process.env.CODEX_SCRATCH_DIR;
    delete process.env.CODEX_SCRATCH_DIR;
    try {
      let thrown: Error | null = null;
      try {
        mod?.capture({ from, out: path.join(tmp('cx-out3-'), 'corpus') });
      } catch (e) { thrown = e as Error; }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).toContain('G8');
    } finally {
      if (saved !== undefined) process.env.CODEX_SCRATCH_DIR = saved;
    }
  });

  it('accepts a corpus whose every cwd IS the scratch repo (the vacuity control)', () => {
    // Without this, every refusal above would also pass if capture() threw
    // unconditionally.
    const from = tmp('cx-ok-');
    const scratch = path.join(tmp('cx-scratch3-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    plantRun(from, { run: 'r', cwd: scratch, hooks: [true, true] });

    const r = mod?.capture({ from, out: path.join(tmp('cx-out4-'), 'corpus'), scratch, log: () => {} });
    expect(r?.runs).toEqual(['r']);
  });
});

/* ================================================================== *
 * SUITE 2 - the faked-home replay control.
 * ================================================================== */
describe('2. faked home / CODEX_HOME replay', () => {
  it('fails loudly rather than falling back to the real ~/.codex', () => {
    const emptyHome = tmp('cx-fakehome-');
    const saved: Record<string, string | undefined> = {
      [HOME_VAR]: process.env[HOME_VAR],
      [DECOY_VAR]: process.env[DECOY_VAR],
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_SCRATCH_DIR: process.env.CODEX_SCRATCH_DIR,
    };
    // All three at once. CODEX_HOME relocates the ENTIRE Codex surface, so a
    // control that fakes only the OS home leaves a second door open.
    process.env[HOME_VAR] = emptyHome;
    process.env[DECOY_VAR] = emptyHome;
    process.env.CODEX_HOME = path.join(emptyHome, '.codex');
    delete process.env.CODEX_SCRATCH_DIR;

    try {
      let thrown: Error | null = null;
      try {
        // A source that does not exist under the faked home. The script must
        // say so, not quietly find the real captures.
        mod?.capture({ from: path.join(emptyHome, 'captures'), out: path.join(emptyHome, 'out') });
      } catch (e) { thrown = e as Error; }

      expect(thrown, 'a missing source under a faked home must fail loudly').not.toBeNull();
      expect(String(thrown?.message)).toMatch(/not found|required|G8/);
      // And nothing may have been written into the faked home.
      expect(fs.existsSync(path.join(emptyHome, 'out'))).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('never reads a live Codex data root: the never-open list is exported and non-empty', () => {
    // G10. The list is the auditable artifact; Phase 2's grep test is the
    // enforcement. Here we only assert it exists and names the secret-bearing
    // files, so a silent truncation of the list fails.
    const never = mod?.NEVER_OPEN ?? [];
    expect(never.length).toBeGreaterThan(0);
    for (const name of ['auth.json', 'installation_id', 'cap_sid']) {
      expect(never, `${name} must be on the never-open list`).toContain(name);
    }
  });
});

/* ================================================================== *
 * SUITE 3 - the scrub.
 * ================================================================== */
describe('3. base_instructions scrub', () => {
  const SYSTEM_PROMPT = 'You are Codex. SECRET-SYSTEM-PROMPT-BODY that must never be committed.';

  function captureWithPrompt(): { out: string; result: CaptureResult | undefined } {
    const from = tmp('cx-scrub-');
    const scratch = path.join(tmp('cx-scratch4-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    plantRun(from, { run: 'r', cwd: scratch, baseInstructions: SYSTEM_PROMPT, hooks: [true] });
    const out = path.join(tmp('cx-out5-'), 'corpus');
    const result = mod?.capture({ from, out, scratch, log: () => {} });
    return { out, result };
  }

  it('replaces the prompt text with {scrubbed, bytes, sha256}', () => {
    const { out, result } = captureWithPrompt();
    expect(result?.scrubbedTotal).toBe(1);

    const written = fs.readFileSync(
      path.join(out, 'r', 'home', '.codex', 'sessions', '2026', '09', '03',
        'rollout-2026-09-03T00-00-00-root.jsonl'),
      'utf8',
    );
    const meta = JSON.parse(written.split('\n')[0] ?? '') as {
      payload: { base_instructions: { scrubbed: boolean; bytes: number; sha256: string } };
    };
    expect(meta.payload.base_instructions.scrubbed).toBe(true);
    expect(meta.payload.base_instructions.bytes).toBe(Buffer.byteLength(SYSTEM_PROMPT, 'utf8'));
    expect(meta.payload.base_instructions.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the original text is absent from every byte written', () => {
    const { out } = captureWithPrompt();
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(out);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(fs.readFileSync(f, 'utf8'), `${f} still carries the prompt`)
        .not.toContain('SECRET-SYSTEM-PROMPT-BODY');
    }
  });

  it('is idempotent: capturing an already-scrubbed corpus changes nothing', () => {
    const { out } = captureWithPrompt();
    const target = path.join(out, 'r', 'home', '.codex', 'sessions', '2026', '09', '03',
      'rollout-2026-09-03T00-00-00-root.jsonl');
    const firstPass = fs.readFileSync(target);

    // Feed the OUTPUT back in as a source.
    const scratch2 = path.join(tmp('cx-scratch5-'), 'scratch');
    fs.mkdirSync(scratch2, { recursive: true });
    // The written corpus carries the original cwd, so point scratch at it.
    const meta = JSON.parse(firstPass.toString('utf8').split('\n')[0] ?? '') as { payload: { cwd: string } };
    const out2 = path.join(tmp('cx-out6-'), 'corpus');
    mod?.capture({ from: out, out: out2, scratch: meta.payload.cwd, log: () => {} });

    const secondPass = fs.readFileSync(path.join(out2, 'r', 'home', '.codex', 'sessions',
      '2026', '09', '03', 'rollout-2026-09-03T00-00-00-root.jsonl'));
    expect(secondPass.equals(firstPass)).toBe(true);
  });
});

/* ================================================================== *
 * SUITE 4 - the foreign-engine hook filter.
 *
 * Both engines POST to ONE loopback listener, and this repository's own
 * Claude Code hook block is live and unconditional, so a harvest captures
 * Claude Code traffic. Measured on the real Phase 1 captures: 18 foreign
 * records across 4 of 9 runs, one batch injected by a Claude Code SUBAGENT.
 * ================================================================== */
describe('4. foreign-engine hook filtering', () => {
  it('classifies by the same discriminator the Phase 3 listener will use', () => {
    // If these two drift apart, the capture and the listener disagree about
    // what a Codex event is - one defect, not two.
    expect(mod?.CODEX_HOOK_DISCRIMINATOR).toBe('model');
  });

  it('keeps Codex records and drops foreign ones, reporting the count', () => {
    const from = tmp('cx-mix-');
    const scratch = path.join(tmp('cx-scratch6-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    // 5 Codex, 2 foreign - deliberately under the refusal threshold.
    plantRun(from, { run: 'r', cwd: scratch, hooks: [true, true, false, true, true, false, true] });

    const logged: string[] = [];
    const out = path.join(tmp('cx-out7-'), 'corpus');
    const r = mod?.capture({ from, out, scratch, log: (s) => logged.push(s) });

    expect(r?.foreignDroppedTotal).toBe(2);
    expect(r?.summary[0]?.hookKept).toBe(5);
    expect(r?.summary[0]?.hookForeignDropped).toBe(2);

    // Rule 18: the drop is STATED, with a count and a reason - never silent.
    const line = logged.join('\n');
    expect(line).toContain('2');
    expect(line).toMatch(/foreign/i);

    // And the written stream carries only the Codex records.
    const written = fs.readFileSync(path.join(out, 'r', 'hook-stream.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim());
    expect(written.length).toBe(5);
    for (const l of written) {
      expect(JSON.parse(l).raw).toHaveProperty('model');
    }
  });

  it('VACUITY CONTROL: a clean stream loses nothing and reports zero', () => {
    // Without this, a filter that deleted everything would pass the test above.
    const from = tmp('cx-clean-');
    const scratch = path.join(tmp('cx-scratch7-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    plantRun(from, { run: 'r', cwd: scratch, hooks: [true, true, true] });

    const logged: string[] = [];
    const out = path.join(tmp('cx-out8-'), 'corpus');
    const r = mod?.capture({ from, out, scratch, log: (s) => logged.push(s) });

    expect(r?.foreignDroppedTotal).toBe(0);
    expect(r?.summary[0]?.hookKept).toBe(3);
    const written = fs.readFileSync(path.join(out, 'r', 'hook-stream.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim());
    expect(written.length).toBe(3);
    // Nothing to report, so nothing is reported.
    expect(logged.join('\n')).not.toMatch(/dropped/i);
  });

  it('REFUSES a stream that is mostly foreign, and the message names the threshold', () => {
    const from = tmp('cx-majority-');
    const scratch = path.join(tmp('cx-scratch8-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    plantRun(from, { run: 'mostly-foreign', cwd: scratch, hooks: [true, false, false, false] });

    let thrown: Error | null = null;
    try {
      mod?.capture({ from, out: path.join(tmp('cx-out9-'), 'corpus'), scratch, log: () => {} });
    } catch (e) { thrown = e as Error; }

    expect(thrown, 'a mostly-foreign stream must refuse').not.toBeNull();
    expect(thrown?.message).toContain('mostly-foreign');
    expect(thrown?.message).toContain(String((mod?.FOREIGN_REFUSE_FRACTION ?? 0.5) * 100));
    expect(thrown?.message).toContain('Nothing was written');
  });

  it('the refusal row does NOT tick on a PROMPT that merely says "already exists"', () => {
    // Found by mutation: reverting the predicate to a bare substring search over the
    // whole record passed every other test here, while on the REAL corpus it ticked
    // the refusal row for `long-output` — whose prompt happens to read "The file
    // big.txt already exists". A checklist row passing on the operator's own prose is
    // the vacuous-assertion class, so it gets its own guard.
    const from = tmp('cx-refusal-');
    const scratch = path.join(tmp('cx-scratchD-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const runDir = plantRun(from, { run: 'prompt-says-it', cwd: scratch, hooks: [true] });

    // A user message containing the words, and NO engine refusal anywhere.
    const sess = path.join(runDir, 'home', '.codex', 'sessions', '2026', '09', '03');
    fs.appendFileSync(
      path.join(sess, 'rollout-2026-09-03T00-00-00-root.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-09-03T00:00:03Z',
        ordinal: 2,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'The file big.txt already exists. Do not create it.' }],
        },
      })}\n`,
      'utf8',
    );

    const out = path.join(tmp('cx-outD-'), 'corpus');
    mod?.capture({ from, out, scratch, log: () => {} });
    const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
    const refusalRow = readme.split('\n').find((l) => l.includes('duplicate agent_path refused'));
    expect(refusalRow).toBeDefined();
    expect(refusalRow, 'the prompt own words must not tick the refusal row').toContain('**NO**');
  });

  it('treats disagreeing signals as a hard error, never a tiebreak', () => {
    // A record carrying `model` but a `.claude` transcript root means one of the
    // two assumptions has moved. Picking a winner would bury that.
    let thrown: Error | null = null;
    try {
      mod?.filterHooks(
        [{ seq: 1, raw: { model: 'gpt-5.6-terra', transcript_path: 'C:\\x\\.claude\\p\\y.jsonl' } }],
        { run: 'conflicted' },
      );
    } catch (e) { thrown = e as Error; }

    expect(thrown, 'disagreeing signals must throw').not.toBeNull();
    expect(thrown?.message).toMatch(/conflict/i);
    expect(thrown?.message).toContain('conflicted');
  });

  it('classifies a record with no transcript_path by the discriminator alone', () => {
    // The listener will have to do the same, so the fallback is asserted rather
    // than left to chance.
    expect(mod?.classifyHookRecord({ raw: { model: 'gpt-5.5' } })).toBe('codex');
    expect(mod?.classifyHookRecord({ raw: { session_id: 'x' } })).toBe('foreign');
  });
});

/* ================================================================== *
 * SUITE 5 - the corpus README is DERIVED, not decorative.
 * ================================================================== */
describe('5. corpus README', () => {
  function buildIncomplete(): { out: string; result: CaptureResult | undefined } {
    const from = tmp('cx-readme-');
    const scratch = path.join(tmp('cx-scratch9-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    // Deliberately INCOMPLETE: no depth-2, no long output, no double stop.
    plantRun(from, { run: 'thin', cwd: scratch, hooks: [true], subagentPath: '/root/a' });
    const out = path.join(tmp('cx-outA-'), 'corpus');
    const result = mod?.capture({ from, out, scratch, log: () => {} });
    return { out, result };
  }

  it('is written to the corpus root', () => {
    const { out } = buildIncomplete();
    expect(fs.existsSync(path.join(out, 'README.md'))).toBe(true);
  });

  it('states the version it derived from the transcripts', () => {
    const { out } = buildIncomplete();
    const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
    expect(readme).toContain('0.151.0-alpha.7.2');
  });

  it('marks a corpus MIXED when the runs disagree on cli_version', () => {
    const from = tmp('cx-mixed-');
    const scratch = path.join(tmp('cx-scratchB-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    plantRun(from, { run: 'a', cwd: scratch, cliVersion: '0.151.0-alpha.7.2', hooks: [true] });
    plantRun(from, { run: 'b', cwd: scratch, cliVersion: '0.152.0', hooks: [true] });
    const out = path.join(tmp('cx-outB-'), 'corpus');
    mod?.capture({ from, out, scratch, log: () => {} });

    const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
    expect(readme).toContain('MIXED');
    // Both are listed rather than one being silently picked.
    expect(readme).toContain('0.152.0');
  });

  it('THE CHECKLIST IS DERIVED: an incomplete corpus produces unticked rows', () => {
    // This is the test that makes the checklist evidence rather than decoration.
    // A hardcoded checklist would tick every row here.
    const { out } = buildIncomplete();
    const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
    expect(readme).toContain('**NO**');
    // Specifically: this corpus has no >=200,000-byte record.
    const longRow = readme.split('\n').find((l) => l.includes('long-output'));
    expect(longRow).toBeDefined();
    expect(longRow).toContain('**NO**');
  });

  it('records the model per run, and says it is not the provenance anchor', () => {
    const { out } = buildIncomplete();
    const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
    expect(readme).toContain('gpt-5.6-terra');
    // The claim that matters: a model change does not move the G9 anchor.
    expect(readme).toMatch(/does not read the model/i);
    expect(readme).toContain('cli_version');
  });

  it('reports the foreign-record drop in the README, not only on stdout', () => {
    const from = tmp('cx-readmedrop-');
    const scratch = path.join(tmp('cx-scratchC-'), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    plantRun(from, { run: 'r', cwd: scratch, hooks: [true, true, false] });
    const out = path.join(tmp('cx-outC-'), 'corpus');
    mod?.capture({ from, out, scratch, log: () => {} });

    const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
    expect(readme).toMatch(/Foreign hook records dropped:\*{0,2}\s*1/);
  });
});
