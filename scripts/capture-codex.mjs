/**
 * capture-codex.mjs — turn a lab capture into a committable Codex fixture corpus.
 *
 * Phase 1 DoD 1.3. The counterpart of `scripts/capture-opencode.mjs`, and it holds
 * the same line: the LAB holds unredacted captures, `fixtures/` holds redacted ones,
 * and this script is the only door between them.
 *
 * WHAT IT READS. Exactly two things per run, both produced by
 * `lab/scripts/codex-drive.mjs`:
 *   - `home/.codex/sessions/**\/*.jsonl`   the rollout transcripts
 *   - `hook-stream.jsonl`                  the listener's own record of the hook POSTs
 * It never reads a live `~/.codex`, never opens a `*.sqlite`, and never touches
 * `auth.json`, `.sandbox-secrets/`, `installation_id` or `cap_sid` (G10).
 *
 * WHAT IT REFUSES. G8 is enforced here, not hoped for: if ANY transcript's
 * `session_meta.payload.cwd` is not the scratch repo, the run aborts and writes
 * nothing. A corpus is only committable when every session in it belongs to the
 * throwaway probe repo.
 *
 * node: builtins only, so the fixture pipeline never depends on the app's deps.
 *
 * Usage:
 *   node scripts/capture-codex.mjs --from <lab captures dir> --out fixtures/codex-<version>
 *                                  [--scratch <abs path>] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Files under a Codex data root this script must never open. G10. */
export const NEVER_OPEN = Object.freeze([
  'auth.json',
  '.sandbox-secrets',
  'installation_id',
  'cap_sid',
  '*.sqlite',
  '*.sqlite-wal',
  '*.sqlite-shm',
]);

const SCRUB_KEY = 'base_instructions';

/** Every *.jsonl under a directory, recursively, sorted for determinism. */
function jsonlFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const records = [];
  let malformed = 0;
  for (const l of lines) {
    try { records.push(JSON.parse(l)); } catch { malformed += 1; }
  }
  return { records, malformed, lineCount: lines.length };
}

/**
 * Replace the OpenAI system prompt with a digest stub.
 *
 * Everything else is left byte-exact — ids, call_ids, agent_paths, ordinals,
 * timestamps — and the ENCRYPTED reasoning and spawn-message bytes stay verbatim,
 * because they are the evidence a G4 test asserts against (see the spec's C7).
 */
function scrubRecord(rec) {
  const bi = rec?.payload?.[SCRUB_KEY];
  if (!bi || typeof bi.text !== 'string') return { rec, scrubbed: 0 };
  const text = bi.text;
  return {
    rec: {
      ...rec,
      payload: {
        ...rec.payload,
        [SCRUB_KEY]: {
          scrubbed: true,
          bytes: Buffer.byteLength(text, 'utf8'),
          sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        },
      },
    },
    scrubbed: 1,
  };
}

/** G8: every transcript's cwd must be the scratch repo. Returns offending paths. */
function foreignCwds(transcripts, scratch) {
  const want = path.resolve(scratch).toLowerCase();
  const bad = [];
  for (const t of transcripts) {
    for (const rec of t.records) {
      if (rec?.type !== 'session_meta') continue;
      const cwd = rec?.payload?.cwd;
      if (typeof cwd !== 'string') continue;
      if (path.resolve(cwd).toLowerCase() !== want) bad.push({ file: t.rel, cwd });
    }
  }
  return bad;
}

function parseArgs(argv) {
  const a = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') a.from = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--scratch') a.scratch = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
  }
  return a;
}

export function capture({ from, out, scratch, dryRun = false, log = console.log }) {
  if (!from || !out) throw new Error('--from and --out are required');
  if (!fs.existsSync(from)) throw new Error(`capture source not found: ${from}`);

  const runs = fs.readdirSync(from, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (runs.length === 0) throw new Error(`no run directories under ${from}`);

  // ---- read -----------------------------------------------------------------
  const collected = [];
  for (const run of runs) {
    const runDir = path.join(from, run);
    const sessionsRoot = path.join(runDir, 'home', '.codex', 'sessions');
    const transcripts = jsonlFiles(sessionsRoot).map((f) => ({
      abs: f,
      rel: path.relative(runDir, f).replace(/\\/g, '/'),
      ...readJsonl(f),
    }));
    const hookFile = path.join(runDir, 'hook-stream.jsonl');
    const hooks = fs.existsSync(hookFile) ? readJsonl(hookFile) : null;
    collected.push({ run, runDir, transcripts, hooks });
  }

  // ---- refuse ---------------------------------------------------------------
  const resolvedScratch = scratch ?? process.env.CODEX_SCRATCH_DIR;
  if (!resolvedScratch) {
    throw new Error('G8: --scratch (or CODEX_SCRATCH_DIR) is required; a corpus is only '
      + 'committable when every session is provably the probe repo');
  }
  const offenders = collected.flatMap((c) => foreignCwds(c.transcripts, resolvedScratch)
    .map((o) => ({ run: c.run, ...o })));
  if (offenders.length > 0) {
    const detail = offenders.slice(0, 5).map((o) => `  ${o.run}/${o.file}: ${o.cwd}`).join('\n');
    throw new Error(`G8 REFUSAL: ${String(offenders.length)} session(s) are not the scratch repo.\n`
      + `${detail}\nNothing was written.`);
  }

  const missingHooks = collected.filter((c) => c.hooks === null).map((c) => c.run);
  if (missingHooks.length > 0) {
    // Rule 18: a skip is stated, never silent.
    log(`WARNING: no hook stream for: ${missingHooks.join(', ')}`);
  }

  // ---- scrub + write --------------------------------------------------------
  const summary = [];
  let scrubbedTotal = 0;
  for (const c of collected) {
    const files = [];
    for (const t of c.transcripts) {
      const scrubbedRecs = [];
      let n = 0;
      for (const rec of t.records) {
        const { rec: r, scrubbed } = scrubRecord(rec);
        scrubbedRecs.push(r);
        n += scrubbed;
      }
      scrubbedTotal += n;
      const dest = path.join(out, c.run, t.rel);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, `${scrubbedRecs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
      }
      files.push({ rel: t.rel, records: t.records.length, malformed: t.malformed, scrubbed: n });
    }
    if (c.hooks) {
      const dest = path.join(out, c.run, 'hook-stream.jsonl');
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(c.runDir, 'hook-stream.jsonl'), dest);
      }
    }
    summary.push({
      run: c.run,
      transcripts: files,
      hookEvents: c.hooks ? c.hooks.records.length : null,
      hookMalformed: c.hooks ? c.hooks.malformed : null,
    });
  }

  // Anchor version: from the transcripts, never from a binary.
  const versions = new Set();
  for (const c of collected) {
    for (const t of c.transcripts) {
      for (const rec of t.records) {
        if (rec?.type === 'session_meta' && rec?.payload?.cli_version) versions.add(rec.payload.cli_version);
      }
    }
  }

  return { runs, summary, versions: [...versions].sort(), scrubbedTotal, out, dryRun };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const r = capture({ ...args, scratch: args.scratch });
    console.log(JSON.stringify({
      runs: r.runs, versions: r.versions, scrubbed: r.scrubbedTotal, dryRun: r.dryRun,
    }, null, 2));
    for (const s of r.summary) {
      console.log(`${s.run}: ${String(s.transcripts.length)} transcript(s), `
        + `${String(s.hookEvents ?? 0)} hook event(s), ${String(s.hookMalformed ?? 0)} malformed`);
    }
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
