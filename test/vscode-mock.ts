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
      cspSource: 'vscode-resource://agent-deck-test',
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
  errorMessages: string[];
  informationMessages: string[];
  configurationEmitter: Emitter<{ affectsConfiguration(section: string): boolean }>;
}

const state: MockState = {
  workspaceFolders: undefined,
  configuration: new Map(),
  commands: new Map(),
  panels: [],
  errorMessages: [],
  informationMessages: [],
  configurationEmitter: new Emitter(),
};

/** Drop every piece of mock state. Call in `beforeEach`. */
export function resetVscodeMock(): void {
  state.workspaceFolders = undefined;
  state.configuration = new Map();
  state.commands = new Map();
  state.panels = [];
  state.errorMessages = [];
  state.informationMessages = [];
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
  get errorMessages(): string[] {
    return state.errorMessages;
  },
  get informationMessages(): string[] {
    return state.informationMessages;
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
};

export const window = {
  createWebviewPanel(
    viewType: string,
    title: string,
    _column: number,
    options: unknown,
  ): MockWebviewPanel {
    const panel = new MockWebviewPanel(viewType, title, options);
    state.panels.push(panel);
    return panel;
  },
  showErrorMessage(message: string): Promise<undefined> {
    state.errorMessages.push(message);
    return Promise.resolve(undefined);
  },
  showInformationMessage(message: string): Promise<undefined> {
    state.informationMessages.push(message);
    return Promise.resolve(undefined);
  },
};

/** A stand-in for `vscode.ExtensionContext`, carrying only what activate uses. */
export function createExtensionContext(extensionPath = '/ext'): {
  subscriptions: MockDisposable[];
  extensionUri: Uri;
} {
  return { subscriptions: [], extensionUri: Uri.file(extensionPath) };
}
