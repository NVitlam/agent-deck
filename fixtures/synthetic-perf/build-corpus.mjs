// Builds the SYNTHETIC perf corpus. Run from anywhere:
//
//   node fixtures/synthetic-perf/build-corpus.mjs --out <dir> [--lines N]
//                                                [--subagents K] [--seed S]
//
// THIS IS NOT THE DoD's HARVEST. Read `fixtures/synthetic-perf/README.md`
// before quoting any number produced from this corpus. PLAN's Phase 4 answers
// "where does the >=10k-line session come from?" with "a live extended R2 run,
// harvested -- not synthesised", and explicitly refuses to let a
// programmatically amplified transcript count. This generator exists so the
// harness in `src/perf/` is runnable and threshold-asserted BEFORE that
// harvest lands, and so the harvest can be dropped in by setting one env var
// instead of by editing code.
//
// Nothing is written into the repo tree. `--out` is required and the harness
// always points it at an OS temp directory.
//
// Determinism is load-bearing: `Date.now()` and `Math.random()` appear nowhere
// here. Every varying value comes from the seeded LCG below and every
// timestamp from a fixed epoch, so two runs with the same arguments produce
// byte-identical trees. `src/perf/perf.test.ts` proves that by generating
// twice into two directories and comparing SHA-256 digests, rather than by
// pinning a digest literal that would rot the first time this file changes.
//
// Everything emitted is printable ASCII plus newlines. No raw control byte is
// ever written into a generated file -- the same rule the source files are
// under, for the same reason (a file with a literal 0x00 becomes binary to
// git and loses reviewable diffs forever).
//
// Shape of the emitted tree, which is CC 2.1.234's undocumented layout:
//
//   <out>/projects/C--SYNTHETIC-PERF-not-a-harvest/<sessionId>.jsonl
//   <out>/projects/C--SYNTHETIC-PERF-not-a-harvest/<sessionId>/subagents/agent-<id>.jsonl
//   <out>/projects/C--SYNTHETIC-PERF-not-a-harvest/<sessionId>/subagents/agent-<id>.meta.json
//   <out>/projects/C--SYNTHETIC-PERF-not-a-harvest/<sessionId>/tool-results/<id>.txt
//
// The slug is `slugifyWorkspace('C:\\SYNTHETIC-PERF-not-a-harvest')` --
// ':' and '\' both collapse to '-' -- so `discoverSessions` finds it from that
// workspace path on any platform. The name says what the corpus is in the one
// place a reader cannot miss it.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Identity. Deliberately un-mistakable for captured data.
// ---------------------------------------------------------------------------

/** Hex + dashes, because `SESSION_FILE_RE` is `^[0-9a-f][0-9a-f-]{7,}\.jsonl$`. */
export const SESSION_ID = '5eed0000-0000-4000-8000-00000000feed';
export const WORKSPACE_PATH = 'C:\\SYNTHETIC-PERF-not-a-harvest';
export const PROJECT_SLUG = 'C--SYNTHETIC-PERF-not-a-harvest';
/** In-window for `fingerprint.ts` (anchor 2.1.234, patch +-5, minor +-1). */
export const CC_VERSION = '2.1.234';

/** 2026-08-01T00:00:00.000Z, as a literal so no clock is ever read. */
const EPOCH_MS = 1_785_542_400_000;

const DEFAULTS = {
  /**
   * >= 10000 because that is the number the DoD names. Not exactly 10000: a
   * corpus sitting exactly on a threshold cannot show whether the threshold
   * is the binding constraint.
   */
  lines: 10_400,
  subagents: 6,
  subagentLines: 220,
  seed: 20_260_821,
  /** Append lines the harness draws its samples from. */
  appends: 512,
};

// ---------------------------------------------------------------------------
// Seeded PRNG. Numerical Recipes LCG; the exact constants do not matter, that
// it never reads a clock or a global entropy source does.
// ---------------------------------------------------------------------------

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Integer in [lo, hi]. */
function pick(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Deterministic filler of exactly `n` printable-ASCII characters. */
function filler(n, tag) {
  if (n <= 0) return '';
  const unit = `${tag} `;
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}

const HEX = '0123456789abcdef';
function hex(n, width) {
  let out = '';
  let v = n;
  for (let i = 0; i < width; i += 1) {
    out = HEX[v & 0xf] + out;
    v >>>= 4;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line builders
// ---------------------------------------------------------------------------

const TOOL_NAMES = ['Read', 'Bash', 'Grep', 'Edit', 'Glob', 'Write'];

/**
 * A thinking block exactly as CC writes it: the `thinking` string is EMPTY on
 * disk and the `signature` carries the bytes. A G4 assertion against thinking
 * TEXT is vacuous, so the corpus reproduces the shape that makes it vacuous
 * and gives the redaction layer something real to drop.
 */
function thinkingBlock(n) {
  return {
    type: 'thinking',
    thinking: '',
    signature: `SYNTHETICPERFSIGNATURE${hex(n, 8)}${filler(600, 'ZmFrZXNpZ25hdHVyZQ')}`,
  };
}

function core(state, type, extra) {
  const line = {
    parentUuid: state.lineNo === 0 ? null : uuidOf(state.lineNo - 1),
    isSidechain: state.agentId !== undefined,
    type,
    uuid: uuidOf(state.lineNo),
    timestamp: new Date(EPOCH_MS + state.lineNo * 1_500).toISOString(),
    sessionId: SESSION_ID,
    version: CC_VERSION,
    cwd: WORKSPACE_PATH,
    gitBranch: 'synthetic-perf',
  };
  if (state.agentId !== undefined) line.agentId = state.agentId;
  state.lineNo += 1;
  return { ...line, ...extra };
}

function uuidOf(n) {
  return `00000000-0000-4000-8000-${hex(n, 12)}`;
}

function userText(state, rng) {
  return core(state, 'user', {
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `SYNTHETIC PERF PROMPT ${state.lineNo}: ${filler(pick(rng, 40, 400), 'prompt')}`,
        },
      ],
    },
  });
}

function assistantThinking(state, rng) {
  const n = state.lineNo;
  return core(state, 'assistant', {
    message: {
      id: `msg_perf_${hex(n, 8)}`,
      role: 'assistant',
      model: 'claude-synthetic-perf',
      stop_reason: null,
      usage: { input_tokens: pick(rng, 100, 4000), output_tokens: pick(rng, 1, 900) },
      content: [thinkingBlock(n)],
    },
  });
}

function assistantToolUse(state, rng, toolUseId, toolName, inputBytes) {
  const n = state.lineNo;
  return core(state, 'assistant', {
    message: {
      id: `msg_perf_${hex(n, 8)}`,
      role: 'assistant',
      model: 'claude-synthetic-perf',
      stop_reason: 'end_turn',
      usage: { input_tokens: pick(rng, 100, 4000), output_tokens: pick(rng, 1, 900) },
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input: {
            file_path: `${WORKSPACE_PATH}\\src\\generated\\module-${hex(n, 6)}.ts`,
            description: filler(inputBytes, 'input'),
          },
        },
      ],
    },
  });
}

function userToolResult(state, toolUseId, text, isError) {
  return core(state, 'user', {
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: text,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  });
}

function attachment(state, rng) {
  return core(state, 'attachment', {
    attachment: { kind: 'synthetic', bytes: pick(rng, 10, 900) },
  });
}

function queueOperation(state) {
  const line = core(state, 'queue-operation', { operation: 'enqueue' });
  // `queue-operation` requires only sessionId + timestamp, and carries no
  // message. Dropping the conversation-core fields keeps the corpus honest
  // about how thin the real record is.
  delete line.parentUuid;
  delete line.isSidechain;
  delete line.uuid;
  delete line.version;
  return line;
}

/**
 * CC's `<persisted-output>` stub, byte-shaped for
 * `redact.ts:parsePersistedOutputPointer`. The `\n\n` after the path and the
 * closing tag on its own line are both load-bearing: cut either off and
 * hydration silently never runs.
 *
 * Note the size label is KiB, not KB -- CC reports a 63,774-byte payload as
 * "62.3KB" -- so this reproduces the KiB convention rather than fixing it.
 */
function persistedStub(basename, payloadBytes, previewText) {
  const kib = (payloadBytes / 1024).toFixed(1);
  const path = `${WORKSPACE_PATH}\\.claude\\projects\\${PROJECT_SLUG}\\${SESSION_ID}\\tool-results\\${basename}`;
  return [
    '<persisted-output>',
    `Output too large (${kib}KB). Full output saved to: ${path}`,
    '',
    'Preview (first 2KB):',
    previewText,
    '</persisted-output>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Corpus assembly
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{projectsRoot: string, slugDir: string, mainTranscript: string,
 *   mainLines: number, subagentCount: number, toolResultCount: number,
 *   appendsPath: string, bytes: number}>}
 */
export async function buildCorpus(options) {
  const outDir = options.outDir;
  if (typeof outDir !== 'string' || outDir === '') {
    throw new Error('buildCorpus: outDir is required; never defaults into the repo tree');
  }
  const lines = options.lines ?? DEFAULTS.lines;
  const subagentCount = options.subagents ?? DEFAULTS.subagents;
  const subagentLines = options.subagentLines ?? DEFAULTS.subagentLines;
  const appendCount = options.appends ?? DEFAULTS.appends;
  const rng = makeRng(options.seed ?? DEFAULTS.seed);

  const projectsRoot = join(outDir, 'projects');
  const slugDir = join(projectsRoot, PROJECT_SLUG);
  const sessionDir = join(slugDir, SESSION_ID);
  const subagentsDir = join(sessionDir, 'subagents');
  const toolResultsDir = join(sessionDir, 'tool-results');
  await mkdir(subagentsDir, { recursive: true });
  await mkdir(toolResultsDir, { recursive: true });

  const state = { lineNo: 0 };
  const out = [];
  const toolResultFiles = [];
  /** `tool_use` ids in the MAIN transcript that a sidecar may name as parent. */
  const mainAgentSpawns = [];

  // The main transcript. Emitted as whole turns until the line budget is met,
  // then truncated to exactly `lines` so the count is a stated number rather
  // than whatever the loop happened to reach.
  let spawnIndex = 0;
  while (out.length < lines) {
    const turn = out.length;

    out.push(JSON.stringify(userText(state, rng)));
    if (turn % 5 === 0) out.push(JSON.stringify(assistantThinking(state, rng)));

    // A subagent spawn: an `Agent` tool_use whose id a sidecar names. Spread
    // across the file so the graft has work to do at several depths of the
    // transcript, not only near the head.
    const depth1Spawns = Math.ceil(subagentCount / 2);
    const spawnEvery = Math.max(1, Math.floor(lines / (depth1Spawns + 1)));
    if (spawnIndex < depth1Spawns && out.length >= spawnEvery * (spawnIndex + 1)) {
      const id = `toolu_PERFAGENT${hex(spawnIndex, 8)}`;
      out.push(JSON.stringify(assistantToolUse(state, rng, id, 'Agent', pick(rng, 60, 300))));
      mainAgentSpawns.push(id);
      spawnIndex += 1;
      continue;
    }

    const toolUseId = `toolu_PERF${hex(out.length, 12)}`;
    const toolName = TOOL_NAMES[pick(rng, 0, TOOL_NAMES.length - 1)];
    out.push(
      JSON.stringify(assistantToolUse(state, rng, toolUseId, toolName, pick(rng, 40, 500))),
    );

    // Result size distribution, chosen so the corpus exercises all three
    // payload regimes the redaction layer has:
    //   ~ 8/12  small   (under the 8 KiB parse ceiling, never truncated)
    //   ~ 3/12  large   (over the ceiling, truncated INLINE -- the case that
    //                    matters most, since 7 of the 8 over-8 KiB payloads in
    //                    the committed capture never touch tool-results/)
    //   ~ 1/60  offload (a <persisted-output> stub + a tool-results/*.txt)
    const roll = pick(rng, 0, 59);
    if (roll === 0) {
      const basename = `perf${hex(toolResultFiles.length, 8)}.txt`;
      const payloadBytes = pick(rng, 40_000, 70_000);
      const payload = `===== SYNTHETIC PERF OFFLOAD ${basename} =====\n${filler(payloadBytes, 'offload')}`;
      toolResultFiles.push({ basename, payload });
      out.push(
        JSON.stringify(
          userToolResult(
            state,
            toolUseId,
            persistedStub(basename, payload.length, filler(2000, 'preview')),
            false,
          ),
        ),
      );
    } else if (roll < 15) {
      out.push(
        JSON.stringify(
          userToolResult(state, toolUseId, filler(pick(rng, 8_500, 14_000), 'large'), false),
        ),
      );
    } else {
      out.push(
        JSON.stringify(
          userToolResult(
            state,
            toolUseId,
            filler(pick(rng, 120, 900), 'small'),
            roll === 59,
          ),
        ),
      );
    }

    if (turn % 37 === 0) out.push(JSON.stringify(attachment(state, rng)));
    if (turn % 53 === 0) out.push(JSON.stringify(queueOperation(state)));
  }
  out.length = lines;

  const mainTranscript = join(slugDir, `${SESSION_ID}.jsonl`);
  const mainText = `${out.join('\n')}\n`;
  assertPlainAscii(mainText, mainTranscript);
  await writeFile(mainTranscript, mainText, 'utf8');
  let bytes = Buffer.byteLength(mainText, 'utf8');

  for (const file of toolResultFiles) {
    assertPlainAscii(file.payload, file.basename);
    await writeFile(join(toolResultsDir, file.basename), file.payload, 'utf8');
    bytes += Buffer.byteLength(file.payload, 'utf8');
  }

  // --- subagents ----------------------------------------------------------
  //
  // Half at spawnDepth 1 (parent = the main transcript), half at spawnDepth 2
  // (parent = a depth-1 agent's transcript). Depth 2 is the deepest REAL data
  // this repo has, because `.claude/settings.local.json` caps
  // CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH at 2; going deeper here would make
  // the corpus less like the harvest it stands in for, not more.
  const depth1 = mainAgentSpawns.length;
  const agents = [];
  for (let i = 0; i < subagentCount; i += 1) {
    agents.push({ agentId: `aperf${hex(i, 11)}`, depth: i < depth1 ? 1 : 2 });
  }

  for (let i = 0; i < agents.length; i += 1) {
    const agent = agents[i];
    const agentState = { lineNo: 0, agentId: agent.agentId };
    const agentLines = [];
    /** A depth-1 agent must offer a `tool_use` for a depth-2 sidecar to name. */
    let nestedSpawnId;

    while (agentLines.length < subagentLines) {
      agentLines.push(JSON.stringify(userText(agentState, rng)));
      if (agentLines.length % 7 === 0) {
        agentLines.push(JSON.stringify(assistantThinking(agentState, rng)));
      }
      const toolUseId = `toolu_PERFSUB${hex(i, 4)}${hex(agentLines.length, 8)}`;
      agentLines.push(
        JSON.stringify(
          assistantToolUse(
            agentState,
            rng,
            toolUseId,
            TOOL_NAMES[pick(rng, 0, TOOL_NAMES.length - 1)],
            pick(rng, 40, 300),
          ),
        ),
      );
      if (nestedSpawnId === undefined && agent.depth === 1) nestedSpawnId = toolUseId;
      agentLines.push(
        JSON.stringify(
          userToolResult(agentState, toolUseId, filler(pick(rng, 120, 3_000), 'sub'), false),
        ),
      );
    }
    agentLines.length = subagentLines;
    agent.spawnableToolUseId = nestedSpawnId;

    const text = `${agentLines.join('\n')}\n`;
    assertPlainAscii(text, agent.agentId);
    await writeFile(join(subagentsDir, `agent-${agent.agentId}.jsonl`), text, 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
  }

  // Sidecars are written second: a depth-2 sidecar names a `tool_use` id that
  // only exists once its parent's transcript has been generated.
  for (let i = 0; i < agents.length; i += 1) {
    const agent = agents[i];
    /** @type {Record<string, unknown>} */
    let meta;
    if (agent.depth === 1) {
      meta = {
        agentType: 'general-purpose',
        description: `synthetic perf depth-1 agent ${i}`,
        toolUseId: mainAgentSpawns[i],
        spawnDepth: 1,
      };
    } else {
      const parent = agents[(i - depth1) % Math.max(1, depth1)];
      if (parent === undefined || parent.spawnableToolUseId === undefined) {
        throw new Error(`no depth-1 parent available for ${agent.agentId}`);
      }
      meta = {
        agentType: 'general-purpose',
        description: `synthetic perf depth-2 agent ${i}`,
        toolUseId: parent.spawnableToolUseId,
        spawnDepth: 2,
        // Required at spawnDepth >= 2 and REFUSED below it. Both directions
        // are `metaParentAgentIdRule` in `fingerprint.ts`.
        parentAgentId: parent.agentId,
      };
    }
    const text = `${JSON.stringify(meta)}\n`;
    assertPlainAscii(text, `${agent.agentId}.meta.json`);
    await writeFile(join(subagentsDir, `agent-${agent.agentId}.meta.json`), text, 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
  }

  // --- append stream ------------------------------------------------------
  //
  // Written OUTSIDE the projects root -- `<out>/appends.jsonl`, not
  // `<out>/projects/...` -- because anything inside the slug directory is
  // something `discoverSessions` may pick up, and a stray file in there would
  // change what the harness is measuring. The harness does not require this
  // file: for a supplied (harvested) corpus it derives its append lines from
  // the transcript's own last assistant turn. It is emitted here so the
  // synthetic path and the harvested path can be compared line-for-line.
  const appendLines = [];
  const appendState = { lineNo: lines };
  for (let i = 0; i < appendCount; i += 1) {
    const id = `toolu_PERFAPPEND${hex(i, 10)}`;
    appendLines.push(
      JSON.stringify(assistantToolUse(appendState, rng, id, 'Read', pick(rng, 40, 400))),
    );
    appendLines.push(
      JSON.stringify(userToolResult(appendState, id, filler(pick(rng, 200, 2_000), 'appended'), false)),
    );
  }
  const appendsPath = join(outDir, 'appends.jsonl');
  const appendsText = `${appendLines.join('\n')}\n`;
  assertPlainAscii(appendsText, appendsPath);
  await writeFile(appendsPath, appendsText, 'utf8');

  const manifest = {
    notAHarvest: true,
    note: 'SYNTHETIC calibration corpus. Not the DoD >=10k-line harvest. See fixtures/synthetic-perf/README.md.',
    sessionId: SESSION_ID,
    projectSlug: PROJECT_SLUG,
    workspacePath: WORKSPACE_PATH,
    ccVersion: CC_VERSION,
    mainLines: lines,
    subagentCount,
    subagentLines,
    toolResultFiles: toolResultFiles.length,
    appendLines: appendLines.length,
    seed: options.seed ?? DEFAULTS.seed,
    bytes,
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    projectsRoot,
    slugDir,
    mainTranscript,
    mainLines: lines,
    subagentCount,
    toolResultCount: toolResultFiles.length,
    appendsPath,
    bytes,
  };
}

/**
 * Guard the guard: every generated file must be printable ASCII plus newline.
 * A raw control byte in a generated corpus would make a diff of it useless and
 * would defeat the `grep -a` privacy sweep this repo already pays a trap for.
 */
function assertPlainAscii(text, where) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) continue;
    if (code < 0x20 || code > 0x7e) {
      throw new Error(
        `${where}: non-ASCII code unit 0x${code.toString(16)} at offset ${i}: escape it, do not embed it`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--out') options.outDir = value;
    else if (flag === '--lines') options.lines = Number(value);
    else if (flag === '--subagents') options.subagents = Number(value);
    else if (flag === '--subagent-lines') options.subagentLines = Number(value);
    else if (flag === '--appends') options.appends = Number(value);
    else if (flag === '--seed') options.seed = Number(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  return options;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArgs(process.argv.slice(2));
  if (options.outDir === undefined) {
    process.stderr.write('--out <dir> is required (never defaults into the repo tree)\n');
    process.exit(2);
  }
  const result = await buildCorpus(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
