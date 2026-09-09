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

  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
} as const;

// ---------------------------------------------------------------------------
// Webview view (the sidebar) — v0.7.0 Phase 4, DoD 4.6b
// ---------------------------------------------------------------------------

/** The slice of `vscode.WebviewView` the sidebar controller reaches for. */
export class MockWebviewView {
  readonly viewType: string;
  readonly webview: MockWebview;
  disposed = false;

  readonly #inbound = new Emitter<unknown>();
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

  onDidDispose(listener: () => void): MockDisposable {
    return this.#onDispose.event(() => {
      listener();
    });
  }

  /** Deliver a raw message as if the sidebar had posted it. */
  fireMessage(raw: unknown): void {
    this.#inbound.fire(raw);
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
  configurationEmitter: Emitter<{ affectsConfiguration(section: string): boolean }>;
}

const state: MockState = {
  workspaceFolders: undefined,
  configuration: new Map(),
  commands: new Map(),
  panels: [],
  panelColumns: [],
  executed: [],
  viewProviders: new Map(),
  editorGroups: 1,
  errorMessages: [],
  informationMessages: [],
  warningMessages: [],
  warningAnswer: undefined,
  configurationEmitter: new Emitter(),
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
  state.editorGroups = 1;
  state.errorMessages = [];
  state.informationMessages = [];
  state.warningMessages = [];
  state.warningAnswer = undefined;
  state.configurationEmitter = new Emitter();
}

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
  getConfiguration(section: string): { get(key: string): unknown } {
    const values = state.configuration.get(section);
    return {
      get: (key: string) => values?.get(key),
    };
  },
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration(section: string): boolean }) => void,
  ): MockDisposable {
    return state.configurationEmitter.event(listener);
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
    state.executed.push({ command, args });
    const handler = state.commands.get(command);
    if (handler === undefined) return Promise.resolve(undefined);
    return Promise.resolve(handler(...args));
  },
};

export const window = {
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
  showErrorMessage(message: string): Promise<undefined> {
    state.errorMessages.push(message);
    return Promise.resolve(undefined);
  },
  showInformationMessage(message: string): Promise<undefined> {
    state.informationMessages.push(message);
    return Promise.resolve(undefined);
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
} {
  return {
    subscriptions: [],
    extensionUri: Uri.file(extensionPath),
    globalStorageUri: Uri.file(globalStoragePath),
  };
}
