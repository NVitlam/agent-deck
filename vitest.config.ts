import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `webview/` joined the glob in Phase 3. Webview tests that need a DOM opt
    // in per file with a `@vitest-environment jsdom` docblock rather than
    // switching the default: the host suites are node suites and stay that way.
    include: ['src/**/*.test.ts', 'webview/**/*.test.ts'],
    environment: 'node',
    // The forks pool (vitest 3's default) intermittently exits non-zero while
    // reporting every test passed: the parent raises ERR_IPC_CHANNEL_CLOSED from
    // tinypool's ProcessWorker.send to a child whose IPC channel already closed.
    // It needs the listener's socket tests AND forks together; it is not raised in
    // the worker (uncaughtException/unhandledRejection handlers there catch nothing
    // across reproducing runs). Measured on this machine, full suite, counting
    // non-zero exits: forks 1/24, threads 0/20 with all tests passing.
    //
    // This matters because every phase gates on 'full suite passes', and a suite
    // that randomly exits 1 with a green summary reads as a fresh regression to
    // whoever hits it. Do not revert to forks without re-measuring over >=20 runs;
    // any conclusion from <=12 runs on a ~5-15% event is noise.
    pool: 'threads',
    // `npm test` runs `vitest run` (non-watch) so CI and agents get an exit code.
    watch: false,
  },
});
