/**
 * Running one of Agent Deck Insights' commands from the parent — v0.9.0 DoD
 * 9.25, spec `Amendment 2026-09-21 — About page and Insights entries`.
 *
 * ## Why this file exists: "Open Insights" did nothing, and said nothing
 *
 * The user's own-eyes pass on `94c79db`: with Insights installed, Open Insights
 * produced no notification, no panel and no log line. Two causes, both on
 * this side:
 *
 * 1. **The id was never Insights'.** The parent executed
 *    `agentDeckInsights.open`, and Insights 0.1.0 contributes exactly four
 *    commands — `run`, `pickAgent`, `clearHistory`, `showPayload` — pinned by
 *    its own PLAN 3.5. VS Code rejects an unknown command with
 *    "command '…' not found". The 9.21 verifier had flagged the id as having
 *    no second anchor anywhere (its S3); the 9.22 fold gave it one in the
 *    README, which anchored the wrong string twice.
 * 2. **The rejection was thrown away.** The handler was
 *    `void vscode.commands.executeCommand(id)`, so the promise's rejection
 *    reached nobody. A dead button is bad; a dead button that cannot say why
 *    is the defect class this release keeps paying for.
 *
 * So every invocation goes through {@link invokeInsights}: it finds the
 * extension, activates it when it is not active yet (the same order the
 * Insights side uses to reach this extension's API), runs the command,
 * writes the activation and the outcome to the output channel, and **turns any failure
 * into an information message that names the command**. Nothing here can
 * end in silence.
 *
 * ## Dependencies are injected
 *
 * The `vscode` calls live in `extension.ts`, which passes them in. That keeps
 * this testable without an editor, and it lets a test hand in an extension
 * record that is NOT active, whose manifest lacks the command, or whose
 * command throws — the three shapes the own-eyes pass could not tell apart.
 *
 * ## What the parent still never asks
 *
 * The licence. Insights refuses its own run when there is none; the parent
 * running the command and relaying Insights' own refusal is the whole
 * relationship.
 */

/** The shape of `vscode.Extension` this reads. Structural, so no `vscode` import. */
export interface InsightsExtensionRecord {
  readonly isActive: boolean;
  readonly packageJSON: unknown;
  activate(): PromiseLike<unknown>;
}

export interface InsightsInvokeDeps {
  /** `vscode.extensions.getExtension(INSIGHTS_EXTENSION_ID)`. */
  getExtension(): InsightsExtensionRecord | undefined;
  /** `vscode.commands.executeCommand`. */
  executeCommand(command: string): PromiseLike<unknown>;
  /** `vscode.window.showInformationMessage`, message only. */
  showInformationMessage(message: string): void;
  /** A line to the "Agent Deck" output channel. */
  log(line: string): void;
}

/** What happened, for the caller and for the tests. */
export type InsightsInvokeOutcome =
  | { kind: 'ran' }
  | { kind: 'not-installed' }
  | { kind: 'activation-failed'; error: string }
  | { kind: 'command-failed'; contributed: boolean | null; error: string };

/**
 * The command ids an extension's manifest contributes, or `null` when the
 * manifest cannot be read. `null` is NOT "none": it means this cannot say,
 * and the message says less rather than guessing.
 */
export function contributedCommands(packageJSON: unknown): readonly string[] | null {
  if (typeof packageJSON !== 'object' || packageJSON === null) return null;
  const contributes = (packageJSON as Record<string, unknown>)['contributes'];
  if (typeof contributes !== 'object' || contributes === null) return null;
  const commands = (contributes as Record<string, unknown>)['commands'];
  if (!Array.isArray(commands)) return null;
  const ids: string[] = [];
  for (const entry of commands) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as Record<string, unknown>)['command'];
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/** The manifest's `version`, or `null`. Only ever used in a message. */
function versionOf(packageJSON: unknown): string | null {
  if (typeof packageJSON !== 'object' || packageJSON === null) return null;
  const version = (packageJSON as Record<string, unknown>)['version'];
  return typeof version === 'string' ? version : null;
}

/** An error as one line of text, whatever was thrown. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Run `command`, which belongs to Agent Deck Insights.
 *
 * Never throws and never resolves without leaving a trace: every path
 * writes at least one log line, and every path that did not run the command also
 * shows an information message naming it.
 */
export async function invokeInsights(
  command: string,
  deps: InsightsInvokeDeps,
): Promise<InsightsInvokeOutcome> {
  let extension: InsightsExtensionRecord | undefined;
  try {
    extension = deps.getExtension();
  } catch {
    extension = undefined;
  }
  if (extension === undefined) {
    deps.log(`insights ${command}: not run, Agent Deck Insights is not installed`);
    deps.showInformationMessage(
      `Agent Deck Insights is not installed, so ${command} was not run.`,
    );
    return { kind: 'not-installed' };
  }

  const packageJSON = extension.packageJSON;
  const version = versionOf(packageJSON);
  const named = version === null ? 'Agent Deck Insights' : `Agent Deck Insights ${version}`;

  if (!extension.isActive) {
    try {
      await extension.activate();
      deps.log(`insights ${command}: activated ${named}`);
    } catch (error) {
      const text = describe(error);
      deps.log(`insights ${command}: not run, ${named} failed to activate: ${text}`);
      deps.showInformationMessage(
        `${named} failed to activate, so ${command} was not run: ${text}`,
      );
      return { kind: 'activation-failed', error: text };
    }
  }

  try {
    const result = await deps.executeCommand(command);
    deps.log(
      `insights ${command}: ran on ${named}, returned ${result === undefined ? 'nothing' : typeof result}`,
    );
    return { kind: 'ran' };
  } catch (error) {
    const text = describe(error);
    const ids = contributedCommands(packageJSON);
    const contributed = ids === null ? null : ids.includes(command);
    deps.log(
      `insights ${command}: failed on ${named} (manifest contributes it: ${
        contributed === null ? 'unknown' : contributed ? 'yes' : 'no'
      }): ${text}`,
    );
    deps.showInformationMessage(
      contributed === false
        ? `${named} has no command ${command}, so it was not run.`
        : `${named} could not run ${command}: ${text}`,
    );
    return { kind: 'command-failed', contributed, error: text };
  }
}
