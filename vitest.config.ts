import { fileURLToPath } from 'node:url';

import { defaultExclude, defineConfig } from 'vitest/config';

// `vscode` is injected by the extension host at runtime and has no package
// on disk, so `src/extension.ts`'s top-level import cannot resolve in a
// node test process. `test/vscode-mock.ts` is the runtime stand-in;
// production code still type-checks against the real `@types/vscode`, and
// esbuild keeps `vscode` external for the same reason.
//
// A RegExp anchored on both ends, not a bare string: vite treats a string
// `find` as a PREFIX, so `'vscode'` would also rewrite `vscode-uri` and
// any future `vscode-*` dependency into a nonexistent path.
//
// Projects do NOT inherit the root vite config, so this is spread into each
// project rather than declared once at the top level. One definition, two
// references - the same rule `src/bridge/contract.ts` exists to enforce.
const VSCODE_ALIAS = [
  {
    find: /^vscode$/,
    replacement: fileURLToPath(new URL('./test/vscode-mock.ts', import.meta.url)),
  },
];

// The full set of test files, unchanged by the split into projects. `webview/`
// joined the glob in Phase 3. The union of the two projects' include/exclude
// below must equal exactly this - a file that stops being collected reports as
// a SKIP and reads green in the summary line, which is a worse outcome than
// any red budget. Check with `vitest list --filesOnly` before and after
// touching either glob.
const ALL_TESTS = ['src/**/*.test.ts', 'webview/**/*.test.ts'];

// A glob rather than a literal path, so a second wall-clock file joins the
// isolated project automatically instead of silently rejoining the parallel
// one. Today it matches `perf.test.ts` and `sweep-history.test.ts`.
const PERF_TESTS = ['src/perf/**/*.test.ts'];

// Webview tests that need a DOM opt in per file with a
// `@vitest-environment jsdom` docblock rather than switching the default: the
// host suites are node suites and stay that way. `environment` is a
// project-level option, so it is stated in both projects.
const ENVIRONMENT = 'node';

export default defineConfig({
  test: {
    // `npm test` runs `vitest run` (non-watch) so CI and agents get an exit
    // code. Root-level: `watch` is not a per-project option.
    watch: false,
    // TWO PROJECTS, AND THE SPLIT IS THE POINT.
    //
    // Every wall-clock assertion in this repository measures a machine, not a
    // change. Run beside forty other files on a loaded box they go red, and a
    // gate that goes red on load is a gate whose green does not reproduce -
    // `CLAUDE.md` rule 14 exists because exactly that happened to the Phase 5
    // gate. It then happened again, to a `phase-verifier` auditing this
    // release's predecessor: four timeouts plus `privacy.test.ts`'s history
    // budget, `expected 12344 to be less than 10000`, on a tree whose code was
    // green forty minutes earlier. That assertion now lives in
    // `src/perf/sweep-history.test.ts`, in the isolated project, with the same
    // 10,000 ms limit it always had.
    //
    // `sequence.groupOrder` is a project-level option only, which is why this
    // is two projects rather than one added option. Groups run lowest to
    // highest, so group 1 does not start until group 0 has finished.
    //
    // ORDERING ALONE IS NOT ENOUGH, and the measurement that says so is
    // recorded in `CLAUDE.md`: with groupOrder in place and both projects on
    // threads, the perf file's window landed 35 s after the last other file's
    // ended - overlap 0 ms, real isolation - and `tailPoll` still measured
    // 1050.6 ms, against 12.3 ms for the same two projects run as two separate
    // processes. The slow number belongs to the state of the vitest HOST
    // PROCESS after the whole suite, and no ordering inside one process
    // reaches it. Hence forks below: a fork is a child process with its own
    // libuv loop and thread pool, which is the only process boundary a vitest
    // config can ask for.
    //
    // NO LIMIT WAS WIDENED to get here, in either file. Widening a budget to
    // survive load is the version-window mistake in timing form.
    projects: [
      {
        resolve: { alias: [...VSCODE_ALIAS] },
        test: {
          name: 'suite',
          include: [...ALL_TESTS],
          // `defaultExclude` must be re-stated: supplying `exclude` replaces
          // it wholesale, and dropping it would sweep node_modules into the
          // run.
          exclude: [...defaultExclude, ...PERF_TESTS],
          environment: ENVIRONMENT,
          // The forks pool (vitest 3's default) intermittently exits non-zero
          // while reporting every test passed: the parent raises
          // ERR_IPC_CHANNEL_CLOSED from tinypool's ProcessWorker.send to a
          // child whose IPC channel already closed. It needs the listener's
          // socket tests AND forks together; it is not raised in the worker
          // (uncaughtException/unhandledRejection handlers there catch nothing
          // across reproducing runs). Measured on this machine, full suite,
          // counting non-zero exits: forks 1/24, threads 0/20 with all tests
          // passing.
          //
          // This matters because every gate is "the full suite passes", and a
          // suite that randomly exits 1 with a green summary reads as a fresh
          // regression to whoever hits it. Do not revert this project to forks
          // without re-measuring over >= 20 runs; any conclusion from <= 12
          // runs on a ~5-15% event is noise.
          //
          // `src/hooks/listener.test.ts` - the socket half of that measured
          // pairing - is in THIS project, and stays on threads with it.
          pool: 'threads',
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: { alias: [...VSCODE_ALIAS] },
        test: {
          name: 'perf',
          include: [...PERF_TESTS],
          environment: ENVIRONMENT,
          // Forks HERE ONLY, and for the process boundary rather than for the
          // pool semantics - see the block above. The recorded hazard that put
          // the rest of the suite on threads is a socket-test interaction, and
          // this project contains no socket tests: neither file here opens a
          // listener or binds a port. `singleFork` because two workers over
          // two files would reintroduce inside this project exactly the
          // contention the project exists to remove.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
