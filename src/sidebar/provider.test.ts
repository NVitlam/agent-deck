/**
 * The sidebar controller — v0.7.0 Phase 4, DoD 4.6b, the host half.
 *
 * Same CSP, same bundle, zero network: the document the sidebar emits is
 * `webviewHtml` with the sidebar root and NOTHING else different, so every
 * policy assertion `html.test.ts` makes about the panel holds here by
 * identity — and this file asserts the identity rather than re-asserting the
 * policy. A click's `runCommand` executes the command; anything else the
 * guard admits is still dropped here, because the sidebar has one job.
 */

import { describe, expect, it } from 'vitest';

import { SIDEBAR_ROOT_ID, WEBVIEW_ROOT_ID } from '../bridge/contract.js';
import { contentSecurityPolicy, webviewHtml } from '../bridge/html.js';
import { WEBVIEW_SCRIPT_SEGMENTS, WEBVIEW_STYLE_SEGMENTS } from '../bridge/panel-assets.js';
import type { SettingsMessage } from '../model/events.js';
import { SIDEBAR_MENU } from './menu.js';
import { SidebarController } from './provider.js';
import type { SidebarSurface } from './provider.js';
import { TWEAK_SETTINGS } from './tweaks.js';

/** VS Code's measured desktop `cspSource` — see `test/vscode-mock.ts`. */
const CSP_SOURCE = "'self' https://*.vscode-cdn.net";

interface FakeView {
  surface: SidebarSurface;
  html: string;
  /** Every message the controller posted, in order. */
  posted: SettingsMessage[];
  fire(raw: unknown): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  subscriptions: number;
}

function fakeView(): FakeView {
  const messageHandlers = new Set<(raw: unknown) => void>();
  const visibilityHandlers = new Set<(visible: boolean) => void>();
  const disposeHandlers = new Set<() => void>();
  const posted: SettingsMessage[] = [];
  const view: FakeView = {
    html: '',
    posted,
    get subscriptions(): number {
      return messageHandlers.size + visibilityHandlers.size + disposeHandlers.size;
    },
    fire: (raw) => {
      for (const h of [...messageHandlers]) h(raw);
    },
    setVisible: (visible) => {
      for (const h of [...visibilityHandlers]) h(visible);
    },
    dispose: () => {
      for (const h of [...disposeHandlers]) h();
    },
    surface: {
      cspSource: CSP_SOURCE,
      setHtml: (html) => {
        view.html = html;
      },
      asWebviewUri: (...segments) => `webview://ext/${segments.join('/')}`,
      postMessage: (message) => {
        posted.push(message);
      },
      onDidReceiveMessage: (handler) => {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
      onDidChangeVisibility: (handler) => {
        visibilityHandlers.add(handler);
        return () => {
          visibilityHandlers.delete(handler);
        };
      },
      onDidDispose: (handler) => {
        disposeHandlers.add(handler);
        return () => {
          disposeHandlers.delete(handler);
        };
      },
    },
  };
  return view;
}

function controller(view: FakeView, executed: string[] = [], onError?: (e: unknown) => void): SidebarController {
  return new SidebarController({
    surface: view.surface,
    executeCommand: (command) => {
      executed.push(command);
      return undefined;
    },
    nonce: 'AAAAAAAA',
    ...(onError === undefined ? {} : { onError }),
  });
}

describe('the sidebar document', () => {
  it('is webviewHtml with the sidebar root: the same bundle, the same stylesheet', () => {
    const view = fakeView();
    controller(view);
    expect(view.html).toBe(
      webviewHtml({
        scriptUri: `webview://ext/${WEBVIEW_SCRIPT_SEGMENTS.join('/')}`,
        styleUri: `webview://ext/${WEBVIEW_STYLE_SEGMENTS.join('/')}`,
        nonce: 'AAAAAAAA',
        cspSource: CSP_SOURCE,
        rootId: SIDEBAR_ROOT_ID,
        title: 'Agent Deck',
      }),
    );
    expect(view.html).toContain(`<div id="${SIDEBAR_ROOT_ID}"></div>`);
    expect(view.html).not.toContain(`id="${WEBVIEW_ROOT_ID}"`);
    // ONE script, and it is the panel's: `dist/webview/main.js`.
    expect(view.html.match(/<script /g)).toHaveLength(1);
    expect(view.html).toContain(`src="webview://ext/${WEBVIEW_SCRIPT_SEGMENTS.join('/')}"`);
  });

  it('carries the SAME Content-Security-Policy as the panel, byte for byte', () => {
    const view = fakeView();
    controller(view);
    const policy = contentSecurityPolicy({ nonce: 'AAAAAAAA', cspSource: CSP_SOURCE });
    expect(view.html).toContain(`content="${policy}"`);
    // And that policy is the zero-network one: `html.test.ts` proves the
    // properties; this proves the sidebar did not get a different string.
    expect(policy.startsWith("default-src 'none'")).toBe(true);
    expect(policy).not.toContain('connect-src');
  });
});

describe('the sidebar boundary', () => {
  it('executes a runCommand naming a menu entry — every entry — and counts it', () => {
    const view = fakeView();
    const executed: string[] = [];
    const c = controller(view, executed);
    for (const entry of SIDEBAR_MENU) view.fire({ type: 'runCommand', command: entry.command });
    expect(executed).toStrictEqual(SIDEBAR_MENU.map((e) => e.command));
    expect(c.counters).toStrictEqual({
      messagesReceived: SIDEBAR_MENU.length,
      messagesDropped: 0,
      commandsExecuted: SIDEBAR_MENU.length,
      // v0.8.0 DoD 7.6 — a menu click writes no setting and posts nothing.
      tweakWrites: 0,
      settingsSent: 0,
    });
  });

  it('drops a runCommand naming anything off the menu, and every other message type', () => {
    const view = fakeView();
    const executed: string[] = [];
    const c = controller(view, executed);
    for (const hostile of [
      { type: 'runCommand', command: 'workbench.action.closeWindow' },
      { type: 'runCommand', command: 'agentDeck.open ' },
      { type: 'runCommand', command: '' },
      { type: 'runCommand' },
      // Well-formed for the PANEL, meaningless here.
      { type: 'selectSession', sessionId: 's1' },
      { type: 'expandNode', sessionId: 's1', nodeId: 'n1' },
      { type: 'resyncRequest', reason: 'x' },
      JSON.parse('{"type":"runCommand","command":"agentDeck.open","__proto__":{"x":1}}'),
      null,
      'agentDeck.open',
      /*
       * v0.8.0 DoD 7.6 — an `updateTweak` naming no tweak, or carrying a value
       * that tweak may not take. `isWebviewToHostMessage` refuses all of these
       * at the boundary, BEFORE the host would write into `settings.json`;
       * they are listed here so this file states what this surface drops as
       * well as what it acts on.
       */
      { type: 'updateTweak', key: 'telemetry.enabled', value: true },
      { type: 'updateTweak', key: 'followNewSessions', value: 'true' },
      { type: 'updateTweak', key: 'defaultOrdering', value: 'sideways' },
      { type: 'updateTweak', key: 'defaultOrdering', value: true },
      { type: 'updateTweak', key: 'followNewSessions' },
    ]) {
      view.fire(hostile);
    }
    expect(executed).toStrictEqual([]);
    expect(c.counters.messagesDropped).toBe(15);
    expect(c.counters.commandsExecuted).toBe(0);
    expect(c.counters.tweakWrites).toBe(0);
  });

  it('a command that throws, or rejects, reaches onError and never the host', async () => {
    const view = fakeView();
    const errors: unknown[] = [];
    new SidebarController({
      surface: view.surface,
      executeCommand: (command) => {
        if (command === 'agentDeck.open') throw new Error('boom');
        return Promise.reject(new Error('later'));
      },
      nonce: 'AAAAAAAA',
      onError: (e) => errors.push(e),
    });
    view.fire({ type: 'runCommand', command: 'agentDeck.open' });
    view.fire({ type: 'runCommand', command: 'agentDeck.openStats' });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => (e as Error).message)).toStrictEqual(['boom', 'later']);
  });

  it('disposes with the view, and drops its subscriptions', () => {
    const view = fakeView();
    const c = controller(view);
    // Three now: messages, visibility (DoD 7.6) and dispose.
    expect(view.subscriptions).toBe(3);
    view.dispose();
    expect(c.disposed).toBe(true);
    expect(view.subscriptions).toBe(0);
    c.dispose();
    expect(c.disposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 DoD 7.6 — the Tweaks tab's host half
// ---------------------------------------------------------------------------

/** A settings message carrying every tweak, with a value chosen per kind. */
function tweaksMessage(overrides: Record<string, boolean | string> = {}): Omit<SettingsMessage, 'type'> {
  const tweaks: Record<string, boolean | string> = {};
  for (const tweak of TWEAK_SETTINGS) {
    tweaks[tweak.key] = tweak.kind === 'boolean' ? true : (tweak.options?.[1] ?? '');
  }
  return { canvasAutoFit: true, tweaks: { ...tweaks, ...overrides } };
}

describe('the Tweaks tab, host half (DoD 7.6)', () => {
  it('posts nothing until it is told the settings, then posts exactly what it was told', () => {
    const view = fakeView();
    const c = controller(view);
    // A view that has been told nothing is told nothing: the host reads the
    // configuration and sends it, and there is no default manufactured here.
    expect(view.posted).toStrictEqual([]);
    expect(c.counters.settingsSent).toBe(0);

    const sent = tweaksMessage();
    c.setSettings(sent);
    expect(view.posted).toStrictEqual([{ type: 'settings', ...sent }]);
    expect(c.counters.settingsSent).toBe(1);
    // Every declared tweak is on the wire — a message carrying three of four
    // would leave one control drawing whatever the renderer's own default is.
    const posted = view.posted[0]?.tweaks ?? {};
    expect(Object.keys(posted).sort()).toStrictEqual(TWEAK_SETTINGS.map((x) => x.key).sort());
  });

  it('re-sends on becoming visible and not on being hidden: a re-shown view is a new document', () => {
    const view = fakeView();
    const c = controller(view);
    const sent = tweaksMessage();
    c.setSettings(sent);
    expect(view.posted).toHaveLength(1);

    view.setVisible(false);
    expect(view.posted, 'a hidden view was posted to').toHaveLength(1);
    view.setVisible(true);
    expect(view.posted).toStrictEqual([
      { type: 'settings', ...sent },
      { type: 'settings', ...sent },
    ]);
    expect(c.counters.settingsSent).toBe(2);
  });

  it('holds no state of its own: after a re-show the values equal the last settings, not the first', () => {
    /*
     * THE DoD'S OWN PROPERTY — "the panel holds no state of its own (test:
     * reload -> values equal settings)" — on the host side of the wire.
     *
     * The failure it rules out is a controller that remembered the FIRST
     * settings it was given and replayed them on every reload, which looks
     * identical to correct behaviour until a value changes.
     */
    const view = fakeView();
    const c = controller(view);
    c.setSettings(tweaksMessage({ followNewSessions: false }));
    c.setSettings(tweaksMessage({ followNewSessions: true }));
    view.setVisible(false);
    view.setVisible(true);
    expect(view.posted).toHaveLength(3);
    expect(view.posted.at(-1)?.tweaks.followNewSessions).toBe(true);
    // ...and the first message really did carry the other value, so the
    // assertion above is not comparing `true` with `true`.
    expect(view.posted[0]?.tweaks.followNewSessions).toBe(false);
  });

  it('an updateTweak the guard admits is handed on with its key and value, and counted', () => {
    const view = fakeView();
    const writes: { key: string; value: boolean | string }[] = [];
    const c = new SidebarController({
      surface: view.surface,
      executeCommand: () => undefined,
      onUpdateTweak: (key, value) => {
        writes.push({ key, value });
        return undefined;
      },
      nonce: 'AAAAAAAA',
    });

    // Every declared tweak, at a value of its own kind. `false` is included
    // deliberately: an "is the value there" read discards it, which is why the
    // boundary guard uses `ownDataProperty`.
    view.fire({ type: 'updateTweak', key: 'followNewSessions', value: false });
    view.fire({ type: 'updateTweak', key: 'openDrawerOnEnter', value: true });
    view.fire({ type: 'updateTweak', key: 'drawerExpandedByDefault', value: true });
    view.fire({ type: 'updateTweak', key: 'defaultOrdering', value: 'engine' });
    expect(writes).toStrictEqual([
      { key: 'followNewSessions', value: false },
      { key: 'openDrawerOnEnter', value: true },
      { key: 'drawerExpandedByDefault', value: true },
      { key: 'defaultOrdering', value: 'engine' },
    ]);
    expect(c.counters.tweakWrites).toBe(4);
    expect(c.counters.messagesDropped).toBe(0);

    // AND IT DOES NOT ECHO. The control moves when the next `settings` message
    // says so, never because this surface decided it had. Nothing was posted.
    expect(view.posted).toStrictEqual([]);
  });

  it('with no writer wired, an updateTweak is dropped rather than half-acted-on', () => {
    const view = fakeView();
    const c = controller(view);
    view.fire({ type: 'updateTweak', key: 'followNewSessions', value: true });
    expect(c.counters.tweakWrites).toBe(0);
    expect(c.counters.messagesDropped).toBe(1);
  });

  it('a write that throws, or rejects, reaches onError and never the host', async () => {
    const view = fakeView();
    const errors: unknown[] = [];
    const c = new SidebarController({
      surface: view.surface,
      executeCommand: () => undefined,
      onUpdateTweak: (key) => {
        if (key === 'followNewSessions') throw new Error('read-only settings file');
        return Promise.reject(new Error('later'));
      },
      nonce: 'AAAAAAAA',
      onError: (e) => errors.push(e),
    });
    view.fire({ type: 'updateTweak', key: 'followNewSessions', value: true });
    view.fire({ type: 'updateTweak', key: 'openDrawerOnEnter', value: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => (e as Error).message)).toStrictEqual([
      'read-only settings file',
      'later',
    ]);
    // A synchronous throw counts nothing — the write did not happen. The
    // rejecting one was issued, so it did.
    expect(c.counters.tweakWrites).toBe(1);
  });

  it('calls onDispose once, so a registry can drop it', () => {
    const view = fakeView();
    let disposals = 0;
    const c = new SidebarController({
      surface: view.surface,
      executeCommand: () => undefined,
      nonce: 'AAAAAAAA',
      onDispose: () => {
        disposals += 1;
      },
    });
    view.dispose();
    c.dispose();
    expect(disposals).toBe(1);
    // ...and a disposed controller posts nothing, however it is asked.
    c.setSettings(tweaksMessage());
    expect(view.posted).toStrictEqual([]);
  });
});
