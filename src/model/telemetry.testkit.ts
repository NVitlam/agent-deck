/**
 * v0.7.1 Phase 6 — what the telemetry route and host-module tests share.
 *
 * ---------------------------------------------------------------------------
 * THE BODIES ARE THE FIXTURE'S, BYTE FOR BYTE. THE TRANSCRIPTS ARE STAGED.
 * ---------------------------------------------------------------------------
 *
 * `fixtures/otel-cc-2.1.260/` carries the telemetry of two real sessions and NO
 * transcript of either (its README says so, and `join.test.ts`'s header records
 * it as a limit). A test that joins telemetry onto a session the data path read
 * needs a transcript whose session id and tool ids are the telemetry's, and
 * there is no committed one.
 *
 * So the telemetry side is never touched — every body is POSTed exactly as it
 * sits in the corpus's `raw` field, which is exactly what an HTTP receiver was
 * handed (DoD 6.2: "the fixture's raw bodies") — and the TRANSCRIPT side is a
 * staged copy of a real committed CC corpus with two kinds of string replaced,
 * in contents and in file names alike:
 *
 *   - its session id, by the telemetry session's id;
 *   - some of its `tool_use` ids, by the telemetry's span ids, in order.
 *
 * That is the recorded precedent (`src/codex/context-window.test.ts`): a
 * MUTATION of a good fixture, staged in a temp dir, never written back to
 * `fixtures/` (G1, G6). What it buys is that the states the join targets are the
 * ones the production engine grafts — watcher, tailer, fingerprint, grafter,
 * liveness, stall derivation — rather than a hand-built tree. What it does not
 * buy is a transcript CC wrote beside this telemetry; that is still owed, and
 * the mapping is stated per test so no reader mistakes it for one.
 *
 * Only NON-`Agent` tool calls are remapped: an `Agent` call grafts as the
 * subagent it spawned, not as a `ToolNode`, so a span mapped onto one would be
 * unmatched by construction and the arithmetic below would hide a shrug.
 */

import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyTelemetryCounts, parseOtlpBody, type OtelSignal } from '../otel/parse.js';

export const OTEL_CORPUS = fileURLToPath(new URL('../../fixtures/otel-cc-2.1.260/', import.meta.url));

/** The corpus's two sessions (its README's A and B). */
export const OTEL_SESSION_A = '8c1910bb-9e45-40a3-ad0d-982df98ed71b';
export const OTEL_SESSION_B = 'f7f0eef9-8100-4891-963b-79f25326014c';

/** One captured request, as the corpus file carries it. */
export interface OtelEnvelope {
  readonly receivedAt: string;
  readonly signal: OtelSignal;
  readonly raw: string;
}

/** Every envelope of every signal, in ARRIVAL order (`receivedAt`), as the exporter sent them. */
export function otelEnvelopes(): OtelEnvelope[] {
  const out: OtelEnvelope[] = [];
  for (const signal of ['metrics', 'logs', 'traces'] as const) {
    for (const line of readFileSync(join(OTEL_CORPUS, `${signal}.jsonl`), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const parsed = JSON.parse(line) as OtelEnvelope;
      if (parsed.signal !== signal) throw new Error(`corpus line under ${signal} says ${parsed.signal}`);
      out.push({ receivedAt: parsed.receivedAt, signal, raw: parsed.raw });
    }
  }
  return out.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
}

/** A session's `claude_code.tool` span ids, in corpus order, through the real parse boundary. */
export function spanToolIds(sessionId: string): string[] {
  const counts = emptyTelemetryCounts();
  const ids: string[] = [];
  for (const envelope of otelEnvelopes()) {
    if (envelope.signal !== 'traces') continue;
    for (const span of parseOtlpBody(envelope.raw, 'traces', counts).toolSpans) {
      if (span.sessionId === sessionId && !ids.includes(span.toolUseId)) ids.push(span.toolUseId);
    }
  }
  return ids;
}

/** Committed CC slug directories the staging reads from. */
export const CC_2_1_234_SLUG = fileURLToPath(
  new URL('../../fixtures/cc-2.1.234/projects/c--Users-dev-projects-agent-deck', import.meta.url),
);
export const CC_2_1_260_SLUG = fileURLToPath(
  new URL('../../fixtures/cc-2.1.260/projects/c--Users-dev-projects-agent-deck', import.meta.url),
);

/**
 * `fixtures/cc-2.1.234`'s 05c5482d: complete, four subagents, every call
 * answered. Staged as the IDLE session.
 */
export const IDLE_SOURCE = { slugDir: CC_2_1_234_SLUG, sessionId: '05c5482d-5568-44ce-97fe-bc9a6c15afc4' };

/**
 * `fixtures/cc-2.1.260`'s 99f96635: the session `src/model/stall.ts` names, whose
 * subagent `Bash` never returned. Staged as the STALLED session, with that call
 * pinned FIRST in the remap so a span lands on the stalled node itself.
 */
export const STALLED_SOURCE = {
  slugDir: CC_2_1_260_SLUG,
  sessionId: '99f96635-2042-41dc-9000-bbc9f9233bc3',
  stalledToolId: 'toolu_018fuffcyA46w1xfU6Wpcj5z',
};

interface ToolUseBlock {
  id: string;
  name: string;
}

/** `tool_use` blocks in one transcript, in document order. */
function toolUsesIn(text: string): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; id?: unknown; name?: unknown };
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        out.push({ id: b.id, name: b.name });
      }
    }
  }
  return out;
}

/** Every file under a directory, relative, sorted. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

export interface StagePlan {
  readonly slugDir: string;
  readonly sessionId: string;
  /** The telemetry session this transcript is staged AS. */
  readonly asSessionId: string;
  /** Span ids to write over the transcript's non-`Agent` tool ids, in order. */
  readonly spanIds: readonly string[];
  /** A source tool id to remap FIRST, ahead of document order. */
  readonly pinFirst?: string;
}

export interface StagedSession {
  readonly sessionId: string;
  /** source tool id -> span id, for every remapped call. */
  readonly remapped: ReadonlyMap<string, string>;
  /** Span ids of this session that were NOT written onto any call. */
  readonly unplaced: readonly string[];
}

/** Replace every occurrence, by slicing — no `$` substitution syntax at all. */
function replaceAll(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}

/**
 * Stage one committed CC session into `targetSlugDir` under a telemetry
 * session's id, with its tool ids remapped onto that session's span ids.
 */
export async function stageSessionAs(targetSlugDir: string, plan: StagePlan): Promise<StagedSession> {
  await mkdir(targetSlugDir, { recursive: true });
  const main = join(plan.slugDir, `${plan.sessionId}.jsonl`);
  const sessionDir = join(plan.slugDir, plan.sessionId);
  const sideFiles = await filesUnder(sessionDir);

  // Candidate calls: main transcript first, then each subagent transcript in
  // name order. Non-`Agent` only — see the module header.
  const candidates: string[] = [];
  const pushFrom = (text: string): void => {
    for (const block of toolUsesIn(text)) {
      if (block.name === 'Agent' || block.name === 'Task') continue;
      if (!candidates.includes(block.id)) candidates.push(block.id);
    }
  };
  pushFrom(await readFile(main, 'utf8'));
  for (const rel of sideFiles.filter((f) => f.endsWith('.jsonl'))) {
    pushFrom(await readFile(join(sessionDir, rel), 'utf8'));
  }
  if (plan.pinFirst !== undefined) {
    if (!candidates.includes(plan.pinFirst)) throw new Error(`${plan.pinFirst} is not a non-Agent call here`);
    candidates.splice(candidates.indexOf(plan.pinFirst), 1);
    candidates.unshift(plan.pinFirst);
  }

  const remapped = new Map<string, string>();
  plan.spanIds.forEach((spanId, index) => {
    const source = candidates[index];
    if (source !== undefined) remapped.set(source, spanId);
  });
  const unplaced = plan.spanIds.filter((id) => ![...remapped.values()].includes(id));

  const rewrite = (text: string): string => {
    let out = replaceAll(text, plan.sessionId, plan.asSessionId);
    for (const [from, to] of remapped) out = replaceAll(out, from, to);
    return out;
  };

  await writeFile(join(targetSlugDir, `${plan.asSessionId}.jsonl`), rewrite(await readFile(main, 'utf8')), 'utf8');
  for (const rel of sideFiles) {
    const target = join(targetSlugDir, plan.asSessionId, rewrite(rel));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, rewrite(await readFile(join(sessionDir, rel), 'utf8')), 'utf8');
  }
  return { sessionId: plan.asSessionId, remapped, unplaced };
}

/** A whole committed slug dir, copied verbatim (the non-telemetry controls). */
export async function copySlug(sourceSlugDir: string, targetSlugDir: string): Promise<void> {
  await cp(sourceSlugDir, targetSlugDir, { recursive: true });
}

export interface PostResult {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
}

/**
 * One request to a telemetry path (or any path) on a bound listener.
 *
 * `contentType: null` sends NO content-type header. `chunked: true` sends no
 * `content-length`, so the listener's streaming guard rather than its
 * declared-size guard is what meets the body.
 */
export async function postTo(
  port: number,
  path: string,
  body: string | Buffer,
  options: { method?: string; contentType?: string | null; chunked?: boolean } = {},
): Promise<PostResult> {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const headers: Record<string, string | number> = { connection: 'close' };
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null) headers['content-type'] = contentType;
  if (options.chunked !== true) headers['content-length'] = bytes.length;
  return new Promise<PostResult>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'POST', agent: false, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'],
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    // A server that answers 413 and destroys the socket mid-body is the
    // designed outcome, not a failure of this helper.
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
        resolve({ status: -1, contentType: undefined, body: '' });
        return;
      }
      reject(error);
    });
    if (options.chunked === true) {
      const step = 64 * 1024;
      for (let at = 0; at < bytes.length; at += step) req.write(bytes.subarray(at, at + step));
      req.end();
    } else {
      req.end(bytes);
    }
  });
}

/** Wait for a condition, or fail naming it. Polls; never a fixed sleep. */
export async function waitFor(predicate: () => boolean, what: string, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The corpus's five identity attribute NAMES and placeholder VALUES, and the
 * three content keys — the literal bytes DoD 6.6 says may appear nowhere
 * downstream of the route. Written out, not imported from `parse.ts`: a test
 * that read the list from the module under test would agree with any mistake
 * in it.
 */
export const IDENTITY_NAMES = ['user.email', 'user.id', 'user.account_id', 'user.account_uuid', 'organization.id'];
export const IDENTITY_PLACEHOLDERS = [
  'redacted@example.invalid',
  '0'.repeat(64),
  `user_${'0'.repeat(26)}`,
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000001',
];
export const CONTENT_KEYS = ['prompt', 'response', 'user_prompt'];
