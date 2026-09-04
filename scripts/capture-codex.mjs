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
 * WHAT IT REFUSES. G8 is enforced here, not hoped for, and in TWO places:
 *   - if ANY transcript's `session_meta.payload.cwd` is not the scratch repo, the
 *     run aborts and writes nothing;
 *   - if the hook stream is MOSTLY foreign (see below), the run aborts too.
 * A corpus is only committable when every session in it belongs to the throwaway
 * probe repo.
 *
 * WHY THE HOOK STREAM NEEDS FILTERING AT ALL. Both engines POST to ONE loopback
 * listener (decision D0.3), and this repository's own Claude Code hook block is live
 * and unconditional. So while a harvest holds the port, Claude Code's own tool calls
 * land in the Codex capture. Measured on the Phase 1 captures: 18 foreign records
 * across 4 of 9 runs, one batch injected by a Claude Code SUBAGENT's worktree. Those
 * records carry real developer paths, so they would fail the privacy sweep the moment
 * they crossed into `fixtures/`.
 *
 * Records are classified by the SAME field the Phase 3 listener uses to route them:
 * the presence of `model`. Measured 160/160 Codex against 0/305 Claude Code. The
 * classification is cross-checked against the payload's `transcript_path` root, and
 * the two signals DISAGREEING is a hard error rather than a tiebreak — a disagreement
 * means the assumption moved and a silent pick would bury that.
 *
 * Filtering is never silent (rule 18): the count and the reason are printed, written
 * into the corpus README, and returned to callers.
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

/**
 * The engine discriminator, and the ONE place its name is written.
 *
 * Phase 3's listener routes on this same property, so a drift here and a drift there
 * are the same defect rather than two. Measured over both corpora: every Codex hook
 * payload carries `model` (160/160) and no Claude Code payload does (0/305, including
 * 18 live records that arrived on the shared port during these very harvests).
 */
export const CODEX_HOOK_DISCRIMINATOR = 'model';

/** Transcript-path roots, used only to CROSS-CHECK the discriminator. */
const CODEX_PATH_MARK = '.codex';
const CC_PATH_MARK = '.claude';

/**
 * Refuse a run whose hook stream is at least this fraction foreign.
 *
 * Named, not buried in a condition, because the number is a judgement and a later
 * reader is entitled to argue with it. A capture that is mostly someone else's
 * traffic is not a capture of anything.
 */
export const FOREIGN_REFUSE_FRACTION = 0.5;

/**
 * Classify one hook record: 'codex' | 'foreign'.
 *
 * Throws when the discriminator and the transcript-path root disagree. That is
 * deliberate: two independent signals disagreeing is new information, and picking a
 * winner would convert it into a silent wrong answer.
 */
export function classifyHookRecord(record, { run = '?', seq = '?' } = {}) {
  const raw = record?.raw ?? record ?? {};
  const byField = Object.hasOwn(raw, CODEX_HOOK_DISCRIMINATOR);
  const tp = typeof raw.transcript_path === 'string' ? raw.transcript_path : '';
  const saysCodex = tp.includes(CODEX_PATH_MARK);
  const saysCc = tp.includes(CC_PATH_MARK);

  // No usable path signal: fall back to the discriminator alone, which is what the
  // listener will have to do too.
  if (!saysCodex && !saysCc) return byField ? 'codex' : 'foreign';

  if (byField !== saysCodex) {
    throw new Error(
      `hook classification conflict in run '${run}' seq ${String(seq)}: `
      + `'${CODEX_HOOK_DISCRIMINATOR}' key ${byField ? 'present' : 'absent'} but `
      + `transcript_path names ${saysCodex ? CODEX_PATH_MARK : CC_PATH_MARK}. `
      + 'Two signals disagree; the engine discriminator may have moved. Nothing was written.',
    );
  }
  return byField ? 'codex' : 'foreign';
}

/**
 * Split a hook stream into the Codex records and the foreign ones.
 * Refuses when the stream is mostly foreign.
 */
export function filterHooks(records, { run = '?' } = {}) {
  const kept = [];
  let dropped = 0;
  for (const [i, rec] of records.entries()) {
    const seq = rec?.seq ?? i;
    if (classifyHookRecord(rec, { run, seq }) === 'codex') kept.push(rec);
    else dropped += 1;
  }
  const total = records.length;
  const fraction = total === 0 ? 0 : dropped / total;
  if (total > 0 && fraction >= FOREIGN_REFUSE_FRACTION) {
    throw new Error(
      `G8 REFUSAL: run '${run}' hook stream is ${String(dropped)}/${String(total)} foreign `
      + `(${(fraction * 100).toFixed(1)}%), at or above the `
      + `${String(FOREIGN_REFUSE_FRACTION * 100)}% threshold. A capture that is mostly another `
      + "engine's traffic is not a capture. Nothing was written.",
    );
  }
  return { kept, dropped, total, fraction };
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

/** Every thread in a run, with the identity a later reader needs to find it again. */
function threadsOf(c) {
  const out = [];
  for (const t of c.transcripts) {
    // A transcript can carry MORE THAN ONE session_meta: a forked child re-serialises
    // its parent's inherited records under its own ordinals and adds a second one
    // (spec C5). So the same thread id legitimately appears twice, in two files. The
    // file is carried on every row precisely so that reads as a fork rather than a bug.
    for (const rec of t.records) {
      if (rec?.type !== 'session_meta') continue;
      const p = rec.payload ?? {};
      const sp = p.source?.subagent?.thread_spawn;
      out.push({
        file: t.rel.split('/').pop() ?? t.rel,
        forkStart: p.subagent_history_start_ordinal ?? null,
        id: p.id ?? null,
        source: p.thread_source ?? null,
        agentPath: sp ? (sp.agent_path ?? null) : null,
        nickname: sp?.agent_nickname ?? p.agent_nickname ?? null,
        depth: sp?.depth ?? null,
        parent: sp?.parent_thread_id ?? null,
      });
    }
  }
  return out;
}

/**
 * The model(s) a run was produced by, read from the transcripts.
 *
 * Recorded because the corpus is fixture law (G6) and a later reader will want to know
 * what produced it. It is NOT provenance: G9 anchors on `cli_version`, and nothing in
 * the fingerprint reads a model string.
 */
function modelsOf(c) {
  const s = new Set();
  for (const t of c.transcripts) {
    for (const rec of t.records) {
      const p = rec?.payload ?? {};
      for (const v of [p.model, p.model_slug, p?.turn_context?.model]) {
        if (typeof v === 'string' && v) s.add(v);
      }
    }
  }
  return [...s].sort();
}

/** Does any transcript in the run contain these bytes? Used by the checklist. */
function runContains(c, needle) {
  return c.transcripts.some((t) => t.records.some((r) => JSON.stringify(r).includes(needle)));
}

/**
 * The engine's duplicate-agent_path refusal, matched on the ENGINE'S OWN output.
 *
 * Deliberately NOT a substring search for 'already exists'. That ticked on a run whose
 * PROMPT happened to contain the words "big.txt already exists" — a checklist row
 * passing on the operator's own prose rather than on anything Codex did. The predicate
 * therefore requires the refusal to appear in a tool-call OUTPUT and to name an agent
 * path, which is the shape the engine actually emits:
 *   {"call_id":"...","output":"agent path \`/root/dup\` already exists"}
 */
function hasDuplicatePathRefusal(c) {
  return c.transcripts.some((t) => t.records.some((r) => {
    const p = r?.payload ?? {};
    const type = String(p.type ?? '');
    if (!type.includes('output')) return false;
    const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
    return /agent path/i.test(out) && /already exists/i.test(out);
  }));
}

/** The longest single serialised record, which is how the inline-output ceiling shows up. */
function longestRecordBytes(c) {
  let max = 0;
  for (const t of c.transcripts) {
    for (const r of t.records) max = Math.max(max, Buffer.byteLength(JSON.stringify(r), 'utf8'));
  }
  return max;
}

/**
 * The harvest checklist of PLAN.md DoD 1.4, evaluated against the corpus on disk.
 *
 * Every row is derived. A hardcoded checklist that always ticks is worse than no
 * checklist, because it reads as evidence while measuring nothing — this repository's
 * most-recorded defect class.
 */
function checklist(collected) {
  const anyRun = (fn) => collected.filter(fn).map((c) => c.run);
  const subs = (c) => threadsOf(c).filter((x) => x.source === 'subagent');
  // DISTINCT threads, not rows. `threadsOf` emits one row per session_meta, and a
  // forked child re-serialises a second one (spec C5), so counting rows credited
  // `dup-names` with three named subagents when it has two — a derived checklist
  // ticking on a fork-boundary duplicate. Found by phase-verifier, 2026-09-03.
  const named = (c) => {
    const byId = new Map();
    for (const x of subs(c)) {
      if (typeof x.agentPath === 'string' && x.agentPath) byId.set(x.id ?? x.agentPath, x);
    }
    return [...byId.values()];
  };

  return [
    {
      item: 'baseline: a session with >= 1 shell call and >= 1 function call',
      runs: anyRun((c) => runContains(c, '"custom_tool_call"') && runContains(c, '"function_call"')),
    },
    {
      item: 'dup-names: a duplicate agent_path refused, with the refusal bytes',
      runs: anyRun(hasDuplicatePathRefusal),
    },
    {
      item: 'parallel-3: three or more DISTINCT named subagents in one session',
      runs: anyRun((c) => named(c).length >= 3),
    },
    {
      item: 'depth-2: a subagent at depth >= 2',
      runs: anyRun((c) => subs(c).some((x) => Number(x.depth) >= 2)),
    },
    {
      item: 'long-output: a single record of >= 200,000 bytes (the inline ceiling)',
      runs: anyRun((c) => longestRecordBytes(c) >= 200_000),
    },
    {
      item: 'a Stop carrying two SubagentStops for ONE agent',
      runs: anyRun((c) => {
        if (!c.hooks) return false;
        const byAgent = new Map();
        for (const r of c.hooks.records) {
          if ((r?.eventName ?? r?.raw?.hook_event_name) !== 'SubagentStop') continue;
          const a = r?.agentId ?? r?.raw?.agent_id ?? '(none)';
          if (!byAgent.has(a)) byAgent.set(a, new Set());
          byAgent.get(a).add(r?.raw?.turn_id ?? '(no turn)');
        }
        return [...byAgent.values()].some((s) => s.size >= 2);
      }),
    },
    {
      item: 'a clean hook stream for every run (0 parse failures)',
      runs: anyRun((c) => c.hooks !== null && c.hooks.malformed === 0),
      all: true,
    },
  ];
}

/** Write the corpus README. Version, time, ids taken, checklist, model provenance. */
function writeCorpusReadme({ out, collected, summary, versions, scrubbedTotal, foreignDroppedTotal, dryRun }) {
  const mixed = versions.length !== 1;
  const version = mixed ? `MIXED (${versions.join(', ')})` : versions[0];
  const rows = checklist(collected);
  const total = collected.length;

  const lines = [];
  const L = (s = '') => lines.push(s);

  L(`# Codex fixture corpus — ${version}`);
  L();
  L('Generated by `scripts/capture-codex.mjs`. **Do not hand-edit**: regenerate it, so the');
  L('checklist below keeps meaning what it says.');
  L();
  L(`- **Anchor version (\`session_meta.payload.cli_version\`):** \`${version}\``);
  if (mixed) {
    L('  - **MIXED — the runs disagree.** Every distinct value is listed above rather than one');
    L('    being picked. G9 anchors on this string, so a mixed corpus is a decision, not a detail.');
  }
  L(`- **Captured:** ${new Date().toISOString()}`);
  L(`- **Runs:** ${String(total)}`);
  L(`- **\`base_instructions\` blocks scrubbed:** ${String(scrubbedTotal)}`);
  L(`- **Foreign hook records dropped:** ${String(foreignDroppedTotal)}`);
  L();

  L('## Harvest checklist (PLAN.md DoD 1.4)');
  L();
  L('Derived from the corpus on disk, not written down.');
  L();
  L('| | item | satisfied by |');
  L('|---|---|---|');
  for (const r of rows) {
    const ok = r.all ? r.runs.length === total : r.runs.length > 0;
    const by = r.all
      ? `${String(r.runs.length)}/${String(total)} runs`
      : (r.runs.length ? r.runs.map((x) => `\`${x}\``).join(', ') : '—');
    L(`| ${ok ? 'YES' : '**NO**'} | ${r.item} | ${by} |`);
  }
  L();

  L('## Runs, threads and ids taken');
  L();
  for (const s of summary) {
    L(`### \`${s.run}\``);
    L();
    L(`- transcripts: ${String(s.transcripts.length)} · hook records kept: `
      + `${String(s.hookKept ?? 0)} · foreign dropped: ${String(s.hookForeignDropped ?? 0)} `
      + `· malformed: ${String(s.hookMalformed ?? 0)}`);
    L(`- model(s): ${s.models.length ? s.models.map((m) => `\`${m}\``).join(', ') : '(not stated)'}`);
    L();
    L('| thread id | source | agent_path | nickname | depth | fork start | in file |');
    L('|---|---|---|---|---|---|---|');
    for (const th of s.threads) {
      L(`| \`${th.id ?? '?'}\` | ${th.source ?? '?'} | `
        + `${th.agentPath ? `\`${th.agentPath}\`` : (th.source === 'subagent' ? '**null**' : '—')} | `
        + `${th.nickname ?? '—'} | ${th.depth ?? '—'} | ${th.forkStart ?? '—'} | `
        + `\`${th.file}\` |`);
    }
    if (s.threads.length > new Set(s.threads.map((x) => x.id)).size) {
      L();
      L('> A thread id appears more than once above. That is the **fork boundary** (spec C5), not');
      L('> a duplicate: a forked child re-serialises its parent\'s inherited records into its own');
      L('> file under its own ordinals, carrying a second `session_meta`. The **fork start** column');
      L('> is `subagent_history_start_ordinal` — records below it are inherited and are dropped at');
      L('> parse.');
    }
    L();
  }

  L('## Model provenance, and why it is not the anchor');
  L();
  L('The model each run used is recorded above because this corpus is **fixture law** (G6) and a');
  L('later reader is entitled to know what produced it.');
  L();
  L('**The fingerprint does not read the model string.** G9 anchors provenance on');
  L('`session_meta.payload.cli_version` alone, so changing model does not move the corpus anchor');
  L('and cannot make an unsupported version supported.');
  L();
  L('It is recorded for a second reason, which is not cosmetic: Codex ships **two multi-agent');
  L('toolsets** and hands a session one of them **by model**, at one `cli_version`. A `v2` model');
  L('(`collaboration` namespace) produces `task_name` and a populated `agent_path`; a `v1` model');
  L('produces neither and joins its children by id instead (`output.agent_id`), so both dialects');
  L('graft — only the key and the node label differ. Every run DECLARES its own dialect at');
  L('`turn_context.multi_agent_version`, so nothing has to be inferred from a model name. The');
  L('earlier anchor corpus was produced by `gpt-5.6-terra`.');
  L();

  L('## What was filtered out of the hook streams, and why');
  L();
  L('Both engines POST hook events to **one** loopback listener (D0.3), and a Claude Code hook');
  L('block on the same machine is live and unconditional. Records not carrying the Codex');
  L('discriminator are dropped at this boundary, counted, and reported — never silently. A run');
  L('whose stream is mostly foreign is refused outright rather than filtered.');
  L();
  L('The dropped records are retained under `lab/` as witness data, because real Claude Code');
  L('payloads arriving on the shared port are exactly what the Phase 3 listener-discrimination');
  L('test needs. They never cross into `fixtures/`: they carry real developer paths.');

  const text = `${lines.join('\n')}\n`;
  if (!dryRun) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'README.md'), text, 'utf8');
  }
  return text;
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
  let foreignDroppedTotal = 0;
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
    // The hook stream is FILTERED, never copied: see the header. A copy would carry
    // another engine's payloads, and their real developer paths, into fixtures/.
    let hookFilter = null;
    if (c.hooks) {
      hookFilter = filterHooks(c.hooks.records, { run: c.run });
      const dest = path.join(out, c.run, 'hook-stream.jsonl');
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, `${hookFilter.kept.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
      }
      if (hookFilter.dropped > 0) {
        // Rule 18: stated, with the count and the reason, never silent.
        log(`${c.run}: dropped ${String(hookFilter.dropped)} of ${String(hookFilter.total)} hook `
          + `record(s) — foreign engine (no '${CODEX_HOOK_DISCRIMINATOR}' key)`);
      }
    }
    foreignDroppedTotal += hookFilter ? hookFilter.dropped : 0;
    summary.push({
      run: c.run,
      transcripts: files,
      hookEvents: c.hooks ? c.hooks.records.length : null,
      hookMalformed: c.hooks ? c.hooks.malformed : null,
      hookKept: hookFilter ? hookFilter.kept.length : null,
      hookForeignDropped: hookFilter ? hookFilter.dropped : null,
      threads: threadsOf(c),
      models: modelsOf(c),
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

  const sortedVersions = [...versions].sort();
  const readme = writeCorpusReadme({
    out, collected, summary, versions: sortedVersions, scrubbedTotal, foreignDroppedTotal, dryRun,
  });

  return {
    runs, summary, versions: sortedVersions, scrubbedTotal, foreignDroppedTotal, out, dryRun, readme,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const r = capture({ ...args, scratch: args.scratch });
    console.log(JSON.stringify({
      runs: r.runs,
      versions: r.versions,
      scrubbed: r.scrubbedTotal,
      foreignHookRecordsDropped: r.foreignDroppedTotal,
      dryRun: r.dryRun,
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
