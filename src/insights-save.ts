/**
 * THE ONE PLACE AN INSIGHTS EXPORT IS WRITTEN — v0.9.0 DoD 9.47, spec
 * `Amendment 2026-09-23 — Paid Insights surface, export, provider v1 growth`
 * ("save via `vscode.window.showSaveDialog`; batch export writes one file per
 * run into a chosen folder").
 *
 * ## Why this is a module of its own
 *
 * `src/extension.ts` writes nothing itself, and `extension.test.ts` holds it
 * to that by scanning its source for every write API. The G7 amendment met
 * the same question for the stats store and answered it by putting the one
 * writer in one module (`src/stats/store.ts`) and pinning who may reach it.
 * This is that answer again: the export's write lives here, next to the
 * refusal that guards it, and `src/insights-save.test.ts` pins that
 * `extension.ts` is its only importer and that nothing else in `src/` calls
 * `workspace.fs.writeFile`.
 *
 * ## G1 — never into an observed engine's directory
 *
 * The user chooses where an export goes. What Agent Deck refuses is a path
 * inside a directory it only ever READS: `~/.claude`, the Claude Code
 * projects root (`CLAUDE_PROJECTS_ROOT` when set), the Codex root
 * (`CODEX_HOME` when set) and the OpenCode data directory. Such a path is
 * answered with a message and NOTHING is written — resolved at the moment of
 * asking, from the same functions the engines resolve those roots with.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { resolveCodexRoot } from './codex/locate.js';
import { observedRootOf } from './insights-export.js';
import { opencodeDataDir } from './opencode/index.js';
import { resolveProjectsRoot } from './parser/tailer.js';

/** The directories an export must never write into, resolved now. */
export function observedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    join(homedir(), '.claude'),
    resolveProjectsRoot({ env }).root,
    resolveCodexRoot({ env }).root,
    opencodeDataDir(env),
  ];
}

/**
 * Is `path` inside an observed engine's directory? Returns the root it is
 * inside, for the message, or `null`.
 */
export function refusedExportPath(path: string): string | null {
  return observedRootOf(path, observedRoots());
}

/** The sentence a refused path is answered with. */
export function refusedExportMessage(path: string, root: string): string {
  return `Agent Deck: ${path} is inside ${root}, which Agent Deck only reads; nothing was written.`;
}

/**
 * Write one exported file, or refuse — G1 first, then the write. Never
 * throws: a refusal or a failed write is SAID, with a message, and the answer
 * says whether the file was written.
 */
export async function writeExportFile(
  uri: vscode.Uri,
  text: string,
  log: (line: string) => void,
): Promise<boolean> {
  const inside = refusedExportPath(uri.fsPath);
  if (inside !== null) {
    void vscode.window.showInformationMessage(refusedExportMessage(uri.fsPath, inside));
    return false;
  }
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    return true;
  } catch (error) {
    void vscode.window.showInformationMessage(`Agent Deck: ${uri.fsPath} could not be written.`);
    log(`insights export: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
