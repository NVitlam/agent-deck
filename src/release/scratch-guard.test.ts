/**
 * The scratch guard's one exception, pinned (v0.7.1 gate, 2026-09-10).
 *
 * `test/scratch-guard.ts` fails a run over any new `%TEMP%` directory shaped
 * like `mkdtemp`'s output. The v0.7.1 20-run gate block was refused twice by
 * directories that are vitest's own `ssr/` transform cache under 21-character
 * random names that happen to end in a separator plus six alphanumerics. The
 * exception is by STRUCTURE (one entry, an `ssr` directory), and this file
 * holds both arms: the two real names are forgiven only with that structure,
 * and a real `mkdtemp` name is a leak however it is spelled.
 */

import { describe, expect, it } from 'vitest';

import { classifyTempDir, isViteSsrCache } from '../../test/scratch-guard.js';

/** The two names the gate block was refused over, verbatim. */
const MEASURED = ['YO29-KeKkywXSM-PaJY2D', 'l1lo6NkPoURdW_-sZIuFi'];

describe('the scratch guard forgives vitest\'s ssr/ cache and nothing else', () => {
  it('the measured names have mkdtemp\'s shape — which is why they were refused', () => {
    for (const name of MEASURED) {
      // With any other contents, the same name is a leak: the name alone
      // earns nothing.
      expect(classifyTempDir(name, [], false), name).toBe('leak');
      expect(classifyTempDir(name, ['something.txt'], false), name).toBe('leak');
    }
  });

  it('a directory whose only entry is an ssr/ DIRECTORY is the runner cache', () => {
    for (const name of MEASURED) {
      expect(classifyTempDir(name, ['ssr'], true), name).toBe('runner-cache');
    }
  });

  it('the structure is exact: a second entry, or ssr as a FILE, is still a leak', () => {
    expect(isViteSsrCache(['ssr', 'x'], true)).toBe(false);
    expect(isViteSsrCache(['ssr'], false)).toBe(false);
    expect(classifyTempDir('agent-deck-otel-a1B2c3', ['ssr', 'staged'], true)).toBe('leak');
  });

  it('this repository\'s own mkdtemp directories are leaks, as they always were', () => {
    for (const name of ['agent-deck-otel-a1B2c3', 'agent-deck-ext-Zz9Yy8', 'wire-test-q1w2e3']) {
      expect(classifyTempDir(name, [], false), name).toBe('leak');
    }
  });

  it('a name without mkdtemp\'s shape is foreign — reported, not gated — whatever it holds', () => {
    expect(classifyTempDir('tu5Erj6JcmIKvUD0JT-ZL', ['ssr'], true)).toBe('foreign');
    expect(classifyTempDir('vscode-typescript', [], false)).toBe('foreign');
  });
});
