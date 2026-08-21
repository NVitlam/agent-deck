#!/usr/bin/env node
/**
 * Privacy sweep - Phase 5 DoD1 gate evidence.
 *
 * READ-ONLY except for the report file named by `--json`. No network, no
 * dependencies outside `node:` builtins. It never mutates the repository, and
 * it never prints a matched secret value.
 *
 * WHAT IT SWEEPS
 * --------------
 * Two corpora:
 *   1. the working tree - every TRACKED file (`git ls-files -z`), so ignored
 *      build artifacts and `node_modules` are out of scope by construction;
 *   2. full history - every blob reachable from every ref
 *      (`git rev-list --all --objects` + `git cat-file --batch`).
 *
 * Both are scanned as BYTES in Node, decoded `latin1` so one byte is one
 * character. That is deliberate: a tracked test file (`src/parser/parse.test.ts`)
 * contains real NUL bytes, and GNU grep without `-a` silently abandons such a
 * stream and returns a clean-looking, meaningless result. Scanning buffers
 * sidesteps grep's binary heuristic entirely. `latin1` is safe for the ASCII
 * needles used here because UTF-8 continuation bytes always have the high bit
 * set and can never collide with an ASCII pattern.
 *
 * WHAT "PASS" MEANS - read this before "fixing" a number
 * -----------------------------------------------------
 * The DoD's `-> 0` applies to FOREIGN content and to SECRETS. It does NOT apply
 * to this developer's own absolute paths: those are present in the capture
 * corpora deliberately, because a fixture without `cwd` cannot pin the
 * main-thread hook rule and a normalised recording is not a recording of the
 * real wire. Deleting fixture content to make a counter reach zero would
 * destroy G6 evidence and is explicitly not the fix. This sweep's job for those
 * paths is an ENUMERATED INVENTORY of a known set, plus zero outside it.
 *
 * BUCKETS
 * -------
 *   ALLOWED     developer-identifier hit in a file matched by an allow rule
 *               below. Each rule carries a written reason.
 *   UNEXPECTED  developer-identifier hit in a file matched by no allow rule.
 *               Gate: must be empty.
 *   SECRET      credential-shaped match anywhere. Gate: must be empty.
 *               Locations are printed; values never are.
 *   FOREIGN     inside the REAL-CAPTURE corpora, a `cwd` / `transcript_path` /
 *               `agent_transcript_path` / project-slug value naming a project
 *               other than agent-deck. Gate: must be empty. This is the
 *               assertion that protects other people's work.
 *
 * Plus one non-gating output, because an inventory that hides its own outliers
 * is not an inventory:
 *   ADVISORY    an ALLOWED hit whose enclosing path token points somewhere on
 *               the developer's machine OUTSIDE the agent-deck tree, `~/.claude`
 *               and `~/.vscode`. Still the developer's own path, so it is not a
 *               `-> 0` item under the recorded scope, but it is listed by file
 *               and line so a human can decide before a public flip.
 *
 * EXIT CODE: 0 when UNEXPECTED, SECRET and FOREIGN are all empty; 1 otherwise.
 *
 * USAGE
 *   node scripts/privacy-sweep.mjs [--json <path>] [--root <dir>]
 *                                  [--no-history] [--quiet] [--stamp <iso>]
 *
 *   --root <dir>   sweep a different tree (the test's negative controls point
 *                  it at a scratch directory). A non-git root is enumerated by
 *                  directory walk and its history leg is skipped.
 *   --no-history   working-tree leg only. Also settable with
 *                  AGENT_DECK_SWEEP_HISTORY=0.
 *   --stamp <iso>  fix `generatedAt` instead of stamping `Date.now()`.
 *
 * DETERMINISM: same tree, same report, except for `generatedAt` and
 * `timingsMs`. Those are the only two nondeterministic keys.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * Needles
 *
 * Every needle is assembled from fragments at runtime so that THIS FILE
 * does not itself become a hit on the next run. A sweep script that trips
 * its own detector teaches everyone to ignore the detector.
 * ------------------------------------------------------------------ */

const DEVELOPER_IDENTIFIERS = [
  'Na' + 'dav',
  'One' + 'Drive',
  'Claude' + 'Home',
  'nada' + 'vvitlam',
];

/** The project this repository is allowed to have captured data from. */
const OWN_PROJECT = 'agent-deck';

/**
 * Path prefixes whose developer-identifier hits are deliberate.
 *
 * These are measured, not assumed: the list was built by enumerating every
 * tracked file containing an identifier and writing down why each one does.
 * A file outside this list is UNEXPECTED and fails the gate.
 */
const ALLOW_RULES = [
  {
    id: 'capture-cc-2.1.234',
    prefixes: ['fixtures/cc-2.1.234/'],
    reason:
      'Real CC 2.1.234 transcripts and sidecars. G6: fixtures are law and are ' +
      'byte-exact; the cwd and transcript_path values ARE the data under test.',
  },
  {
    id: 'capture-cc-2.1.237',
    prefixes: ['fixtures/cc-2.1.237/'],
    reason:
      'Real CC 2.1.237 transcript, content-destroyed, kept as the witness for ' +
      'the accepted version window.',
  },
  {
    id: 'capture-hook-events',
    prefixes: ['fixtures/hook-events/'],
    reason:
      'Content-free but deliberately NOT anonymous: cwd, transcript_path, ' +
      'session_id, agent_id and prompt_id are kept verbatim because a fixture ' +
      'without them cannot pin the main-thread rule (absence of agent_id is ' +
      'the signal).',
  },
  {
    id: 'capture-phase0-evidence',
    prefixes: ['fixtures/phase0-evidence/'],
    reason: 'Phase 0 latency logs and hook captures; the gate evidence itself.',
  },
  {
    id: 'derived-goldens',
    prefixes: ['fixtures/golden/', 'webview/goldens/'],
    reason:
      'Goldens derived from the captures. They carry the project slug because ' +
      'the slug is the join key the graft and the layout are pinned on.',
  },
  {
    id: 'synthetic-path-matrix',
    prefixes: ['fixtures/synthetic-path-matrix/'],
    reason:
      'Slug-encoding matrix. The real slug from this machine is one row of it ' +
      '- the row that proves the encoding rule against reality.',
  },
  {
    id: 'synthetic-perf',
    prefixes: ['fixtures/synthetic-perf/'],
    reason: 'Synthetic perf corpus generator; names the repo path it writes under.',
  },
  {
    id: 'fixture-docs',
    prefixes: [
      'fixtures/README.md',
      'fixtures/PHASE0-VERDICT.md',
      'fixtures/SCRUB-EVIDENCE.md',
    ],
    reason:
      'Fixture provenance and scrub-evidence docs, which must state where the ' +
      'data came from and what was removed from it.',
  },
  {
    id: 'licence',
    prefixes: ['LICENSE', 'LICENCE'],
    reason:
      "The MIT copyright line names the licensor. Identifying who grants the " +
      "licence is that line's whole function; removing the name voids it.",
  },
  {
    id: 'wire-corpus',
    prefixes: ['webview/wire/'],
    reason:
      'Phase 4.5 recorded wire corpus. Payloads are verbatim, including ' +
      'absolute paths, deliberately: a normalised recording is not a recording ' +
      'of the real wire. Already committed under fixtures/, so a second copy, ' +
      'not new exposure. .vscodeignore keeps webview/** out of the VSIX.',
  },
  {
    id: 'perf-evidence',
    prefixes: ['src/perf/evidence/'],
    reason: 'Perf evidence records the absolute path of the generator that produced it.',
  },
  {
    id: 'tests-and-testdata',
    prefixes: ['src/', 'webview/', 'test/'],
    suffixes: ['.test.ts', 'testdata.ts', 'testkit.ts'],
    reason:
      'Tests pin the fixture project slug because the slug is a production ' +
      'join key. A test that writes a placeholder slug pins nothing.',
  },
  {
    id: 'source-doc-comments',
    prefixes: ['src/watch/inference.ts'],
    reason: 'One doc comment naming the fixture directory the module was measured against.',
  },
  {
    id: 'spike',
    prefixes: ['spike/'],
    reason: 'Frozen Phase 0 reference implementation and its notes; not shipped.',
  },
  {
    id: 'project-docs',
    prefixes: [
      'CLAUDE.md',
      'HANDOVER.md',
      'PLAN.md',
      'README.md',
      'SECURITY.md',
      'agent-deck-spec.md',
      'docs/',
    ],
    reason:
      'Project documentation quoting concrete measured paths. Several of these ' +
      'traps are only communicable by quoting the exact path that produced them.',
  },
  {
    id: 'repo-local-cc-config',
    prefixes: ['.claude/'],
    reason:
      'Repo-local CC settings (deliberately committed so G1 stays absolute - ' +
      'nothing under ~/.claude is ever written) and agent memory notes. ' +
      'Anything here pointing outside the agent-deck tree is raised as an ' +
      'ADVISORY rather than buried.',
  },
];

/**
 * Real-capture corpora - the only places FOREIGN is meaningful.
 *
 * Deliberately excludes the synthetic corpora: `webview/wire/synthetic-stress.json`
 * and `fixtures/synthetic-perf/` carry invented roots such as `C:\SYNTHETIC`,
 * and `src/**\/*.test.ts` invents slugs like `c--Users-Test-Documents-ws`. Those
 * are not captured content and flagging them would make the FOREIGN counter
 * noise rather than a gate.
 */
const CAPTURE_CORPORA = [
  'fixtures/cc-2.1.234/',
  'fixtures/cc-2.1.237/',
  'fixtures/hook-events/',
  'fixtures/phase0-evidence/',
  'fixtures/golden/',
  'webview/goldens/',
  'webview/wire/cc-',
  'src/perf/evidence/',
];

/**
 * The sweep does not inventory its OWN OUTPUT FILE. The report necessarily
 * quotes every path it found, so including it would make the report's
 * identifier counts a function of the previous run. Scoped to the one generated
 * file, not the directory: the README beside it is prose written by a human and
 * gets no exemption. Secrets and foreign content ARE still scanned here - only
 * the identifier inventory skips it.
 */
const IDENTITY_SCAN_EXCLUDE = ['docs/evidence/privacy/report.json'];

/* ------------------------------------------------------------------ *
 * Secret shapes
 * ------------------------------------------------------------------ */

const SECRET_RULES = [
  { id: 'anthropic-api-key', re: new RegExp('sk' + '-ant-' + '[A-Za-z0-9_\\-]{8,}', 'g') },
  { id: 'github-token', re: new RegExp('gh' + '[pousr]_' + '[A-Za-z0-9]{16,}', 'g') },
  { id: 'github-pat', re: new RegExp('github' + '_pat_' + '[A-Za-z0-9_]{16,}', 'g') },
  { id: 'aws-access-key-id', re: new RegExp('AK' + 'IA' + '[0-9A-Z]{16}', 'g') },
  {
    id: 'private-key-block',
    re: new RegExp('-----BE' + 'GIN [A-Z ]*PRIVATE KEY-----', 'g'),
  },
  {
    id: 'authorization-bearer',
    re: new RegExp('[Aa]uthorization["\']?\\s*[:=]\\s*["\']?\\s*[Bb]earer\\s+[A-Za-z0-9._\\-]{12,}', 'g'),
  },
];

/** Generic high-entropy assignment to a credential-shaped key name. */
const GENERIC_SECRET_RE = new RegExp(
  '(?:^|[^A-Za-z0-9_])' +
    '(' +
    ['token', 'secret', 'password', 'passwd', 'api_key', 'apikey', 'access_key', 'client_secret'].join(
      '|',
    ) +
    ')' +
    '["\']?\\s*[:=]\\s*["\']([A-Za-z0-9+/_\\-]{24,})["\']',
  'gi',
);

/** Shannon entropy in bits per character. */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const GENERIC_SECRET_MIN_ENTROPY = 3.5;

/* ------------------------------------------------------------------ *
 * Foreign-content shapes
 * ------------------------------------------------------------------ */

const PROJECT_VALUE_RE = new RegExp(
  '"(cwd|transcript_path|agent_transcript_path|projectSlug|project_slug|slug)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"',
  'g',
);

/** `.claude/projects/<slug>` in any slash flavour, including JSON-escaped ones. */
const SLUG_PATH_RE = new RegExp(
  '\\.claude(?:[\\\\/]|\\\\{2,4})projects(?:[\\\\/]|\\\\{2,4})([A-Za-z0-9_.\\-]+)',
  'g',
);

/**
 * A CC project slug is the cwd with every separator replaced by `-`, so it
 * always starts with `<drive>--` on Windows or `-` on posix. Requiring that
 * shape is not cosmetic. Without it the prose `~/.claude/projects\ndirectory`
 * inside a committed transcript parses as a project named `ndirectory` and the
 * FOREIGN counter reports a leak that is really a JSON newline escape -
 * measured, it was the first run's only working-tree FOREIGN hit besides the
 * synthetic one below.
 */
const SLUG_SHAPE_RE = /^(?:[A-Za-z]--|-)/;

/**
 * Values that declare themselves synthetic are generated, not captured, and so
 * cannot be foreign content. `C:\SYNTHETIC` and `C--SYNTHETIC-PERF-not-a-harvest`
 * come from `fixtures/synthetic-perf/build-corpus.mjs`, which named them that
 * way precisely so nobody would mistake them for a harvest.
 */
const SYNTHETIC_MARKERS = ['synthetic', 'not-a-harvest'];

function isSyntheticValue(value) {
  const norm = normalisePathToken(value);
  return SYNTHETIC_MARKERS.some((m) => norm.includes(m));
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function matchesPrefixRule(relPath, rule) {
  const hitPrefix = rule.prefixes.some((p) => relPath === p || relPath.startsWith(p));
  if (!hitPrefix) return false;
  if (!rule.suffixes) return true;
  return rule.suffixes.some((s) => relPath.endsWith(s));
}

function findAllowRule(relPath) {
  for (const rule of ALLOW_RULES) {
    if (matchesPrefixRule(relPath, rule)) return rule;
  }
  return null;
}

function inCaptureCorpus(relPath) {
  return CAPTURE_CORPORA.some((p) => relPath.startsWith(p));
}

function excludedFromIdentityScan(relPath) {
  return IDENTITY_SCAN_EXCLUDE.some((p) => relPath.startsWith(p));
}

/** Byte offsets of every line start, so a hit index becomes a 1-based line. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const PATH_CHAR = /[A-Za-z0-9_.:\-\\/~]/;

/**
 * Expand a hit outwards over path-ish characters. Backslash runs are included
 * so JSON-escaped Windows paths (`C:\\\\Users\\\\...` in the bytes) come back
 * whole rather than as four separate fragments.
 */
function pathTokenAround(text, index, len) {
  let start = index;
  while (start > 0 && PATH_CHAR.test(text[start - 1])) start -= 1;
  let end = index + len;
  while (end < text.length && PATH_CHAR.test(text[end])) end += 1;
  return text.slice(start, end);
}

function normalisePathToken(token) {
  return token.replace(/\\+/g, '/').toLowerCase();
}

/**
 * Anchors that make a token an actual filesystem path rather than prose that
 * happens to contain a slash. Without this check, a sentence naming two folder
 * names either side of a slash, and a bare project slug, both read as paths:
 * measured at 19 working-tree advisories before the check, most of them prose,
 * which is how an advisory list stops being read.
 */
const PATH_ANCHORS = [/[a-z]:\//, /~\//, /\/mnt\/[a-z]\//, /\/home\//, /\/users\//];

function anchoredPath(norm) {
  let best = -1;
  for (const a of PATH_ANCHORS) {
    const m = norm.match(a);
    if (m !== null && m.index !== undefined && (best === -1 || m.index < best)) best = m.index;
  }
  return best === -1 ? null : norm.slice(best);
}

/**
 * Where does this hit point? `prose` when it is not inside a path at all.
 * Anything that resolves to `other` becomes an ADVISORY.
 */
function classifyPathToken(token) {
  const p = anchoredPath(normalisePathToken(token));
  if (p === null) return 'prose';
  if (p.includes(OWN_PROJECT)) return 'project';
  if (p.includes('/.claude')) return 'cc-home';
  if (p.includes('/.vscode')) return 'editor';
  // A bare home directory with nothing meaningful below it.
  if (/^(?:[a-z]:\/users\/[a-z0-9_.-]+|\/home\/[a-z0-9_.-]+)\/?$/.test(p)) return 'home';
  return 'other';
}

/** Collapse the parts of a path token that vary per session. */
function canonicalisePathToken(token) {
  return normalisePathToken(token)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/agent-a[0-9a-f]{8,}/g, 'agent-<id>')
    .replace(/[/]{2,}/g, '/');
}

/** Never print a secret. Report its shape and its ends only. */
function redactSecret(value) {
  if (value.length <= 8) return `<${value.length} chars redacted>`;
  return `${value.slice(0, 4)}...<${value.length - 8} chars redacted>...${value.slice(-4)}`;
}

/* ------------------------------------------------------------------ *
 * Scanners
 * ------------------------------------------------------------------ */

function scanIdentifiers(text, starts, relPath, sink) {
  const lowered = text.toLowerCase();
  for (const needle of DEVELOPER_IDENTIFIERS) {
    const target = needle.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(target, from);
      if (at === -1) break;
      from = at + target.length;
      const token = pathTokenAround(text, at, needle.length);
      sink({
        path: relPath,
        line: lineOf(starts, at),
        needle,
        scope: classifyPathToken(token),
        // NOT `token`: a JSON key literally named `token` holding a 24+ char
        // path made the sweep's own report trip its own generic-secret rule, 24
        // times, on the first run that scanned a committed report. Measured.
        pathToken: canonicalisePathToken(token),
      });
    }
  }
}

function scanSecrets(text, starts, relPath, sink) {
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      sink({
        path: relPath,
        line: lineOf(starts, m.index),
        rule: rule.id,
        redacted: redactSecret(m[0]),
      });
    }
  }
  GENERIC_SECRET_RE.lastIndex = 0;
  let g;
  while ((g = GENERIC_SECRET_RE.exec(text)) !== null) {
    const value = g[2];
    if (entropy(value) < GENERIC_SECRET_MIN_ENTROPY) continue;
    sink({
      path: relPath,
      line: lineOf(starts, g.index),
      rule: `generic-high-entropy:${g[1].toLowerCase()}`,
      redacted: redactSecret(value),
    });
  }
}

/** Does this captured value name the agent-deck project? */
function namesOwnProject(value) {
  return normalisePathToken(value).includes(OWN_PROJECT);
}

function scanForeign(text, starts, relPath, sink) {
  PROJECT_VALUE_RE.lastIndex = 0;
  let m;
  while ((m = PROJECT_VALUE_RE.exec(text)) !== null) {
    const [, key, value] = m;
    if (namesOwnProject(value) || isSyntheticValue(value)) continue;
    sink({
      path: relPath,
      line: lineOf(starts, m.index),
      kind: `key:${key}`,
      value: canonicalisePathToken(value),
    });
  }
  SLUG_PATH_RE.lastIndex = 0;
  let s;
  while ((s = SLUG_PATH_RE.exec(text)) !== null) {
    const slug = s[1];
    if (!SLUG_SHAPE_RE.test(slug)) continue;
    if (namesOwnProject(slug) || isSyntheticValue(slug)) continue;
    sink({
      path: relPath,
      line: lineOf(starts, s.index),
      kind: 'projects-slug',
      value: slug.toLowerCase(),
    });
  }
}

/* ------------------------------------------------------------------ *
 * Corpus enumeration
 * ------------------------------------------------------------------ */

function git(root, args, opts = {}) {
  return spawnSync('git', ['-C', root, ...args], {
    maxBuffer: 1 << 28,
    ...opts,
  });
}

function isGitRepo(root) {
  const r = git(root, ['rev-parse', '--git-dir'], { encoding: 'utf8' });
  return r.status === 0;
}

function walkDir(root) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel === '' ? root : path.join(root, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) stack.push(childRel);
      else if (ent.isFile()) out.push(childRel);
    }
  }
  return out.sort();
}

function trackedFiles(root) {
  const r = git(root, ['ls-files', '-z'], { encoding: 'buffer' });
  if (r.status !== 0) throw new Error('git ls-files failed');
  return r.stdout
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0)
    .sort();
}

/**
 * Every blob reachable from every ref, with the path(s) it was stored under.
 * `git cat-file --batch` is fed the whole object list at once and its output
 * is parsed as bytes, which keeps NUL-containing blobs intact.
 */
function historyBlobs(root) {
  const rev = git(root, ['rev-list', '--all', '--objects'], { encoding: 'utf8' });
  if (rev.status !== 0) throw new Error('git rev-list failed');
  const paths = new Map();
  const order = [];
  for (const line of rev.stdout.split('\n')) {
    if (line.length === 0) continue;
    const sp = line.indexOf(' ');
    const sha = sp === -1 ? line : line.slice(0, sp);
    const p = sp === -1 ? null : line.slice(sp + 1);
    if (!paths.has(sha)) {
      paths.set(sha, new Set());
      order.push(sha);
    }
    if (p !== null) paths.get(sha).add(p);
  }

  const batch = git(root, ['cat-file', '--batch', '--buffer'], {
    input: `${order.join('\n')}\n`,
    maxBuffer: 1 << 30,
  });
  if (batch.status !== 0) throw new Error('git cat-file --batch failed');

  const buf = batch.stdout;
  const blobs = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) break;
    const header = buf.toString('latin1', off, nl);
    const parts = header.split(' ');
    if (parts.length < 3) {
      // "<sha> missing" - nothing to read past the header.
      off = nl + 1;
      continue;
    }
    const [sha, type, sizeStr] = parts;
    const size = Number(sizeStr);
    const start = nl + 1;
    const end = start + size;
    if (type === 'blob') {
      blobs.push({ sha, paths: [...(paths.get(sha) ?? [])].sort(), body: buf.subarray(start, end) });
    }
    off = end + 1;
  }
  return blobs;
}

/* ------------------------------------------------------------------ *
 * Sweep
 * ------------------------------------------------------------------ */

function newLeg() {
  return {
    filesScanned: 0,
    bytesScanned: 0,
    nulFiles: [],
    identifier: { totalHits: 0, allowed: { totalHits: 0, byRule: [] }, unexpected: [] },
    advisories: [],
    secrets: [],
    foreign: [],
  };
}

function scanUnit(leg, relPath, body, ruleTally) {
  const text = body.toString('latin1');
  const starts = lineIndex(text);
  leg.filesScanned += 1;
  leg.bytesScanned += body.length;
  if (body.includes(0)) leg.nulFiles.push(relPath);

  if (!excludedFromIdentityScan(relPath)) {
    const rule = findAllowRule(relPath);
    scanIdentifiers(text, starts, relPath, (hit) => {
      leg.identifier.totalHits += 1;
      if (rule === null) {
        leg.identifier.unexpected.push(hit);
        return;
      }
      leg.identifier.allowed.totalHits += 1;
      let tally = ruleTally.get(rule.id);
      if (tally === undefined) {
        tally = { rule: rule.id, reason: rule.reason, hits: 0, files: new Map(), tokens: new Map() };
        ruleTally.set(rule.id, tally);
      }
      tally.hits += 1;
      tally.files.set(relPath, (tally.files.get(relPath) ?? 0) + 1);
      tally.tokens.set(hit.pathToken, (tally.tokens.get(hit.pathToken) ?? 0) + 1);
      if (hit.scope === 'other') {
        leg.advisories.push({
          path: hit.path,
          line: hit.line,
          rule: rule.id,
          pathToken: hit.pathToken,
          why: 'developer path outside the agent-deck tree, ~/.claude and ~/.vscode',
        });
      }
    });
  }

  scanSecrets(text, starts, relPath, (hit) => leg.secrets.push(hit));

  if (inCaptureCorpus(relPath)) {
    scanForeign(text, starts, relPath, (hit) => leg.foreign.push(hit));
  }
}

function finaliseLeg(leg, ruleTally) {
  leg.identifier.allowed.byRule = [...ruleTally.values()]
    .sort((a, b) => b.hits - a.hits || a.rule.localeCompare(b.rule))
    .map((t) => ({
      rule: t.rule,
      reason: t.reason,
      hits: t.hits,
      fileCount: t.files.size,
      files: [...t.files.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([p, n]) => ({ path: p, hits: n })),
      distinctPathTokens: [...t.tokens.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([pathToken, n]) => ({ pathToken, hits: n })),
    }));
  leg.nulFiles.sort();
  // One path token typically trips several identifier needles at once
  // (a home path under a cloud-sync folder trips three of the four at once), so
  // collapse an advisory to one entry per location and record the needle count.
  const advisoryByKey = new Map();
  for (const a of leg.advisories) {
    const key = `${a.path}\u0000${a.line}\u0000${a.pathToken}`;
    const seen = advisoryByKey.get(key);
    if (seen === undefined) advisoryByKey.set(key, { ...a, needleHits: 1 });
    else seen.needleHits += 1;
  }
  leg.advisories = [...advisoryByKey.values()];
  const byLoc = (a, b) => a.path.localeCompare(b.path) || a.line - b.line;
  leg.identifier.unexpected.sort(byLoc);
  leg.advisories.sort(byLoc);
  leg.secrets.sort(byLoc);
  leg.foreign.sort(byLoc);
  return leg;
}

export function sweep(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const wantHistory = options.history !== false;
  const timings = {};

  const gitRepo = isGitRepo(root);
  const files = gitRepo ? trackedFiles(root) : walkDir(root);

  let t0 = Date.now();
  const wt = newLeg();
  const wtTally = new Map();
  for (const rel of files) {
    let body;
    try {
      body = fs.readFileSync(path.join(root, rel));
    } catch {
      continue; // deleted between enumeration and read; nothing to scan.
    }
    scanUnit(wt, rel, body, wtTally);
  }
  finaliseLeg(wt, wtTally);
  timings.workingTreeMs = Date.now() - t0;

  let history = null;
  if (gitRepo && wantHistory) {
    t0 = Date.now();
    const hist = newLeg();
    const histTally = new Map();
    const blobs = historyBlobs(root);
    hist.blobsScanned = blobs.length;
    for (const blob of blobs) {
      // A blob stored at several paths is scanned once per path so the allow
      // rule is evaluated against each place it actually lived.
      const at = blob.paths.length > 0 ? blob.paths : [`<unnamed-blob>/${blob.sha}`];
      for (const rel of at) scanUnit(hist, rel, blob.body, histTally);
    }
    finaliseLeg(hist, histTally);
    history = hist;
    timings.historyMs = Date.now() - t0;
  }

  const unexpected = wt.identifier.unexpected.length + (history?.identifier.unexpected.length ?? 0);
  const secrets = wt.secrets.length + (history?.secrets.length ?? 0);
  const foreign = wt.foreign.length + (history?.foreign.length ?? 0);

  const head = gitRepo
    ? git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    : null;

  return {
    tool: 'scripts/privacy-sweep.mjs',
    reportVersion: 1,
    generatedAt: options.stamp ?? new Date().toISOString(),
    head,
    historyScope: history === null ? 'skipped' : 'all-refs',
    config: {
      identifierCount: DEVELOPER_IDENTIFIERS.length,
      ownProject: OWN_PROJECT,
      allowRules: ALLOW_RULES.map((r) => ({
        id: r.id,
        prefixes: r.prefixes,
        suffixes: r.suffixes ?? null,
        reason: r.reason,
      })),
      captureCorpora: CAPTURE_CORPORA,
      identityScanExcluded: IDENTITY_SCAN_EXCLUDE,
      secretRules: [...SECRET_RULES.map((r) => r.id), 'generic-high-entropy'],
    },
    workingTree: wt,
    history,
    verdict: {
      unexpected,
      secrets,
      foreign,
      advisories: wt.advisories.length + (history?.advisories.length ?? 0),
      pass: unexpected === 0 && secrets === 0 && foreign === 0,
    },
    timingsMs: timings,
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

// `process.stdout.write`, not `console`: the eslint flat config declares only
// `process` as a global for `.mjs`, which is the convention the other scripts
// in this directory already follow.
function say(line) {
  process.stdout.write(`${line}\n`);
}

function printLeg(name, leg) {
  if (leg === null) {
    say(`\n${name}: SKIPPED`);
    return;
  }
  const unit = name === 'history' ? `${leg.blobsScanned} blobs` : `${leg.filesScanned} files`;
  say(`\n${name}: ${unit}, ${leg.bytesScanned} bytes, ${leg.nulFiles.length} containing NUL`);
  say(
    `  ALLOWED    ${leg.identifier.allowed.totalHits} hits across ` +
      `${leg.identifier.allowed.byRule.length} rules`,
  );
  for (const r of leg.identifier.allowed.byRule) {
    say(`             ${String(r.hits).padStart(5)}  ${r.rule} (${r.fileCount} files)`);
  }
  say(`  UNEXPECTED ${leg.identifier.unexpected.length}`);
  for (const h of leg.identifier.unexpected) {
    say(`             ${h.path}:${h.line}  ${h.pathToken}`);
  }
  say(`  SECRET     ${leg.secrets.length}`);
  for (const h of leg.secrets) {
    say(`             ${h.path}:${h.line}  ${h.rule}  ${h.redacted}`);
  }
  say(`  FOREIGN    ${leg.foreign.length}`);
  for (const h of leg.foreign) {
    say(`             ${h.path}:${h.line}  ${h.kind}  ${h.value}`);
  }
  say(`  ADVISORY   ${leg.advisories.length} (non-gating)`);
  for (const h of leg.advisories) {
    say(`             ${h.path}:${h.line}  ${h.pathToken}  (${h.needleHits} needles)`);
  }
}

function parseArgs(argv) {
  const opts = { json: null, root: process.cwd(), history: true, quiet: false, stamp: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--no-history') opts.history = false;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--stamp') opts.stamp = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (process.env.AGENT_DECK_SWEEP_HISTORY === '0') opts.history = false;
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const report = sweep(opts);

  if (!opts.quiet) {
    say(`privacy sweep - root HEAD ${report.head ?? '(not a git repo)'}`);
    printLeg('working tree', report.workingTree);
    printLeg('history', report.history);
    say(
      `\nVERDICT ${report.verdict.pass ? 'PASS' : 'FAIL'}  ` +
        `unexpected=${report.verdict.unexpected} secrets=${report.verdict.secrets} ` +
        `foreign=${report.verdict.foreign} advisories=${report.verdict.advisories} (non-gating)`,
    );
    say(
      `timings working-tree=${report.timingsMs.workingTreeMs}ms ` +
        `history=${report.timingsMs.historyMs ?? 'skipped'}ms`,
    );
  }

  if (opts.json !== null) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!opts.quiet) say(`report written to ${opts.json}`);
  }

  return report.verdict.pass ? 0 : 1;
}

// Only run the CLI when this file IS the entry point. `src/release/privacy.test.ts`
// imports `sweep` directly and must not trip the process exit code.
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
