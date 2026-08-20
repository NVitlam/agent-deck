<script lang="ts">
  import type { SessionSummary } from './store.js';
  import { displayLiveness, livenessLabel, livenessTitle } from './format.js';

  // A refused session displays `unsupported` here even when the last snapshot
  // said `live`: a `schemaMismatch` message refuses without changing the
  // liveness on the wire, and a rail saying "live" beside a main pane showing
  // the refusal screen is two surfaces disagreeing about one session.
  const shown = (session: SessionSummary): 'live' | 'idle' | 'ended' | 'unsupported' =>
    displayLiveness(session.liveness, session.refused);

  let {
    sessions,
    selectedSessionId,
    onselect,
  }: {
    sessions: readonly SessionSummary[];
    selectedSessionId: string | undefined;
    onselect: (sessionId: string) => void;
  } = $props();
</script>

<nav class="rail" data-testid="session-rail" aria-label="Sessions">
  <h2 class="rail-title">Sessions</h2>
  {#if sessions.length === 0}
    <p class="empty" data-testid="rail-empty">No sessions observed yet.</p>
  {:else}
    <ul>
      {#each sessions as session (session.sessionId)}
        <li>
          <button
            type="button"
            class="rail-item"
            class:selected={session.sessionId === selectedSessionId}
            data-testid="rail-item"
            data-session-id={session.sessionId}
            data-selected={String(session.sessionId === selectedSessionId)}
            data-liveness={shown(session)}
            data-refused={String(session.refused)}
            aria-current={session.sessionId === selectedSessionId}
            onclick={() => onselect(session.sessionId)}
          >
            <span class="rail-label">{session.label}</span>
            <span class="rail-meta">
              <span
                class="liveness liveness-{shown(session)}"
                data-testid="rail-liveness"
                data-liveness={shown(session)}
                title={livenessTitle(shown(session))}
                ><span class="dot" aria-hidden="true"></span>{livenessLabel(shown(session))}</span
              >
              {#if !session.workspaceMatch}
                <span class="foreign" data-testid="rail-foreign">other workspace</span>
              {/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
  .rail {
    border-right: 1px solid var(--vscode-panel-border, transparent);
    min-width: 180px;
    max-width: 260px;
    overflow-y: auto;
    padding: 6px 0;
  }

  .rail-title {
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.7;
    margin: 0 10px 6px 10px;
    font-weight: 600;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .rail-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 4px 10px;
  }

  .rail-item:hover {
    background: var(--vscode-list-hoverBackground, transparent);
  }

  .rail-item.selected {
    background: var(--vscode-list-activeSelectionBackground, transparent);
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }

  .rail-label {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail-meta {
    display: block;
    font-size: 0.8em;
    opacity: 0.75;
  }

  /* Same four-state treatment as the header: colour plus a filled/hollow dot,
     so the states stay apart in greyscale and for a colour-blind reader. */
  .liveness {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }

  .dot {
    width: 0.55em;
    height: 0.55em;
    border-radius: 50%;
    border: 1px solid currentColor;
    align-self: center;
  }

  .liveness-live {
    color: var(--vscode-charts-green, inherit);
    opacity: 1;
  }

  .liveness-live .dot {
    background: currentColor;
  }

  .liveness-idle {
    color: var(--vscode-charts-yellow, inherit);
    opacity: 1;
  }

  .liveness-ended .dot {
    background: currentColor;
    opacity: 0.5;
  }

  .liveness-unsupported {
    color: var(--vscode-errorForeground, inherit);
    opacity: 1;
  }

  .liveness-unsupported .dot {
    border-style: dashed;
  }

  .foreign {
    margin-left: 6px;
    font-style: italic;
  }

  .empty {
    margin: 0 10px;
    font-size: 0.9em;
    opacity: 0.75;
  }
</style>
