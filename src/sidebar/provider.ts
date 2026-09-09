/**
 * The activity-bar sidebar — v0.7.0 Phase 4, DoD 4.6b (spec §G2).
 *
 * One `webviewView` under the Agent Deck activity-bar icon, rendering the
 * command menu `src/sidebar/menu.ts` declares. It is the product's
 * discoverable front door; the panel remains the room.
 *
 * SAME BUNDLE, SAME CSP, ZERO NETWORK. The sidebar's document is
 * `webviewHtml(...)` with the SIDEBAR root id and nothing else different — the
 * same script, the same stylesheet, the same policy the panel gets, byte for
 * byte. There is no second bundle and no second CSP anywhere in this file; the
 * bundle mounts the menu instead of the app because of which root it finds.
 *
 * NO `vscode` IMPORT, on the `PanelController` precedent: the editor surface
 * arrives as a port ({@link SidebarSurface}) and the command runner as a
 * function, so the whole controller is testable in a node suite and
 * `src/extension.ts` adapts the real `WebviewView` in one place.
 *
 * THE INBOUND BOUNDARY is `isWebviewToHostMessage`, exactly as for the panel,
 * and then one more question: is the command one of the menu's? The guard
 * already answers it for a `runCommand` message, so what this class adds is
 * refusing every OTHER valid message type — an `expandNode` arriving from the
 * sidebar is well-formed and meaningless here, and meaningless is dropped.
 *
 * G1: writes nothing. G5: the document it emits forbids every connection.
 */

import { createNonce, webviewHtml } from '../bridge/html.js';
import { SIDEBAR_ROOT_ID } from '../bridge/contract.js';
import { isWebviewToHostMessage } from '../bridge/messages.js';
import { WEBVIEW_SCRIPT_SEGMENTS, WEBVIEW_STYLE_SEGMENTS } from '../bridge/panel-assets.js';
import { isSidebarCommand } from './menu.js';

type Unsubscribe = () => void;

/** The slice of a `vscode.WebviewView` the sidebar needs. */
export interface SidebarSurface {
  readonly cspSource: string;
  setHtml(html: string): void;
  /** `webview.asWebviewUri(Uri.joinPath(extensionUri, ...segments))`, stringified. */
  asWebviewUri(...segments: string[]): string;
  onDidReceiveMessage(handler: (raw: unknown) => void): Unsubscribe;
  onDidDispose(handler: () => void): Unsubscribe;
}

export interface SidebarControllerOptions {
  surface: SidebarSurface;
  /** Runs a command id. `vscode.commands.executeCommand` in production. */
  executeCommand: (command: string) => unknown;
  /** Injected so a test can assert the exact document. */
  nonce?: string;
  /** Receives a throw out of `executeCommand`. Never re-thrown. */
  onError?: (error: unknown) => void;
}

export interface SidebarCounters {
  messagesReceived: number;
  messagesDropped: number;
  commandsExecuted: number;
}

export class SidebarController {
  readonly #surface: SidebarSurface;
  readonly #executeCommand: (command: string) => unknown;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #subscriptions: Unsubscribe[] = [];
  readonly #counts: SidebarCounters = { messagesReceived: 0, messagesDropped: 0, commandsExecuted: 0 };
  #disposed = false;

  constructor(options: SidebarControllerOptions) {
    this.#surface = options.surface;
    this.#executeCommand = options.executeCommand;
    this.#onError = options.onError;

    this.#surface.setHtml(
      webviewHtml({
        scriptUri: this.#surface.asWebviewUri(...WEBVIEW_SCRIPT_SEGMENTS),
        styleUri: this.#surface.asWebviewUri(...WEBVIEW_STYLE_SEGMENTS),
        nonce: options.nonce ?? createNonce(),
        cspSource: this.#surface.cspSource,
        rootId: SIDEBAR_ROOT_ID,
        title: 'Agent Deck',
      }),
    );

    this.#subscriptions.push(
      this.#surface.onDidReceiveMessage((raw: unknown) => {
        this.#receive(raw);
      }),
      this.#surface.onDidDispose(() => {
        this.dispose();
      }),
    );
  }

  get counters(): SidebarCounters {
    return { ...this.#counts };
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsubscribe of this.#subscriptions.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // A disposed subscription that throws must not block the rest.
      }
    }
  }

  #receive(raw: unknown): void {
    this.#counts.messagesReceived += 1;
    // The guard first, then the narrower question. `isWebviewToHostMessage`
    // has already checked that a `runCommand`'s command is on the menu; the
    // second `isSidebarCommand` call is the belt to that brace, and it is what
    // a test mutates to prove the sidebar cannot run an off-menu id.
    if (!isWebviewToHostMessage(raw) || raw.type !== 'runCommand' || !isSidebarCommand(raw.command)) {
      this.#counts.messagesDropped += 1;
      return;
    }
    try {
      const result = this.#executeCommand(raw.command);
      this.#counts.commandsExecuted += 1;
      // A thenable that rejects must not become an unhandled rejection in the
      // extension host; the error path is the same as a synchronous throw.
      if (result !== null && typeof result === 'object' && 'then' in result) {
        (result as PromiseLike<unknown>).then(undefined, (error: unknown) => {
          this.#onError?.(error);
        });
      }
    } catch (error) {
      this.#onError?.(error);
    }
  }
}
