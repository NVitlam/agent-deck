/**
 * Agent Deck — the OpenTelemetry parse boundary (Component 12).
 *
 * v0.7.0 Phase 1, DoD 1.9. OTLP/HTTP **JSON** bodies in, a small typed slice
 * out. No I/O, no socket: this is a pure function of a request body, which is
 * what lets the tests replay `fixtures/otel-cc-2.1.260/`'s captured bytes
 * exactly as an HTTP receiver would be handed them. The listener ROUTE is
 * Phase 3.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A DROP BOUNDARY, NOT A REDACTION PASS
 * ---------------------------------------------------------------------------
 *
 * The five identity attributes and the three content fields are dropped HERE,
 * where the body is parsed, before anything reaches the session model. That is
 * the G4 pattern and it is deliberately not a scrub applied afterwards: a scrub
 * can be forgotten by a new caller, and a value that never enters the model
 * cannot leak from it.
 *
 * The way to read the code below is that it never copies a whole attribute bag.
 * Each record is rebuilt from the handful of keys named in
 * {@link TELEMETRY_KEPT_KEYS}, so a NEW attribute Claude Code starts sending —
 * identifying or not — is dropped by construction rather than by a rule someone
 * has to add. An allow-list is the only shape that is safe against a producer
 * that changes under you.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONTENT FIELDS ARE DROPPED EVEN THOUGH THEY ARRIVE REDACTED
 * ---------------------------------------------------------------------------
 *
 * `prompt`, `response` and `user_prompt` arrive carrying the literal string
 * `"<REDACTED>"` — one distinct value each across the whole capture — because
 * `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
 * `OTEL_LOG_TOOL_DETAILS` and `OTEL_LOG_RAW_API_BODIES` were all unset.
 *
 * Those four flags are the USER'S to set, in their own `settings.json`. So the
 * corpus witnesses a safe default and the code must not depend on it: these
 * fields are dropped unconditionally, and `parse.test.ts` proves it by planting
 * real text in each one.
 *
 * ---------------------------------------------------------------------------
 * G3, G5
 * ---------------------------------------------------------------------------
 *
 * Nothing here throws. A body that is not JSON, not an object, or shaped
 * unlike OTLP yields an empty slice with a counter moved — the same
 * refuse-don't-guess posture the three engines use. And nothing here sends:
 * this module only ever reads a string it was handed.
 */

/**
 * The account-linked attributes, dropped at this boundary — DoD 1.9b.
 *
 * **FIVE, not the four the plan and the spec's Component 12 bullet name.**
 * `user.account_id` is a fifth, in a different format from `user.account_uuid`,
 * so a rule written for the uuid does not cover it. Measured against the raw
 * capture before anything was committed: each of the five occurs on 850 of 850
 * records — exactly one per record.
 *
 * Listed here as documentation and as the privacy sweep's counterpart. The
 * actual defence is {@link TELEMETRY_KEPT_KEYS}: nothing outside that list is
 * copied at all, so this set is what a reader checks against, not what the code
 * depends on.
 */
export const TELEMETRY_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'user.email',
  'user.id',
  'user.account_id',
  'user.account_uuid',
  'organization.id',
]);

/**
 * Free-text fields dropped unconditionally — DoD 1.9c.
 *
 * See the header: they arrive as `"<REDACTED>"` today only because four env
 * flags are unset, and those flags belong to the user.
 */
export const TELEMETRY_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'response',
  'user_prompt',
]);

/**
 * Everything Component 12 reads. An allow-list, so an attribute nobody has seen
 * yet is dropped without anyone adding a rule for it.
 */
export const TELEMETRY_KEPT_KEYS: ReadonlySet<string> = new Set([
  'session.id',
  'tool_use_id',
  'tool_name',
  'duration_ms',
  'agent_id',
]);

/** One `claude_code.tool` span, reduced to what the join needs. */
export interface OtelToolSpan {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly durationMs: number;
  /**
   * The subagent that made this call, when it was a subagent's.
   *
   * Measured 4 of 40 spans — the two subagents' own tool calls and nothing
   * else. A main-thread call carries none, which is correct, and is why "spans
   * carry `agent_id`" is the wrong sentence to remember.
   */
  readonly agentId?: string;
}

/** One `claude_code.cost.usage` data point. */
export interface OtelCostPoint {
  readonly sessionId: string;
  /** USD. DELTA temporality, so points SUM rather than replace. */
  readonly usd: number;
}

/** What one or more request bodies reduce to. */
export interface TelemetrySlice {
  readonly toolSpans: readonly OtelToolSpan[];
  readonly costPoints: readonly OtelCostPoint[];
  readonly counts: TelemetryCounts;
}

export interface TelemetryCounts {
  /** Bodies handed in. */
  bodies: number;
  /** Bodies that were not JSON, not an object, or not OTLP-shaped. */
  bodiesUnparseable: number;
  /** Identity attributes seen and dropped. Non-zero is NORMAL, not an alarm. */
  identityAttributesDropped: number;
  /** Content fields seen and dropped. */
  contentFieldsDropped: number;
  /** Records skipped for want of a usable `session.id` or `tool_use_id`. */
  recordsUnusable: number;
}

export function emptyTelemetryCounts(): TelemetryCounts {
  return {
    bodies: 0,
    bodiesUnparseable: 0,
    identityAttributesDropped: 0,
    contentFieldsDropped: 0,
    recordsUnusable: 0,
  };
}

/** Which OTLP signal a body is. The three routes Phase 3 will mount. */
export type OtelSignal = 'metrics' | 'logs' | 'traces';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * An OTLP attribute bag -> only the kept keys, with the drops counted.
 *
 * The counting is not bookkeeping. Rule 18: a check that skips an input has to
 * SAY SO, or a silent drop is indistinguishable from an input that never
 * arrived. `identityAttributesDropped` being non-zero is the NORMAL state and
 * means the boundary is doing its job.
 */
function readAttributes(
  attributes: unknown,
  counts: TelemetryCounts,
): Map<string, string | number> {
  const out = new Map<string, string | number>();
  for (const entry of asArray(attributes)) {
    if (!isRecord(entry)) continue;
    const key = stringOf(entry['key']);
    if (key === undefined) continue;

    if (TELEMETRY_IDENTITY_KEYS.has(key)) {
      counts.identityAttributesDropped += 1;
      continue;
    }
    if (TELEMETRY_CONTENT_KEYS.has(key)) {
      counts.contentFieldsDropped += 1;
      continue;
    }
    // The allow-list. Anything not named is dropped without a counter, because
    // it is neither identifying nor content — merely unread.
    if (!TELEMETRY_KEPT_KEYS.has(key)) continue;

    const value = entry['value'];
    if (!isRecord(value)) continue;
    const asString = stringOf(value['stringValue']);
    if (asString !== undefined) {
      out.set(key, asString);
      continue;
    }
    for (const numeric of ['asDouble', 'asInt', 'intValue', 'doubleValue'] as const) {
      const raw = value[numeric];
      const parsed = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof parsed === 'number' && Number.isFinite(parsed)) {
        out.set(key, parsed);
        break;
      }
    }
  }
  return out;
}

function numberOf(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Parse one OTLP/HTTP JSON body into the slice Component 12 consumes.
 *
 * @param body the request body, exactly as an HTTP receiver is handed it.
 */
export function parseOtlpBody(
  body: string,
  signal: OtelSignal,
  counts: TelemetryCounts = emptyTelemetryCounts(),
): TelemetrySlice {
  counts.bodies += 1;
  const toolSpans: OtelToolSpan[] = [];
  const costPoints: OtelCostPoint[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    counts.bodiesUnparseable += 1;
    return { toolSpans, costPoints, counts };
  }
  if (!isRecord(parsed)) {
    counts.bodiesUnparseable += 1;
    return { toolSpans, costPoints, counts };
  }

  if (signal === 'traces') readSpans(parsed, toolSpans, counts);
  else if (signal === 'metrics') readMetrics(parsed, costPoints, counts);
  // `logs` carries the token/cost surface per request and the content fields.
  // Phase 1 reads nothing from it: F9(c) is Phase 2 and the per-request token
  // split is a Phase 2 refinement of F6/F7. The body is still WALKED, so its
  // identity and content attributes are counted as dropped rather than being
  // quietly ignored.
  else readLogsForCountsOnly(parsed, counts);

  return { toolSpans, costPoints, counts };
}

function readSpans(body: Record<string, unknown>, out: OtelToolSpan[], counts: TelemetryCounts): void {
  for (const resource of asArray(body['resourceSpans'])) {
    if (!isRecord(resource)) continue;
    for (const scope of asArray(resource['scopeSpans'])) {
      if (!isRecord(scope)) continue;
      for (const span of asArray(scope['spans'])) {
        if (!isRecord(span)) continue;
        const attributes = readAttributes(span['attributes'], counts);

        // ONLY `claude_code.tool`. `tool.execution` and `tool.blocked_on_user`
        // measure different intervals of the same call, and summing or
        // preferring one silently would report a duration the engine never
        // stated. 40 of 40 `claude_code.tool` spans carry a `duration_ms`.
        if (stringOf(span['name']) !== 'claude_code.tool') continue;

        const sessionId = attributes.get('session.id');
        const toolUseId = attributes.get('tool_use_id');
        const durationMs = numberOf(attributes.get('duration_ms'));
        if (
          typeof sessionId !== 'string' ||
          typeof toolUseId !== 'string' ||
          durationMs === undefined
        ) {
          counts.recordsUnusable += 1;
          continue;
        }

        const agentId = attributes.get('agent_id');
        const toolName = attributes.get('tool_name');
        out.push({
          sessionId,
          toolUseId,
          toolName: typeof toolName === 'string' ? toolName : '',
          durationMs,
          ...(typeof agentId === 'string' ? { agentId } : {}),
        });
      }
    }
  }
}

function readMetrics(
  body: Record<string, unknown>,
  out: OtelCostPoint[],
  counts: TelemetryCounts,
): void {
  for (const resource of asArray(body['resourceMetrics'])) {
    if (!isRecord(resource)) continue;
    for (const scope of asArray(resource['scopeMetrics'])) {
      if (!isRecord(scope)) continue;
      for (const metric of asArray(scope['metrics'])) {
        if (!isRecord(metric)) continue;
        const sum = metric['sum'];
        if (!isRecord(sum)) continue;
        const isCost = stringOf(metric['name']) === 'claude_code.cost.usage';

        for (const point of asArray(sum['dataPoints'])) {
          if (!isRecord(point)) continue;
          // Every data point's attributes are walked even for a metric we do
          // not read, so the identity drops are COUNTED across the whole body
          // rather than only where a value happened to be wanted.
          const attributes = readAttributes(point['attributes'], counts);
          if (!isCost) continue;

          const sessionId = attributes.get('session.id');
          const usd = numberOf(
            typeof point['asDouble'] === 'number'
              ? point['asDouble']
              : (point['asInt'] as string | number | undefined),
          );
          if (typeof sessionId !== 'string' || usd === undefined) {
            counts.recordsUnusable += 1;
            continue;
          }
          out.push({ sessionId, usd });
        }
      }
    }
  }
}

function readLogsForCountsOnly(body: Record<string, unknown>, counts: TelemetryCounts): void {
  for (const resource of asArray(body['resourceLogs'])) {
    if (!isRecord(resource)) continue;
    for (const scope of asArray(resource['scopeLogs'])) {
      if (!isRecord(scope)) continue;
      for (const record of asArray(scope['logRecords'])) {
        if (!isRecord(record)) continue;
        readAttributes(record['attributes'], counts);
      }
    }
  }
}

/** Merge slices from many bodies into one, preserving the shared counters. */
export function mergeSlices(slices: readonly TelemetrySlice[]): TelemetrySlice {
  const counts = emptyTelemetryCounts();
  const toolSpans: OtelToolSpan[] = [];
  const costPoints: OtelCostPoint[] = [];
  for (const slice of slices) {
    toolSpans.push(...slice.toolSpans);
    costPoints.push(...slice.costPoints);
    counts.bodies += slice.counts.bodies;
    counts.bodiesUnparseable += slice.counts.bodiesUnparseable;
    counts.identityAttributesDropped += slice.counts.identityAttributesDropped;
    counts.contentFieldsDropped += slice.counts.contentFieldsDropped;
    counts.recordsUnusable += slice.counts.recordsUnusable;
  }
  return { toolSpans, costPoints, counts };
}
