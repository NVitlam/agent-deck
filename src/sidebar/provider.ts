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
 * and then one more question: is the message one this surface acts on? The
 * guard already answers the narrow questions — a `runCommand`'s command is on
 * the menu, an `updateTweak`'s key and value are a tweak's — so what this
 * class adds is refusing every OTHER valid message type: an `expandNode`
 * arriving from the sidebar is well-formed and meaningless here, and
 * meaningless is dropped.
 *
 * ---------------------------------------------------------------------------
 * THE TWEAKS TAB: THE SETTINGS ARE THE STATE, THIS IS A RENDERER (DoD 7.6)
 * ---------------------------------------------------------------------------
 *
 * Two directions, and neither keeps a value here:
 *
 *   - OUT, {@link SidebarController.setSettings}: the host reads
 *     `workspace.getConfiguration()` and sends what it read. Sent when the
 *     view is created, again whenever it becomes visible — a hidden
 *     `WebviewView` is torn down by default, so what comes back is a NEW
 *     document that knows nothing, the same reason `PanelController` re-sends
 *     on `onDidBecomeVisible` — and again on every configuration change.
 *   - IN, `updateTweak`: the controller hands the key and value to
 *     {@link SidebarControllerOptions.onUpdateTweak}, which calls
 *     `WorkspaceConfiguration.update`. It does NOT echo the value back, and
 *     that is the decision rather than an omission: the write moves the
 *     configuration, the configuration change fires, and the next
 *     `setSettings` is what moves the control. A control that moved itself
 *     first would show the user a position `settings.json` might disagree
 *     with — which is exactly what happens when a workspace override wins, or
 *     when the write fails.
 *
 * The LAST settings message is remembered here so a re-shown view can be told
 * again without the host being asked. That is a cache of what was SENT, never
 * a source: nothing reads it to answer a question about a setting.
 *
 * G1: this file writes nothing. The one write in the tweaks path is
 * `WorkspaceConfiguration.update` in `src/extension.ts`, into the user's own
 * settings, at the user's click — never into `~/.claude`, a Codex root or an
 * OpenCode store. G5: the document it emits forbids every connection.
 */

import { createNonce, webviewHtml } from '../bridge/html.js';
import { SIDEBAR_ROOT_ID } from '../bridge/contract.js';
import { isWebviewToHostMessage } from '../bridge/messages.js';
import { WEBVIEW_SCRIPT_SEGMENTS, WEBVIEW_STYLE_SEGMENTS } from '../bridge/panel-assets.js';
import type { SettingsMessage } from '../model/events.js';
import { isSidebarCommand } from './menu.js';

type Unsubscribe = () => void;

/** The slice of a `vscode.WebviewView` the sidebar needs. */
export interface SidebarSurface {
  readonly cspSource: string;
  setHtml(html: string): void;
  /** `webview.asWebviewUri(Uri.joinPath(extensionUri, ...segments))`, stringified. */
  asWebviewUri(...segments: string[]): string;
  /**
   * `webview.postMessage`. Typed as {@link SettingsMessage} and NOT as
   * `HostToWebviewMessage` (v0.8.0 DoD 7.6): the sidebar is a menu and a
   * settings panel, never a second deck, and the narrow type is what stops it
   * quietly becoming one. The deck's snapshot/diff channel is
   * `PanelController`'s and stays there.
   */
  postMessage(message: SettingsMessage): void;
  onDidReceiveMessage(handler: (raw: unknown) => void): Unsubscribe;
  /**
   * `view.onDidChangeVisibility`, with the view's `visible` at that moment.
   *
   * A `WebviewView` is torn down when hidden (`retainContextWhenHidden` is
   * false by default), so becoming visible again means a NEW document that
   * knows nothing — the panel's recorded reason for re-sending its settings
   * on `onDidBecomeVisible`, reaching the sidebar through the other API.
   */
  onDidChangeVisibility(handler: (visible: boolean) => void): Unsubscribe;
  onDidDispose(handler: () => void): Unsubscribe;
}

export interface SidebarControllerOptions {
  surface: SidebarSurface;
  /** Runs a command id. `vscode.commands.executeCommand` in production. */
  executeCommand: (command: string) => unknown;
  /**
   * Write one tweak (v0.8.0 DoD 7.6). `WorkspaceConfiguration.update` in
   * production, and the ONE write in this path.
   *
   * Called only after `isWebviewToHostMessage` has confirmed the key names a
   * tweak and the value is one that tweak may take, because the next thing
   * that happens is a write into the user's `settings.json`. Absent, an
   * `updateTweak` is counted and dropped like any other message this surface
   * does not act on.
   */
  onUpdateTweak?: (key: string, value: boolean | string) => unknown;
  /** Injected so a test can assert the exact document. */
  nonce?: string;
  /** Receives a throw out of `executeCommand` or `onUpdateTweak`. Never re-thrown. */
  onError?: (error: unknown) => void;
  /** Called once when this controller disposes, so a registry can drop it. */
  onDispose?: () => void;
}

export interface SidebarCounters {
  messagesReceived: number;
  messagesDropped: number;
  commandsExecuted: number;
  /** `updateTweak` messages handed to `onUpdateTweak` (v0.8.0 DoD 7.6). */
  tweakWrites: number;
  /** `settings` messages posted to the view: on create, on re-show, on change. */
  settingsSent: number;
}

export class SidebarController {
  readonly #surface: SidebarSurface;
  readonly #executeCommand: (command: string) => unknown;
  readonly #onUpdateTweak: ((key: string, value: boolean | string) => unknown) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onDispose: (() => void) | undefined;
  readonly #subscriptions: Unsubscribe[] = [];
  readonly #counts: SidebarCounters = {
    messagesReceived: 0,
    messagesDropped: 0,
    commandsExecuted: 0,
    tweakWrites: 0,
    settingsSent: 0,
  };
  /**
   * The last settings message SENT, re-sent when the view becomes visible
   * again (DoD 7.6) — `PanelController.#settings`'s reason, verbatim: a
   * re-shown `WebviewView` is a new document that knows nothing.
   *
   * A record of what left, never a source. Nothing in this file reads a value
   * out of it to answer a question about a setting; the settings are the
   * state and the host reads them.
   */
  #settings: SettingsMessage | null = null;
  #disposed = false;

  constructor(options: SidebarControllerOptions) {
    this.#surface = options.surface;
    this.#executeCommand = options.executeCommand;
    this.#onUpdateTweak = options.onUpdateTweak;
    this.#onError = options.onError;
    this.#onDispose = options.onDispose;

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
      // DoD 7.6. Only on becoming VISIBLE: a view being hidden has nothing to
      // be told, and posting to a torn-down document is a message nobody
      // reads.
      this.#surface.onDidChangeVisibility((visible: boolean) => {
        if (visible) this.#sendSettings();
      }),
      this.#surface.onDidDispose(() => {
        this.dispose();
      }),
    );
  }

  /**
   * Tell the view the host settings it draws (DoD 7.6).
   *
   * Unconditional: no no-nagging rule, for the reason `PanelController`
   * states for its own — this is one small message, and a rule about when to
   * skip it costs more than it saves.
   */
  setSettings(settings: Omit<SettingsMessage, 'type'>): void {
    if (this.#disposed) return;
    this.#settings = { type: 'settings', ...settings };
    this.#sendSettings();
  }

  /** Post the remembered settings, if any. The one place they go out. */
  #sendSettings(): void {
    if (this.#disposed || this.#settings === null) return;
    this.#counts.settingsSent += 1;
    this.#surface.postMessage(this.#settings);
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
    this.#onDispose?.();
  }

  #receive(raw: unknown): void {
    this.#counts.messagesReceived += 1;
    if (!isWebviewToHostMessage(raw)) {
      this.#counts.messagesDropped += 1;
      return;
    }
    // TWO message types reach this surface and everything else is dropped. An
    // `expandNode` from the sidebar is well-formed and meaningless here.
    if (raw.type === 'updateTweak') {
      // `isWebviewToHostMessage` has already checked `key` against
      // `isTweakKey` and `value` against `isTweakValue`, at the boundary,
      // because the next act is a write into the user's settings. With no
      // writer wired, the message is dropped rather than half-acted-on.
      if (this.#onUpdateTweak === undefined) {
        this.#counts.messagesDropped += 1;
        return;
      }
      this.#run(
        () => this.#onUpdateTweak?.(raw.key, raw.value),
        () => {
          this.#counts.tweakWrites += 1;
        },
      );
      return;
    }
    // The guard has already checked that a `runCommand`'s command is on the
    // menu, so the second `isSidebarCommand` call is SHADOWED by the guard and
    // no test can turn it red on its own — `phase-verifier` measured exactly
    // that (2026-09-09). It stays as belt to the guard's brace, stated as
    // such: if the guard ever widens, this line is the one that still refuses.
    if (raw.type !== 'runCommand' || !isSidebarCommand(raw.command)) {
      this.#counts.messagesDropped += 1;
      return;
    }
    this.#run(
      () => this.#executeCommand(raw.command),
      () => {
        this.#counts.commandsExecuted += 1;
      },
    );
  }

  /**
   * Run `work`; on a synchronous throw report it and count nothing.
   *
   * `onDone` runs only when the call returned, which is what makes each
   * counter mean "this was carried out" rather than "this was attempted". A
   * thenable that rejects afterwards is reported too: an unhandled rejection
   * in the extension host is the failure mode this catches, and
   * `WorkspaceConfiguration.update` returns exactly such a thenable, so the
   * settings write is covered by the same three lines as a command.
   */
  #run(work: () => unknown, onDone: () => void): void {
    let result: unknown;
    try {
      result = work();
    } catch (error) {
      this.#onError?.(error);
      return;
    }
    onDone();
    if (result !== null && typeof result === 'object' && 'then' in result) {
      (result as PromiseLike<unknown>).then(undefined, (error: unknown) => {
        this.#onError?.(error);
      });
    }
  }
}
