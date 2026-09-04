/**
 * G5, measured rather than read: the zero-egress audit.
 *
 * Two halves, and they answer different questions.
 *
 * (A) DEPENDENCY REVIEW — what could open a socket, statically.
 *     The VSIX ships `dist/` and nothing else (`vsce --no-dependencies`, plus
 *     `node_modules/**` in `.vscodeignore`), so the shipped runtime surface is
 *     the bundle, not the lockfile. These tests therefore enumerate the module
 *     ids the BUILT BUNDLE actually requires and gate them against an
 *     allow/deny list, rather than auditing a dependency tree that is never
 *     installed on a user's machine.
 *
 * (B) RUNTIME SOCKET CENSUS — what actually opens, dynamically.
 *     A child `node` process stages the freshly built bundle next to a stub
 *     `vscode` (module resolution is relative, so the stub is what
 *     `require('vscode')` finds), instruments every outbound-capable API in
 *     the module cache BEFORE loading the bundle, then drives the real
 *     `activate()` against the committed fixtures and counts live handles with
 *     `process._getActiveHandles()` at four points in the lifecycle.
 *
 * What this does NOT establish, said plainly:
 *
 *   - It is not a proof that no dependency contains egress code. Nobody here
 *     read chokidar's source line by line. What is shown is narrower and
 *     checkable: across a full activate/serve/deactivate cycle driven on real
 *     fixtures, zero outbound connects and zero DNS lookups were attempted,
 *     and the only TCP handle that ever existed was the loopback listener.
 *     Code that never runs in that cycle is not covered by it.
 *   - It measures the Node host. The webview is a separate artifact with its
 *     own guard (`webview/bundle.test.ts`) and its own CSP.
 *
 * Nothing in this file skips. The bundle is built on demand rather than read
 * from whatever `dist/` happens to hold — `npm run package` does NOT rebuild
 * `dist/` and there is no `vscode:prepublish`, so trusting the on-disk artifact
 * would silently measure an old one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { slugFromWorktree } from '../opencode/slug.js';

import { HOOK_LISTENER_HOST } from './listener.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CAPTURED_ROOT = fileURLToPath(
  new URL('../../fixtures/cc-2.1.234/projects', import.meta.url),
);

/**
 * Module ids that must never appear in the host bundle.
 *
 * `node:http` is absent from this list because it is the listener, and the
 * listener is the single sanctioned socket. Everything else that can reach a
 * peer is denied outright — including `node:net`, which the listener uses only
 * for a type import that erases at compile time. If a future change needs one
 * of these, that is a G5 review, and failing here is the review.
 */
const DENIED_MODULE_IDS = [
  'net',
  'tls',
  'https',
  'http2',
  'dns',
  'dns/promises',
  'dgram',
  'child_process',
  'worker_threads',
  'cluster',
  'inspector',
];

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

/**
 * Port band for the census child.
 *
 * NOT arbitrary. Windows hands out 49152-65535 for OUTBOUND ephemeral sockets,
 * including the ones this very suite opens, so a census port drawn from there
 * can be taken by a client socket in another worker between being chosen and
 * being bound. Measured: one full-suite run in fifteen failed exactly that way,
 * with the census child unable to bind 49753 and reporting no TCP handle at
 * all. The band below stops short of 49152 so the OS will never assign one of
 * these numbers to anything on its own.
 */
const CENSUS_PORT_MIN = 40000;
const CENSUS_PORT_MAX = 49150;

/**
 * A census port that was bindable a moment ago.
 *
 * Unlike the listener's own tests — which now bind port 0 on the listener
 * itself and never handle a bare port number — this one CANNOT close the
 * window. The census drives the real bundled `activate()`, which reads its port
 * from configuration and refuses port 0 on purpose (that refusal is a shipped
 * property, and a test-only escape hatch is not reachable through the vscode
 * config the child stubs). A bound handle cannot be handed to a separate
 * process portably either. So the window is made as small as it can be —
 * probe-bind, close, spawn immediately, from a band the OS never assigns —
 * and the caller retries a bounded number of times on a different port. See
 * the retry note at the spawn site.
 */
async function reserveCensusPort(): Promise<number> {
  const span = CENSUS_PORT_MAX - CENSUS_PORT_MIN;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = CENSUS_PORT_MIN + Math.floor(Math.random() * span);
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => {
        probe.close(() => resolve(true));
      });
    });
    if (free) return candidate;
  }
  throw new Error(
    `no free port in ${String(CENSUS_PORT_MIN)}..${String(CENSUS_PORT_MAX)} after 50 probes`,
  );
}

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-deck-egress-'));
  tempRoots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempRoots) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Build the host bundle and return its text.
 *
 * Built every time, never read opportunistically: `npm run package` does not
 * rebuild `dist/`, so an audit that trusted the on-disk file could pass against
 * a bundle that predates the code it claims to have measured.
 *
 * The retry is not superstition. `src/extension.test.ts` also shells out to
 * this build when `dist/` is missing, and both files can run concurrently under
 * the threads pool; esbuild writes the outfile by truncate-then-write, so a
 * reader can catch it short. The output is deterministic, so a rebuild
 * resolves it. Three attempts, then fail loudly.
 */
function buildHostBundle(): string {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    execFileSync('node', ['esbuild.config.mjs', '--host'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    // Synchronous on purpose: an `await` between the build and the read is
    // exactly the window the retry exists to close.
    last = readFileSync(join(REPO_ROOT, 'dist', 'extension.cjs'), 'utf8');
    if (last.length > 50_000 && last.includes('require("vscode")')) return last;
  }
  throw new Error(
    `host bundle did not build to a complete artifact (${String(last.length)} bytes)`,
  );
}

/** The workspace path the committed transcripts were captured in. */
async function capturedWorkspacePath(): Promise<string> {
  const slugs = (await readdir(CAPTURED_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  expect(slugs.length, 'the captured fixture root must hold a slug dir').toBeGreaterThan(0);
  const slugDir = join(CAPTURED_ROOT, slugs[0] as string);
  const files = (await readdir(slugDir)).filter((f) => f.endsWith('.jsonl'));
  for (const file of files) {
    const text = await readFile(join(slugDir, file), 'utf8');
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
    if (match?.[1] === undefined) continue;
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    if (decoded !== '') return decoded;
  }
  throw new Error('no cwd found in the captured transcripts');
}

/**
 * Every module id the bundle names, in BOTH forms it can name one.
 *
 * The second form is the whole point of this function existing. esbuild leaves
 * a dynamic `import("node:https")` in the output exactly as written — it is not
 * rewritten to `require` — so a scan that matched only `require(...)` was blind
 * to `node:net`, `node:dns` and `node:https` reached that way, while §4a of
 * `SECURITY.md` claims those modules are not REACHABLE. The claim is the
 * stronger one, so the scan is the thing that had to change.
 *
 * Both patterns are deliberately wide rather than precise: this feeds a
 * denylist, so an over-match fails loudly and an under-match fails silently.
 */
function bundleModuleIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    ids.add(m[1] as string);
  }
  for (const m of text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    ids.add(m[1] as string);
  }
  return ids;
}

/** Denied ids present in `text`, in either the bare or the `node:` spelling. */
function deniedModulesIn(text: string): string[] {
  const ids = bundleModuleIds(text);
  const found: string[] = [];
  for (const denied of DENIED_MODULE_IDS) {
    if (ids.has(denied)) found.push(denied);
    if (ids.has(`node:${denied}`)) found.push(`node:${denied}`);
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// (A) dependency review
// ---------------------------------------------------------------------------

describe('G5 dependency review: what the shipped bundle can reach', () => {
  let bundle = '';

  // 120 s for the same reason the census hook below carries one: this body is a
  // synchronous esbuild subprocess, retried up to three times, and vitest's
  // DEFAULT hookTimeout is 10 s. It fit inside the default until the suite grew
  // heavier and this file started running alongside `vsix.test.ts` (spawns
  // `vsce`) and `webview/capture.test.ts` -- then the hook timed out, the whole
  // describe reported as SIX SKIPS, and the summary line still read green
  // because a suite-level failure contributes no failed-test count. Six G5
  // zero-egress assertions ran zero times. A wall-clock-sensitive subprocess
  // under the default timeout is a test that passes or fails by CPU load, which
  // is a recorded defect class in this repo, not noise to re-run.
  beforeAll(() => {
    bundle = buildHostBundle();
  }, 120_000);

  it('the shipped artifact is the bundle, not a node_modules tree', async () => {
    // If this stops being true the review above is measuring the wrong thing:
    // an installed dependency tree would put code on the user's machine that
    // never passed through esbuild and never appears in the require census.
    const manifest = JSON.parse(
      await readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
    expect(manifest.scripts?.['package']).toContain('--no-dependencies');
    expect(await readFile(join(REPO_ROOT, '.vscodeignore'), 'utf8')).toContain(
      'node_modules/**',
    );
    // Recorded, not asserted as a fixed list: the gate is the require census
    // below, which is about what actually ships.
    expect(Object.keys(manifest.dependencies ?? {}).length).toBeGreaterThanOrEqual(0);
  });

  it('names only node builtins and vscode — no third-party module survives bundling', () => {
    const ids = bundleModuleIds(bundle);
    expect(ids.size, 'a bundle that names no module has not been built').toBeGreaterThan(0);
    for (const id of ids) {
      if (id === 'vscode') continue;
      expect(id, `${id} is neither a node: builtin nor vscode`).toMatch(/^node:/);
    }
  });

  it('reaches no network-capable module other than the listener', () => {
    const found = deniedModulesIn(bundle);
    expect(
      found,
      `network-capable module(s) reachable from the host bundle: ${found.join(', ')}`,
    ).toStrictEqual([]);
    // The one sanctioned socket module is present, so this is not vacuous.
    expect(bundleModuleIds(bundle)).toContain('node:http');
  });

  it('the scan sees a dynamic import(), proven by injecting one', () => {
    // Not asserted, INJECTED. esbuild emits `import("node:https")` verbatim, so
    // a require-only scan reported a clean bundle while `node:https`,
    // `node:net` and `node:dns` sat one dynamic import away. The runtime census
    // in part (B) did catch that injection — layered checks are why — but §4a
    // of SECURITY.md makes a static reachability claim, and this is what backs
    // it. Each denied id is injected in the exact form esbuild would leave.
    for (const denied of DENIED_MODULE_IDS) {
      const injected = `${bundle}\nglobalThis.__leak = () => import("node:${denied}");\n`;
      expect(
        deniedModulesIn(injected),
        `a dynamic import of node:${denied} slipped past the scan`,
      ).toContain(`node:${denied}`);
    }
    // The bare spelling too, and the require form, so neither half rotted.
    expect(deniedModulesIn(`${bundle}\nconst s = import('net');\n`)).toContain(
      'net',
    );
    expect(
      deniedModulesIn(`${bundle}\nconst t = require("node:tls");\n`),
    ).toContain('node:tls');
  });

  it('contains a server and no client: no outbound request API is compiled in', () => {
    expect(bundle).toContain('createServer');
    // `http.request` / `http.get` are how a Node process talks OUT. Matched on
    // the destructured and member forms esbuild can emit.
    expect(bundle).not.toMatch(/\bhttps?\.request\s*\(/);
    expect(bundle).not.toMatch(/\bimport_node_http\d*\.request\s*\(/);
    expect(bundle).not.toMatch(/\bfetch\s*\(/);
    expect(bundle).not.toContain('XMLHttpRequest');
    expect(bundle).not.toContain('new WebSocket(');
    expect(bundle).not.toContain('navigator.sendBeacon');
  });

  it('binds the loopback literal and never a wildcard, in the built artifact', () => {
    // Asserted against the BUNDLE, not the source: the source guard in
    // listener.test.ts cannot see a build step rewriting a constant.
    expect(bundle).toContain(`"${HOOK_LISTENER_HOST}"`);
    expect(bundle).not.toContain('0.0.0.0');
    expect(bundle).not.toMatch(/listen\(\s*0\s*[,)]/);
  });
});

// ---------------------------------------------------------------------------
// (B) runtime socket census
// ---------------------------------------------------------------------------

interface HandleRecord {
  ctor: string;
  handle: string;
  address?: string;
  port?: number;
  remote?: string;
  listening?: boolean;
  /**
   * This handle is the HARNESS's own POST client, not the extension's.
   *
   * Tagged on the socket object in the child before it connects, so the census
   * can name it rather than quietly filter it. It is needed because the
   * client survives in `process._getActiveHandles()` after the response
   * completes — with `_handle` already released, so it reports as
   * `Socket/none` — and the phases it survives into vary run to run. The
   * previous census filtered on `handle === 'TCP'` and therefore never saw it
   * at all, which is why the question never came up.
   */
  harness?: boolean;
}

interface OutboundRecord {
  api: string;
  target: string;
  stack?: string;
}

interface CensusReport {
  ok: boolean;
  error?: string;
  nodeVersion: string;
  port: number;
  activated: boolean;
  postStatus: number | null;
  requiredIds: string[];
  outboundAtLoad: OutboundRecord[];
  outboundAtActivate: OutboundRecord[];
  outboundFinal: OutboundRecord[];
  dnsFinal: OutboundRecord[];
  phases: Record<string, HandleRecord[]>;
  /**
   * Every line the diagnostics channel wrote, in order.
   *
   * The per-engine evidence, and the reason the `vscode` stub grew a
   * `createOutputChannel`. `DiagnosticsChannel` creates its sink lazily inside
   * a `try` that swallows a throwing factory (G2), so the stub's previous
   * SILENCE was indistinguishable from a host with nothing to say: a census
   * child whose OpenCode and Codex engines never mounted at all produced
   * exactly the same evidence as one where all three ran.
   */
  diagnosticsLines: string[];
  /**
   * The port of the DECOY listener, when the harness asked the child to open a
   * second socket. `null` on every scenario that did not. See the vacuity
   * control at the end of part (B).
   */
  decoyPort: number | null;
}

/**
 * The census program, run in a bare `node` child.
 *
 * Written out as a file rather than `node -e` so that a failure has a real
 * stack with line numbers. It instruments the module cache BEFORE the bundle is
 * loaded: wrapping `net.Socket.prototype.connect`, `dns.lookup`, `tls.connect`
 * and friends means any code path that tries to reach a peer is recorded even
 * if it never gets as far as a live handle.
 */
const CENSUS_PROGRAM = String.raw`
'use strict';
const path = require('node:path');

// ---- instrumentation, installed before the bundle is loaded ----------------
const outbound = [];
const dnsCalls = [];
const requiredIds = [];

function target(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    return JSON.stringify({ host: first.host, hostname: first.hostname, port: first.port, path: first.path });
  }
  return JSON.stringify(args.filter((a) => typeof a !== 'function'));
}

const net = require('node:net');
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  outbound.push({ api: 'net.Socket.connect', target: target(args) });
  return origConnect.apply(this, args);
};
const origNetConnect = net.connect;
net.connect = function (...args) {
  outbound.push({ api: 'net.connect', target: target(args) });
  return origNetConnect.apply(this, args);
};
net.createConnection = net.connect;

const http = require('node:http');
for (const name of ['request', 'get']) {
  const orig = http[name];
  http[name] = function (...args) {
    outbound.push({ api: 'http.' + name, target: target(args) });
    return orig.apply(this, args);
  };
}
const https = require('node:https');
for (const name of ['request', 'get']) {
  const orig = https[name];
  https[name] = function (...args) {
    outbound.push({ api: 'https.' + name, target: target(args) });
    return orig.apply(this, args);
  };
}
const tls = require('node:tls');
const origTlsConnect = tls.connect;
tls.connect = function (...args) {
  outbound.push({ api: 'tls.connect', target: target(args) });
  return origTlsConnect.apply(this, args);
};
const dgram = require('node:dgram');
const origDgram = dgram.createSocket;
dgram.createSocket = function (...args) {
  outbound.push({ api: 'dgram.createSocket', target: target(args) });
  return origDgram.apply(this, args);
};
const dns = require('node:dns');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const orig = dns[name];
  if (typeof orig !== 'function') continue;
  dns[name] = function (...args) {
    dnsCalls.push({
      api: 'dns.' + name,
      target: target(args),
      stack: String(new Error('dns').stack).split('\n').slice(1, 5).join(' | '),
    });
    return orig.apply(this, args);
  };
}

const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  requiredIds.push(request);
  return origLoad.call(this, request, parent, isMain);
};

// ---- handle census ---------------------------------------------------------
function describeHandle(h) {
  const rec = { ctor: 'unknown', handle: 'none' };
  try { rec.ctor = h && h.constructor ? h.constructor.name : typeof h; } catch (_) {}
  try {
    const inner = h && h._handle;
    rec.handle = inner && inner.constructor ? inner.constructor.name : 'none';
  } catch (_) {}
  try {
    if (h && typeof h.address === 'function') {
      const a = h.address();
      if (a && typeof a === 'object') { rec.address = a.address; rec.port = a.port; }
    }
  } catch (_) {}
  try { if (h && typeof h.remoteAddress === 'string') rec.remote = h.remoteAddress; } catch (_) {}
  try { if (h && typeof h.listening === 'boolean') rec.listening = h.listening; } catch (_) {}
  // The harness's own client, tagged on the object itself before it connects.
  // Reported, never omitted: a handle this program dropped from its own
  // census would be a skip nobody could see, and the census would then be
  // asserting over a list it had edited.
  try { if (h && h.__censusHarness === true) rec.harness = true; } catch (_) {}
  return rec;
}

function census() {
  const get = process._getActiveHandles;
  if (typeof get !== 'function') {
    throw new Error('process._getActiveHandles is unavailable on ' + process.version);
  }
  return get.call(process).map(describeHandle);
}

const report = {
  ok: false,
  nodeVersion: process.version,
  port: Number(process.env.CENSUS_PORT),
  activated: false,
  postStatus: null,
  requiredIds: [],
  outboundAtLoad: [],
  outboundAtActivate: [],
  outboundFinal: [],
  dnsFinal: [],
  phases: {},
  diagnosticsLines: [],
  decoyPort: null,
};

// The engines that have announced a session on the diagnostics channel.
//
// One line per session the DECK ACTUALLY SHOWS - the host writes it from the
// emission rather than from any engine's internals - so an engine appearing
// here read a real corpus, matched a real workspace folder and reached the
// renderer's input. That is what makes "three engines" a measurement instead
// of three environment variables.
function enginesAnnounced(lines) {
  const seen = new Set();
  for (const line of lines) {
    const m = / session discovered (\S+) /.exec(line);
    if (m) seen.add(m[1]);
  }
  return seen;
}

function emit() {
  report.requiredIds = requiredIds;
  report.outboundFinal = outbound;
  report.dnsFinal = dnsCalls;
  process.stdout.write('__CENSUS__' + JSON.stringify(report) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The harness must not appear in its own census.
//
// http.request is out: it calls net.connect internally and both are
// instrumented, so posting through it would attribute the harness's own
// connect to the extension. Measured: it also drives dns.lookup, which node
// calls even for a literal address. This speaks raw HTTP over a socket
// connected with origConnect - the function captured BEFORE the prototype was
// wrapped - so not one instrumented API is touched and the outbound/dnsCalls
// lists stay exactly what the extension itself did. postStatus proves the
// socket really connected and the listener really answered.
function postEvent(port) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ session_id: 'census', hook_event_name: 'Stop' });
    const sock = new net.Socket();
    // See HandleRecord.harness: this socket outlives the response inside
    // process._getActiveHandles(), so it is labelled at the source rather
    // than guessed at from the far side. (No backtick in this comment on
    // purpose - the whole program is a String.raw template, and a backtick
    // here ends it mid-file with a diagnostic that points nowhere near.)
    sock.__censusHarness = true;
    let text = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => { text += c; });
    sock.on('error', () => resolve(null));
    sock.on('close', () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
      resolve(m ? Number(m[1]) : null);
    });
    origConnect.call(sock, port, '127.0.0.1', () => {
      sock.write(
        'POST /event HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
        'Content-Type: application/json\r\nConnection: close\r\n' +
        'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body,
      );
    });
  });
}

async function main() {
  const bundle = path.join(__dirname, 'dist', 'extension.cjs');
  const mod = require(bundle);
  report.phases.loaded = census();
  report.outboundAtLoad = outbound.slice();

  const vscode = require('vscode');
  vscode.__setWorkspace(JSON.parse(process.env.CENSUS_WORKSPACES));
  vscode.__setConfig({ port: Number(process.env.CENSUS_PORT) });

  await mod.activate(vscode.__context());
  report.activated = true;

  // THE DECOY, and it is the harness deliberately breaking its own rule.
  //
  // Everywhere else this program is careful not to appear in its own census.
  // Here it opens a SECOND loopback listener on purpose, so that one scenario
  // can prove the census reports two sockets when two sockets exist. Without
  // it, "exactly one listener" rests on the assumption that the enumeration
  // would have shown a second one - which is the assumption, not the evidence.
  // Opened AFTER activation and BEFORE the activated census, because that is
  // the phase the exact-set assertion is made against.
  let decoy = null;
  if (process.env.CENSUS_DECOY === '1') {
    decoy = net.createServer();
    await new Promise((resolve, reject) => {
      decoy.once('error', reject);
      decoy.listen(0, '127.0.0.1', resolve);
    });
    report.decoyPort = decoy.address().port;
  }

  report.phases.activated = census();
  // The load-bearing number: from require through activation, on real
  // fixtures, the extension attempted zero outbound connections.
  report.outboundAtActivate = outbound.slice();

  // Emissions are COALESCED on a timer, so the engines have not necessarily
  // announced anything by the time activation resolves. Wait for the named
  // ones - bounded, and a timeout is NOT an error here: the wait falls
  // through, the lines are reported as they stand, and the assertion that
  // wanted them fails with the real list rather than with a timeout.
  const wanted = String(process.env.CENSUS_WAIT_ENGINES || '')
    .split(',')
    .filter((name) => name !== '');
  if (wanted.length > 0) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const seen = enginesAnnounced(vscode.__lines);
      if (wanted.every((name) => seen.has(name))) break;
      if (Date.now() > deadline) break;
      await sleep(25);
    }
  }
  // THE PHASE THE DoD IS ABOUT, and it is taken BEFORE the POST on purpose:
  // every engine has now read its corpus and put its sessions on the deck,
  // and nothing has yet connected to the listener, so whatever is open here
  // is what three live engines cost. Serving is measured separately below,
  // because an accepted connection is a socket the extension is supposed to
  // have and folding it into this phase would blur the two claims.
  report.phases.engines = census();
  report.diagnosticsLines = vscode.__lines.slice();

  report.postStatus = await postEvent(Number(process.env.CENSUS_PORT));
  report.phases.serving = census();

  if (decoy !== null) {
    await new Promise((resolve) => decoy.close(resolve));
  }

  await mod.deactivate();
  await sleep(150);
  report.phases.disposed = census();

  report.ok = true;
}

main().then(
  () => { emit(); process.exit(0); },
  (err) => { report.error = String(err && err.stack ? err.stack : err); emit(); process.exit(0); },
);
`;

/** A `vscode` stub good enough for `activate()` and nothing more. */
const VSCODE_STUB = String.raw`
'use strict';
let workspaceList = [];
let config = {};
const lines = [];
const noop = { dispose() {} };
const api = {
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', path: p }),
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/'), scheme: 'file' }),
  },
  ViewColumn: { Beside: 2, One: 1 },
  commands: { registerCommand: () => noop },
  window: {
    createWebviewPanel: () => { throw new Error('the census never opens a panel'); },
    // A LINE COLLECTOR, and not decoration. DiagnosticsChannel creates its
    // sink lazily inside a try/catch (G2: a channel that cannot be created
    // must not take the data path down), so a stub without this method makes
    // every diagnostic vanish silently - and a census whose OpenCode and Codex
    // engines never mounted would look exactly like one where all three ran.
    // The channel is never revealed, so nothing here calls show() for real.
    createOutputChannel: () => ({
      appendLine: (line) => { lines.push(String(line)); },
      show() {},
      dispose() {},
    }),
    showInformationMessage: () => undefined,
    showErrorMessage: (m) => { api.__errors.push(String(m)); },
  },
  workspace: {
    // MULTI-ROOT, because the three engines answer to different folders: the
    // Claude Code half reads the FIRST folder only (firstWorkspacePath) while
    // the OpenCode and Codex halves are handed every folder
    // (workspacePaths()). A single-folder stub could therefore mount at most
    // two of the three engines, whatever the environment said.
    get workspaceFolders() {
      return workspaceList.length === 0
        ? undefined
        : workspaceList.map((p, index) => ({ uri: api.Uri.file(p), name: 'w' + index, index }));
    },
    getConfiguration: () => ({ get: (key) => config[key] }),
    onDidChangeConfiguration: () => noop,
  },
  __errors: [],
  __lines: lines,
  __setWorkspace: (paths) => { workspaceList = paths; },
  __setConfig: (c) => { config = c; },
  __context: () => ({ subscriptions: [], extensionUri: api.Uri.file('/census/ext') }),
};
module.exports = api;
`;

// ---------------------------------------------------------------------------
// (B.1) the census harness: staged once, spawned per scenario
// ---------------------------------------------------------------------------

/**
 * One census run's environment.
 *
 * A record rather than four positional arguments because DoD 4.3 needs the
 * census run in several ENVIRONMENTS, not just once: three engines live, Codex
 * alone, nothing observable at all, and one deliberately-broken run that opens
 * a second socket. Each of those is a different answer to "should anything be
 * listening", and a census that could only be run one way could not tell the
 * difference between "no extra socket opened" and "nothing opened at all".
 */
interface CensusScenario {
  /** Every folder the `vscode` stub reports. The FIRST is the Claude Code one. */
  readonly workspaces: readonly string[];
  /** `CLAUDE_PROJECTS_ROOT`. An empty directory means no CC project correlates. */
  readonly claudeProjectsRoot: string;
  /** `AGENT_DECK_OPENCODE_ROOT`. A directory with no `opencode.db` means off. */
  readonly opencodeRoot: string;
  /** `CODEX_HOME`. A path that does not exist means the Codex engine is off. */
  readonly codexHome: string;
  /** Engine tags to wait for on the diagnostics channel before the last census. */
  readonly waitForEngines?: readonly string[];
  /** Open a SECOND loopback listener in the child. The vacuity control only. */
  readonly decoy?: boolean;
  /**
   * Whether a listening socket is the expected outcome.
   *
   * Drives the bind RETRY and nothing else: a scenario that expects no bind
   * must not retry, or a correct "nothing is listening" would be re-rolled
   * five times and then asserted anyway.
   */
  readonly expectBind: boolean;
}

interface CensusRun {
  readonly report: CensusReport;
  /** The port the child was configured with. */
  readonly port: number;
  readonly stderr: string;
  readonly attempts: number;
}

/**
 * The staged census directory: the freshly built bundle, the `vscode` stub and
 * the census program, memoised for the whole file.
 *
 * Memoised because it is the expensive half (an esbuild subprocess) and it is
 * identical for every scenario — what differs between runs is the ENVIRONMENT,
 * which is passed at spawn time. Re-staging per scenario would quadruple the
 * build cost to produce four byte-identical directories.
 */
let stagePromise: Promise<string> | null = null;

async function stagedCensusDir(): Promise<string> {
  stagePromise ??= (async (): Promise<string> => {
    const bundleText = buildHostBundle();
    const stage = await makeTempDir();
    const staged = join(stage, 'dist', 'extension.cjs');
    await mkdir(dirname(staged), { recursive: true });
    await copyFile(join(REPO_ROOT, 'dist', 'extension.cjs'), staged);
    // The staged copy must be the artifact just built, byte for byte.
    expect((await readFile(staged, 'utf8')).length).toBe(bundleText.length);

    const stub = join(stage, 'node_modules', 'vscode');
    await mkdir(stub, { recursive: true });
    await writeFile(join(stub, 'package.json'), '{"name":"vscode","main":"index.js"}\n');
    await writeFile(join(stub, 'index.js'), VSCODE_STUB);
    await writeFile(join(stage, 'census.cjs'), CENSUS_PROGRAM);
    return stage;
  })();
  return stagePromise;
}

/** An empty directory inside the stage. The shape of "this engine has nothing". */
async function stagedEmptyDir(name: string): Promise<string> {
  const dir = join(await stagedCensusDir(), name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A path inside the stage that is deliberately never created. */
async function stagedAbsentPath(name: string): Promise<string> {
  const path = join(await stagedCensusDir(), name);
  expect(existsSync(path), `${path} must not exist`).toBe(false);
  return path;
}

/**
 * Spawn one census child and return its report.
 *
 * The retry, argued rather than assumed. Everywhere else in this package a
 * port race was CLOSED, not narrowed — the listener binds port 0 itself and no
 * bare number is ever handed around. That is unavailable here: the child runs
 * the shipped `activate()`, which takes its port from configuration and
 * refuses 0, and a bound socket cannot be handed to another process portably
 * on Windows. What is left is to shrink the window (a band the OS never
 * assigns, probed free microseconds earlier) and to retry on a DIFFERENT port
 * when the child reports no listening socket. The retry is bounded and it
 * cannot hide a product defect: a bind that fails on five separately-probed
 * ports is not a race, and the assertions then run against the last report and
 * fail with it.
 *
 * `expectBind: false` scenarios never retry — see {@link CensusScenario}.
 */
async function runCensus(scenario: CensusScenario): Promise<CensusRun> {
  const stage = await stagedCensusDir();
  const MAX_BIND_ATTEMPTS = 5;
  let attempts = 0;
  let parsed: CensusReport | undefined;
  let lastStdout = '';
  let stderr = '';
  let port = 0;
  for (;;) {
    attempts += 1;
    port = await reserveCensusPort();

    const run = spawnSync(process.execPath, [join(stage, 'census.cjs')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        // G6, three times over: the census spawns the REAL bundled
        // `activate()` and inherits `process.env`, so every engine's root is
        // pinned at a committed fixture or at a directory this file made.
        // An unpinned run reads the developer's own `~/.claude`,
        // `%USERPROFILE%/.local/share/opencode` (~24 MB, WAL mode, so a
        // read-only open touches its `-shm` sidecar) and `~/.codex`.
        CLAUDE_PROJECTS_ROOT: scenario.claudeProjectsRoot,
        AGENT_DECK_OPENCODE_ROOT: scenario.opencodeRoot,
        CODEX_HOME: scenario.codexHome,
        CENSUS_WORKSPACES: JSON.stringify(scenario.workspaces),
        CENSUS_PORT: String(port),
        CENSUS_WAIT_ENGINES: (scenario.waitForEngines ?? []).join(','),
        CENSUS_DECOY: scenario.decoy === true ? '1' : '0',
      },
    });
    stderr = run.stderr ?? '';
    lastStdout = run.stdout ?? '';
    const line = lastStdout.split(/\r?\n/).find((l) => l.startsWith('__CENSUS__'));
    if (line !== undefined) {
      parsed = JSON.parse(line.slice('__CENSUS__'.length)) as CensusReport;
      if (!scenario.expectBind) break;
      const bound = (parsed.phases['activated'] ?? []).some((h) => h.handle === 'TCP');
      if (bound) break;
    }
    if (attempts >= MAX_BIND_ATTEMPTS) break;
  }
  if (attempts > 1) {
    // Never silent: a retried census is a fact a reviewer should see even on a
    // green run, because a rising count means the band is getting crowded.
    process.stderr.write(`[census] the child needed ${String(attempts)} bind attempt(s)\n`);
  }
  expect(
    parsed,
    `census child produced no report after ${String(attempts)} attempt(s).\nstdout:\n${lastStdout}\nstderr:\n${stderr}`,
  ).toBeDefined();
  const report = parsed as CensusReport;

  // The census is evidence, and evidence nobody can print is hard to audit.
  // `AGENT_DECK_CENSUS_DEBUG=1 npx vitest run src/hooks/egress.test.ts` dumps
  // every raw report so a reviewer can read the handle lists themselves
  // instead of taking these assertions' word for it.
  if (process.env['AGENT_DECK_CENSUS_DEBUG'] !== undefined) {
    process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
  }
  return { report, port, stderr, attempts };
}

// ---------------------------------------------------------------------------
// (B.2) reading a report: ONE set of predicates, shared by every scenario
// ---------------------------------------------------------------------------

/** Every handle at a phase. An unknown phase is an empty list, never a throw. */
function handlesAt(report: CensusReport, phase: string): HandleRecord[] {
  return report.phases[phase] ?? [];
}

/**
 * Is this handle the child's own stdio?
 *
 * A libuv `Pipe` under a `Socket` is this process talking to `spawnSync`
 * through stdout or stderr. It cannot reach a peer and it cannot become a
 * socket that can. Whether it is PRESENT is not deterministic — the handle
 * materialises when the stream is first written, so the same phase carries one
 * on a run that logged and none on a run that did not — which is why it is
 * classified rather than counted.
 */
function isStdio(handle: HandleRecord): boolean {
  return handle.ctor === 'Socket' && handle.handle === 'Pipe';
}

/** The harness's own POST client. See {@link HandleRecord.harness}. */
function isHarness(handle: HandleRecord): boolean {
  return handle.harness === true;
}

/**
 * Everything at a phase that is neither this child's stdio nor the harness's
 * own client: the handles the EXTENSION is responsible for.
 */
function extensionHandles(report: CensusReport, phase: string): HandleRecord[] {
  return handlesAt(report, phase).filter((h) => !isStdio(h) && !isHarness(h));
}

/**
 * The `ctor/handle` kinds the extension holds at a phase, deduplicated and
 * sorted.
 *
 * Pinned as an EXACT SET by every scenario below, and that is what makes the
 * narrower socket assertions honest rather than selective: `networkHandles`
 * keeps only `Server`/`Socket`, so if a handle ever showed up wearing a kind
 * this list does not name — a `UDP`, a `ChildProcess`, an `Agent` — the kind
 * set goes red before anything gets filtered out.
 *
 * Two classes are excluded, both by an explicit predicate, and both pinned by
 * their own assertions rather than trusted: stdio ({@link isStdio}) and the
 * harness's client ({@link isHarness}). Rule 18 — a check that skips an input
 * says so — so `stdioAndHarness` below is asserted to contain nothing else.
 *
 * COUNTS are deliberately not pinned here: the `FSWatcher/FSEvent` count is
 * the number of directories the Claude Code watcher opened on the committed
 * corpus, and a fixture-set size hard-coded into a test breaks on the next
 * harvest and reads as a regression. The counts that DO matter — the sockets —
 * are pinned exactly, beside their set, by {@link networkDescriptors}.
 */
function handleKinds(report: CensusReport, phase: string): string[] {
  return [...new Set(extensionHandles(report, phase).map((h) => `${h.ctor}/${h.handle}`))].sort();
}

/**
 * The extension's handles that could carry a byte to a peer.
 *
 * `Server` and `Socket`, after stdio and the harness's client are taken out.
 * Everything else that survives is reported, INCLUDING a socket whose
 * `_handle` has already been released (`handle: 'none'`) — the previous
 * version of this census filtered on `handle === 'TCP'` and therefore could
 * not see a released one at all, while the test that did the filtering was
 * named "including the served connection".
 */
function networkHandles(report: CensusReport, phase: string): HandleRecord[] {
  return extensionHandles(report, phase).filter(
    (h) => h.ctor === 'Server' || h.ctor === 'Socket',
  );
}

/** Every handle, at every phase, that the two exclusions above removed. */
function stdioAndHarness(report: CensusReport): HandleRecord[] {
  return Object.keys(report.phases).flatMap((phase) =>
    handlesAt(report, phase).filter((h) => isStdio(h) || isHarness(h)),
  );
}

/**
 * One line per network handle, sorted — the form the exact-set assertions use.
 *
 * A listening server is named by the address and port it is BOUND to; a
 * connection is named by its peer. Sorted rather than left in
 * `_getActiveHandles` order, because that order is libuv's business and an
 * assertion that depended on it would be pinning the wrong thing.
 */
function networkDescriptors(report: CensusReport, phase: string): string[] {
  return networkHandles(report, phase)
    .map((h) => {
      if (h.listening === true) {
        return `listener ${h.address ?? '?'}:${String(h.port ?? 0)}`;
      }
      return `connection remote=${h.remote ?? h.address ?? '?'}`;
    })
    .sort();
}

/** The engine tags that announced a session on the diagnostics channel. */
function enginesAnnouncedIn(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    const match = / session discovered (\S+) /.exec(line);
    if (match?.[1] !== undefined) seen.add(match[1]);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// (B.3) fixture derivations — every root and every workspace read off disk
// ---------------------------------------------------------------------------

/**
 * The workspace a committed Codex run was recorded in (`session_meta.cwd`).
 *
 * Read from the transcript, never written down: it is what
 * `codexWorkspaceMatcher` compares an open folder against, so a hard-coded
 * copy here would be a second opinion about the same fact, and this file
 * already records what two agreeing literals cost.
 */
async function codexWorkspacePath(root: string): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  await walk(join(root, 'sessions'));
  files.sort();
  for (const file of files) {
    const first = (await readFile(file, 'utf8')).split('\n')[0] ?? '';
    const record = JSON.parse(first) as { payload?: { cwd?: unknown } };
    const cwd = record.payload?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  }
  throw new Error(`no session_meta cwd under ${root}`);
}

/**
 * The smallest committed OpenCode corpus holding a session for `workspacePath`.
 *
 * The predicate is PRODUCTION'S: `src/opencode/index.ts` matches a project by
 * `slugFromWorktree(folder).toLowerCase()`, and this uses the same function
 * rather than a lookalike, so a corpus selected here is a corpus the engine
 * will really match. Smallest first because the census child reads it for
 * real and this is the only place in the file that pays for its size.
 */
function opencodeCorpusDir(workspacePath: string): string {
  const wanted = slugFromWorktree(workspacePath).toLowerCase();
  const fixtures = join(REPO_ROOT, 'fixtures');
  const candidates = readdirSync(fixtures, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('opencode-'))
    .map((e) => join(fixtures, e.name))
    .filter((dir) => existsSync(join(dir, 'opencode.db')) && existsSync(join(dir, 'golden.json')))
    .filter((dir) => {
      const golden = JSON.parse(readFileSync(join(dir, 'golden.json'), 'utf8')) as {
        sessions?: { projectSlug?: string }[];
      };
      return (golden.sessions ?? []).some(
        (s) => (s.projectSlug ?? '').toLowerCase() === wanted,
      );
    })
    .sort((a, b) => statSync(join(a, 'opencode.db')).size - statSync(join(b, 'opencode.db')).size);
  const [smallest] = candidates;
  if (smallest === undefined) {
    throw new Error(`no fixtures/opencode-* corpus holds a session for ${wanted}`);
  }
  return smallest;
}

// ---------------------------------------------------------------------------
// (B.4) DoD 4.3 — the census with THREE engines live
// ---------------------------------------------------------------------------

/**
 * v0.6.0 DoD 4.3: "Runtime socket census re-run with three engines: one
 * listener, zero others."
 *
 * The census this describe drives is the same one Phase 5 wrote, pointed at
 * three live engines instead of one: Claude Code on the committed transcripts,
 * OpenCode on a committed SQLite corpus, and Codex on a committed rollout
 * root. All three announce sessions on the diagnostics channel before the last
 * census is taken, so "one listener, zero others" is a statement about a host
 * with three engines RUNNING rather than about three environment variables.
 *
 * WHY THE ENGINE EVIDENCE IS PART OF THE SOCKET CLAIM. Since 2026-09-04 the
 * hook socket binds when a Claude Code project correlates OR a Codex data root
 * exists, and not otherwise. A census child with neither would therefore find
 * ZERO listeners — correct behaviour, and indistinguishable from a passing
 * "no unexpected socket" test. So this describe pins the listener's presence
 * as an exact set, not merely the absence of extras, and the scenario below it
 * pins the same socket appearing for Codex ALONE.
 */
describe('G5 runtime socket census: three engines, one loopback listener (DoD 4.3)', () => {
  let report: CensusReport;
  let port = 0;
  let stderr = '';
  let ccWorkspace = '';
  let codexWorkspace = '';
  let opencodeRoot = '';
  let codexRoot = '';

  // 120 s for the reason every hook in this file carries one: the body builds
  // the bundle in an esbuild subprocess and then spawns a child that reads
  // three real corpora, and vitest's DEFAULT hookTimeout is 10 s. A hook that
  // loses that race reports the whole describe as SKIPS with a clean-looking
  // tests line and no failed count — which is how six G5 assertions ran zero
  // times in Phase 3.
  beforeAll(async () => {
    ccWorkspace = await capturedWorkspacePath();
    codexRoot = codexRunRoot();
    codexWorkspace = await codexWorkspacePath(codexRoot);
    opencodeRoot = opencodeCorpusDir(ccWorkspace);

    const run = await runCensus({
      // Two folders, deliberately: the Claude Code half reads the FIRST one
      // and the OpenCode and Codex halves read every one, so a single-folder
      // workspace can mount at most two of the three engines. The OpenCode
      // corpus was captured in the same project as the Claude Code corpus, so
      // one folder serves both.
      workspaces: [ccWorkspace, codexWorkspace],
      claudeProjectsRoot: CAPTURED_ROOT,
      opencodeRoot,
      codexHome: codexRoot,
      waitForEngines: ['cc', 'opencode', 'codex'],
      expectBind: true,
    });
    report = run.report;
    port = run.port;
    stderr = run.stderr;
  }, 120_000);

  it('the census child ran the real bundle to completion', () => {
    expect(report.error ?? '', stderr).toBe('');
    expect(report.ok).toBe(true);
    expect(report.activated).toBe(true);
    // Not vacuous: it really loaded the bundle, which really required vscode.
    expect(report.requiredIds).toContain('vscode');
  });

  it('all THREE engines mounted and put sessions on the deck', () => {
    /*
     * THE VACUITY CONTROL FOR THE WHOLE DESCRIBE, and the reason it is a test
     * rather than a comment. Every socket assertion below is a claim about a
     * host running three engines; an engine that silently failed to mount
     * opens no socket either, and would make every one of them pass for the
     * wrong reason.
     *
     * `session discovered <engine> <id>` is written from the EMISSION — the
     * sessions the renderer is being handed — so an engine named here read its
     * corpus, matched a workspace folder and reached the deck. Exact set, and
     * the count beside it, because "the lines include cc" is satisfied by a
     * run where the other two never started.
     */
    const engines = enginesAnnouncedIn(report.diagnosticsLines);
    expect(engines, report.diagnosticsLines.join('\n')).toStrictEqual([
      'cc',
      'codex',
      'opencode',
    ]);
    expect(engines.length).toBe(3);
  });

  it('opens exactly one socket with three engines live: the loopback listener', () => {
    // THE DoD ITEM. An exact set and its count, at the phase where all three
    // engines have read their corpora and announced and nothing has yet
    // connected — never a containment, which would pass with three other
    // sockets open beside it.
    const expected = [`listener ${HOOK_LISTENER_HOST}:${String(port)}`];
    expect(networkDescriptors(report, 'engines')).toStrictEqual(expected);
    expect(networkHandles(report, 'engines').length).toBe(1);
    expect(networkHandles(report, 'engines')[0]?.listening).toBe(true);
    // ...and the same at activation, before the engines had finished reading.
    expect(networkDescriptors(report, 'activated')).toStrictEqual(expected);
    expect(networkHandles(report, 'activated').length).toBe(1);
  });

  it('the whole handle enumeration is accounted for at every phase', () => {
    /*
     * The exact set of handle KINDS, phase by phase — the assertion that keeps
     * `networkHandles`'s exclusion of libuv `Pipe` honest. A new kind of
     * handle appearing anywhere in the lifecycle fails here first, before the
     * socket predicate gets a chance to filter it out.
     *
     * Kinds, not counts: the `FSWatcher/FSEvent` count is the number of
     * directories the Claude Code watcher opened on the committed corpus, and
     * pinning a fixture-set size breaks on the next harvest. The counts that
     * carry the G5 claim are the socket ones, pinned exactly above.
     */
    expect(handleKinds(report, 'loaded')).toStrictEqual([]);
    expect(handleKinds(report, 'activated')).toStrictEqual([
      'FSWatcher/FSEvent',
      'Server/TCP',
    ]);
    expect(handleKinds(report, 'engines')).toStrictEqual([
      'FSWatcher/FSEvent',
      'Server/TCP',
    ]);
    // One kind more while serving, and it is the accepted connection: a
    // `Socket` whose libuv handle has already been released.
    expect(handleKinds(report, 'serving')).toStrictEqual([
      'FSWatcher/FSEvent',
      'Server/TCP',
      'Socket/none',
    ]);
    expect(handleKinds(report, 'disposed')).toStrictEqual([]);
    // The FS watchers are the Claude Code engine's, and there is at least one:
    // an empty enumeration would satisfy every "no extra socket" claim above.
    expect(
      handlesAt(report, 'engines').filter((h) => h.handle === 'FSEvent').length,
    ).toBeGreaterThan(0);
  });

  it('everything the socket predicate excluded is stdio or the harness itself', () => {
    /*
     * RULE 18, applied to a filter. `handleKinds` and `networkHandles` skip
     * two classes of handle, and a skip nobody states is the fail-open shape
     * this repository has been bitten by three times. So the excluded set is
     * enumerated and characterised here: every member is either this child's
     * own stdout/stderr, or the socket the harness itself opened to POST a
     * hook event — which the census tags at the source rather than inferring.
     *
     * Non-vacuous in both directions: the harness socket must actually have
     * been seen (an exclusion that never matches anything is an exclusion
     * hiding nothing, and would mean the tag had stopped working and the
     * client was being counted as the extension's), and nothing else may be
     * in the list.
     */
    const excluded = stdioAndHarness(report);
    for (const handle of excluded) {
      if (isStdio(handle)) {
        expect(handle.address, JSON.stringify(handle)).toBeUndefined();
        expect(handle.remote, JSON.stringify(handle)).toBeUndefined();
        continue;
      }
      expect(handle.ctor, JSON.stringify(handle)).toBe('Socket');
      expect(handle.listening, JSON.stringify(handle)).toBeUndefined();
      if (handle.remote !== undefined) expect(handle.remote).toBe(HOOK_LISTENER_HOST);
    }
    /*
     * MEASURED, and it is the reverse of what writing the tag assumed: on a
     * run where the POST SUCCEEDS the harness's own client is gone from the
     * enumeration by the next census, and the socket that lingers is the
     * EXTENSION's accepted connection (untagged, `remote` loopback,
     * `_handle` already released). So nothing here is excluded by the harness
     * tag at all, and saying so is the point — the tag is what proves that,
     * rather than the two sockets being told apart by a guess about which one
     * a `Socket/none` is. The tag is shown to still match a real handle by
     * the no-engine scenario below, where the client that failed to connect
     * IS the lingering socket.
     */
    expect(excluded.every(isStdio), JSON.stringify(excluded)).toBe(true);
  });

  it('has no socket before activation and none after disposal', () => {
    expect(networkDescriptors(report, 'loaded')).toStrictEqual([]);
    expect(networkDescriptors(report, 'disposed')).toStrictEqual([]);
  });

  it('serves a real hook POST over loopback: the listener plus its connection', () => {
    // 200 is the listener answering a real request over a real TCP
    // connection, so the "one socket" above is a socket that WORKS rather
    // than one that merely exists.
    expect(report.postStatus).toBe(200);
    /*
     * Serving costs exactly one more socket, and the extra one is the
     * EXTENSION's — the connection the listener accepted, still enumerated
     * with its `_handle` already released after the `Connection: close`
     * response. The harness's own client is not in this list: it is tagged at
     * the source and excluded, which is what lets these two sockets be told
     * apart rather than guessed at.
     *
     * This is also the assertion the old census could not make. It filtered
     * on `handle === 'TCP'`, so a released handle was invisible to it, and the
     * test that did the filtering was named "including the served connection".
     */
    expect(networkDescriptors(report, 'serving')).toStrictEqual([
      `connection remote=${HOOK_LISTENER_HOST}`,
      `listener ${HOOK_LISTENER_HOST}:${String(port)}`,
    ]);
    expect(networkHandles(report, 'serving').length).toBe(2);
    // And it goes away: disposal returns the process to zero sockets.
    expect(networkDescriptors(report, 'disposed')).toStrictEqual([]);
  });

  it('every socket at every phase is loopback, the served connection included', () => {
    for (const phase of Object.keys(report.phases)) {
      // The harness's own client is INCLUDED here and excluded everywhere
      // else: this is the one question it is evidence for — the connection
      // that actually carried a hook event was a loopback one.
      const sockets = [
        ...networkHandles(report, phase),
        ...handlesAt(report, phase).filter((h) => isHarness(h) && h.remote !== undefined),
      ];
      for (const handle of sockets) {
        const seen = [handle.address, handle.remote].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        expect(seen.length, `${phase}: a socket with no address at all`).toBeGreaterThan(0);
        for (const addr of seen) {
          expect(addr, `${phase}: ${JSON.stringify(handle)}`).toMatch(
            /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/,
          );
        }
      }
    }
  });

  it('attempts zero outbound connections from load through activation', () => {
    expect(report.outboundAtLoad).toStrictEqual([]);
    expect(report.outboundAtActivate).toStrictEqual([]);
  });

  it('resolves no hostname: every DNS call is node resolving the loopback literal it was told to BIND', () => {
    // MEASURED, and not what was expected going in. The run is not
    // DNS-silent: node's own `Server.listen(port, host)` routes through
    // `lookupAndListen` -> `dns.lookup(host, { all: true })` even when the
    // host is already a literal IP. So there is exactly one lookup, its
    // argument is the string '127.0.0.1', and its caller is the inbound bind.
    //
    // Asserting `dnsFinal` is empty would therefore be wrong, and asserting
    // only "no lookup happened" would have to be deleted the first time
    // someone read this. What actually matters is the property: no NAME is
    // ever resolved, so nothing can reach a host it did not already have an
    // address for. That is what is asserted, on the target and on the caller.
    for (const call of report.dnsFinal) {
      const first = (JSON.parse(call.target) as unknown[])[0];
      expect(
        first,
        `dns lookup of a non-loopback argument: ${call.target}\n${call.stack ?? ''}`,
      ).toMatch(/^(127\.\d+\.\d+\.\d+|::1)$/);
      expect(
        call.stack ?? '',
        'a DNS call from anywhere but the inbound bind is egress',
      ).toContain('Server.listen');
    }
    // EXACTLY one, not merely "at least one". `SECURITY.md` §4a says exactly
    // one, and a document that claims more than its test asserts is how a
    // measured finding turns into a comfortable story. One bind, one lookup:
    // a second call would mean something else in the run resolved something,
    // and that is the event worth failing on. THREE engines and still one:
    // neither the OpenCode nor the Codex engine resolves anything.
    expect(
      report.dnsFinal.length,
      `expected exactly one DNS call (the inbound bind); saw ${JSON.stringify(
        report.dnsFinal.map((c) => c.target),
      )}`,
    ).toBe(1);
  });

  it('attempts zero outbound connections across the entire run', () => {
    // The harness POST deliberately goes through the un-instrumented client
    // captured before the wrap, so this list is the EXTENSION's own outbound
    // traffic across load, activation, serving a real hook event and disposal.
    // It must be empty, and `postStatus === 200` above proves the harness's own
    // connect really happened and really reached the listener.
    expect(report.outboundFinal).toStrictEqual([]);
  });

  it('loads no module outside node builtins and the vscode stub', () => {
    const external = report.requiredIds.filter(
      (id) => !id.startsWith('node:') && id !== 'vscode' && !id.startsWith('.') && !id.includes(':\\') && !id.startsWith('/'),
    );
    expect(external, `unexpected runtime require(s): ${external.join(', ')}`).toStrictEqual(
      [],
    );
    // The three engines' own doors, so this run is not a Claude-Code-only one
    // wearing three environment variables: `node:sqlite` is the OpenCode
    // accessor's and `node:http` is the shared listener's.
    expect(report.requiredIds).toContain('node:sqlite');
    expect(report.requiredIds).toContain('node:http');
  });
});

// ---------------------------------------------------------------------------
// (B.5) the same census, one engine at a time — the three control scenarios
// ---------------------------------------------------------------------------

/**
 * The socket binds for CODEX ALONE, and it is still exactly one socket.
 *
 * The user's ruling of 2026-09-04: the hook listener binds when a Claude Code
 * project correlates OR a Codex data root exists. Before it, a Codex-only
 * workspace bound nothing and Codex liveness never saw a hook — and the gap
 * was gated TWICE, in `activate()` and again in `AgentDeckDataPath.start()`,
 * so closing either alone changed nothing for the user it was for.
 *
 * This scenario is that path measured end to end: no CC project, no OpenCode
 * store, a Codex root — one listener, which really serves a POST, and no other
 * socket anywhere in the lifecycle.
 */
describe('G5 runtime socket census: Codex alone still binds exactly one socket', () => {
  let report: CensusReport;
  let port = 0;
  let stderr = '';

  beforeAll(async () => {
    const codexRoot = codexRunRoot();
    const run = await runCensus({
      workspaces: [await codexWorkspacePath(codexRoot)],
      // No Claude Code project can correlate against an empty projects root,
      // so `activate()` sets `ccEnabled: false` — the ordinary state for
      // someone running Codex where Claude Code has never run.
      claudeProjectsRoot: await stagedEmptyDir('no-claude'),
      opencodeRoot: await stagedEmptyDir('no-opencode'),
      codexHome: codexRoot,
      waitForEngines: ['codex'],
      expectBind: true,
    });
    report = run.report;
    port = run.port;
    stderr = run.stderr;
  }, 120_000);

  it('the census child ran the real bundle to completion', () => {
    expect(report.error ?? '', stderr).toBe('');
    expect(report.ok).toBe(true);
    expect(report.activated).toBe(true);
  });

  it('mounts CODEX and nothing else', () => {
    // Exact set: `['codex']`. A run that also mounted Claude Code would bind
    // the socket for a reason this scenario is not about, and the assertion
    // below would then prove nothing about the 2026-09-04 rule.
    expect(
      enginesAnnouncedIn(report.diagnosticsLines),
      report.diagnosticsLines.join('\n'),
    ).toStrictEqual(['codex']);
  });

  it('binds exactly one loopback listener, and it serves', () => {
    const expected = [`listener ${HOOK_LISTENER_HOST}:${String(port)}`];
    expect(networkDescriptors(report, 'activated')).toStrictEqual(expected);
    expect(networkHandles(report, 'activated').length).toBe(1);
    expect(networkDescriptors(report, 'engines')).toStrictEqual(expected);
    expect(networkHandles(report, 'engines').length).toBe(1);
    // The socket is not merely present, it answers — which is what a Codex
    // hook event arriving at it would find.
    expect(report.postStatus).toBe(200);
    expect(networkDescriptors(report, 'loaded')).toStrictEqual([]);
    expect(networkDescriptors(report, 'disposed')).toStrictEqual([]);
  });

  it('allocates no Claude Code watcher, which is what ccEnabled: false buys', () => {
    // The exact kind set, and it is SHORTER than the three-engine one by
    // exactly the FS watchers. The correlation gate's original point — a
    // non-matching workspace allocates no watcher and no CC timer — survives
    // the socket no longer being behind it.
    expect(handleKinds(report, 'activated')).toStrictEqual(['Server/TCP']);
    expect(handleKinds(report, 'engines')).toStrictEqual(['Server/TCP']);
    expect(handleKinds(report, 'disposed')).toStrictEqual([]);
  });

  it('attempts zero outbound connections and resolves no name', () => {
    expect(report.outboundFinal).toStrictEqual([]);
    expect(report.dnsFinal.length).toBe(1);
  });
});

/**
 * Neither hook-driven engine observable: NOTHING binds, and the census says so.
 *
 * The other half of the 2026-09-04 rule, and the control that makes "zero
 * others" mean something in the two scenarios above. A census that reported no
 * socket because the child never bound one would look exactly like a census
 * that reported no EXTRA socket — so this run proves the environment really
 * decides, and that a bound socket in the other scenarios is a product fact
 * rather than a harness artefact.
 */
describe('G5 runtime socket census: no observable engine binds nothing at all', () => {
  let report: CensusReport;
  let stderr = '';

  beforeAll(async () => {
    const run = await runCensus({
      workspaces: [await stagedEmptyDir('nowhere')],
      claudeProjectsRoot: await stagedEmptyDir('no-claude'),
      opencodeRoot: await stagedEmptyDir('no-opencode'),
      // `codexRootExists` is `statSync(root).isDirectory()`, so a path that
      // does not exist is the only honest way to say "no Codex here". An
      // EMPTY DIRECTORY is a root that exists — the harness default that
      // `src/extension.test.ts`'s own comment once got wrong.
      codexHome: await stagedAbsentPath('no-codex-root'),
      expectBind: false,
    });
    report = run.report;
    stderr = run.stderr;
  }, 120_000);

  it('the census child ran the real bundle to completion', () => {
    expect(report.error ?? '', stderr).toBe('');
    expect(report.ok).toBe(true);
    expect(report.activated).toBe(true);
  });

  it('opens no socket at any phase, and nothing answers on the port', () => {
    for (const phase of Object.keys(report.phases)) {
      expect(networkDescriptors(report, phase), phase).toStrictEqual([]);
    }
    // `null` is the harness's own client failing to connect: there is nothing
    // listening. It is the measurement that makes `postStatus === 200` in the
    // scenarios above evidence rather than decoration.
    expect(report.postStatus).toBeNull();
  });

  it('the socket the census DOES see here is the harness\'s own, tagged', () => {
    /*
     * The non-vacuity control for the harness tag, and the only scenario that
     * can carry it. With nothing listening, the harness's client never
     * connects — and THAT socket is what lingers in the enumeration, with no
     * `remote` because there is no peer. Every other scenario's lingering
     * socket is the extension's accepted connection instead.
     *
     * So: the tag still matches a real handle (an exclusion that never
     * matched anything would be an exclusion hiding nothing), and it is the
     * only thing excluded here besides stdio.
     */
    const excluded = stdioAndHarness(report);
    const harness = excluded.filter(isHarness);
    expect(
      harness.length,
      'the harness tag matched nothing: it has stopped reaching the socket',
    ).toBeGreaterThan(0);
    for (const handle of harness) {
      expect(handle.ctor).toBe('Socket');
      expect(handle.remote, JSON.stringify(handle)).toBeUndefined();
    }
    expect(excluded.every((h) => isStdio(h) || isHarness(h))).toBe(true);
  });

  it('announces no engine and resolves no name', () => {
    expect(enginesAnnouncedIn(report.diagnosticsLines)).toStrictEqual([]);
    // No bind, so not even the inbound bind's own lookup happens. The one DNS
    // call the other scenarios measure is `Server.listen`'s, and there is no
    // `Server.listen`.
    expect(report.dnsFinal).toStrictEqual([]);
    expect(report.outboundFinal).toStrictEqual([]);
  });
});

/**
 * THE VACUITY CONTROL: the census can see a second socket.
 *
 * Every assertion above is of the form "the enumeration is exactly this", and
 * an enumeration that could never grow would satisfy all of them. So this
 * scenario runs the identical child with `CENSUS_DECOY=1`, which opens a
 * second loopback listener in the child after activation, and asserts that the
 * SAME predicate the scenarios above use reports two sockets and rejects the
 * one-socket expectation.
 *
 * Run against the Codex-alone environment rather than the three-engine one
 * because the property under test is the census's own eyesight, and that is
 * the cheaper of the two to spawn.
 */
describe('G5 runtime socket census: a second socket is CAUGHT (vacuity control)', () => {
  let report: CensusReport;
  let port = 0;
  let stderr = '';

  beforeAll(async () => {
    const codexRoot = codexRunRoot();
    const run = await runCensus({
      workspaces: [await codexWorkspacePath(codexRoot)],
      claudeProjectsRoot: await stagedEmptyDir('no-claude'),
      opencodeRoot: await stagedEmptyDir('no-opencode'),
      codexHome: codexRoot,
      decoy: true,
      expectBind: true,
    });
    report = run.report;
    port = run.port;
    stderr = run.stderr;
  }, 120_000);

  it('the decoy really opened, on a port of its own', () => {
    expect(report.error ?? '', stderr).toBe('');
    expect(report.ok).toBe(true);
    expect(report.decoyPort).toBeTypeOf('number');
    expect(report.decoyPort).not.toBe(port);
  });

  it('reports TWO listeners, and the one-socket expectation goes red', () => {
    const decoyPort = report.decoyPort ?? 0;
    const oneSocket = [`listener ${HOOK_LISTENER_HOST}:${String(port)}`];
    // The exact-set assertion every scenario above makes, made here against a
    // child with one extra socket. If this passed, those assertions would be
    // measuring nothing.
    expect(networkDescriptors(report, 'activated')).not.toStrictEqual(oneSocket);
    expect(networkDescriptors(report, 'activated')).toStrictEqual(
      [
        `listener ${HOOK_LISTENER_HOST}:${String(port)}`,
        `listener ${HOOK_LISTENER_HOST}:${String(decoyPort)}`,
      ].sort(),
    );
    expect(networkHandles(report, 'activated').length).toBe(2);
  });

  it('and the extra socket is gone once the decoy is closed', () => {
    // Closed before `deactivate()`, so the disposal census is clean and this
    // control cannot leave the file's last measurement in a mutated state.
    expect(networkDescriptors(report, 'disposed')).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (C) helpers — the OpenCode engine bundle and its corpus
// ---------------------------------------------------------------------------

/**
 * Bundle `src/opencode/index.ts` as its own entry point.
 *
 * Built here rather than read from `dist/`, for the reason stated at the top of
 * this file: `npm run package` does not rebuild `dist/`, so trusting an on-disk
 * artifact silently measures an old one. `esbuild.config.mjs` has no OpenCode
 * target because the engine is not wired into the host yet (DoD 5.2), so this
 * mirrors `hostOptions` rather than invoking the config.
 */
function buildOpencodeBundle(): string {
  const result = buildSync({
    entryPoints: [join(REPO_ROOT, 'src', 'opencode', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const [out] = result.outputFiles;
  if (out === undefined) throw new Error('the OpenCode engine bundle produced no output');
  const text = out.text;
  if (text.length < 5_000) {
    throw new Error(`the OpenCode engine bundle is implausibly small (${text.length} bytes)`);
  }
  return text;
}

/**
 * The smallest committed OpenCode corpus, derived from disk.
 *
 * Deliberately NOT imported from `src/opencode/synthetic.ts`: that module is
 * the write-capable one this file asserts is unreachable, and importing it here
 * would make the test process itself a counter-example to the point it is
 * making. Sizes are not asserted — the smallest is chosen so the mutation audit
 * stays quick when a bigger corpus is harvested.
 */
function ocCorpusDbPath(): string {
  const fixtures = join(REPO_ROOT, 'fixtures');
  const candidates = readdirSync(fixtures, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('opencode-'))
    .map((e) => join(fixtures, e.name, 'opencode.db'))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(a).size - statSync(b).size);
  const [smallest] = candidates;
  if (smallest === undefined) throw new Error('no fixtures/opencode-*/opencode.db found');
  return smallest;
}

// ---------------------------------------------------------------------------
// (C) the OpenCode engine — PLAN.md DoD 4.7
// ---------------------------------------------------------------------------

/**
 * DoD 4.7: "loading `src/opencode/*` opens zero sockets (`dns`, `net`, `http`
 * spies); the accessor exposes no write surface (every exported function
 * audited by a mutation test)."
 *
 * **DoD 5.2 landed and the paragraph that stood here is now false.** It said
 * the engine was "NOT yet reachable from `src/extension.ts`", which was true
 * when written and was the reason this describe exists. The host bundle audited
 * in part (A) now DOES contain the engine.
 *
 * This describe is kept, and it is not redundant: bundling
 * `src/opencode/index.ts` as its own entry point denies **`node:http`** too,
 * which the host bundle cannot do — there the hook listener is the one
 * sanctioned socket, so a host-bundle scan would pass while an engine that
 * opened an HTTP client hid behind the listener's allowance. Scanning the
 * engine alone is what makes the claim about the engine rather than about the
 * bundle it now travels in.
 *
 * `node:http` is DENIED here, unlike in the host bundle. There the listener is
 * the one sanctioned socket; the OpenCode engine has no listener and no client
 * — spec OC4 is explicit that the tap is a cursor over the `event` table with
 * "no listener, no client, no server, no SSE" — so the engine reaching any
 * socket module at all is a G5 review, and failing here is that review.
 */
describe('G5 — the OpenCode engine (DoD 4.7)', () => {
  let bundle = '';

  // 120 s for the reason both sibling hooks carry one: this body is a
  // synchronous esbuild subprocess and vitest's DEFAULT hookTimeout is 10 s. A
  // hook that loses that race reports the whole describe as SKIPS with a
  // clean-looking tests line and no failed count — which is how six G5
  // assertions ran zero times in Phase 3.
  beforeAll(() => {
    bundle = buildOpencodeBundle();
  }, 120_000);

  it('reaches no network-capable module at all — not even node:http', () => {
    const ids = bundleModuleIds(bundle);
    expect(ids.size, 'a bundle that names no module has not been built').toBeGreaterThan(0);
    const denied = [...DENIED_MODULE_IDS, 'http'];
    const found: string[] = [];
    for (const id of denied) {
      if (ids.has(id)) found.push(id);
      if (ids.has(`node:${id}`)) found.push(`node:${id}`);
    }
    expect(
      found.sort(),
      `the OpenCode engine reaches network-capable module(s): ${found.join(', ')}`,
    ).toStrictEqual([]);
  });

  it('names only node builtins — no third-party module survives bundling', () => {
    for (const id of bundleModuleIds(bundle)) {
      expect(id, `${id} is not a node: builtin`).toMatch(/^node:/);
    }
  });

  it('contains no outbound request API', () => {
    expect(bundle).not.toMatch(/\bhttps?\.request\s*\(/);
    expect(bundle).not.toMatch(/\bimport_node_http\d*\.request\s*\(/);
    expect(bundle).not.toMatch(/\bfetch\s*\(/);
    expect(bundle).not.toContain('XMLHttpRequest');
    expect(bundle).not.toContain('new WebSocket(');
    expect(bundle).not.toContain('createServer');
    expect(bundle).not.toContain('navigator.sendBeacon');
  });

  it('the scan sees a dynamic import(), proven by injecting one', () => {
    // Not asserted, INJECTED — the same guard part (A) carries. A require-only
    // scan once reported a clean bundle while three denied modules sat one
    // dynamic import away.
    for (const denied of ['net', 'dns', 'http']) {
      const injected = `${bundle}\nglobalThis.__leak = () => import("node:${denied}");\n`;
      expect(
        bundleModuleIds(injected),
        `a dynamic import of node:${denied} slipped past the scan`,
      ).toContain(`node:${denied}`);
    }
  });

  it('never reaches synthetic.ts, the one module here that can write', () => {
    /*
     * `src/opencode/synthetic.ts` builds `synthetic-` fixtures: it opens a
     * database for WRITE and writes files. It is confined to a `mkdtemp`
     * directory and refuses any path inside `fixtures/`, but the property that
     * matters is that it can never reach a shipped bundle at all.
     *
     * Asserted against the BUNDLE rather than by reading imports, because only
     * the bundle knows what an import graph actually pulled in — the same
     * reason the loopback literal in part (A) is asserted post-build.
     */
    expect(bundle).not.toContain('refusing to open a committed fixture for write');
    expect(bundle).not.toContain('agent-deck-oc-');
    expect(bundle).not.toMatch(/\bmkdtempSync\b/);
    expect(bundle).not.toMatch(/\bwriteFileSync\b/);
    expect(bundle).not.toMatch(/\bcopyFileSync\b/);
  });

  it('opens the database read-only and nowhere else in the engine', () => {
    // The engine's ONE `new DatabaseSync(...)` is db.ts's, and it passes
    // `readOnly: true`. A second construction site anywhere on this path would
    // be a write surface that no mutation test covers.
    // The identifier is namespaced in the bundle — esbuild emits
    // `new import_node_sqlite.DatabaseSync(` — so the pattern allows a dotted
    // prefix. A bare-identifier match finds ZERO sites here and would pass an
    // assertion that measured nothing.
    const constructions = [...bundle.matchAll(/new\s+[\w.]*DatabaseSync\s*\(/g)];
    expect(constructions.length, 'expected exactly one DatabaseSync construction site').toBe(1);
    expect(bundle).toContain('readOnly: true');
  });

  it('every exported function of the accessor refuses to write (mutation audit)', async () => {
    /*
     * DoD 4.7's second half, done by MUTATION rather than by inspection: take
     * every exported function of `db.ts`, call the ones that take a database
     * path against a real corpus, and assert none of them can be made to write.
     *
     * The strong half is the handle itself — SQLite enforces `readOnly`, so an
     * `INSERT` through it throws errcode 8 — and that is asserted in
     * `db.test.ts`. What is asserted HERE is the surface: no exported function
     * accepts SQL, and none returns anything through which a caller could get
     * at the handle.
     */
    const db = (await import('../opencode/db.js')) as unknown as Record<string, unknown>;
    const exported = Object.entries(db).filter(([, v]) => typeof v === 'function');
    expect(exported.length, 'db.ts exports no functions — the audit is vacuous').toBeGreaterThan(3);

    for (const [name] of exported) {
      // No exported name may promise a write. A reader is a reader.
      expect(name).not.toMatch(/write|insert|update|delete|exec/i);
    }

    /*
     * SQL verbs are scanned in the BUNDLE, not in the source.
     *
     * `db.ts`'s header documents what a read-only handle does when you try to
     * INSERT through it, so the source contains that word in prose and a
     * source scan fails on its own documentation. esbuild strips comments, so
     * the bundle holds only strings and code — which is exactly the corpus the
     * question "does this code name a mutating statement" is about.
     */
    for (const verb of ['INSERT ', 'UPDATE ', 'DELETE ', 'DROP ', 'ALTER ', 'CREATE ']) {
      expect(bundle.toUpperCase().includes(verb), `the engine names ${verb.trim()}`).toBe(false);
    }
    /*
     * `.exec()` is DatabaseSync's arbitrary-SQL door — and it is ALSO
     * `RegExp.prototype.exec`, which `fingerprint.ts` uses to parse a version
     * string. Scanning the whole bundle for it therefore fails on a regex,
     * which is a false positive rather than a finding.
     *
     * The narrow check is the correct one: `db.ts` is the only module on this
     * path that ever holds a handle (asserted directly above — exactly one
     * construction site in the whole bundle), so a SQL `.exec()` could only be
     * written there. Nothing else can reach the handle to call it.
     */
    const accessorSource = await readFile(
      join(REPO_ROOT, 'src', 'opencode', 'db.ts'),
      'utf8',
    );
    expect(accessorSource).not.toMatch(/\.exec\s*\(/);

    const corpus = ocCorpusDbPath();
    const before = createHash('sha256').update(readFileSync(corpus)).digest('hex');
    const readers = exported.filter(([name]) => name.startsWith('read'));
    expect(readers.length, 'no reader was exercised').toBeGreaterThan(0);
    for (const [, fn] of readers) {
      (fn as (p: string) => unknown)(corpus);
    }
    expect(createHash('sha256').update(readFileSync(corpus)).digest('hex')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// (D) helpers - the Codex engine bundle and its corpus
// ---------------------------------------------------------------------------

/**
 * Bundle `src/codex/index.ts` as its own entry point.
 *
 * Built here rather than read from `dist/`, for the reason stated at the top of
 * this file: `npm run package` does not rebuild `dist/`, so trusting an on-disk
 * artifact silently measures an old one. `esbuild.config.mjs` has no Codex
 * target because the engine is not wired into the host yet (DoD 3.x), so this
 * mirrors `buildOpencodeBundle` rather than invoking the config.
 */
function buildCodexBundle(): string {
  const result = buildSync({
    entryPoints: [join(REPO_ROOT, 'src', 'codex', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const [out] = result.outputFiles;
  if (out === undefined) throw new Error('the Codex engine bundle produced no output');
  const text = out.text;
  if (text.length < 5_000) {
    throw new Error(`the Codex engine bundle is implausibly small (${text.length} bytes)`);
  }
  return text;
}

/**
 * The Codex data root of one committed run, derived from disk.
 *
 * Sizes are not asserted and no corpus name is written down: the corpus and its
 * runs are enumerated, and the first is used. A hard-coded fixture name breaks
 * on the next harvest and reads as a regression.
 */
function codexRunRoot(): string {
  const fixtures = join(REPO_ROOT, 'fixtures');
  const corpora = readdirSync(fixtures, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('codex-'))
    .map((e) => e.name)
    .filter((name) => existsSync(join(fixtures, name, 'golden.json')))
    .sort();
  const [corpus] = corpora;
  if (corpus === undefined) throw new Error('no fixtures/codex- corpus with a golden.json found');
  const runs = readdirSync(join(fixtures, corpus), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(fixtures, corpus, name, 'home', '.codex')))
    .sort();
  const [run] = runs;
  if (run === undefined) throw new Error(`${corpus} has no run with a home/.codex root`);
  return join(fixtures, corpus, run, 'home', '.codex');
}

// ---------------------------------------------------------------------------
// (D) the Codex engine - PLAN.md v0.6.0 DoD 2.8
// ---------------------------------------------------------------------------

/**
 * DoD 2.8: "the Codex engine opens zero sockets."
 *
 * Two properties have to hold at `src/codex/index.ts` rather than merely being
 * true today, and both are asserted against the BUNDLE, because only a bundle
 * knows what an import graph actually pulled in:
 *
 *   - it imports no network-capable module, directly or transitively;
 *   - the bundled graph rooted at that file opens zero sockets.
 *
 * `node:http` is DENIED here, exactly as it is for the OpenCode engine and
 * unlike in the host bundle. G5 is absolute: there is ONE socket in this
 * product, the loopback hook listener. The Codex engine has no listener, no
 * client, no App Server connection and no socket to Codex - spec C1 and C6 put
 * every fact it reads in a FILE, and `never-open.ts` is the list of the files it
 * must not even open. So this engine reaching any socket module at all is a G5
 * review, and failing here is that review.
 *
 * Scanning the engine ALONE is what makes the claim about the engine rather
 * than about whatever bundle it eventually travels in: once DoD 3.x wires it
 * into the host, the host bundle's `node:http` allowance would hide a Codex
 * HTTP client behind the listener's exemption.
 */
describe('G5 - the Codex engine (DoD 2.8)', () => {
  let bundle = '';

  // 120 s for the reason both sibling hooks carry one: this body is a
  // synchronous esbuild subprocess and vitest's DEFAULT hookTimeout is 10 s. A
  // hook that loses that race reports the whole describe as SKIPS with a
  // clean-looking tests line and no failed count - which is how six G5
  // assertions ran zero times in Phase 3.
  beforeAll(() => {
    bundle = buildCodexBundle();
  }, 120_000);

  it('reaches no network-capable module at all - not even node:http', () => {
    const ids = bundleModuleIds(bundle);
    expect(ids.size, 'a bundle that names no module has not been built').toBeGreaterThan(0);
    const denied = [...DENIED_MODULE_IDS, 'http'];
    const found: string[] = [];
    for (const id of denied) {
      if (ids.has(id)) found.push(id);
      if (ids.has(`node:${id}`)) found.push(`node:${id}`);
    }
    expect(
      found.sort(),
      `the Codex engine reaches network-capable module(s): ${found.join(', ')}`,
    ).toStrictEqual([]);
  });

  it('names only node builtins - no third-party module survives bundling', () => {
    for (const id of bundleModuleIds(bundle)) {
      expect(id, `${id} is not a node: builtin`).toMatch(/^node:/);
    }
  });

  it('contains no outbound request API and no server', () => {
    expect(bundle).not.toMatch(/\bhttps?\.request\s*\(/);
    expect(bundle).not.toMatch(/\bimport_node_http\d*\.request\s*\(/);
    expect(bundle).not.toMatch(/\bfetch\s*\(/);
    expect(bundle).not.toContain('XMLHttpRequest');
    expect(bundle).not.toContain('new WebSocket(');
    expect(bundle).not.toContain('createServer');
    expect(bundle).not.toContain('createConnection');
    expect(bundle).not.toContain('navigator.sendBeacon');
    // Codex ships an App Server with an HTTP surface. Nothing in this engine
    // may name it: the tap is the rollout files and the hook listener the host
    // already owns, and a URL literal here would be the first step to a second
    // socket. `localhost` is checked as well as the loopback literal because a
    // client would plausibly be written either way.
    expect(bundle).not.toContain('127.0.0.1');
    expect(bundle).not.toContain('localhost');
    expect(bundle).not.toContain('http://');
  });

  it('the scan sees a dynamic import(), proven by injecting one', () => {
    // Not asserted, INJECTED - the same guard parts (A) and (C) carry. A
    // require-only scan once reported a clean bundle while three denied modules
    // sat one dynamic import away.
    for (const denied of ['net', 'dns', 'http']) {
      const injected = `${bundle}\nglobalThis.__leak = () => import("node:${denied}");\n`;
      expect(
        bundleModuleIds(injected),
        `a dynamic import of node:${denied} slipped past the scan`,
      ).toContain(`node:${denied}`);
    }
  });

  it('opens every file read-only and writes nothing (G1)', () => {
    /*
     * The engine's reads all go through `FileTail`, which opens with the read
     * flag and nothing else. What is asserted here is the SURFACE: no writing
     * API survives bundling at all. `src/codex/never-open.ts` is on this path
     * deliberately - it is the G10 list - so its NAMES appear in the bundle as
     * strings; that is the list of things not to open, not an open.
     */
    expect(bundle).not.toMatch(/\bwriteFileSync\b/);
    expect(bundle).not.toMatch(/\bappendFileSync\b/);
    expect(bundle).not.toMatch(/\bmkdtempSync\b/);
    expect(bundle).not.toMatch(/\bcopyFileSync\b/);
    expect(bundle).not.toMatch(/\brmSync\b/);
    expect(bundle).not.toMatch(/\bunlinkSync\b/);
    // `node:sqlite` is the OpenCode engine's door and has no business here.
    expect(bundleModuleIds(bundle).has('node:sqlite')).toBe(false);
  });

  it('the scanned entry point is the one that really reads a corpus', async () => {
    /*
     * THE VACUITY CONTROL FOR EVERY SCAN ABOVE. A bundle that reaches no socket
     * because it reaches nothing at all would pass all of them. So the same
     * entry point is imported and RUN against a committed Codex root here, in
     * this process, and must produce real sessions.
     *
     * And the bundle is pinned to that same engine by two literals only the
     * real discovery path carries - the rollout filename prefix and the writer
     * lock directory - so a future refactor cannot leave this file scanning a
     * stub while the engine lives somewhere else.
     */
    expect(bundle).toContain('rollout-');
    expect(bundle).toContain('thread-writer-locks');

    const { readCodexEngine } = await import('../codex/index.js');
    const outcome = await readCodexEngine({ root: codexRunRoot() });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.sessions.length).toBeGreaterThan(0);
    expect(outcome.result.threads.length).toBeGreaterThan(0);
    for (const session of outcome.result.sessions) expect(session.engine).toBe('codex');
  });
});
