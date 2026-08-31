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
};

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
  vscode.__setWorkspace(process.env.CENSUS_WORKSPACE);
  vscode.__setConfig({ port: Number(process.env.CENSUS_PORT) });

  await mod.activate(vscode.__context());
  report.activated = true;
  report.phases.activated = census();
  // The load-bearing number: from require through activation, on real
  // fixtures, the extension attempted zero outbound connections.
  report.outboundAtActivate = outbound.slice();

  report.postStatus = await postEvent(Number(process.env.CENSUS_PORT));
  report.phases.serving = census();

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
let workspacePath = null;
let config = {};
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
    showInformationMessage: () => undefined,
    showErrorMessage: (m) => { api.__errors.push(String(m)); },
  },
  workspace: {
    get workspaceFolders() {
      return workspacePath === null ? undefined : [{ uri: api.Uri.file(workspacePath), name: 'w', index: 0 }];
    },
    getConfiguration: () => ({ get: (key) => config[key] }),
    onDidChangeConfiguration: () => noop,
  },
  __errors: [],
  __setWorkspace: (p) => { workspacePath = p; },
  __setConfig: (c) => { config = c; },
  __context: () => ({ subscriptions: [], extensionUri: api.Uri.file('/census/ext') }),
};
module.exports = api;
`;

describe('G5 runtime socket census: only the loopback listener opens', () => {
  let report: CensusReport;
  let port = 0;
  let stderr = '';

  beforeAll(async () => {
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

    // G6: "Tests never read live `~/.claude` or the live OpenCode DB."
    //
    // The census spawns the REAL bundled `activate()` and inherits
    // `process.env`. The CC half has always been pinned by
    // `CLAUDE_PROJECTS_ROOT` below; until DoD 5.2 there was no OpenCode half to
    // pin, because the engine was not reachable from the host. Now it is, so an
    // unpinned run would resolve `%USERPROFILE%/.local/share/opencode` and open
    // the developer's own database — which on this machine is ~24 MB and in WAL
    // mode, so a read-only open would also touch its `-shm` sidecar.
    //
    // An EMPTY directory rather than a fixture corpus, deliberately: this
    // describe measures SOCKETS, and the engine finding no data directory is
    // both the quietest path through it and the one that adds no I/O to a
    // census that is already timing-sensitive. DoD 5.2's "absent directory →
    // engine silently off" is what makes that a supported state rather than a
    // degraded one.
    const emptyOpencodeRoot = join(stage, 'no-opencode');
    await mkdir(emptyOpencodeRoot, { recursive: true });

    // A known port, probed free immediately before the spawn. The extension
    // refuses to bind port 0 by design, and the live hook tap in this repo may
    // well hold 47821 right now, so the census cannot use either.
    //
    // The retry, argued rather than assumed. Everywhere else in this package a
    // port race was CLOSED, not narrowed — the listener binds port 0 itself and
    // no bare number is ever handed around. That is unavailable here: the child
    // runs the shipped `activate()`, which takes its port from configuration
    // and refuses 0, and a bound socket cannot be handed to another process
    // portably on Windows. What is left is to shrink the window (a band the OS
    // never assigns, probed free microseconds earlier) and to retry on a
    // DIFFERENT port when the child reports no listening socket. The retry is
    // bounded and it cannot hide a product defect: a bind that fails on five
    // separately-probed ports is not a race, and the assertions below then run
    // against the last report and fail with it.
    const MAX_BIND_ATTEMPTS = 5;
    let attempts = 0;
    let parsed: CensusReport | undefined;
    let lastStdout = '';
    for (;;) {
      attempts += 1;
      port = await reserveCensusPort();

      const run = spawnSync(process.execPath, [join(stage, 'census.cjs')], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          CLAUDE_PROJECTS_ROOT: CAPTURED_ROOT,
          // The OpenCode half of the same rule. See the staging comment above.
          AGENT_DECK_OPENCODE_ROOT: emptyOpencodeRoot,
          CENSUS_WORKSPACE: await capturedWorkspacePath(),
          CENSUS_PORT: String(port),
        },
      });
      stderr = run.stderr ?? '';
      lastStdout = run.stdout ?? '';
      const line = lastStdout
        .split(/\r?\n/)
        .find((l) => l.startsWith('__CENSUS__'));
      if (line !== undefined) {
        parsed = JSON.parse(line.slice('__CENSUS__'.length)) as CensusReport;
        const bound = (parsed.phases['activated'] ?? []).some(
          (h) => h.handle === 'TCP',
        );
        if (bound) break;
      }
      if (attempts >= MAX_BIND_ATTEMPTS) break;
    }
    if (attempts > 1) {
      // Never silent: a retried census is a fact a reviewer should see even on
      // a green run, because a rising count means the band is getting crowded.
      process.stderr.write(
        `[census] the child needed ${String(attempts)} bind attempt(s)\n`,
      );
    }
    expect(
      parsed,
      `census child produced no report after ${String(attempts)} attempt(s).\nstdout:\n${lastStdout}\nstderr:\n${stderr}`,
    ).toBeDefined();
    report = parsed as CensusReport;

    // The census is evidence, and evidence nobody can print is hard to audit.
    // `AGENT_DECK_CENSUS_DEBUG=1 npx vitest run src/hooks/egress.test.ts`
    // dumps the raw report so a reviewer can read the handle list themselves
    // instead of taking these assertions' word for it.
    if (process.env['AGENT_DECK_CENSUS_DEBUG'] !== undefined) {
      process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
    }
  }, 120_000);

  /** Handles whose underlying libuv handle is a TCP socket — the only kind that can leave the box. */
  function tcpHandles(phase: string): HandleRecord[] {
    return (report.phases[phase] ?? []).filter((h) => h.handle === 'TCP');
  }

  it('the census child ran the real bundle to completion', () => {
    expect(report.error ?? '', stderr).toBe('');
    expect(report.ok).toBe(true);
    expect(report.activated).toBe(true);
    // Not vacuous: it really loaded the bundle, which really required vscode.
    expect(report.requiredIds).toContain('vscode');
  });

  it('opens exactly one TCP handle, and it is the loopback listener on the configured port', () => {
    const listening = tcpHandles('activated');
    expect(
      listening.map((h) => `${h.ctor}/${h.address ?? '?'}:${String(h.port ?? 0)}`),
    ).toStrictEqual([`Server/${HOOK_LISTENER_HOST}:${String(port)}`]);
    expect(listening[0]?.listening).toBe(true);
  });

  it('has no TCP handle before activation and none after disposal', () => {
    expect(tcpHandles('loaded')).toStrictEqual([]);
    expect(tcpHandles('disposed')).toStrictEqual([]);
  });

  it('every TCP handle at every phase is loopback, including the served connection', () => {
    expect(report.postStatus).toBe(200);
    for (const phase of Object.keys(report.phases)) {
      for (const handle of tcpHandles(phase)) {
        const seen = [handle.address, handle.remote].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        expect(seen.length, `${phase}: a TCP handle with no address at all`).toBeGreaterThan(0);
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
    // and that is the event worth failing on.
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
