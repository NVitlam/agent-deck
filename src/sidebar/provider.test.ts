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
import { SIDEBAR_MENU } from './menu.js';
import { SidebarController } from './provider.js';
import type { SidebarSurface } from './provider.js';

/** VS Code's measured desktop `cspSource` — see `test/vscode-mock.ts`. */
const CSP_SOURCE = "'self' https://*.vscode-cdn.net";

interface FakeView {
  surface: SidebarSurface;
  html: string;
  fire(raw: unknown): void;
  dispose(): void;
  subscriptions: number;
}

function fakeView(): FakeView {
  const messageHandlers = new Set<(raw: unknown) => void>();
  const disposeHandlers = new Set<() => void>();
  const view: FakeView = {
    html: '',
    get subscriptions(): number {
      return messageHandlers.size + disposeHandlers.size;
    },
    fire: (raw) => {
      for (const h of [...messageHandlers]) h(raw);
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
      onDidReceiveMessage: (handler) => {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
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
    ]) {
      view.fire(hostile);
    }
    expect(executed).toStrictEqual([]);
    expect(c.counters.messagesDropped).toBe(10);
    expect(c.counters.commandsExecuted).toBe(0);
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
    expect(view.subscriptions).toBe(2);
    view.dispose();
    expect(c.disposed).toBe(true);
    expect(view.subscriptions).toBe(0);
    c.dispose();
    expect(c.disposed).toBe(true);
  });
});
