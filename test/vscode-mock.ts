/**
 * A `vscode` test double.
 *
 * There is no `vscode` module outside the extension host — VS Code injects it
 * at runtime — so `src/extension.ts`'s top-level `import * as vscode from
 * 'vscode'` cannot resolve in a node test process. `vitest.config.ts` therefore
 * aliases the specifier to this file. That alias is the ONLY change this
 * package made to the vitest config.
 *
 * Two things this file is not:
 *
 *   - It is not a second implementation of anything. Every unit of behaviour
 *     worth testing lives in `AgentDeckDataPath`, `PanelController` and
 *     `AgentDeckHost`, which take injected seams and never import `vscode`.
 *     This double exists so `activate()` and `deactivate()` — the two functions
 *     that unavoidably do touch the editor API — can be driven at all.
 *   - It is not type-checked against `@types/vscode`. Production code compiles
 *     against the REAL types (`npm run typecheck` proves that); this file is
 *     the runtime stand-in, and asserting structural identity with the whole
 *     editor API would be a large lie for no coverage. The residual risk — that
 *     the real API and this double diverge — is what the "VSIX side-loads and
 *     runs" DoD item covers, and that item needs a human.
 *
 * All state is module-level and must be reset between tests with
 * {@link resetVscodeMock}.
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

/** A path-only stand-in for `vscode.Uri`. Enough for `joinPath` and `fsPath`. */
export class Uri {
  readonly scheme: string;
  readonly fsPath: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.fsPath, ...segments].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, joined);
  }

  /**
   * `vscode.Uri.parse` — v0.9.0 DoD 9.7.
   *
   * Keeps the WHOLE string rather than splitting it into scheme and path,
   * because `toString()` is what a test asserts about an opened link, and a
   * lossy round trip would make that assertion about this mock rather than
   * about the url. `parsed` carries the original; `toString` returns it.
   */
  static parse(value: string): Uri {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1] ?? 'file';
    const uri = new Uri(scheme, value);
    uri.#parsed = value;
    return uri;
  }

  /** Set only by {@link Uri.parse}; see the note there. */
  #parsed: string | undefined;

  toString(): string {
    // A parsed url is returned verbatim — see {@link Uri.parse}.
    return this.#parsed ?? `${this.scheme}://${this.fsPath}`;
  }
}

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
} as const;

/**
 * `vscode.ConfigurationTarget`, with VS Code's own numbering (v0.8.0 DoD 7.6).
 *
 * The NUMBERS matter and are not arbitrary: `update`'s third argument is
 * recorded and asserted, so a double that numbered them differently would let
 * a test pass while production wrote a setting into the wrong file.
 */
export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

// ---------------------------------------------------------------------------
// Webview view (the sidebar) — v0.7.0 Phase 4, DoD 4.6b
// ---------------------------------------------------------------------------

/** The slice of `vscode.WebviewView` the sidebar controller reaches for. */
export class MockWebviewView {
  readonly viewType: string;
  readonly webview: MockWebview;
  disposed = false;
  /**
   * `vscode.WebviewView.visible`. A resolved view starts visible — VS Code
   * resolves it when the container is opened.
   */
  visible = true;

  readonly #inbound = new Emitter<unknown>();
  readonly #visibility = new Emitter<void>();
  readonly #onDispose = new Emitter<void>();
  readonly #posted: unknown[] = [];

  constructor(viewType: string) {
    this.viewType = viewType;
    const posted = this.#posted;
    const inbound = this.#inbound;
    this.webview = {
      html: '',
      options: undefined,
      // The same measured desktop value the panel carries — one VS Code, one
      // `cspSource`. See `MockWebviewPanel`.
      cspSource: "'self' https://*.vscode-cdn.net",
      asWebviewUri: (uri: Uri) => uri,
      postMessage: (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener: (raw: unknown) => void) => inbound.event(listener),
      posted,
    };
  }

  /** `vscode.WebviewView.onDidChangeVisibility` — fires with no argument. */
  onDidChangeVisibility(listener: () => void): MockDisposable {
    return this.#visibility.event(() => {
      listener();
    });
  }

  onDidDispose(listener: () => void): MockDisposable {
    return this.#onDispose.event(() => {
      listener();
    });
  }

  /** Deliver a raw message as if the sidebar had posted it. */
  fireMessage(raw: unknown): void {
    this.#inbound.fire(raw);
  }

  /**
   * Hide or re-show the view (v0.8.0 DoD 7.6).
   *
   * Moves `visible` and THEN fires, which is the order the real API has and
   * the order the whole check depends on: the controller reads `view.visible`
   * inside the handler, so a mock that fired first would let a re-send land on
   * a view still marked hidden.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.#visibility.fire(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#onDispose.fire(undefined);
  }
}

// ---------------------------------------------------------------------------
// Disposables and events
// ---------------------------------------------------------------------------

export interface MockDisposable {
  dispose(): void;
}

class Emitter<T> {
  readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): MockDisposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

// ---------------------------------------------------------------------------
// Webview panel
// ---------------------------------------------------------------------------

export interface MockWebview {
  html: string;
  options: unknown;
  cspSource: string;
  asWebviewUri(uri: Uri): Uri;
  postMessage(message: unknown): Promise<boolean>;
  onDidReceiveMessage(listener: (raw: unknown) => void): MockDisposable;
  /** Everything the host posted, in order. */
  readonly posted: unknown[];
}

export class MockWebviewPanel {
  readonly viewType: string;
  readonly title: string;
  visible = true;
  disposed = false;
  revealCount = 0;

  readonly webview: MockWebview;

  readonly #inbound = new Emitter<unknown>();
  readonly #viewState = new Emitter<{ webviewPanel: MockWebviewPanel }>();
  readonly #onDispose = new Emitter<void>();
  readonly #posted: unknown[] = [];

  constructor(viewType: string, title: string, options: unknown) {
    this.viewType = viewType;
    this.title = title;
    const posted = this.#posted;
    const inbound = this.#inbound;
    this.webview = {
      html: '',
      options,
      // VS Code's ACTUAL desktop `webview.cspSource`, byte for byte. Read from
      // the installed VS Code 1.134.0 (commit
      // 110a328ea54b42367b803ec53ee0bf52ef26b419),
      // resources/app/out/vs/workbench/api/node/extensionHostProcess.js:
      //   const BASE = `'self' https://*.vscode-cdn.net`;
      //   get cspSource() { ...http/https extensionLocation prefix...; return BASE }
      // The value that stood here before — 'vscode-resource://agent-deck-test'
      // — was invented, and that is why the suite was green while the panel
      // could not open: src/bridge/html.ts refused the real string. Re-measure
      // from that file; do not re-invent.
      cspSource: "'self' https://*.vscode-cdn.net",
      asWebviewUri: (uri: Uri) => uri,
      postMessage: (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener: (raw: unknown) => void) => inbound.event(listener),
      posted,
    };
  }

  onDidReceiveMessage(listener: (raw: unknown) => void): MockDisposable {
    return this.#inbound.event(listener);
  }

  onDidChangeViewState(
    listener: (event: { webviewPanel: MockWebviewPanel }) => void,
  ): MockDisposable {
    return this.#viewState.event(listener);
  }

  onDidDispose(listener: () => void): MockDisposable {
    return this.#onDispose.event(() => {
      listener();
    });
  }

  reveal(): void {
    this.revealCount += 1;
    this.visible = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#onDispose.fire(undefined);
  }

  // ---- test drivers -------------------------------------------------------

  /** Deliver a raw message as if the webview had posted it. */
  fireMessage(raw: unknown): void {
    this.#inbound.fire(raw);
  }

  /** Simulate VS Code hiding and restoring the panel (the bundle re-runs). */
  fireViewStateChange(visible: boolean): void {
    this.visible = visible;
    this.#viewState.fire({ webviewPanel: this });
  }

  get subscriberCount(): number {
    return (
      this.#inbound.listeners.size +
      this.#viewState.listeners.size +
      this.#onDispose.listeners.size
    );
  }
}

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

interface MockState {
  workspaceFolders: { uri: Uri; name: string; index: number }[] | undefined;
  configuration: Map<string, Map<string, unknown>>;
  commands: Map<string, (...args: unknown[]) => unknown>;
  /** Extension ids this fake editor has installed (DoD 9.6). */
  extensions: Set<string>;
  /**
   * What an installed extension's record carries — DoD 9.25.
   *
   * The real `vscode.Extension` has a manifest and an activation state, and
   * "Open Insights did nothing" was a question about both: which commands the
   * manifest contributes, and whether the extension was active when the
   * parent ran one. An installed id with no entry here gets
   * {@link DEFAULT_EXTENSION_MANIFEST}.
   */
  extensionManifests: Map<string, MockExtensionManifest>;
  /** Ids whose record reports `isActive: true`. */
  activeExtensions: Set<string>;
  /**
   * Every `showInformationMessage` call, with the buttons it offered (DoD
   * 9.23). The BUTTONS are recorded because "a message was shown" and "the
   * user was asked" are different claims, and only the second is the one the
   * About confirmation makes.
   */
  informationPrompts: { message: string; items: string[]; modal: boolean }[];
  /** Every line written to any output channel, with the channel's name. */
  outputLines: { channel: string; line: string }[];
  /** The name of every `createOutputChannel` call, in order. */
  outputChannelsCreated: string[];
  /** The name of every output channel `dispose()`d, in order. */
  outputChannelsDisposed: string[];
  /** Every URI handed to `env.openExternal`, in order (DoD 9.7). */
  openedExternal: string[];
  /**
   * Every UNTITLED document opened with content, and whether it was then
   * SHOWN (v0.9.0 DoD 9.40). Both, because "a document was made" and "the
   * user sees it" are two claims, and the raw-output action makes the second.
   */
  openedDocuments: { content: string; language: string | undefined; shown: boolean }[];
  /** When set, the next `openTextDocument` rejects (verifier round 9.43, W2). */
  openTextDocumentFails: boolean;
  /** What the next modal returns, as if the user had pressed it (DoD 9.7). */
  modalAnswer: string | undefined;
  panels: MockWebviewPanel[];
  /**
   * Every `createWebviewPanel` call's `viewColumn`, in order (v0.7.0 DoD
   * 4.6c). Recorded rather than ignored: "the deck opens in `ViewColumn.One`"
   * is a claim about this argument and nothing else the panel carries.
   */
  panelColumns: number[];
  /**
   * Every `commands.executeCommand` call, in order, with its arguments
   * (v0.7.0 DoD 4.6b/4.6c). The workbench commands this extension runs —
   * `workbench.action.evenEditorWidths`, `workbench.action.openSettings` —
   * exist only in the editor, so what a test can assert is that they were
   * ASKED FOR, which is exactly what the DoD says.
   */
  executed: { command: string; args: unknown[] }[];
  /** The providers `registerWebviewViewProvider` was given, by view id. */
  viewProviders: Map<string, { resolveWebviewView(view: MockWebviewView): void }>;
  /** The tree views `createTreeView` was given, by view id (DoD 9.14). */
  treeViews: Map<string, MockTreeView<unknown>>;
  /** Every `showQuickPick` call, in order, with the items it offered. */
  quickPicks: { items: string[]; placeHolder: string | undefined }[];
  /** What the next `showQuickPick` returns, when it is one of the items. */
  quickPickAnswer: string | undefined;
  /** What `window.tabGroups.all.length` reports. Default one group. */
  editorGroups: number;
  errorMessages: string[];
  informationMessages: string[];
  /**
   * Every modal warning shown, with the buttons it offered (v0.7.0 DoD 3.5).
   *
   * The OPTIONS are recorded and not just the message, because
   * `showWarningMessage` is only a confirmation dialog when it is passed
   * `{ modal: true }`: without it VS Code shows a dismissable notification
   * toast, which a user can miss entirely and which returns `undefined` the
   * moment it times out. A test that asserted only the text would pass on a
   * toast that silently declined to delete anything — and, worse, would pass
   * identically on one that deleted without asking.
   */
  warningMessages: { message: string; modal: boolean; items: string[] }[];
  /**
   * What the next `showWarningMessage` returns.
   *
   * `undefined` is the DEFAULT and it is the honest one: it is what VS Code
   * returns when a user dismisses a modal with Escape or Cancel. A mock that
   * defaulted to the destructive answer would make "cancel leaves everything"
   * the test nobody remembered to write.
   */
  warningAnswer: string | undefined;
  /**
   * Every `WorkspaceConfiguration.update` call, in order (v0.8.0 DoD 7.6).
   *
   * The TARGET is recorded, not only the key and value: which file a
   * setting is written into is a decision `src/extension.ts` states a reason
   * for, and a decision nothing asserts is a comment.
   */
  configurationWrites: { section: string; key: string; value: unknown; target: number | undefined }[];
  configurationEmitter: Emitter<{ affectsConfiguration(section: string): boolean }>;
  /**
   * v0.9.0 DoD 9.45 — every `setContext` the extension ran, by key, holding
   * the LAST value. The real editor keeps exactly that; a test reads it to
   * see what the Menu submenu and the palette would show.
   */
  contexts: Map<string, unknown>;
  /**
   * v0.9.0 DoD 9.47 — every file `workspace.fs.writeFile` wrote, by `fsPath`,
   * as UTF-8 text. IN MEMORY: the double writes nothing to disk, so a test
   * can assert the bytes an export produced without a scratch directory.
   */
  writtenFiles: Map<string, string>;
  /** What `workspace.fs.readDirectory` lists, by folder `fsPath`. */
  directories: Map<string, string[]>;
  /** Folders `readDirectory` REJECTS for (verifier round 9.48, W3). */
  unlistable: Set<string>;
  /** Every `showSaveDialog` call's options, in order. */
  saveDialogs: { defaultUri: string | undefined; filters: Record<string, string[]> | undefined }[];
  /** What the next `showSaveDialog` returns — an `fsPath`, or `undefined` (cancelled). */
  saveDialogAnswer: string | undefined;
  /** Every `showOpenDialog` call's options, in order. */
  openDialogs: { canSelectFolders: boolean; canSelectFiles: boolean }[];
  /** What the next `showOpenDialog` returns — a folder `fsPath`, or `undefined`. */
  openDialogAnswer: string | undefined;
  /** What `env.clipboard.writeText` last wrote, or `undefined`. */
  clipboard: string | undefined;
}

const state: MockState = {
  workspaceFolders: undefined,
  configuration: new Map(),
  commands: new Map(),
  extensions: new Set<string>(),
  extensionManifests: new Map(),
  activeExtensions: new Set<string>(),
  informationPrompts: [],
  outputLines: [],
  outputChannelsCreated: [],
  outputChannelsDisposed: [],
  openedExternal: [] as string[],
  openedDocuments: [] as { content: string; language: string | undefined; shown: boolean }[],
  openTextDocumentFails: false,
  modalAnswer: undefined as string | undefined,
  panels: [],
  panelColumns: [],
  executed: [],
  viewProviders: new Map(),
  treeViews: new Map(),
  quickPicks: [],
  quickPickAnswer: undefined as string | undefined,
  editorGroups: 1,
  errorMessages: [],
  informationMessages: [],
  warningMessages: [],
  warningAnswer: undefined,
  configurationWrites: [],
  configurationEmitter: new Emitter(),
  contexts: new Map(),
  writtenFiles: new Map(),
  directories: new Map(),
  unlistable: new Set(),
  saveDialogs: [],
  saveDialogAnswer: undefined,
  openDialogs: [],
  openDialogAnswer: undefined,
  clipboard: undefined,
};

/** Drop every piece of mock state. Call in `beforeEach`. */
export function resetVscodeMock(): void {
  state.workspaceFolders = undefined;
  state.configuration = new Map();
  state.commands = new Map();
  state.panels = [];
  state.panelColumns = [];
  state.executed = [];
  state.viewProviders = new Map();
  state.treeViews = new Map();
  state.quickPicks = [];
  state.quickPickAnswer = undefined;
  state.editorGroups = 1;
  state.errorMessages = [];
  state.informationMessages = [];
  state.warningMessages = [];
  state.warningAnswer = undefined;
  state.openedExternal = [];
  state.openedDocuments = [];
  state.openTextDocumentFails = false;
  state.modalAnswer = undefined;
  state.configurationWrites = [];
  state.configurationEmitter = new Emitter();
  state.contexts = new Map();
  state.writtenFiles = new Map();
  state.directories = new Map();
  state.unlistable = new Set();
  state.saveDialogs = [];
  state.saveDialogAnswer = undefined;
  state.openDialogs = [];
  state.openDialogAnswer = undefined;
  state.clipboard = undefined;
  state.extensionManifests = new Map();
  state.activeExtensions = new Set();
  state.informationPrompts = [];
  state.outputLines = [];
  state.outputChannelsCreated = [];
  state.outputChannelsDisposed = [];
}

/**
 * An installed extension's manifest, as far as this double needs one.
 *
 * `commands` is what `contributes.commands` lists; activating the extension
 * registers a handler for each, which is what the real editor's activation
 * of a contributing extension ends in. `failOnActivate` makes `activate()`
 * reject, and `commandErrors` makes the named command's handler throw.
 */
export interface MockExtensionManifest {
  version: string;
  commands: string[];
  failOnActivate?: string;
  commandErrors?: Record<string, string>;
}

/** An installed extension with no manifest of its own. Contributes nothing. */
export const DEFAULT_EXTENSION_MANIFEST: MockExtensionManifest = { version: '0.0.0', commands: [] };

/** Test control surface. Never imported by production code. */
export const mock = {
  state,
  setWorkspaceFolder(fsPath: string | undefined): void {
    state.workspaceFolders =
      fsPath === undefined
        ? undefined
        : [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }];
  },
  setConfig(section: string, values: Record<string, unknown>): void {
    state.configuration.set(section, new Map(Object.entries(values)));
  },
  /** Every `WorkspaceConfiguration.update` call, in order, with its target. */
  get configurationWrites(): {
    section: string;
    key: string;
    value: unknown;
    target: number | undefined;
  }[] {
    return state.configurationWrites;
  },
  fireConfigurationChange(section: string): void {
    state.configurationEmitter.fire({
      affectsConfiguration: (candidate: string) => candidate === section,
    });
  },
  async runCommand(id: string, ...args: unknown[]): Promise<unknown> {
    const handler = state.commands.get(id);
    if (handler === undefined) throw new Error(`command not registered: ${id}`);
    return handler(...args);
  },
  hasCommand(id: string): boolean {
    return state.commands.has(id);
  },
  /** DoD 9.6 — install or uninstall an extension in this fake editor. */
  setExtensionInstalled(id: string, installed: boolean, manifest?: MockExtensionManifest): void {
    if (installed) state.extensions.add(id);
    else state.extensions.delete(id);
    if (manifest !== undefined) state.extensionManifests.set(id, manifest);
  },
  /** DoD 9.25 — is that extension's record active now? */
  isExtensionActive(id: string): boolean {
    return state.activeExtensions.has(id);
  },
  /** DoD 9.23 — every information message and the buttons it offered. */
  get informationPrompts(): { message: string; items: string[]; modal: boolean }[] {
    return state.informationPrompts;
  },
  /** DoD 9.25 — every line written to an output channel. */
  get outputLines(): { channel: string; line: string }[] {
    return state.outputLines;
  },
  /** DoD 9.26 — every `createOutputChannel` call, by name. */
  get outputChannelsCreated(): string[] {
    return state.outputChannelsCreated;
  },
  /** DoD 9.26 — every output channel disposed, by name. */
  get outputChannelsDisposed(): string[] {
    return state.outputChannelsDisposed;
  },
  /** DoD 9.7 — every URI handed to `env.openExternal`, in order. */
  get openedExternal(): readonly string[] {
    return state.openedExternal;
  },
  /** DoD 9.40 — every untitled document opened with content, and whether shown. */
  get openedDocuments(): readonly { content: string; language: string | undefined; shown: boolean }[] {
    return state.openedDocuments;
  },
  /** Verifier round 9.43, W2 — make the next `openTextDocument` reject. */
  failNextOpenTextDocument(): void {
    state.openTextDocumentFails = true;
  },
  /** DoD 9.7 — answer the next modal as if the user had pressed that button. */
  answerModal(label: string | undefined): void {
    state.modalAnswer = label;
  },
  get panels(): MockWebviewPanel[] {
    return state.panels;
  },
  /** The `viewColumn` of every panel created, in order (DoD 4.6c). */
  get panelColumns(): number[] {
    return state.panelColumns;
  },
  /** Every `executeCommand` call, in order (DoD 4.6b/4.6c). */
  get executed(): { command: string; args: unknown[] }[] {
    return state.executed;
  },
  /** Pretend the window has this many editor groups. */
  setEditorGroups(count: number): void {
    state.editorGroups = count;
  },
  /** Resolve a registered webview view, as VS Code does when the user opens it. */
  resolveView(viewId: string): MockWebviewView {
    const provider = state.viewProviders.get(viewId);
    if (provider === undefined) throw new Error(`no webview view provider registered: ${viewId}`);
    const view = new MockWebviewView(viewId);
    provider.resolveWebviewView(view);
    return view;
  },
  hasViewProvider(viewId: string): boolean {
    return state.viewProviders.has(viewId);
  },
  /** The tree view a `createTreeView` call registered (DoD 9.14). */
  treeView(viewId: string): MockTreeView<unknown> {
    const view = state.treeViews.get(viewId);
    if (view === undefined) throw new Error(`no tree view created: ${viewId}`);
    return view;
  },
  hasTreeView(viewId: string): boolean {
    return state.treeViews.has(viewId);
  },
  /** Every `showQuickPick` call, in order. */
  get quickPicks(): { items: string[]; placeHolder: string | undefined }[] {
    return state.quickPicks;
  },
  /** What the next `showQuickPick` returns. Ignored unless it is offered. */
  answerQuickPick(answer: string | undefined): void {
    state.quickPickAnswer = answer;
  },
  /** DoD 9.45 — the last value `setContext` gave each key. */
  get contexts(): ReadonlyMap<string, unknown> {
    return state.contexts;
  },
  /** DoD 9.47 — every file written through `workspace.fs`, by `fsPath`. */
  get writtenFiles(): ReadonlyMap<string, string> {
    return state.writtenFiles;
  },
  /** DoD 9.47 — make `readDirectory` list these names in `folder`. */
  setDirectory(folder: string, names: string[]): void {
    state.directories.set(folder, [...names]);
  },
  /** Verifier round 9.48, W3 — make `readDirectory` reject for this folder. */
  setDirectoryUnlistable(folder: string): void {
    state.unlistable.add(folder);
  },
  /** DoD 9.47 — every save dialog shown. */
  get saveDialogs(): { defaultUri: string | undefined; filters: Record<string, string[]> | undefined }[] {
    return state.saveDialogs;
  },
  /** DoD 9.47 — the next save dialog returns this path, or `undefined` (cancel). */
  answerSaveDialog(fsPath: string | undefined): void {
    state.saveDialogAnswer = fsPath;
  },
  /** DoD 9.47 — every folder dialog shown. */
  get openDialogs(): { canSelectFolders: boolean; canSelectFiles: boolean }[] {
    return state.openDialogs;
  },
  /** DoD 9.47 — the next folder dialog returns this folder, or `undefined` (cancel). */
  answerOpenDialog(fsPath: string | undefined): void {
    state.openDialogAnswer = fsPath;
  },
  /** DoD 9.47 — what the clipboard holds. */
  get clipboard(): string | undefined {
    return state.clipboard;
  },
  get errorMessages(): string[] {
    return state.errorMessages;
  },
  get informationMessages(): string[] {
    return state.informationMessages;
  },
  get warningMessages(): { message: string; modal: boolean; items: string[] }[] {
    return state.warningMessages;
  },
  /** What the next modal returns. `undefined` means the user dismissed it. */
  answerWarningWith(answer: string | undefined): void {
    state.warningAnswer = answer;
  },
};

// ---------------------------------------------------------------------------
// The namespaces `src/extension.ts` reaches for
// ---------------------------------------------------------------------------

export const workspace = {
  get workspaceFolders(): { uri: Uri; name: string; index: number }[] | undefined {
    return state.workspaceFolders;
  },
  /**
   * `vscode.workspace.getConfiguration`.
   *
   * `update` is REAL here (v0.8.0 DoD 7.6): it writes into the same map `get`
   * reads, so a test can drive the whole round trip — a click posts
   * `updateTweak`, the host calls `update`, and the next read returns the new
   * value. A mock that only recorded the call would let a test pass while the
   * host wrote a key nothing reads back.
   *
   * The write is recorded in {@link MockState.configurationWrites} with its
   * target, because WHICH file a setting lands in is a decision with a stated
   * reason, and a decision nothing asserts is a comment.
   *
   * It does NOT fire `onDidChangeConfiguration`: real VS Code does, and a test
   * that wants the follow-on calls `mock.fireConfigurationChange` itself. An
   * automatic fire would make every test's ordering implicit.
   */
  getConfiguration(section: string): {
    get(key: string): unknown;
    update(key: string, value: unknown, target?: number): Promise<void>;
  } {
    const values = state.configuration.get(section);
    return {
      get: (key: string) => values?.get(key),
      update: (key: string, value: unknown, target?: number): Promise<void> => {
        const existing = state.configuration.get(section) ?? new Map<string, unknown>();
        existing.set(key, value);
        state.configuration.set(section, existing);
        state.configurationWrites.push({ section, key, value, target });
        return Promise.resolve();
      },
    };
  },
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration(section: string): boolean }) => void,
  ): MockDisposable {
    return state.configurationEmitter.event(listener);
  },
  /**
   * `vscode.workspace.openTextDocument({ content, language })` — the UNTITLED
   * overload only (DoD 9.40). A path or a Uri is refused here, because this
   * extension opens nothing from disk and a test reaching for it has found a
   * write-shaped path worth failing on.
   */
  /**
   * `vscode.workspace.fs` — DoD 9.47. Two methods, both IN MEMORY:
   * `writeFile` records the bytes by `fsPath` (decoded as UTF-8, which is
   * what an export writes) and `readDirectory` lists what a test set with
   * `mock.setDirectory` plus anything already written into that folder.
   */
  fs: {
    writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      state.writtenFiles.set(uri.fsPath, Buffer.from(content).toString('utf8'));
      return Promise.resolve();
    },
    readDirectory(uri: Uri): Promise<[string, number][]> {
      if (state.unlistable.has(uri.fsPath)) {
        return Promise.reject(new Error(`vscode-mock: ${uri.fsPath} cannot be listed`));
      }
      const names = new Set(state.directories.get(uri.fsPath) ?? []);
      for (const path of state.writtenFiles.keys()) {
        const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (cut > 0 && path.slice(0, cut) === uri.fsPath) names.add(path.slice(cut + 1));
      }
      return Promise.resolve([...names].map((name) => [name, 1]));
    },
  },
  openTextDocument(options: { content?: string; language?: string }): Promise<{ index: number }> {
    if (typeof options !== 'object' || options === null || typeof options.content !== 'string') {
      return Promise.reject(new Error('vscode-mock: only the untitled { content } overload is modelled'));
    }
    if (state.openTextDocumentFails) {
      state.openTextDocumentFails = false;
      return Promise.reject(new Error('vscode-mock: the editor refused the document'));
    }
    state.openedDocuments.push({ content: options.content, language: options.language, shown: false });
    return Promise.resolve({ index: state.openedDocuments.length - 1 });
  },
};

export const commands = {
  registerCommand(
    id: string,
    handler: (...args: unknown[]) => unknown,
  ): MockDisposable {
    state.commands.set(id, handler);
    return {
      dispose: () => {
        state.commands.delete(id);
      },
    };
  },
  /**
   * Recorded, then dispatched to a registered handler when there is one.
   *
   * The dispatch half is what lets the sidebar test prove a click reaches
   * `agentDeck.open`'s REAL handler rather than a stub; the record half is
   * what lets a workbench command that exists only in the editor be asserted
   * as asked-for.
   */
  executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    // `setContext` is the editor's own built-in command (DoD 9.45): it sets
    // a context key a manifest `when` clause reads, and it always exists.
    // Recorded in `contexts` and NOT in `executed`: every test reading
    // `executed` asks which commands the extension RAN, and a context key
    // is state, not an act.
    if (command === 'setContext') {
      state.contexts.set(String(args[0]), args[1]);
      return Promise.resolve(undefined);
    }
    state.executed.push({ command, args });
    const handler = state.commands.get(command);
    if (handler === undefined) {
      /*
       * THE REAL EDITOR REJECTS AN UNKNOWN COMMAND — DoD 9.25.
       *
       * This resolved `undefined` for every unregistered id until then,
       * which is how "Open Insights" reached a command Insights does not
       * contribute and every test called it a pass. `workbench.*` ids exist
       * only in the editor and are still answered, because they are the
       * editor's own and a test can only assert they were ASKED FOR.
       */
      if (command.startsWith('workbench.')) return Promise.resolve(undefined);
      return Promise.reject(new Error(`command '${command}' not found`));
    }
    try {
      return Promise.resolve(handler(...args));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
};

/**
 * `vscode.extensions`, enough of it for DoD 9.6.
 *
 * `getExtension` ANSWERS WITHOUT ACTIVATING, and the real one returns a
 * record rather than a boolean, so the mock does too: a test that set a
 * boolean here would be testing a shape the editor does not have.
 */
/**
 * `vscode.env`, enough of it for DoD 9.7.
 *
 * `openExternal` RECORDS what it was handed rather than answering `true`
 * and forgetting: a test that could only see "it was called" cannot tell a
 * correct link from the first link, which is exactly the mutation that
 * survived before this existed.
 */
export const env = {
  /** DoD 9.47 — the Copy export. Holds the last text written. */
  clipboard: {
    writeText(text: string): Promise<void> {
      state.clipboard = text;
      return Promise.resolve();
    },
  },
  openExternal(target: unknown): Promise<boolean> {
    state.openedExternal.push(String((target as { toString(): string }).toString()));
    return Promise.resolve(true);
  },
};

export const extensions = {
  /**
   * A record shaped like `vscode.Extension`: `isActive`, `packageJSON` and
   * `activate()` (DoD 9.25). Activating registers a handler for every command
   * the manifest contributes — which is what the real editor's activation of
   * a contributing extension ends in — and a command the manifest does NOT
   * list stays unregistered, so `executeCommand` rejects it as the editor
   * does.
   */
  getExtension(id: string):
    | { id: string; isActive: boolean; packageJSON: unknown; activate(): Promise<void> }
    | undefined {
    if (!state.extensions.has(id)) return undefined;
    const manifest = state.extensionManifests.get(id) ?? DEFAULT_EXTENSION_MANIFEST;
    return {
      id,
      isActive: state.activeExtensions.has(id),
      packageJSON: {
        version: manifest.version,
        contributes: { commands: manifest.commands.map((command) => ({ command })) },
      },
      activate: (): Promise<void> => {
        if (manifest.failOnActivate !== undefined) {
          return Promise.reject(new Error(manifest.failOnActivate));
        }
        if (!state.activeExtensions.has(id)) {
          state.activeExtensions.add(id);
          for (const command of manifest.commands) {
            const failure = manifest.commandErrors?.[command];
            state.commands.set(command, () => {
              if (failure !== undefined) throw new Error(failure);
              return undefined;
            });
          }
        }
        return Promise.resolve();
      },
    };
  },
};

/* -------------------------------------------------------------------------- *
 * TreeView — v0.9.0 DoD 9.14
 * -------------------------------------------------------------------------- *
 *
 * The sidebar is a NATIVE tree now, so the mock has to carry the four
 * primitives the provider touches: `TreeItem`, its two enums, `ThemeIcon`
 * and `EventEmitter`. They are the real API's shapes and nothing more — a
 * mock that invented a convenience here would let a test pass against a
 * structure VS Code does not have, which is this repository's recorded
 * "a harness comment describing what a fixture MEANS is an assertion with
 * no test behind it".
 */

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

export const TreeItemCheckboxState = {
  Unchecked: 0,
  Checked: 1,
} as const;

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class TreeItem {
  label: string;
  collapsibleState: number;
  id?: string;
  description?: string;
  iconPath?: ThemeIcon;
  command?: { command: string; title: string } | undefined;
  checkboxState?: number;

  constructor(label: string, collapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class EventEmitter<T> {
  readonly #emitter = new Emitter<T>();

  readonly event = this.#emitter.event;

  fire(value: T): void {
    this.#emitter.fire(value);
  }

  dispose(): void {
    this.#emitter.listeners.clear();
  }
}

/** What `createTreeView` hands back, plus what a test needs to drive it. */
export interface MockTreeView<T> {
  readonly provider: {
    getChildren(element?: T): T[];
    getTreeItem(element: T): TreeItem;
  };
  readonly checkboxEmitter: Emitter<{ items: [T, number][] }>;
  visible: boolean;
  dispose(): void;
}

export const window = {
  /**
   * `createTreeView`, recording the provider so a test can walk the real one.
   *
   * The provider is NOT wrapped or adapted: a test reads the same object the
   * editor would, so the adapter half of `AgentDeckTreeProvider` — the one
   * that turns the model into `TreeItem`s — is driven rather than assumed.
   */
  createTreeView<T>(
    viewId: string,
    options: { treeDataProvider: { getChildren(element?: T): T[]; getTreeItem(element: T): TreeItem } },
  ): MockTreeView<T> {
    const view: MockTreeView<T> = {
      provider: options.treeDataProvider,
      checkboxEmitter: new Emitter<{ items: [T, number][] }>(),
      visible: true,
      dispose: () => {
        state.treeViews.delete(viewId);
      },
    };
    state.treeViews.set(viewId, view as MockTreeView<unknown>);
    return view;
  },
  /**
   * `showQuickPick`, answering `state.quickPickAnswer`.
   *
   * Recorded as well as answered: the tool filter's whole job is to offer the
   * names this window holds, and a test that could only see the ANSWER could
   * not tell a correct list from an empty one.
   */
  showQuickPick(items: readonly string[], options?: { placeHolder?: string }): Promise<string | undefined> {
    state.quickPicks.push({ items: [...items], placeHolder: options?.placeHolder });
    const answer = state.quickPickAnswer;
    return Promise.resolve(answer !== undefined && items.includes(answer) ? answer : undefined);
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    column: number,
    options: unknown,
  ): MockWebviewPanel {
    const panel = new MockWebviewPanel(viewType, title, options);
    state.panels.push(panel);
    state.panelColumns.push(column);
    return panel;
  },
  registerWebviewViewProvider(
    viewId: string,
    provider: { resolveWebviewView(view: MockWebviewView): void },
  ): MockDisposable {
    state.viewProviders.set(viewId, provider);
    return {
      dispose: () => {
        state.viewProviders.delete(viewId);
      },
    };
  },
  /** `vscode.window.tabGroups`: only `all.length` is read, for DoD 4.6c. */
  get tabGroups(): { all: unknown[] } {
    return { all: Array.from({ length: state.editorGroups }, () => ({})) };
  },
  /**
   * `createOutputChannel`, recording every line with the channel's name
   * (DoD 9.25). The double had none until then, which is why the host kept
   * the call at the one production site where no test reached it.
   */
  createOutputChannel(name: string): {
    name: string;
    appendLine(line: string): void;
    show(preserveFocus?: boolean): void;
    dispose(): void;
  } {
    // Creation and disposal are RECORDED, not just the lines: "one channel
    // per window" is a claim about how many times this is called, and a
    // line's channel NAME cannot tell one channel from two with one name
    // (verifier round 9.26, mutations M1/M5b/M6 survived without this).
    state.outputChannelsCreated.push(name);
    return {
      name,
      appendLine: (line: string) => {
        state.outputLines.push({ channel: name, line });
      },
      show: () => undefined,
      dispose: () => {
        state.outputChannelsDisposed.push(name);
      },
    };
  },
  /**
   * `showSaveDialog` — DoD 9.47. Recorded with its default and filters, and
   * answered with `mock.answerSaveDialog`; `undefined` is a cancel, the
   * default and the honest one.
   */
  showSaveDialog(options?: { defaultUri?: Uri; filters?: Record<string, string[]> }): Promise<Uri | undefined> {
    state.saveDialogs.push({ defaultUri: options?.defaultUri?.fsPath, filters: options?.filters });
    const answer = state.saveDialogAnswer;
    return Promise.resolve(answer === undefined ? undefined : Uri.file(answer));
  },
  /** `showOpenDialog` — DoD 9.47, the batch export's folder. Same rules. */
  showOpenDialog(options?: { canSelectFolders?: boolean; canSelectFiles?: boolean }): Promise<Uri[] | undefined> {
    state.openDialogs.push({
      canSelectFolders: options?.canSelectFolders === true,
      canSelectFiles: options?.canSelectFiles !== false,
    });
    const answer = state.openDialogAnswer;
    return Promise.resolve(answer === undefined ? undefined : [Uri.file(answer)]);
  },
  /** `vscode.window.showTextDocument` for a document {@link workspace.openTextDocument} made. */
  showTextDocument(document: { index: number }): Promise<undefined> {
    const opened = state.openedDocuments[document.index];
    if (opened === undefined) return Promise.reject(new Error('vscode-mock: no such document'));
    opened.shown = true;
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string): Promise<undefined> {
    state.errorMessages.push(message);
    return Promise.resolve(undefined);
  },
  /**
   * Both overloads. The MODAL one is what DoD 9.7’s About entry calls:
   * `showInformationMessage(message, { modal: true }, ...labels)`.
   *
   * It answers `state.modalAnswer`, which a test sets with
   * `mock.answerModal(label)` — so a test can press a named button and then
   * assert WHICH url was opened. Answering `undefined` blindly, which this
   * did until v0.9.0, makes every modal an unanswered one and every branch
   * below the answer unreachable.
   */
  showInformationMessage(
    message: string,
    optionsOrItem?: { modal?: boolean } | string,
    ...rest: string[]
  ): Promise<string | undefined> {
    // BOTH real overloads: `(message, ...items)` and `(message, options,
    // ...items)`. Reading the second argument as options unconditionally,
    // as this did until DoD 9.23, silently drops the first button of the
    // other form and answers `undefined` to a question the user was asked.
    const items = typeof optionsOrItem === 'string' ? [optionsOrItem, ...rest] : rest;
    state.informationMessages.push(message);
    const modal = typeof optionsOrItem === 'object' && optionsOrItem.modal === true;
    state.informationPrompts.push({ message, items, modal });
    if (items.length === 0) return Promise.resolve(undefined);
    // Only an answer that is one of the offered labels, because the editor
    // can only return one of them.
    const answer = state.modalAnswer;
    return Promise.resolve(answer !== undefined && items.includes(answer) ? answer : undefined);
  },
  /**
   * The modal overload, recorded rather than answered blindly.
   *
   * Signature matches the real one this extension calls:
   * `showWarningMessage(message, options, ...items)`. `options.modal` is read
   * and RECORDED rather than ignored, because it is the difference between a
   * confirmation dialog and a toast — see `MockState.warningMessages`.
   */
  showWarningMessage(
    message: string,
    options?: { modal?: boolean },
    ...items: string[]
  ): Promise<string | undefined> {
    state.warningMessages.push({
      message,
      modal: options?.modal === true,
      items: [...items],
    });
    return Promise.resolve(state.warningAnswer);
  },
};

/**
 * A stand-in for `vscode.ExtensionContext`, carrying only what activate uses.
 *
 * `globalStorageUri` joined in v0.7.0 Phase 3: `activate()` resolves the local
 * store from it, and a context without one would make `resolveStoreDir` throw
 * on a field the real API always supplies.
 *
 * THE DEFAULT IS A PATH NOTHING CAN CREATE A DIRECTORY UNDER, and that is
 * chosen rather than incidental.
 *
 * `activate()` now resolves a store directory unconditionally, so every host
 * test that predates Phase 3 would otherwise start writing real records
 * somewhere. A plausible-looking placeholder is the worst option available:
 * `Uri.file('/gs')` is `\gs` on Windows, which `mkdirSync(..., { recursive:
 * true })` cheerfully creates at the root of the current drive — a test suite
 * silently writing outside the repository, which is the one thing G1 exists to
 * prevent. A path that merely does not exist is no better, for the same
 * reason: `recursive: true` makes it.
 *
 * {@link UNWRITABLE_GLOBAL_STORAGE} is therefore a path UNDER AN EXISTING
 * FILE. `mkdir` under a file is `ENOTDIR` on every platform, so the default
 * cannot create anything anywhere, and the store's failure path is exercised
 * for free. A test that WANTS a store passes a real temp directory of its own
 * and removes it.
 *
 * IT IS `process.execPath` — THE RUNNING NODE BINARY — AND NOT A FILE IN THIS
 * REPOSITORY, which the first draft used and which broke something real.
 * `fileURLToPath(new URL('../package.json', import.meta.url))` is fine in a
 * vitest worker and throws `ERR_INVALID_URL` inside `scripts/record-wire.mjs`,
 * which BUNDLES the host modules and `eval`s them — `import.meta.url` is
 * undefined there, so a module-level `new URL(..., import.meta.url)` in this
 * file took down the wire recorder at load time, and with it
 * `webview/wire.test.ts` and `webview/stress.test.ts`. Nothing about those
 * suites is related to the store; they simply import this double.
 *
 * `process.execPath` needs no URL, no `import.meta`, and no assumption about
 * where this file sits in a tree. It is guaranteed to exist and guaranteed to
 * be a file, which is the entire requirement.
 */
export const UNWRITABLE_GLOBAL_STORAGE = process.execPath;

export function createExtensionContext(
  extensionPath = '/ext',
  globalStoragePath = UNWRITABLE_GLOBAL_STORAGE,
): {
  subscriptions: MockDisposable[];
  extensionUri: Uri;
  globalStorageUri: Uri;
  extension: { packageJSON: unknown };
} {
  return {
    subscriptions: [],
    extensionUri: Uri.file(extensionPath),
    globalStorageUri: Uri.file(globalStoragePath),
    // The REAL manifest, read from the repository root the suite runs in —
    // DoD 9.23's About footer names `packageJSON.version`, and a literal
    // here would be a second copy of the version to keep in step.
    extension: { packageJSON: JSON.parse(readFileSync('package.json', 'utf8')) as unknown },
  };
}
