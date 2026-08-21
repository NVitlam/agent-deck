/**
 * The lines the harness appends, derived from the corpus's own transcript.
 *
 * WHY DERIVED RATHER THAN WRITTEN HERE. An appended line has to survive the
 * real fingerprint: right `sessionId`, an in-window `version`, every field
 * `REQUIRED_ENTRY_FIELDS` names for its `type`. A hand-written line would pin
 * all of that to CC 2.1.234 and to the synthetic corpus, and would refuse the
 * moment the harness were pointed at the harvested session -- which is the one
 * thing this harness must not need a code change for. Taking the last real
 * assistant turn as a template and rewriting only the identity fields means an
 * append is valid for whatever corpus is loaded, including versions this file
 * has never heard of.
 *
 * WHAT AN APPEND IS DESIGNED TO DO. `message.content` is REPLACED with exactly
 * one block, never merged into the template's. That is what makes the
 * measurement interpretable: a `tool_use` append adds exactly one `ToolNode`
 * (one `insertNode` op) and a `tool_result` append fills exactly that node's
 * result. A template carrying two blocks would make "one append" mean two tree
 * changes and the number would stop being comparable between corpora.
 *
 * It also means no `thinking` block or `signature` from the source transcript
 * is ever copied forward by this module (G4). That is a consequence of
 * replacing content, and `perf.test.ts` asserts it rather than trusting it.
 */

/** A parsed transcript line. Deliberately open: CC adds fields between versions. */
type Line = Record<string, unknown>;

export interface AppendPlan {
  /** The exact text to append, without its trailing newline. */
  text: string;
  /** `tool_use` when this line creates a node, `tool_result` when it fills one. */
  kind: 'tool_use' | 'tool_result';
  /** The id this line creates or fills. */
  toolUseId: string;
}

export interface AppendTemplates {
  /** An `assistant` line carrying at least one `tool_use` block. */
  assistant: Line;
  /** A `user` line, used as the carrier for `tool_result` blocks. */
  user: Line;
  /** The timestamp the appended stream starts from, in epoch ms. */
  startMs: number;
}

/**
 * Pull the two templates out of a transcript's text.
 *
 * Scanned from the END backwards, stopping as soon as both templates are in
 * hand. Two reasons, and only one of them is speed: the last assistant turn is
 * the one an append genuinely follows, and on a >=10k-line corpus a
 * forward pass would `JSON.parse` all 10,400 lines to arrive at the same
 * answer -- about 1.5 s per rig, paid twice per suite run, for nothing.
 *
 * Throws rather than falling back. A corpus with no assistant tool call is a
 * corpus this benchmark cannot measure, and a silent fallback would produce a
 * number for a tree that never changes -- the exact vacuous pass this harness
 * exists to avoid.
 */
export function readTemplates(transcriptText: string): AppendTemplates {
  let assistant: Line | undefined;
  let user: Line | undefined;
  let latestMs = 0;

  const raws = transcriptText.split('\n');
  for (let i = raws.length - 1; i >= 0; i -= 1) {
    if (assistant !== undefined && user !== undefined) break;
    const raw = raws[i];
    if (raw === undefined || raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed lines are skipped, never fatal (G3)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const line = parsed as Line;

    const ts = line['timestamp'];
    if (typeof ts === 'string') {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;
    }

    if (assistant === undefined && line['type'] === 'assistant' && hasBlockOfType(line, 'tool_use')) {
      assistant = line;
    }
    if (user === undefined && line['type'] === 'user') user = line;
  }

  if (assistant === undefined) {
    throw new Error(
      'no `assistant` line carrying a `tool_use` block in the corpus transcript; ' +
        'this benchmark measures the cost of adding a tool node and cannot do so without one',
    );
  }
  if (user === undefined) {
    throw new Error('no `user` line in the corpus transcript to carry a `tool_result` block');
  }
  // A zero here would mean no line carried a parseable timestamp. Falling back
  // to a literal keeps the plan deterministic; `Date.now()` never appears.
  const startMs = latestMs === 0 ? Date.parse('2026-08-01T00:00:00.000Z') : latestMs;
  return { assistant, user, startMs };
}

function hasBlockOfType(line: Line, type: string): boolean {
  const message = line['message'];
  if (typeof message !== 'object' || message === null) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === type,
  );
}

/**
 * Build `count` append plans, alternating `tool_use` and `tool_result`.
 *
 * Alternating is deliberate: an all-`tool_use` stream would only ever measure
 * `insertNode`, and the two tree operations have different costs (an insert
 * grows the diff's child list; a result fills a node already in it). A
 * benchmark that measured one and reported both would be wrong in a direction
 * nobody would notice.
 *
 * Pure and seedless -- every varying value is a function of `index`. Two calls
 * with the same arguments produce identical text.
 */
export function planAppends(templates: AppendTemplates, count: number): AppendPlan[] {
  const plans: AppendPlan[] = [];
  for (let i = 0; i < count; i += 1) {
    const pairIndex = i >> 1;
    const toolUseId = `toolu_PERFBENCH${pairIndex.toString(16).padStart(10, '0')}`;
    const at = new Date(templates.startMs + (i + 1) * 1_000).toISOString();
    if (i % 2 === 0) {
      plans.push({
        kind: 'tool_use',
        toolUseId,
        text: JSON.stringify(
          rewrite(templates.assistant, i, at, [
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'Read',
              input: { file_path: 'PERF-BENCH-APPEND', description: `append ${String(i)}` },
            },
          ]),
        ),
      });
    } else {
      plans.push({
        kind: 'tool_result',
        toolUseId,
        text: JSON.stringify(
          rewrite(templates.user, i, at, [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: `PERF BENCH APPEND RESULT ${String(i)}`,
            },
          ]),
        ),
      });
    }
  }
  return plans;
}

/**
 * Clone a template with a fresh identity and exactly the blocks given.
 *
 * `uuid`, `timestamp` and `message.id` move; `sessionId`, `version`,
 * `isSidechain`, `cwd` and every unknown field the source carried stay put,
 * because those are what the fingerprint checks and what makes the line belong
 * to this session.
 */
function rewrite(template: Line, index: number, timestamp: string, content: unknown[]): Line {
  const line: Line = { ...template };
  line['uuid'] = `beefbeef-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  line['timestamp'] = timestamp;
  // `parentUuid` is only type-checked (`stringOrNull`), never followed, so a
  // stable synthetic value is honest here: the harness is not reconstructing a
  // conversation, it is appending a line that must fingerprint.
  if ('parentUuid' in template) line['parentUuid'] = null;

  const message = template['message'];
  const base: Record<string, unknown> =
    typeof message === 'object' && message !== null && !Array.isArray(message)
      ? { ...(message as Record<string, unknown>) }
      : {};
  base['content'] = content;
  if (typeof base['id'] === 'string') {
    base['id'] = `msg_perfbench_${index.toString(16).padStart(8, '0')}`;
  }
  line['message'] = base;
  return line;
}
