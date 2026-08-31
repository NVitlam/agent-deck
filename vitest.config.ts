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

// The full set of test files, unchanged from before the split into projects.
// `webview/` joined the glob in Phase 3. The union of the two projects'
// include/exclude below must equal exactly this - a file that stops being
// collected reports as a skip and reads green in the summary line, which is a
// worse outcome than any red budget. Checked with `vitest list --filesOnly`:
// 51 files before the split, the same 51 after, set-identical.
const ALL_TESTS = ['src/**/*.test.ts', 'webview/**/*.test.ts'];

// A glob rather than a literal path, so a second wall-clock file joins the
// isolated project automatically instead of silently rejoining the parallel
// one. That is not hypothetical any more: `sweep-history.test.ts` arrived
// here on 2026-08-27, carrying `privacy.test.ts`'s `historyMs < 10_000`
// unchanged, after that assertion went red at 12,344 ms in a full run on a
// loaded box while the tree it measured was green forty minutes earlier.
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
    // TWO PROJECTS, AND THE SPLIT IS THE POINT (Phase 5, PLAN.md amendment B8).
    //
    // `src/perf/perf.test.ts` enforces wall-clock budgets on a stage that is
    // filesystem-bound - `src/perf/budgets.ts` describes
    // `postAppend.tailPoll.regression` as "mostly the per-poll discovery sweep
    // (readdir of the slug and subagents directories)". In a single-project
    // 51-file run that stage measured 1076.4 ms against a 150 ms limit, while
    // measuring 10.6 ms with the file run alone. The in-memory `.apply` stage
    // sat on its historical set point throughout, so the machine is not
    // globally slow: only the filesystem-bound stage moved.
    // `docs/evidence/phase-4/PERF-CONTENTION.md` carries the earlier numbers.
    //
    // `sequence.groupOrder` is a project-level option only, which is why this
    // is two projects rather than one added option. Groups run lowest to
    // highest, so group 1 does not start until group 0 has finished.
    //
    // THE ORDERING ALONE WAS NOT ENOUGH, AND THE MEASUREMENT SAYS WHY. With
    // groupOrder in place and both projects on the threads pool, the JSON
    // reporter put the perf file's test window 35 s AFTER the last other
    // file's window ended - overlap 0 ms, so the isolation was real - and
    // `.tailPoll` still measured 1050.6 ms. So the cause is not concurrency.
    // Running the same two projects as two SEPARATE `vitest` processes back to
    // back gave 12.3 ms. The slow number therefore belongs to the state of the
    // vitest host PROCESS after 50 files, not to anything running at the same
    // time, and no amount of ordering inside one process reaches it.
    //
    // Hence the perf project alone takes the forks pool: a fork is a child
    // process with its own libuv loop and thread pool, which is the only
    // process boundary this config can ask for. Measured on the full 51-file
    // run: `.tailPoll` 12.6 ms, `.incremental` 21.1 ms, both MET, exit 0.
    //
    // The limit was NOT widened and the set point was NOT moved:
    // `git diff -- src/perf/` for this change is empty. Widening a limit to
    // survive contention is the version-window mistake in timing form.
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
          // This matters because every phase gates on 'full suite passes', and
          // a suite that randomly exits 1 with a green summary reads as a
          // fresh regression to whoever hits it. Do not revert this project to
          // forks without re-measuring over >=20 runs; any conclusion from
          // <=12 runs on a ~5-15% event is noise.
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
          // pool semantics - see the block above for the measurement that
          // forced it. The recorded hazard that put the rest of the suite on
          // threads is a socket-test interaction, and this project contains no
          // socket tests: neither file here opens a listener or binds a port.
          // `singleFork` because two workers over two files would reintroduce
          // inside this project exactly the contention it exists to remove.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
