// Regenerates `corpus.jsonl`. Run from anywhere:
//
//   node fixtures/synthetic-hook-fuzz/build-corpus.mjs
//
// The corpus is SYNTHETIC — hand-made, not captured — hence the `synthetic-`
// prefix that this repo uses to mean exactly that. It carries no session
// content, no paths and no identifiers from any real machine; every string in
// it is invented here. That is a property of construction, not of a scrub.
//
// Two encoding rules, both load-bearing:
//
//   1. Request bodies are stored BASE64. Several cases are deliberately made
//      of raw control bytes, lone UTF-16 surrogates and invalid UTF-8. Writing
//      those literally would make the corpus binary to git — no reviewable
//      diff, ever — which is a trap this repo has already paid for once. The
//      committed file is therefore pure printable ASCII plus newlines, and a
//      test asserts that.
//   2. The oversized cases are DESCRIPTORS (`{"kind":"pad",...}`), not half a
//      megabyte of committed padding. The reader materializes them against the
//      cap the listener is actually configured with, so the same case
//      exercises the shipped 512 KiB default and a small test cap alike.
//
// Each record declares the exact counter deltas it expects. That is the point:
// "never crashes" is necessary but far too weak on its own — a listener that
// answered 200 to everything would pass it. The corpus pins WHICH refusal each
// malformed shape earns (G3: refuse, don't guess).
//
// This generator is documentation of provenance, not a build step. Nothing in
// the test suite runs it; the suite reads the committed `corpus.jsonl`.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const b64 = (value) =>
  Buffer.isBuffer(value)
    ? value.toString('base64')
    : Buffer.from(value, 'utf8').toString('base64');

const cases = [];

/** Body carried literally, base64-encoded. */
function raw(id, klass, note, body, expect, extra = {}) {
  cases.push({
    id,
    class: klass,
    note,
    body: { kind: 'base64', data: b64(body) },
    expect,
    ...extra,
  });
}

/** Body materialized by the reader relative to the configured cap. */
function fill(id, klass, note, sizing, expect, extra = {}) {
  cases.push({ id, class: klass, note, body: sizing, expect, ...extra });
}

const OK = { status: 200, counters: { accepted: 1 } };
const OK_UNCONFIRMED = {
  status: 200,
  counters: { accepted: 1, unconfirmedEventName: 1 },
};

// ---------------------------------------------------------------------------
// well-formed — the control group. A corpus without one cannot tell "refused
// everything" apart from "refused the right things".
// ---------------------------------------------------------------------------

raw(
  'well-formed/pretooluse',
  'well-formed',
  'A subagent PreToolUse carrying both join keys.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-000000000001',
    hook_event_name: 'PreToolUse',
    agent_id: '00000000-0000-4000-8000-0000000000a1',
    tool_use_id: 'toolu_synthetic_0001',
    tool_name: 'Read',
    prompt_id: 'prompt_synthetic_0001',
    cwd: 'X:\\synthetic\\workspace',
    transcript_path: 'X:\\synthetic\\projects\\slug\\session.jsonl',
  }),
  OK,
);

raw(
  'well-formed/mainthread-no-agent-id',
  'well-formed',
  'Main thread: the agent_id KEY is absent. Absence is the signal; a placeholder value has never appeared on the wire.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-000000000002',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'toolu_synthetic_0002',
    tool_name: 'Bash',
    prompt_id: 'prompt_synthetic_0002',
  }),
  OK,
);

raw(
  'well-formed/subagentstart-no-tool-use-id',
  'well-formed',
  'SubagentStart carries agent_id but no tool_use_id (0/3 observed). Not an error.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-000000000003',
    hook_event_name: 'SubagentStart',
    agent_id: '00000000-0000-4000-8000-0000000000a3',
    prompt_id: 'prompt_synthetic_0003',
  }),
  OK,
);

raw(
  'well-formed/subagentstop-transcript-path',
  'well-formed',
  'SubagentStop carries agent_transcript_path, the documented tap witnessing the undocumented layout.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-000000000004',
    hook_event_name: 'SubagentStop',
    agent_id: '00000000-0000-4000-8000-0000000000a4',
    agent_transcript_path:
      'X:\\synthetic\\projects\\slug\\session\\subagents\\agent-a4.jsonl',
    prompt_id: 'prompt_synthetic_0004',
  }),
  OK,
);

// ---------------------------------------------------------------------------
// missing-keys — well-formed but minimal. "Missing field" and "malformed" are
// DIFFERENT failure classes and only one of them is an error. SessionStart is
// the smallest real payload there is: no agent_id, no tool_use_id, no
// prompt_id. Liveness must never require any of them.
// ---------------------------------------------------------------------------

raw(
  'missing-keys/sessionstart-minimal',
  'missing-keys',
  'The smallest real payload shape: five keys, none of them a join key.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-000000000005',
    transcript_path: 'X:\\synthetic\\projects\\slug\\session.jsonl',
    cwd: 'X:\\synthetic\\workspace',
    hook_event_name: 'SessionStart',
    source: 'startup',
  }),
  OK,
);

raw(
  'missing-keys/no-session-id',
  'missing-keys',
  'No session_id at all. Accepted and normalized; the consumer decides what it can do with it.',
  JSON.stringify({ hook_event_name: 'Stop' }),
  OK,
);

raw(
  'missing-keys/no-event-name',
  'missing-keys',
  'No hook_event_name: cannot be confirmed, still not a rejection.',
  JSON.stringify({ session_id: '00000000-0000-4000-8000-000000000006' }),
  OK_UNCONFIRMED,
);

raw(
  'missing-keys/empty-object',
  'missing-keys',
  'The empty object is a valid JSON object and the degenerate main-thread event.',
  '{}',
  OK_UNCONFIRMED,
);

// ---------------------------------------------------------------------------
// unknown-fields — CC adds fields between versions. An unknown key must be
// carried, never a refusal.
// ---------------------------------------------------------------------------

raw(
  'unknown-fields/future-keys',
  'unknown-fields',
  'Keys no version has ever sent, alongside a known one.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-000000000007',
    hook_event_name: 'Stop',
    future_field_a: 1,
    future_field_b: { nested: ['x', 'y'] },
    future_field_c: null,
  }),
  OK,
);

raw(
  'unknown-fields/unknown-event-name',
  'unknown-fields',
  'An event name from a future CC. Flagged unconfirmed, never rejected.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-000000000008',
    hook_event_name: 'SomeFutureHookThatDoesNotExistYet',
  }),
  OK_UNCONFIRMED,
);

raw(
  'unknown-fields/very-long-key-name',
  'unknown-fields',
  'A 4096-character key name.',
  `{"session_id":"00000000-0000-4000-8000-000000000009","${'k'.repeat(4096)}":1}`,
  OK_UNCONFIRMED,
);

raw(
  'unknown-fields/many-keys',
  'unknown-fields',
  'Two thousand distinct keys in one object.',
  `{${Array.from({ length: 2000 }, (_, i) => `"k${i}":${i}`).join(',')}}`,
  OK_UNCONFIRMED,
);

// ---------------------------------------------------------------------------
// type-confusion — every field present, every one of them the wrong type.
// The normalizer must coerce nothing and throw nowhere.
// ---------------------------------------------------------------------------

raw(
  'type-confusion/join-keys-are-numbers',
  'type-confusion',
  'agent_id and tool_use_id as numbers. The agent_id KEY is present, so this is NOT a main-thread event even though its value is unusable.',
  JSON.stringify({
    session_id: 12345,
    hook_event_name: 99,
    agent_id: 42,
    tool_use_id: -1,
  }),
  OK_UNCONFIRMED,
);

raw(
  'type-confusion/agent-id-null',
  'type-confusion',
  'agent_id present and null: an unattributable subagent event, never the main thread.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-00000000000a',
    hook_event_name: 'Stop',
    agent_id: null,
  }),
  OK,
);

raw(
  'type-confusion/agent-id-object',
  'type-confusion',
  'agent_id as an object.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-00000000000b',
    hook_event_name: 'Stop',
    agent_id: { nope: true },
  }),
  OK,
);

raw(
  'type-confusion/agent-id-empty-string',
  'type-confusion',
  'agent_id present and empty. Key presence still wins.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-00000000000c',
    hook_event_name: 'Stop',
    agent_id: '',
  }),
  OK,
);

raw(
  'type-confusion/everything-an-array',
  'type-confusion',
  'Every known field is an array.',
  JSON.stringify({
    session_id: [],
    hook_event_name: [],
    agent_id: [],
    tool_use_id: [],
    tool_name: [],
    transcript_path: [],
    cwd: [],
  }),
  OK_UNCONFIRMED,
);

raw(
  'type-confusion/huge-and-tiny-numbers',
  'type-confusion',
  'Numeric extremes, including values that lose precision in a double.',
  '{"session_id":"00000000-0000-4000-8000-00000000000d","hook_event_name":"Stop","a":1e308,"b":-1e308,"c":1e-320,"d":123456789012345678901234567890,"e":-0}',
  OK,
);

// ---------------------------------------------------------------------------
// prototype-pollution — a JSON body naming __proto__ / constructor / prototype.
// JSON.parse defines these as own properties rather than assigning through the
// prototype chain, and the normalizer reads presence with
// Object.prototype.hasOwnProperty.call. The case pins both.
// ---------------------------------------------------------------------------

raw(
  'prototype-pollution/proto-key',
  'prototype-pollution',
  'A __proto__ key carrying an agent_id. Must not reach Object.prototype and must not attribute the event.',
  '{"session_id":"00000000-0000-4000-8000-00000000000e","hook_event_name":"Stop","__proto__":{"agent_id":"injected","polluted":true}}',
  OK,
);

raw(
  'prototype-pollution/constructor-prototype',
  'prototype-pollution',
  'constructor.prototype nesting.',
  '{"session_id":"00000000-0000-4000-8000-00000000000f","hook_event_name":"Stop","constructor":{"prototype":{"polluted":true}}}',
  OK,
);

// ---------------------------------------------------------------------------
// nesting — depth. A recursive parser is a stack-overflow crash, and a stack
// overflow in the extension host is exactly the G3 failure this corpus hunts.
// Whatever JSON.parse does with it, the listener must answer and keep serving.
// ---------------------------------------------------------------------------

fill(
  'nesting/deep-array',
  'nesting',
  'Deeply nested arrays. Either it parses (then it is not an object: 400) or JSON.parse throws (then it is malformed: 400). Both are refusals and neither is a crash, so the expectation names both counters.',
  { kind: 'nest', depth: 20000, shape: 'array' },
  { status: 400, counters: { anyOf: [{ notAnObject: 1 }, { malformedJson: 1 }] } },
);

fill(
  'nesting/deep-object',
  'nesting',
  'Deeply nested objects under a single key. Accepted if it parses, refused as malformed if the parser gives out; either way the listener answers.',
  { kind: 'nest', depth: 20000, shape: 'object' },
  {
    status: [200, 400],
    counters: {
      anyOf: [{ accepted: 1, unconfirmedEventName: 1 }, { malformedJson: 1 }],
    },
  },
);

// ---------------------------------------------------------------------------
// malformed-json
// ---------------------------------------------------------------------------

raw('malformed-json/not-json-at-all', 'malformed-json', 'Plain prose.', 'this is not json', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('malformed-json/trailing-comma', 'malformed-json', 'JavaScript-legal, JSON-illegal.', '{"a":1,}', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('malformed-json/single-quotes', 'malformed-json', 'Single-quoted keys.', "{'a':1}", {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('malformed-json/unquoted-key', 'malformed-json', 'Bare identifier as a key.', '{a:1}', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('malformed-json/nan-literal', 'malformed-json', 'NaN is not a JSON value.', '{"a":NaN}', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('malformed-json/infinity-literal', 'malformed-json', 'Infinity is not a JSON value.', '{"a":Infinity}', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('malformed-json/undefined-literal', 'malformed-json', 'undefined is not a JSON value.', '{"a":undefined}', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw(
  'malformed-json/two-objects-concatenated',
  'malformed-json',
  'Two payloads in one body, as a naive appender would produce.',
  '{"a":1}{"b":2}',
  { status: 400, counters: { malformedJson: 1 } },
);

raw('malformed-json/whitespace-only', 'malformed-json', 'A body of blanks is non-empty and non-JSON.', '   \t  ', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw(
  'malformed-json/duplicate-keys',
  'malformed-json',
  'NOT malformed: RFC 8259 allows duplicate names and JSON.parse keeps the last. Recorded here so last-wins is pinned rather than assumed.',
  '{"session_id":"first","session_id":"second","hook_event_name":"Stop"}',
  OK,
);

// ---------------------------------------------------------------------------
// truncated-json — a body cut mid-token. Distinct from a transport-truncated
// request, which cannot be expressed as a body and is driven from a raw socket
// in the test file instead.
// ---------------------------------------------------------------------------

raw('truncated-json/cut-mid-object', 'truncated-json', 'Object never closed.', '{"session_id":"abc","hook_ev', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('truncated-json/cut-mid-string', 'truncated-json', 'String never closed.', '{"session_id":"abc', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('truncated-json/open-brace-only', 'truncated-json', 'One byte.', '{', {
  status: 400,
  counters: { malformedJson: 1 },
});

raw('truncated-json/cut-mid-escape', 'truncated-json', 'A \\u escape cut in half.', '{"a":"\\u00', {
  status: 400,
  counters: { malformedJson: 1 },
});

// ---------------------------------------------------------------------------
// not-an-object — valid JSON, wrong top-level type.
// ---------------------------------------------------------------------------

raw('not-an-object/array', 'not-an-object', 'A JSON array.', '[{"hook_event_name":"Stop"}]', {
  status: 400,
  counters: { notAnObject: 1 },
});

raw(
  'not-an-object/null',
  'not-an-object',
  'JSON null. typeof null === "object", so this is the case a naive guard misses.',
  'null',
  { status: 400, counters: { notAnObject: 1 } },
);

raw('not-an-object/number', 'not-an-object', 'A bare number.', '42', {
  status: 400,
  counters: { notAnObject: 1 },
});

raw('not-an-object/string', 'not-an-object', 'A bare JSON string.', '"Stop"', {
  status: 400,
  counters: { notAnObject: 1 },
});

raw('not-an-object/true', 'not-an-object', 'A bare boolean.', 'true', {
  status: 400,
  counters: { notAnObject: 1 },
});

// ---------------------------------------------------------------------------
// control-characters — the distinction that matters: a RAW control byte inside
// a JSON string is illegal per RFC 8259 and must be refused; the same byte
// written as a \u escape is legal and must be carried through untouched. A
// listener that refused both would be dropping real payloads; one that
// accepted both would be parsing something that is not JSON.
// ---------------------------------------------------------------------------

raw(
  'control-characters/raw-nul-in-string',
  'control-characters',
  'A literal 0x00 inside a JSON string. Illegal JSON.',
  Buffer.concat([
    Buffer.from('{"session_id":"a', 'utf8'),
    Buffer.from([0x00]),
    Buffer.from('b","hook_event_name":"Stop"}', 'utf8'),
  ]),
  { status: 400, counters: { malformedJson: 1 } },
);

raw(
  'control-characters/raw-newline-in-string',
  'control-characters',
  'A literal 0x0a inside a JSON string. Illegal JSON.',
  '{"session_id":"a\nb","hook_event_name":"Stop"}',
  { status: 400, counters: { malformedJson: 1 } },
);

raw(
  'control-characters/raw-tab-in-string',
  'control-characters',
  'A literal 0x09 inside a JSON string. Illegal JSON.',
  '{"session_id":"a\tb","hook_event_name":"Stop"}',
  { status: 400, counters: { malformedJson: 1 } },
);

raw(
  'control-characters/every-c0-byte-raw',
  'control-characters',
  'All 32 C0 control bytes at once, raw, inside a string.',
  Buffer.concat([
    Buffer.from('{"session_id":"', 'utf8'),
    Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
    Buffer.from('","hook_event_name":"Stop"}', 'utf8'),
  ]),
  { status: 400, counters: { malformedJson: 1 } },
);

raw(
  'control-characters/escaped-nul-accepted',
  'control-characters',
  'The same NUL written as a \\u0000 escape. Legal JSON, must be accepted and must not truncate anything.',
  '{"session_id":"a\\u0000b","hook_event_name":"Stop"}',
  OK,
);

raw(
  'control-characters/escaped-c0-sweep-accepted',
  'control-characters',
  'All 32 C0 controls as \\u escapes. Legal JSON.',
  `{"session_id":"${Array.from({ length: 32 }, (_, i) => `\\u${i.toString(16).padStart(4, '0')}`).join('')}","hook_event_name":"Stop"}`,
  OK,
);

raw(
  'control-characters/ansi-escape-sequence',
  'control-characters',
  'A terminal control sequence, escaped. It must never be interpreted, only carried.',
  '{"session_id":"\\u001b[2J\\u001b[H","hook_event_name":"Stop"}',
  OK,
);

// ---------------------------------------------------------------------------
// encoding — bytes that are not valid UTF-8, and UTF-16 edge cases.
// Buffer#toString('utf8') is lossy rather than throwing, so these must land as
// ordinary parse outcomes and never as an exception.
// ---------------------------------------------------------------------------

raw(
  'encoding/invalid-utf8-bytes',
  'encoding',
  'Bare 0x80-0xff inside a string. Decoding substitutes U+FFFD, so the JSON stays syntactically valid and is accepted with replacement characters.',
  Buffer.concat([
    Buffer.from('{"session_id":"', 'utf8'),
    Buffer.from([0x80, 0x81, 0xfe, 0xff]),
    Buffer.from('","hook_event_name":"Stop"}', 'utf8'),
  ]),
  OK,
);

raw(
  'encoding/truncated-utf8-sequence',
  'encoding',
  'A 3-byte sequence missing its last byte, at the very end of the body.',
  Buffer.concat([
    Buffer.from('{"session_id":"x","hook_event_name":"Stop","pad":"', 'utf8'),
    Buffer.from([0xe2, 0x82]),
    Buffer.from('"}', 'utf8'),
  ]),
  OK,
);

raw(
  'encoding/utf8-bom-prefix',
  'encoding',
  'A UTF-8 BOM before the opening brace. JSON.parse rejects it.',
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"hook_event_name":"Stop"}', 'utf8'),
  ]),
  { status: 400, counters: { malformedJson: 1 } },
);

raw(
  'encoding/lone-surrogate-escape',
  'encoding',
  'An unpaired high surrogate as an escape. Legal JSON, unrepresentable text.',
  '{"session_id":"\\ud800","hook_event_name":"Stop"}',
  OK,
);

raw(
  'encoding/astral-plane',
  'encoding',
  'Four-byte UTF-8 and a surrogate pair escape for the same character.',
  '{"session_id":"\u{1f680}\\ud83d\\ude80","hook_event_name":"Stop"}',
  OK,
);

// ---------------------------------------------------------------------------
// empty
// ---------------------------------------------------------------------------

raw('empty/zero-length-body', 'empty', 'A POST with no body at all.', '', {
  status: 400,
  counters: { emptyBody: 1 },
});

// ---------------------------------------------------------------------------
// oversize — sized against the configured cap, not against a committed blob.
// ---------------------------------------------------------------------------

fill(
  'oversize/one-byte-over',
  'oversize',
  'The smallest body the cap refuses. Off-by-one on the boundary is the whole point.',
  { kind: 'pad', overBy: 1 },
  { status: 413, counters: { oversize: 1 } },
);

fill(
  'oversize/well-over-cap',
  'oversize',
  'Four times the cap. Buffered bytes must stay bounded; the reply must still be a clean 413.',
  { kind: 'pad', multiple: 4 },
  { status: 413, counters: { oversize: 1 } },
);

fill(
  'oversize/valid-json-over-cap',
  'oversize',
  'Perfectly well-formed JSON that is simply too big. Size is refused before syntax is considered.',
  { kind: 'pad', multiple: 2, valid: true },
  { status: 413, counters: { oversize: 1 } },
);

fill(
  'at-cap/exactly-at-cap',
  'at-cap',
  'A valid payload padded to exactly the cap. The boundary is inclusive: this is accepted.',
  { kind: 'pad', overBy: 0, valid: true },
  OK,
);

fill(
  'at-cap/one-byte-under-cap',
  'at-cap',
  'One byte under the cap.',
  { kind: 'pad', overBy: -1, valid: true },
  OK,
);

// ---------------------------------------------------------------------------
// content-type
// ---------------------------------------------------------------------------

raw(
  'content-type/text-plain',
  'content-type',
  'A present, non-JSON media type is refused even when the body would have parsed.',
  '{"hook_event_name":"Stop"}',
  { status: 415, counters: { badContentType: 1 } },
  { headers: { 'content-type': 'text/plain' } },
);

raw(
  'content-type/form-urlencoded',
  'content-type',
  'What a naive form POST would send.',
  'a=1&b=2',
  { status: 415, counters: { badContentType: 1 } },
  { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
);

raw(
  'content-type/octet-stream',
  'content-type',
  'Binary media type.',
  '{"hook_event_name":"Stop"}',
  { status: 415, counters: { badContentType: 1 } },
  { headers: { 'content-type': 'application/octet-stream' } },
);

raw(
  'content-type/absent-is-tolerated',
  'content-type',
  'No Content-Type header at all. Tolerated: the hook snippet is a one-liner and the body is validated regardless.',
  '{"session_id":"x","hook_event_name":"Stop"}',
  OK,
  { headers: { 'content-type': null } },
);

raw(
  'content-type/json-with-charset',
  'content-type',
  'Parameters after the media type are ignored.',
  '{"session_id":"x","hook_event_name":"Stop"}',
  OK,
  { headers: { 'content-type': 'application/json; charset=utf-8' } },
);

raw(
  'content-type/structured-suffix',
  'content-type',
  'A +json structured suffix is JSON.',
  '{"session_id":"x","hook_event_name":"Stop"}',
  OK,
  { headers: { 'content-type': 'application/vnd.anthropic.hook+json' } },
);

raw(
  'content-type/uppercase-json',
  'content-type',
  'Media types are case-insensitive.',
  '{"session_id":"x","hook_event_name":"Stop"}',
  OK,
  { headers: { 'content-type': 'APPLICATION/JSON' } },
);

// ---------------------------------------------------------------------------
// route and method
// ---------------------------------------------------------------------------

raw(
  'route/unknown-path',
  'route',
  'Anything but the event path.',
  '{"a":1}',
  { status: 404, counters: { badRoute: 1 } },
  { path: '/not-the-event-path' },
);

raw(
  'route/root',
  'route',
  'A probe of the root.',
  '{"a":1}',
  { status: 404, counters: { badRoute: 1 } },
  { path: '/' },
);

raw(
  'route/percent-encoded-event-path',
  'route',
  'The path is compared as received. %2F is not a separator and does not become /event.',
  '{"a":1}',
  { status: 404, counters: { badRoute: 1 } },
  { path: '/event%2Fx' },
);

raw(
  'route/traversal-attempt',
  'route',
  'A directory-traversal path. The listener serves no files at all, so this can only ever be a 404.',
  '{"a":1}',
  { status: 404, counters: { badRoute: 1 } },
  { path: '/event/../../../../windows/win.ini' },
);

raw(
  'route/query-string-is-stripped',
  'route',
  'A query string does not change the route.',
  '{"session_id":"x","hook_event_name":"Stop"}',
  OK,
  { path: '/event?x=1&y=2' },
);

raw('method/get', 'method', 'GET on the event path.', '', {
  status: 405,
  counters: { badMethod: 1 },
}, { method: 'GET' });

raw('method/put', 'method', 'PUT on the event path.', '{"a":1}', {
  status: 405,
  counters: { badMethod: 1 },
}, { method: 'PUT' });

raw('method/delete', 'method', 'DELETE on the event path.', '', {
  status: 405,
  counters: { badMethod: 1 },
}, { method: 'DELETE' });

raw('method/options', 'method', 'A CORS preflight. There is no CORS surface to grant.', '', {
  status: 405,
  counters: { badMethod: 1 },
}, { method: 'OPTIONS' });

// ---------------------------------------------------------------------------
// non-loopback — G5. These run against a listener constructed with the
// TEST-ONLY spoofRemoteAddress option, so the suite never binds a
// non-loopback socket in order to prove a non-loopback rejection.
// ---------------------------------------------------------------------------

const nonLoopback = [
  ['lan-rfc1918', '192.168.1.50', 'A machine on the same LAN.'],
  ['carrier-nat', '100.64.0.7', 'CGNAT space.'],
  ['public-ipv4', '203.0.113.9', 'A routable public address.'],
  ['link-local', '169.254.1.1', 'IPv4 link-local.'],
  ['ipv6-global', '2001:db8::1', 'A global IPv6 address.'],
  ['ipv6-mapped-lan', '::ffff:10.0.0.5', 'An IPv4-mapped RFC1918 address.'],
  [
    'ipv6-link-local-zoned',
    'fe80::1%eth0',
    'IPv6 link-local with a zone id. The zone must not smuggle it past the check.',
  ],
  ['wildcard-v4', '0.0.0.0', 'The unspecified IPv4 address.'],
  ['wildcard-v6', '::', 'The unspecified IPv6 address.'],
  ['almost-loopback', '127.0.0.1.evil.example', 'A hostname that merely begins with the loopback text.'],
  ['loopback-suffix', 'evil-127.0.0.1', 'A string ending in the loopback text.'],
  ['octal-loopback', '0177.0.0.1', 'An octal spelling of 127.0.0.1. Refused: the guard parses decimal only.'],
  ['empty-remote', '', 'No remote address at all: refused, never defaulted to loopback.'],
];

for (const [id, address, note] of nonLoopback) {
  raw(
    `non-loopback/${id}`,
    'non-loopback',
    note,
    '{"session_id":"x","hook_event_name":"Stop"}',
    { status: 403, counters: { droppedNonLoopback: 1 } },
    { remote: address },
  );
}

raw(
  'non-loopback/well-formed-from-off-box',
  'non-loopback',
  'A perfect payload from a LAN address. Refused on origin alone; accepted must not move.',
  JSON.stringify({
    session_id: '00000000-0000-4000-8000-0000000000ff',
    hook_event_name: 'PreToolUse',
    agent_id: '00000000-0000-4000-8000-0000000000af',
    tool_use_id: 'toolu_synthetic_ff',
  }),
  { status: 403, counters: { droppedNonLoopback: 1 } },
  { remote: '10.1.2.3' },
);

raw(
  'non-loopback/oversize-from-off-box',
  'non-loopback',
  'Origin is checked before size, so this is a 403 and not a 413.',
  'x'.repeat(4096),
  { status: 403, counters: { droppedNonLoopback: 1 } },
  { remote: '198.51.100.4' },
);

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

const ids = new Set();
for (const c of cases) {
  if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
  ids.add(c.id);
}

const text = `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`;

// Guard the guard: the emitted file must be printable ASCII plus \n. Anything
// else means a raw byte escaped the base64 encoding and the corpus is about to
// become binary to git.
for (let i = 0; i < text.length; i += 1) {
  const code = text.charCodeAt(i);
  if (code === 0x0a) continue;
  if (code < 0x20 || code > 0x7e) {
    throw new Error(
      `non-ASCII code unit 0x${code.toString(16)} at offset ${i}: encode it, do not embed it`,
    );
  }
}

const out = fileURLToPath(new URL('./corpus.jsonl', import.meta.url));
writeFileSync(out, text, 'utf8');
process.stdout.write(`${String(cases.length)} cases -> ${out}\n`);
