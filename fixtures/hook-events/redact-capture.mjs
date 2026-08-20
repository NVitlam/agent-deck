#!/usr/bin/env node
// fixtures/hook-events/redact-capture.mjs
//
// Derives the committed hook-event fixture from a RAW loopback capture.
// The raw capture is gitignored and must never be committed: it carries
// verbatim `tool_input` / `tool_response` payloads, which is the exact leak
// class the Phase 1 history scrub removed from this repo.
//
// Regenerate:
//   node fixtures/hook-events/redact-capture.mjs \
//     --in spike/hook-events-r3.jsonl \
//     --out fixtures/hook-events/cc-2.1.234-redacted.jsonl
//
// What this preserves, because the fixture is worthless otherwise:
//   * KEY ABSENCE, exactly. `agent_id` absent is the main-thread signal --
//     CC omits the key rather than sending "main". A redactor that defaulted
//     absent keys to null or "" would destroy the one property the fixture
//     exists to pin. Absent stays absent; present stays present.
//   * event ordering, event counts, and the full key set of every event.
//   * the join keys themselves (session_id, agent_id, tool_use_id) and the
//     correlation fields (transcript_path, cwd) -- all of which name only
//     this repo, whose slug and session uuids are already committed under
//     fixtures/cc-2.1.234/.
//
// What it destroys:
//   * tool_input / tool_response values -> replaced by a shape descriptor
//     (type and length only). No user content, no file contents, no prompts.
//   * any string field not on the allowlist -> replaced by a length marker.

import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const IN = opt('--in', 'spike/hook-events-r3.jsonl');
const OUT = opt('--out', 'fixtures/hook-events/cc-2.1.234-redacted.jsonl');
// --only <EventName>: emit just that hook_event_name. Used for the small
// single-purpose fixtures; the redaction path below is identical either way,
// so a filtered fixture is never redacted differently from the main one.
const ONLY = opt('--only', null);

// Fields kept verbatim. Everything else is shape-only.
const KEEP = new Set([
  'hook_event_name', 'session_id', 'agent_id', 'agent_type', 'tool_use_id',
  'tool_name', 'prompt_id', 'transcript_path', 'cwd', 'permission_mode',
  'agent_transcript_path', 'duration_ms',
  'stop_hook_active', 'source', 'matcher',
]);

function shape(v) {
  if (v === null) return '[redacted:null]';
  if (Array.isArray(v)) return `[redacted:array:${v.length}]`;
  switch (typeof v) {
    case 'string': return `[redacted:string:${v.length}]`;
    case 'number': return '[redacted:number]';
    case 'boolean': return '[redacted:boolean]';
    case 'object': return `[redacted:object:${Object.keys(v).length}]`;
    default: return '[redacted]';
  }
}

const lines = fs.readFileSync(IN, 'utf8').split('\n').filter((l) => l.trim());
const out = [];
const counts = {};
let malformed = 0;

for (const line of lines) {
  let rec;
  try { rec = JSON.parse(line); } catch { malformed++; continue; }
  const p = rec.payload ?? rec.event ?? rec;
  if (!p || typeof p !== 'object') { malformed++; continue; }
  if (ONLY && p.hook_event_name !== ONLY) continue;

  const red = {};
  // Object.keys order is preserved so the fixture mirrors the wire order.
  for (const [k, v] of Object.entries(p)) {
    red[k] = KEEP.has(k) ? v : shape(v);
  }
  counts[p.hook_event_name ?? '(none)'] = (counts[p.hook_event_name ?? '(none)'] ?? 0) + 1;
  out.push(JSON.stringify(red));
}

fs.writeFileSync(OUT, out.join('\n') + '\n');

// Residual check: the redacted output must contain no key we did not allowlist
// carrying a non-marker value.
let residual = 0;
for (const l of out) {
  const o = JSON.parse(l);
  for (const [k, v] of Object.entries(o)) {
    if (!KEEP.has(k) && typeof v === 'string' && !v.startsWith('[redacted:')) residual++;
  }
}

console.log(`in  ${lines.length} lines (${malformed} malformed, skipped)`);
console.log(`out ${out.length} events -> ${OUT}`);
console.log('by type:', JSON.stringify(counts));
console.log(`residual un-redacted non-allowlisted values: ${residual}`);
if (residual !== 0) process.exit(1);
