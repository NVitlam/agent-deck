/**
 * `invokeInsights` — v0.9.0 DoD 9.25.
 *
 * The own-eyes defect was SILENCE: Open Insights did nothing and said
 * nothing. So every test here asserts two things about each path — what
 * happened, and what the user and the log were told — and the order of the
 * calls where the order is the claim (activate BEFORE execute).
 *
 * The same behaviour is driven end to end through `activate()` in
 * `extension.test.ts`, against Insights 0.1.0's recorded manifest.
 */

import { describe, expect, it } from 'vitest';

import type { InsightsExtensionRecord, InsightsInvokeDeps } from './insights-invoke.js';
import { contributedCommands, invokeInsights } from './insights-invoke.js';

interface Harness {
  deps: InsightsInvokeDeps;
  calls: string[];
  messages: string[];
  log: string[];
}

function harness(
  extension: InsightsExtensionRecord | undefined,
  execute: (command: string) => Promise<unknown> = () => Promise.resolve(undefined),
): Harness {
  const calls: string[] = [];
  const messages: string[] = [];
  const log: string[] = [];
  return {
    calls,
    messages,
    log,
    deps: {
      getExtension: () => extension,
      executeCommand: (command) => {
        calls.push(`execute ${command}`);
        return execute(command);
      },
      showInformationMessage: (message) => {
        messages.push(message);
      },
      log: (line) => {
        log.push(line);
      },
    },
  };
}

function record(options: {
  active?: boolean;
  commands?: string[];
  activate?: () => Promise<unknown>;
  calls?: string[];
  packageJSON?: unknown;
}): InsightsExtensionRecord {
  return {
    isActive: options.active ?? false,
    // `in`, not `??`: a test passing `packageJSON: null` means an unreadable
    // manifest, and `??` would quietly replace it with a readable one.
    packageJSON: 'packageJSON' in options ? options.packageJSON : {
      version: '0.1.0',
      contributes: { commands: (options.commands ?? []).map((command) => ({ command })) },
    },
    activate: () => {
      options.calls?.push('activate');
      return options.activate?.() ?? Promise.resolve();
    },
  };
}

describe('invokeInsights', () => {
  it('activates an INACTIVE extension before running the command', async () => {
    const calls: string[] = [];
    const h = harness(record({ commands: ['x.run'], calls }));
    // Share one call log so the ORDER is observable.
    const executed = h.deps.executeCommand;
    h.deps.executeCommand = (command) => {
      calls.push(`execute ${command}`);
      return executed(command);
    };

    expect(await invokeInsights('x.run', h.deps)).toStrictEqual({ kind: 'ran' });
    expect(calls).toStrictEqual(['activate', 'execute x.run']);
    expect(h.messages).toStrictEqual([]);
    expect(h.log).toStrictEqual([
      'insights x.run: activated Agent Deck Insights 0.1.0',
      'insights x.run: ran on Agent Deck Insights 0.1.0, returned nothing',
    ]);
  });

  it('does not activate an extension that is already active', async () => {
    const calls: string[] = [];
    const h = harness(record({ active: true, commands: ['x.run'], calls }));
    await invokeInsights('x.run', h.deps);
    expect(calls).toStrictEqual([]);
    expect(h.calls).toStrictEqual(['execute x.run']);
  });

  it('a REJECTED command becomes a message naming it — the own-eyes defect', async () => {
    /*
     * THE MUTATION THIS KILLS: swallowing the rejection, i.e. the shipped
     * `void executeCommand(id)`. Any version that drops the `catch` arm's
     * message leaves `messages` empty and this red.
     */
    const h = harness(record({ commands: ['x.run'] }), () =>
      Promise.reject(new Error("command 'x.open' not found")),
    );
    expect(await invokeInsights('x.open', h.deps)).toStrictEqual({
      kind: 'command-failed',
      contributed: false,
      error: "command 'x.open' not found",
    });
    expect(h.messages).toStrictEqual([
      'Agent Deck Insights 0.1.0 has no command x.open, so it was not run.',
    ]);
    expect(h.log).toContain(
      "insights x.open: failed on Agent Deck Insights 0.1.0 (manifest contributes it: no): command 'x.open' not found",
    );
  });

  it('a contributed command that throws is reported with its own error', async () => {
    const h = harness(record({ commands: ['x.run'] }), () => Promise.reject(new Error('boom')));
    const outcome = await invokeInsights('x.run', h.deps);
    expect(outcome).toStrictEqual({ kind: 'command-failed', contributed: true, error: 'boom' });
    expect(h.messages).toStrictEqual(['Agent Deck Insights 0.1.0 could not run x.run: boom']);
  });

  it('an unreadable manifest says less rather than guessing "not contributed"', async () => {
    const h = harness(record({ packageJSON: null }), () => Promise.reject('plain string'));
    const outcome = await invokeInsights('x.run', h.deps);
    expect(outcome).toStrictEqual({
      kind: 'command-failed',
      contributed: null,
      error: 'plain string',
    });
    expect(h.messages).toStrictEqual(['Agent Deck Insights could not run x.run: plain string']);
    expect(h.log.at(-1)).toContain('(manifest contributes it: unknown)');
  });

  it('a failed activation is named, and the command is never run', async () => {
    const h = harness(record({ activate: () => Promise.reject(new Error('nope')) }));
    expect(await invokeInsights('x.run', h.deps)).toStrictEqual({
      kind: 'activation-failed',
      error: 'nope',
    });
    expect(h.calls).toStrictEqual([]);
    expect(h.messages).toStrictEqual([
      'Agent Deck Insights 0.1.0 failed to activate, so x.run was not run: nope',
    ]);
  });

  it('not installed — including a probe that throws — is named, and nothing runs', async () => {
    for (const getExtension of [
      () => undefined,
      () => {
        throw new Error('editor refused');
      },
    ]) {
      const h = harness(undefined);
      h.deps.getExtension = getExtension;
      expect(await invokeInsights('x.run', h.deps)).toStrictEqual({ kind: 'not-installed' });
      expect(h.calls).toStrictEqual([]);
      expect(h.messages).toStrictEqual([
        'Agent Deck Insights is not installed, so x.run was not run.',
      ]);
      expect(h.log).toStrictEqual(['insights x.run: not run, Agent Deck Insights is not installed']);
    }
  });

  it('EVERY path leaves a log line, and every path that did not run leaves a message', async () => {
    const shapes: [InsightsExtensionRecord | undefined, () => Promise<unknown>][] = [
      [undefined, () => Promise.resolve(undefined)],
      [record({ activate: () => Promise.reject(new Error('a')) }), () => Promise.resolve(undefined)],
      [record({ commands: ['x.run'] }), () => Promise.reject(new Error('b'))],
      [record({ commands: ['x.run'] }), () => Promise.resolve(42)],
    ];
    for (const [extension, execute] of shapes) {
      const h = harness(extension, execute);
      const outcome = await invokeInsights('x.run', h.deps);
      expect(h.log.length, outcome.kind).toBeGreaterThan(0);
      expect(h.messages.length, outcome.kind).toBe(outcome.kind === 'ran' ? 0 : 1);
    }
  });
});

describe('contributedCommands', () => {
  it('reads contributes.commands, and says null when it cannot', () => {
    expect(
      contributedCommands({
        contributes: { commands: [{ command: 'a' }, { command: 'b' }, { title: 'no id' }, 7] },
      }),
    ).toStrictEqual(['a', 'b']);
    for (const unreadable of [null, undefined, 'x', {}, { contributes: {} }, { contributes: { commands: 'a' } }]) {
      expect(contributedCommands(unreadable), JSON.stringify(unreadable)).toBeNull();
    }
    expect(contributedCommands({ contributes: { commands: [] } })).toStrictEqual([]);
  });
});
