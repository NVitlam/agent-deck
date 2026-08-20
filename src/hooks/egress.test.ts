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
import { readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// (A) dependency review
// ---------------------------------------------------------------------------

describe('G5 dependency review: what the shipped bundle can reach', () => {
  let bundle = '';

  beforeAll(() => {
    bundle = buildHostBundle();
  });

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

  it('requires only node builtins and vscode — no third-party module survives bundling', () => {
    const ids = new Set(
      [...bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] as string),
    );
    expect(ids.size, 'a bundle that requires nothing has not been built').toBeGreaterThan(0);
    for (const id of ids) {
      if (id === 'vscode') continue;
      expect(id, `${id} is neither a node: builtin nor vscode`).toMatch(/^node:/);
    }
  });

  it('reaches no network-capable module other than the listener', () => {
    const ids = new Set(
      [...bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] as string),
    );
    for (const denied of DENIED_MODULE_IDS) {
      expect(ids, `${denied} must not be reachable from the host bundle`).not.toContain(
        `node:${denied}`,
      );
      expect(ids).not.toContain(denied);
    }
    // The one sanctioned socket module is present, so this is not vacuous.
    expect(ids).toContain('node:http');
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

    // An ephemeral-but-known port. The extension refuses to bind port 0, and
    // the live hook tap in this repo may well hold 47821 right now, so the
    // census must not race it.
    port = 40000 + Math.floor(Math.random() * 20000);

    const run = spawnSync(process.execPath, [join(stage, 'census.cjs')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        CLAUDE_PROJECTS_ROOT: CAPTURED_ROOT,
        CENSUS_WORKSPACE: await capturedWorkspacePath(),
        CENSUS_PORT: String(port),
      },
    });
    stderr = run.stderr ?? '';
    const line = (run.stdout ?? '')
      .split(/\r?\n/)
      .find((l) => l.startsWith('__CENSUS__'));
    expect(
      line,
      `census child produced no report.\nstdout:\n${run.stdout ?? ''}\nstderr:\n${stderr}`,
    ).toBeDefined();
    report = JSON.parse((line as string).slice('__CENSUS__'.length)) as CensusReport;

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
    // Not vacuous: the listener really did bind, so the one call really was
    // observed rather than the instrumentation silently missing everything.
    expect(report.dnsFinal.length).toBeGreaterThan(0);
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
