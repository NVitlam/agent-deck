#!/usr/bin/env node
/**
 * Derive the committed CC 2.1.237 transcript fixture from a live session.
 *
 * Unlike `fixtures/cc-2.1.234/`, which is committed RAW on purpose, this
 * capture is **content-destroyed**. The 2.1.234 set was harvested when the
 * repo's exposure had already been audited; 2.1.237 sessions are recent
 * working sessions and there is no reason to commit their conversation text
 * to pin a *layout* rule.
 *
 * The redaction is a WHITELIST, not a blacklist:
 *
 *   - Every top-level KEY is preserved, so "which fields does 2.1.237 emit"
 *     stays pinned exactly.
 *   - Only the keys in `STRUCTURAL` keep their value. Everything else is
 *     replaced by a type marker WITHOUT recursing, because a value the
 *     whitelist does not name may contain file content — and file content can
 *     contribute object KEYS as well as values.
 *   - `message` is recursed into with its own whitelist; content blocks keep
 *     `type`, tool `name`, and the `id` / `tool_use_id` join keys, and nothing
 *     else. `text`, `thinking` and `signature` never survive.
 *
 * What is deliberately KEPT verbatim, and why: `sessionId`, `uuid`,
 * `parentUuid`, `requestId`, `agentId`, `promptId`, tool-use ids, `cwd` and
 * `gitBranch`. A fixture without the join keys and the workspace path cannot
 * pin the rules it exists for — the same trade `fixtures/hook-events/` makes,
 * and the same exposure class: this repo's own paths and ids (G8).
 *
 * Read-only with respect to `~/.claude` (G1): the source is opened for
 * reading, the output is written under `fixtures/`.
 *
 * Usage:
 *   node fixtures/cc-2.1.237/redact-transcript.mjs --in <src.jsonl> --out <dst.jsonl>
 */

import { readFile, writeFile } from 'node:fs/promises';
import { argv, exit, stderr, stdout } from 'node:process';

/** Top-level keys whose values are structural metadata, never content. */
const STRUCTURAL = new Set([
  'type',
  'uuid',
  'parentUuid',
  'sessionId',
  'timestamp',
  'version',
  'isSidechain',
  'userType',
  'requestId',
  'messageId',
  'leafUuid',
  'agentId',
  'promptId',
  'promptSource',
  'origin',
  'entrypoint',
  'permissionMode',
  'operation',
  'isSnapshotUpdate',
  'isMeta',
  'effort',
  'cwd',
  'gitBranch',
  'sourceToolAssistantUUID',
  'isApiErrorMessage',
  'apiErrorStatus',
  'toolDenialKind',
]);

/** `message` sub-keys that are structural. `content` is handled separately. */
const MESSAGE_STRUCTURAL = new Set([
  'role',
  'model',
  'id',
  'type',
  'stop_reason',
  'stop_sequence',
]);

/** Content-block keys that are structural. Everything else in a block is content. */
const BLOCK_STRUCTURAL = new Set(['type', 'name', 'id', 'tool_use_id', 'is_error']);

/** A value the whitelist does not name: keep its TYPE, destroy everything else. */
function marker(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return ['<redacted>'];
  switch (typeof value) {
    case 'string':
      return '<redacted>';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'object':
      return { redacted: 'object' };
    default:
      return '<redacted>';
  }
}

/** `usage` is token counts: numbers are safe, anything else is not. */
function redactUsage(usage) {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return marker(usage);
  const out = {};
  for (const [key, value] of Object.entries(usage)) {
    out[key] = typeof value === 'number' ? value : marker(value);
  }
  return out;
}

function redactBlock(block) {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return marker(block);
  const out = {};
  for (const [key, value] of Object.entries(block)) {
    out[key] = BLOCK_STRUCTURAL.has(key) && typeof value !== 'object' ? value : marker(value);
  }
  return out;
}

function redactMessage(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return marker(message);
  }
  const out = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === 'content') {
      out[key] = Array.isArray(value) ? value.map(redactBlock) : marker(value);
    } else if (key === 'usage') {
      out[key] = redactUsage(value);
    } else if (MESSAGE_STRUCTURAL.has(key) && typeof value !== 'object') {
      out[key] = value;
    } else {
      out[key] = marker(value);
    }
  }
  return out;
}

function redactEntry(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'message') {
      out[key] = redactMessage(value);
    } else if (STRUCTURAL.has(key) && (value === null || typeof value !== 'object')) {
      out[key] = value;
    } else {
      out[key] = marker(value);
    }
  }
  return out;
}

function arg(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const input = arg('--in');
const output = arg('--out');
if (input === undefined || output === undefined) {
  stderr.write('usage: redact-transcript.mjs --in <src.jsonl> --out <dst.jsonl>\n');
  exit(2);
}

const source = await readFile(input, 'utf8');
const lines = source.split('\n');
const kept = [];
let malformed = 0;
for (const line of lines) {
  const text = line.replace(/\r$/, '');
  if (text.trim() === '') continue;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    malformed += 1;
    continue;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    malformed += 1;
    continue;
  }
  kept.push(JSON.stringify(redactEntry(parsed)));
}

// LF only, and a trailing newline: `fixtures/** -text` keeps these bytes.
await writeFile(output, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8');
stdout.write(
  `redacted ${String(kept.length)} entries (${String(malformed)} skipped) -> ${output}\n`,
);
