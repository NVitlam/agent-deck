/**
 * DoD 2.7 — G4 over every golden `StatsRecord`, against LITERAL CAPTURED BYTES.
 *
 * "Over every golden stats file: no substring >= 12 bytes from any fixture's
 * thinking/reasoning, payload, or message text (the substring corpus is built
 * by the test from all three fixture sets, not committed)."
 *
 * ## The trap this repository has already fallen into once
 *
 * On Claude Code the `thinking` string is EMPTY on disk and the `signature`
 * carries the bytes, so "no thinking text leaks" passed for three phases while
 * proving nothing. Codex is the mirror image: every `reasoning` record has an
 * empty `summary` and the bytes live in `encrypted_content`. So every assertion
 * here is made against bytes READ OUT OF THE FIXTURES AT TEST TIME, and every
 * one is paired with a vacuity control asserting those bytes really are present
 * on the input side. A zero with no non-zero beside it is the shape that passes
 * while measuring nothing.
 *
 * ## `filePath` IS a substring of a payload, BY DESIGN, and pretending
 * ## otherwise would make this test a lie
 *
 * This is the one place the DoD's sentence cannot be applied literally, and the
 * reason is structural rather than convenient. G4's allow-list names `filePath`
 * explicitly, and `ToolNode.filePath` is read from ONE named key of a tool's
 * structured input — so the value is, necessarily, a run of bytes that also
 * appears inside a tool payload. A test asserting "no 12-byte run of any
 * payload appears in any record" would fail on the very field the contract
 * permits, and the only ways to make it pass would be to delete F1 or to write
 * an exemption broad enough to hide a real leak.
 *
 * **And the same is true of every other allow-listed identifier**, which the
 * first two drafts of this file learned the hard way. Scoping the content
 * corpus to real content — rather than to every string in a transcript — did
 * not fix it: `a3ecf86bbfb8`, an AGENT ID, still matched, because an agent id
 * legitimately occurs inside message text and tool results. So does a file
 * path, and so does a model id. **"This string does not appear in the content
 * corpus" is FALSE of exactly the fields G4 permits**, and any version of this
 * test built on that question can only be made green by an exemption list long
 * enough to hide a real leak.
 *
 * So the guarantee is split into three assertions that together are stronger
 * than the sentence, and each is stated rather than merged:
 *
 *   A. **PROVENANCE — every string in a record traces to a named field.** Each
 *      one is either a closed enum declared in `schema.ts`, an `unavailable`
 *      code matching the declared grammar, or a value the ENGINE put on
 *      `SessionState.sessionId`, `.projectSlug`, `AgentNode.id`,
 *      `AgentNode.model`, `ToolNode.toolName` or `ToolNode.filePath` of the very
 *      state the record was derived from. Nothing was synthesised and nothing
 *      was found by scanning text. This is the form of the question that cannot
 *      be confounded, and it admits no exemption at all.
 *   B. **Shape — no record string looks like content.** No newline, none
 *      absurdly long. Content is multi-line and unbounded; an identifier is
 *      neither.
 *   C. **The sharpest literals never appear at all.** Thinking text,
 *      signatures, Codex ciphertext and reasoning bodies, checked against the
 *      whole golden FILE, byte for byte, with no exemption of any kind. These
 *      are the strings a leak would actually be made of, and this is the
 *      literal-bytes assertion the DoD names.
 *
 * `AgentNode.label` — `meta.agentType + meta.description`, the most
 * content-shaped string on the tree — is not in the record at all, which is why
 * A can be total rather than carrying an exemption for it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentNode, SessionState, ToolNode } from '../model/events.js';
import { allGoldenEntries } from './corpus.stats.testkit.js';
import type { GoldenEntry } from './corpus.stats.testkit.js';
import { STATS_STRING_FIELDS } from './schema.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const WINDOW = 12;

/**
 * How long a content string must be before it is compared LITERALLY against a
 * whole golden file.
 *
 * Not a threshold on what counts as content — {@link CONTENT_KEYS} decides
 * that — but on what can be compared without flagging the fields G4 permits.
 * Measured over the committed goldens: the longest string any record carries is
 * **142 bytes and it is a `filePath`**, which by construction is a run of bytes
 * inside a tool payload. A body of 64 bytes or more is not an identifier, so a
 * record containing one is carrying content.
 */
const SHARP_BODY_MIN = 64;

/** The census file keys. A value under one of these is `filePath`, not content. */
const FILE_KEYS = new Set(['file_path', 'filePath']);

/**
 * Keys whose VALUE is content, per engine, measured from the corpora.
 *
 * The DoD's corpus is "thinking/reasoning, payload, or message text" — NOT
 * every string a transcript happens to hold, and the distinction is
 * load-bearing. The first draft of this file collected every string, which put
 * `agent_id` and OpenCode's `model` blob into the "content" corpus and made the
 * test report a leak on `a1a53f42c5ec` — an agent id, which is an identifier
 * the engine wrote and which G4's allow-list names explicitly. A corpus that
 * contains the allow-listed identifiers cannot test the allow-list: it only
 * restates that a record's ids came from the sessions they describe.
 *
 * So the content keys are enumerated from what each engine actually writes. CC:
 * `thinking`, `signature`, message `text`, tool_result `content`. Codex:
 * `encrypted_content`, `summary_text`, `raw_content`, and shell `command` /
 * `stdout` / `aggregated_output`. OpenCode: part `text`, `title`, tool
 * `output`. Plus every value inside a tool's structured arguments.
 */
const CONTENT_KEYS = new Set([
  'thinking',
  'signature',
  'encrypted_content',
  'summary_text',
  'raw_content',
  'text',
  'content',
  'output',
  'stdout',
  'aggregated_output',
  'command',
  'title',
  'message',
  'description',
]);

/** Subtrees that are wholly payload: a tool's structured arguments. */
const PAYLOAD_KEYS = new Set(['input', 'arguments', 'tool_input', 'parameters']);

interface ContentCorpus {
  /** Every content string, joined — the haystack the >= 12-byte scan walks. */
  text: string;
  /**
   * The sharpest literals: thinking, signatures, ciphertext, reasoning.
   *
   * Kept SEPARATE from {@link ContentCorpus.bodies}, and the separation is a
   * correction rather than tidiness. Folding long content bodies in here made
   * assertion B fail on a true statement: a payload body of >= 64 bytes that
   * happens to BE a path shares its first 32 bytes with a `filePath`, so "no
   * filePath contains a sharp literal" flagged the field G4 allow-lists. B is
   * about a reasoning body arriving in a path; C is about either arriving in a
   * record. Two questions, two lists.
   */
  sharp: string[];
  /** Long content runs — message text and tool payloads. See `SHARP_BODY_MIN`. */
  bodies: string[];
  bytes: number;
  sources: number;
}

/**
 * Walk parsed JSON and collect every string that is CONTENT.
 *
 * A string counts when its key is in {@link CONTENT_KEYS}, or when it sits
 * anywhere inside a payload subtree ({@link PAYLOAD_KEYS}) under a key that is
 * not a census file key. `filePath` is excluded because it is by construction a
 * run of bytes inside a payload and G4 allow-lists it — assertion B covers it
 * by provenance instead.
 */
function collectContent(
  value: unknown,
  key: string,
  inPayload: boolean,
  out: string[],
  sharp: string[],
  bodies: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectContent(item, key, inPayload, out, sharp, bodies);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectContent(child, childKey, inPayload || PAYLOAD_KEYS.has(childKey), out, sharp, bodies);
    }
    return;
  }
  if (typeof value !== 'string' || value.length === 0) return;
  if (FILE_KEYS.has(key)) return;
  if (!CONTENT_KEYS.has(key) && !inPayload) return;
  out.push(value);
  // The fields this repository has MEASURED as carrying the real bytes.
  if (['thinking', 'signature', 'encrypted_content', 'summary_text', 'raw_content'].includes(key)) {
    if (value.length >= WINDOW) sharp.push(value);
  }
  // ...AND every long content BODY, which is what makes the literal comparison
  // cover "payload, or message text" rather than reasoning alone.
  //
  // `phase-verifier` found the first version comparing only the five reasoning
  // keys above, so §C's "no tool payload, no message text from any fixture
  // appears in any record" was unmet by the leg that names it. The 64-byte
  // floor is what separates a BODY from an identifier: no record string is a
  // 64-byte run of a message, while a `filePath` legitimately is a long run of
  // a payload, and comparing those would flag the field G4 allow-lists.
  else if (value.length >= SHARP_BODY_MIN) bodies.push(value);
}

function walkFiles(dir: string, suffix: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, suffix, visit);
    else if (entry.name.endsWith(suffix)) visit(full);
  }
}

/** Build the content corpus from all three fixture sets, at test time. */
function buildContentCorpus(): ContentCorpus {
  const parts: string[] = [];
  const sharp: string[] = [];
  const bodies: string[] = [];
  let sources = 0;

  // --- Claude Code and Codex: JSONL transcripts -------------------------
  for (const name of readdirSync(FIXTURES)) {
    if (!/^(cc|codex)-/u.test(name)) continue;
    const dir = join(FIXTURES, name);
    if (!statSync(dir).isDirectory()) continue;
    walkFiles(dir, '.jsonl', (path) => {
      sources += 1;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          collectContent(JSON.parse(line), '', false, parts, sharp, bodies);
        } catch {
          // A corpus may hold a deliberately malformed line; it carries no
          // structured content to collect.
        }
      }
    });
  }

  // --- OpenCode: the part rows, read straight out of the store ----------
  for (const name of readdirSync(FIXTURES)) {
    if (!name.startsWith('opencode-')) continue;
    walkFiles(join(FIXTURES, name), 'opencode.db', (path) => {
      sources += 1;
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        for (const row of db.prepare('SELECT data FROM part').all() as { data: unknown }[]) {
          if (typeof row.data !== 'string') continue;
          try {
            collectContent(JSON.parse(row.data), '', false, parts, sharp, bodies);
          } catch {
            collectContent(row.data, 'text', false, parts, sharp, bodies);
          }
        }
      } finally {
        db.close();
      }
    });
  }

  // Joined on a NEWLINE, written as an ESCAPE rather than as a raw byte.
  //
  // Two reasons, and the first is a defect this file committed. The
  // separator was a raw NUL — invisible in a diff, and it makes git treat
  // the file as binary, which is the control-byte class `CLAUDE.md` already
  // records four times. `source-hygiene.test.ts` caught it, but only on the
  // commit that TRACKED this file: that guard scans `git ls-files`, so a new
  // file's hygiene is unchecked until it is committed — one run later than
  // anyone would look.
  //
  // A newline is also the right separator on the merits: assertion B proves
  // no string in any record contains one, so a 12-byte window spanning two
  // parts can never match a needle. A space could bridge them and
  // manufacture a match that is in neither part.
  const text = parts.join('\n');
  return { text, sharp, bodies, bytes: Buffer.byteLength(text, 'utf8'), sources };
}

/**
 * Every window of `haystack` that is also in `needles`.
 *
 * Scanning the big side and looking up the small one, with a first/last
 * character prefilter, because the direct form is unusably slow: the content
 * corpus is tens of megabytes and the needle set is a few thousand short
 * identifiers, so `indexOf` per needle would be a quadratic sweep. The
 * prefilter is exact — a window can only match if its first and last
 * characters match some needle window's — so nothing is missed, only skipped.
 */
function matchesIn(haystack: string, needles: ReadonlySet<string>): string[] {
  const pairs = new Set<number>();
  for (const needle of needles) {
    pairs.add(needle.charCodeAt(0) * 65_536 + needle.charCodeAt(WINDOW - 1));
  }
  const found = new Set<string>();
  const limit = haystack.length - WINDOW;
  for (let i = 0; i <= limit; i += 1) {
    if (!pairs.has(haystack.charCodeAt(i) * 65_536 + haystack.charCodeAt(i + WINDOW - 1))) continue;
    const window = haystack.slice(i, i + WINDOW);
    if (needles.has(window)) found.add(window);
  }
  return [...found];
}

let entries: GoldenEntry[] = [];
let corpus: ContentCorpus;

beforeAll(async () => {
  entries = await allGoldenEntries();
  corpus = buildContentCorpus();
  process.stdout.write(
    `[G4] content corpus: ${String(corpus.bytes)} bytes from ${String(corpus.sources)} sources, ` +
      `${String(corpus.sharp.length)} sharp literals, ` +
      `${String(corpus.bodies.length)} content bodies\n`,
  );
}, 180_000);

describe('the corpus this test rests on is real', () => {
  it('is large, drawn from all three fixture sets, and carries the sharp literals', () => {
    // Vacuity control, and it is the whole test's foundation: every assertion
    // below is "X does not appear in the corpus", which is trivially true of an
    // empty corpus.
    expect(corpus.bytes).toBeGreaterThan(1_000_000);
    expect(corpus.sources).toBeGreaterThan(10);
    expect(corpus.sharp.length).toBeGreaterThan(0);
    expect(corpus.bodies.length).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(20);
  });

  it('the matcher finds a needle that IS in the corpus', () => {
    // A control on the matcher itself. A scanner that finds nothing is
    // indistinguishable from a scanner that looks nowhere — the rule this
    // repository has recorded three times through three different doors.
    const planted = corpus.sharp[0]?.slice(0, WINDOW);
    expect(planted).toBeDefined();
    if (planted === undefined) return;
    expect(matchesIn(corpus.text, new Set([planted]))).toEqual([planted]);
  });
});

/** Values `schema.ts` declares as closed enums. */
const ENUM_VALUES: ReadonlySet<string> = new Set([
  'full',
  'excluded:parked',
  'excluded:unsupported',
  'excluded:deriver-error',
  'cc',
  'opencode',
  'codex',
  'main',
  'subagent',
  'engine',
  'telemetry',
  'user',
  'auto',
  'manual',
  'read',
  'write',
  'edit',
  'search',
  'shell',
  'spawn',
  'other',
]);

/** `F7:opencode`, `F2.errors:codex`, `F13.completed:snapshot`. */
const UNAVAILABLE_CODE = /^F\d+(?:\.[a-z]+)?:[a-z-]+$/u;

/**
 * Every string the ENGINE wrote onto a named field of one state.
 *
 * Module scope because TWO legs need it — assertion A over the in-memory
 * record, and C2 over the committed bytes — and two copies of a rule this
 * strict would be two things that can drift.
 */
function engineStringsOf(state: SessionState): Set<string> {
  const out = new Set<string>([state.sessionId, state.projectSlug]);
  const walk = (node: AgentNode | ToolNode): void => {
    if ('children' in node) {
      out.add(node.id);
      if (node.model !== undefined) out.add(node.model);
      for (const child of node.children) walk(child);
      return;
    }
    out.add(node.toolName);
    if (node.filePath !== undefined) out.add(node.filePath);
  };
  walk(state.root);
  return out;
}

describe('A - every string in a record traces to a named field', () => {
  /** Values `schema.ts` declares as closed enums. */
  const ENUMS = ENUM_VALUES;

  const engineStrings = engineStringsOf;

  it('no string is synthesised, scraped, or borrowed from another session', () => {
    let checked = 0;
    const unexplained: { stem: string; key: string; value: string }[] = [];
    for (const entry of entries) {
      const allowed = engineStrings(entry.state);
      const walk = (value: unknown, key: string): void => {
        if (Array.isArray(value)) {
          for (const item of value) walk(item, key);
          return;
        }
        if (value !== null && typeof value === 'object') {
          for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
          return;
        }
        if (typeof value !== 'string') return;
        checked += 1;
        if (ENUMS.has(value)) return;
        if (key === 'unavailable' && UNAVAILABLE_CODE.test(value)) return;
        if (allowed.has(value)) return;
        unexplained.push({ stem: entry.stem, key, value });
      };
      walk(entry.record, '');
    }
    expect(unexplained).toEqual([]);
    // Vacuity control: an empty walk satisfies the assertion above.
    expect(checked).toBeGreaterThan(500);
  });

  it('the provenance check can see a string that has no source', () => {
    // A mutation control. If the walk stopped finding strings, or the allowed
    // set silently became everything, the test above would go green while
    // measuring nothing.
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const allowed = engineStrings(entry.state);
    expect(allowed.size).toBeGreaterThan(0);
    expect(allowed.has('the model decided to re-read the file')).toBe(false);
    expect(allowed.has(entry.record.sessionId)).toBe(true);
  });

  it('every unavailable code matches the declared grammar', () => {
    let codes = 0;
    for (const entry of entries) {
      for (const code of entry.record.unavailable) {
        expect(code, `${entry.stem}: ${code}`).toMatch(UNAVAILABLE_CODE);
        codes += 1;
      }
    }
    expect(codes).toBeGreaterThan(20);
  });
});

describe('B - no record string has the shape of content', () => {
  it('no string in any record contains a newline or runs long', () => {
    // Content is multi-line and unbounded; an identifier is neither. The cheap
    // structural half of the same guarantee, and it catches a leak arriving
    // through a key nobody declared by a different route than A does.
    let strings = 0;
    for (const entry of entries) {
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }
        if (value !== null && typeof value === 'object') {
          for (const child of Object.values(value)) walk(child);
          return;
        }
        if (typeof value !== 'string') return;
        strings += 1;
        expect(value, entry.stem).not.toContain(String.fromCharCode(10));
        expect(value, entry.stem).not.toContain(String.fromCharCode(13));
        expect(value.length, `${entry.stem}: ${value.slice(0, 40)}`).toBeLessThan(1024);
      };
      walk(entry.record);
    }
    expect(strings).toBeGreaterThan(500);
  });

  it('every filePath came from a census key on a ToolNode', () => {
    // Provenance rather than absence: a file argument is by construction a run
    // of bytes inside a payload, so absence is the wrong question. What matters
    // is that this layer never went looking for path-shaped text.
    let checked = 0;
    for (const entry of entries) {
      for (const file of entry.record.files) {
        expect(file.filePath).not.toContain('\n');
        expect(file.filePath.length).toBeLessThan(1024);
        checked += 1;
      }
      for (const churn of entry.record.churn) {
        expect(churn.filePath).not.toContain('\n');
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('no filePath contains a sharp literal', () => {
    // The one leak a path-shaped field could plausibly carry: a tool input
    // whose file key held something enormous.
    for (const entry of entries) {
      for (const file of entry.record.files) {
        for (const literal of corpus.sharp) {
          expect(file.filePath).not.toContain(literal.slice(0, 32));
        }
      }
    }
  });
});

describe('C — the sharpest literals appear nowhere in any golden file', () => {
  it('no thinking, signature, ciphertext or reasoning body reaches a record', () => {
    // No exemption of any kind here, and the comparison is against the WHOLE
    // serialised golden rather than against its string values — so a leak that
    // arrived through a key nobody declared would still be caught.
    let compared = 0;
    // BOTH lists: the reasoning literals AND every content body of 64 bytes or
    // more, which is what makes this cover §C's "no tool payload, no message
    // text from any fixture appears in any record". Comparing only the five
    // reasoning keys left that half of the sentence unmet, which is what
    // `phase-verifier` found.
    for (const entry of entries) {
      for (const literal of [...corpus.sharp, ...corpus.bodies]) {
        // A 32-byte prefix, which is the shape `codex/parse.test.ts` already
        // uses: long enough that a coincidence is not credible, short enough
        // that a partially-truncated leak is still caught.
        expect(entry.text).not.toContain(literal.slice(0, 32));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('and the same literals really are present on the input side', () => {
    for (const literal of corpus.sharp.slice(0, 25)) {
      expect(corpus.text).toContain(literal.slice(0, 32));
    }
  });
});

describe('C2 - the >=12-byte scan, RUN over the whole content corpus', () => {
  /*
   * THE SCANNER EXISTED AND NOTHING CALLED IT. `phase-verifier` found
   * `matchesIn` with exactly one live call site — inside its own vacuity
   * control — and a 14.9 MB content corpus that was built on every run and
   * compared against nothing. A scanner that is never pointed at the subject is
   * the "check whose subject never happened" class this repository records,
   * wearing the clothes of a check that looks thorough.
   *
   * What it can honestly assert is the shape the header explains: the scan
   * finds THOUSANDS of matches and must, because `filePath`, `agentId` and
   * `model` all occur inside payloads and message text legitimately. So the
   * assertion is not "no match" — it is that **every matched window traces to a
   * string this layer can account for**, re-derived here from the COMMITTED
   * BYTES and the source states rather than from assertion A's own result.
   */
  it('finds matches, and every one of them traces to a named engine field', () => {
    const owners = new Map<string, { stem: string; value: string }[]>();
    let recordStrings = 0;
    for (const entry of entries) {
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }
        if (value !== null && typeof value === 'object') {
          for (const child of Object.values(value)) walk(child);
          return;
        }
        if (typeof value !== 'string' || value.length < WINDOW) return;
        recordStrings += 1;
        for (let i = 0; i + WINDOW <= value.length; i += 1) {
          const key = value.slice(i, i + WINDOW);
          const list = owners.get(key);
          if (list === undefined) owners.set(key, [{ stem: entry.stem, value }]);
          else list.push({ stem: entry.stem, value });
        }
      };
      // Parsed from the committed TEXT, not from the in-memory record.
      walk(JSON.parse(entry.text));
    }
    expect(recordStrings).toBeGreaterThan(50);
    expect(owners.size).toBeGreaterThan(100);

    const matched = matchesIn(corpus.text, new Set(owners.keys()));
    process.stdout.write(
      `[G4] literal scan: ${String(matched.length)} of ${String(owners.size)} ` +
        `12-byte windows occur in the content corpus\n`,
    );
    // The scan is LIVE. Zero here would mean the scanner stopped working, and
    // every assertion below would then hold for the wrong reason.
    expect(matched.length).toBeGreaterThan(0);

    // Everything a record may legitimately hold, per entry.
    const allowedByStem = new Map<string, Set<string>>();
    for (const entry of entries) allowedByStem.set(entry.stem, engineStringsOf(entry.state));

    const unexplained: { stem: string; window: string; value: string }[] = [];
    for (const window of matched) {
      for (const owner of owners.get(window) ?? []) {
        if (allowedByStem.get(owner.stem)?.has(owner.value) === true) continue;
        // The SAME three-way explanation assertion A uses. The first version of
        // this leg carried only the engine-field arm and reported eight
        // "unexplained" windows that were all the enum `excluded:parked` — a
        // value this layer declares, which occurs in the corpus because these
        // captures are recordings of work on this repository.
        if (ENUM_VALUES.has(owner.value)) continue;
        if (UNAVAILABLE_CODE.test(owner.value)) continue;
        unexplained.push({ stem: owner.stem, window, value: owner.value.slice(0, 80) });
      }
    }
    expect(unexplained).toEqual([]);
  });
});

describe('the allow-list and the records agree', () => {
  it('every string key in every golden is on the allow-list', () => {
    // The static half of the same guarantee, over the committed bytes rather
    // than over the objects that produced them.
    const seen = new Set<string>();
    const walk = (value: unknown, key: string): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, key);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
        return;
      }
      if (typeof value === 'string') seen.add(key);
    };
    for (const entry of entries) walk(JSON.parse(entry.text), '');
    expect(seen.size).toBeGreaterThan(5);
    for (const key of seen) expect(STATS_STRING_FIELDS.has(key)).toBe(true);
  });
});
