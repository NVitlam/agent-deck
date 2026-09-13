/**
 * The local store — v0.7.0 Phase 3. The ONLY place Layer 1 writes.
 *
 * G7 as amended (spec section C, and PLAN.md's Grounding Contract):
 *
 *   *No persistence under any engine's directory; no session replay. The
 *   extension MAY keep an append-only, retention-bounded, user-clearable,
 *   setting-disableable history of derived `StatsRecord`s under
 *   `context.globalStorageUri`. The store is never read back into
 *   `SessionState`; it feeds the Trends view and the API only.*
 *
 * Every clause of that sentence is a property of this file, and each is pinned:
 *
 *   - **under `globalStorageUri`** — {@link resolveStoreDir} is the one path
 *     computation, and `store.test.ts` asserts the result is under the
 *     context's own directory and under none of the Claude Code projects root,
 *     the Codex root (including `CODEX_HOME`), the OpenCode data or config
 *     directories, or any workspace folder (DoD 3.1).
 *   - **append-only** — the only write is {@link StatsStore.appendRecord}, and
 *     the only fs call it makes is `appendFileSync`. Nothing here opens a file
 *     for truncation, rewrites a line, or edits a record in place. A superseded
 *     record is a SECOND line, never an edit of the first (DoD 3.2b).
 *   - **retention-bounded** — pruned on write, by `retention.ts`'s pure rule.
 *   - **user-clearable** — {@link StatsStore.clear}; the modal that guards it
 *     lives in `extension.ts`, because a confirmation dialog is a `vscode`
 *     object and this module imports no editor API at all.
 *   - **setting-disableable** — `enabled: false` makes every method a no-op
 *     and creates NO directory (DoD 3.4).
 *   - **never read back into `SessionState`** — enforced statically by
 *     `readback.test.ts`, which asserts nothing under `src/model/`,
 *     `src/parser/`, `src/opencode/` or `src/codex/` imports this file
 *     (DoD 3.6).
 *
 * ## The store adds no field, and that is a G4 property
 *
 * A record's string surface is an allow-list, proved by provenance in
 * `redaction.test.ts`. That proof is worth nothing if the layer that writes
 * records to disk decorates them on the way out. So this module NEVER
 * constructs a field: `appendRecord` takes a record that already carries its
 * `derivedAt`, validates it, and writes `JSON.stringify(record)` verbatim.
 * `store.test.ts` reads the raw line back off disk and requires it to equal
 * the object it was handed.
 *
 * `derivedAt` is therefore the CALLER's stamp. That is not a technicality: the
 * caller owns the clock (`extension.ts` injects one everywhere for exactly this
 * reason), and a store that read the wall clock itself would make every
 * faked-clock test in DoD 3.2b and 3.3 impossible to write.
 *
 * ## A malformed line is counted and skipped, never fatal
 *
 * The parser's posture, applied to this store's own output. A store file can be
 * truncated by a crash mid-append, or hold a record from a future schema
 * version. Neither may take out a read: the line is counted on
 * {@link StatsStore.malformed}, surfaced on the diagnostics channel as
 * `storeMalformed`, and skipped.
 *
 * ## Synchronous on purpose
 *
 * One line per session per emission, at most a few kilobytes, on a path that
 * already runs inside a coalesced emission. An async append would need a queue
 * to keep "append-only" true under concurrent flushes, and a queue is a second
 * account of what is on disk. `appendFileSync` with a single append open is
 * atomic enough for the one property that matters here — a line is whole, or it
 * is skipped by the reader that finds it.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { expiredFileNames, storeFileName } from './retention.js';
import type { StatsRecord } from './schema.js';
import { upgradeStatsRecord, validateStatsRecord } from './schema.js';

/** The subdirectory of `globalStorageUri` the store owns. One declaration. */
export const STORE_DIR_NAME = 'stats';

/**
 * Consecutive failed writes before the store stops trying.
 *
 * Three rather than one, because the failures worth surviving are transient —
 * a virus scanner holding a handle, a directory being replaced by a sync
 * client — and giving up on the first is how a working store gets switched off
 * by a hiccup. Three rather than thirty, because the failure worth STOPPING
 * for is permanent (a read-only directory, a full disk) and the deck pumps
 * several times a minute.
 */
export const WRITE_FAILURE_LIMIT = 3;

/**
 * The slice of `vscode.ExtensionContext` the path law needs.
 *
 * Structural rather than imported, for the reason `diagnostics.ts` gives about
 * itself: this module imports no editor API, which is what lets every test
 * here run with a plain temp directory and no mock.
 */
export interface StoreContextLike {
  readonly globalStorageUri: { readonly fsPath: string };
}

/**
 * The store directory for a context: `<globalStorageUri>/stats/`.
 *
 * ONE computation, exported, so the path law has a single subject. VS Code
 * guarantees `globalStorageUri` is per-extension and outside every workspace;
 * what this function adds is that Agent Deck writes under a named
 * subdirectory of it rather than at its root, so a future artefact of a
 * different kind is a sibling rather than something the retention sweep has to
 * be taught to leave alone.
 */
export function resolveStoreDir(context: StoreContextLike): string {
  return join(context.globalStorageUri.fsPath, STORE_DIR_NAME);
}

/**
 * A record as it exists ON DISK: everything the deriver produced, plus the
 * instant the caller derived it.
 *
 * A separate type rather than a field on the derived record itself, and the
 * reason is the goldens. `deriveStats` is a pure function of a state and its
 * parameters, and the committed goldens compare its output byte for byte. A
 * `derivedAt` on the record it returns would be either a constant (untrue) or a
 * clock reading (a moving golden). The instant a record was derived is a fact
 * about the STORE's copy of it, so it lives on the store's type.
 */
export interface StoredStatsRecord extends StatsRecord {
  /** Epoch milliseconds. Set by the caller, never by this module. */
  derivedAt: number;
}

/** What {@link StatsStore.readRecords} was asked for. Both bounds optional. */
export interface ReadOptions {
  /** Drop records derived before this instant. */
  sinceMs?: number;
  /** Return at most this many, after the newest-per-session reduction. */
  limit?: number;
}

export interface StatsStoreOptions {
  /** The resolved store directory. See {@link resolveStoreDir}. */
  dir: string;
  /** `agentDeck.stats.enabled`. `false` writes nothing and reads nothing. */
  enabled: boolean;
  /** `agentDeck.stats.retentionDays`. Applied on every append. */
  retentionDays: number;
  /**
   * Reports a record this store REFUSED to write, and any fs failure.
   *
   * A callback rather than a channel, the same seam `DataPathOptions`'s
   * `onDiagnostic` uses: this class must stay constructible with no editor and
   * no output sink.
   */
  onError?: (error: unknown) => void;
}

/**
 * A store line that could not be read, with what was wrong.
 *
 * Kept as a COUNT plus the last reason rather than a list: a corrupted file
 * could hold thousands of unreadable lines, and a diagnostic surface that grows
 * with the damage is a second failure on top of the first.
 */
interface MalformedState {
  count: number;
  lastReason: string | undefined;
}

/**
 * Append-only JSONL under one directory, one file per ISO week.
 *
 * Constructed per window and held by the host. Holds no file handle and no
 * cached content: every read is a fresh read, because the store may also be
 * written by another VS Code window observing the same machine, and a cache
 * would make this window's view of the history quietly wrong.
 */
export class StatsStore {
  readonly dir: string;
  readonly enabled: boolean;

  readonly #retentionDays: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #malformed: MalformedState = { count: 0, lastReason: undefined };
  #appended = 0;
  #refused = 0;
  #consecutiveWriteFailures = 0;
  #stoodDown = false;

  constructor(options: StatsStoreOptions) {
    this.dir = options.dir;
    this.enabled = options.enabled;
    this.#retentionDays = options.retentionDays;
    this.#onError = options.onError;
  }

  /** Lines this store could not read. Surfaced as `storeMalformed`. */
  get malformed(): number {
    return this.#malformed.count;
  }

  /** Why the last unreadable line was unreadable, for the channel. */
  get lastMalformedReason(): string | undefined {
    return this.#malformed.lastReason;
  }

  /** Records written since construction. Read by tests and by the host. */
  get appended(): number {
    return this.#appended;
  }

  /** Records this store declined to write because they did not validate. */
  get refused(): number {
    return this.#refused;
  }

  /**
   * True once the store has given up writing.
   *
   * A store whose directory cannot be written to fails on EVERY append, and
   * the deck pumps several times a minute — so without this the failure path
   * is a retry storm that reports the same error forever and slows the thing it
   * cannot help. After {@link WRITE_FAILURE_LIMIT} consecutive failures it
   * stands down and says so once.
   *
   * Rule 18: the standing-down is reported, and `storeStoodDown` is readable,
   * so "nothing is being written" is never a silent state. It is NOT
   * permanent for a reason that is not permanent either — a success resets the
   * counter, and a store that stood down is reset by reloading the window,
   * which is what a user does after fixing a full disk.
   */
  get stoodDown(): boolean {
    return this.#stoodDown;
  }

  /**
   * Every store file present, sorted. Empty when disabled or absent.
   *
   * Sorted by NAME, which for `stats-<year>-W<week>.jsonl` is chronological
   * order: the year is four digits and the week is zero-padded to two, so
   * lexical and chronological agree. That is a property of the format
   * `retention.ts` chose, and it is why nothing here parses a name to sort.
   */
  files(): string[] {
    if (!this.enabled) return [];
    if (!existsSync(this.dir)) return [];
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort();
    } catch (error) {
      this.#report(error);
      return [];
    }
  }

  /**
   * Append one record, then prune.
   *
   * The record is written EXACTLY as given — see the module header. It is
   * validated first, and a record that does not validate is refused rather
   * than repaired: this store is the last thing between a derived record and a
   * durable file, and a field it does not recognise is a field the provenance
   * proof never covered.
   */
  appendRecord(record: StoredStatsRecord): void {
    if (!this.enabled || this.#stoodDown) return;
    const validation = validateStatsRecord(record);
    const stampOk = typeof record.derivedAt === 'number' && Number.isFinite(record.derivedAt);
    if (!validation.ok || !stampOk) {
      this.#refused += 1;
      const why = validation.ok ? 'derivedAt is not a finite number' : validation.errors.join('; ');
      this.#report(new Error(`stats store refused a record for ${record.sessionId}: ${why}`));
      return;
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, storeFileName(record.derivedAt));
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      this.#appended += 1;
      this.#consecutiveWriteFailures = 0;
    } catch (error) {
      this.#consecutiveWriteFailures += 1;
      this.#report(error);
      if (this.#consecutiveWriteFailures >= WRITE_FAILURE_LIMIT) {
        this.#stoodDown = true;
        this.#report(
          new Error(
            `stats store stood down after ${String(WRITE_FAILURE_LIMIT)} consecutive ` +
              `write failures under ${this.dir}; no further records will be written ` +
              'in this window. Reload the window once the directory is writable.',
          ),
        );
      }
      return;
    }
    this.#prune(record.derivedAt);
  }

  /**
   * The newest record per session, newest first.
   *
   * ## The reduction, and the tie-break
   *
   * "Reopen = supersede" (the locked open question) means a session can hold
   * several lines, and reads keep the newest per `sessionId`. `derivedAt`
   * decides that, and where two records of one session carry the SAME
   * `derivedAt` the later LINE wins — append order, which is the only other
   * fact on disk. That is deliberate rather than incidental: the alternative
   * was to fabricate a distinct timestamp for the second record, and a
   * manufactured clock reading is worse than a documented tie-break.
   */
  readRecords(options: ReadOptions = {}): StoredStatsRecord[] {
    if (!this.enabled) return [];
    const newest = new Map<string, { record: StoredStatsRecord; index: number }>();
    let index = 0;
    for (const name of this.files()) {
      let text: string;
      try {
        text = readFileSync(join(this.dir, name), 'utf8');
      } catch (error) {
        this.#report(error);
        continue;
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        index += 1;
        const record = this.#parseLine(line, name);
        if (record === null) continue;
        if (options.sinceMs !== undefined && record.derivedAt < options.sinceMs) continue;
        const held = newest.get(record.sessionId);
        // `>=` so a later line wins a tie. See the doc comment above.
        if (held === undefined || record.derivedAt >= held.record.derivedAt) {
          newest.set(record.sessionId, { record, index });
        }
      }
    }
    const ordered = [...newest.values()].sort((a, b) =>
      a.record.derivedAt === b.record.derivedAt
        ? b.index - a.index
        : b.record.derivedAt - a.record.derivedAt,
    );
    const records = ordered.map((entry) => entry.record);
    return options.limit === undefined ? records : records.slice(0, Math.max(0, options.limit));
  }

  /**
   * Remove the store directory and everything in it.
   *
   * Called only from the `agentDeck.stats.clearHistory` command, behind a modal
   * confirm. `force: true` so clearing a store that was never written is a
   * success rather than an error a user has to interpret.
   */
  clear(): void {
    if (!this.enabled) return;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch (error) {
      this.#report(error);
    }
  }

  /**
   * One line to a record, or `null` with the malformed counter moved.
   *
   * Two gates, both counted the same way: JSON that will not parse (a
   * truncated line), and JSON that parses into something that is not a record
   * carrying a `derivedAt`. The second matters as much as the first — a line
   * written by a future schema version is not a record this version may hand to
   * a reader.
   */
  #parseLine(line: string, file: string): StoredStatsRecord | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#countMalformed(`${file}: line is not JSON`);
      return null;
    }
    // v0.8.0 DoD 7.14 (R3): a line an older version wrote is READ, in the current
    // shape, with its missing facts named. The line on disk is not touched.
    parsed = upgradeStatsRecord(parsed);
    const validation = validateStatsRecord(parsed);
    if (!validation.ok) {
      this.#countMalformed(`${file}: ${validation.errors[0] ?? 'invalid record'}`);
      return null;
    }
    const record = parsed as StoredStatsRecord;
    if (typeof record.derivedAt !== 'number' || !Number.isFinite(record.derivedAt)) {
      this.#countMalformed(`${file}: derivedAt is not a finite number`);
      return null;
    }
    return record;
  }

  #countMalformed(reason: string): void {
    this.#malformed.count += 1;
    this.#malformed.lastReason = reason;
  }

  /** Delete every file whose ISO week ended more than `retentionDays` ago. */
  #prune(nowMs: number): void {
    for (const name of expiredFileNames(this.files(), nowMs, this.#retentionDays)) {
      try {
        unlinkSync(join(this.dir, name));
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // A reporting sink that throws must never be the thing that breaks the
      // store it is reporting on. Same rule as `DiagnosticsChannel`'s writer.
    }
  }
}
