<script lang="ts">
  import type { SessionSummary } from './store.js';
  import { livenessLabel } from './format.js';

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
            aria-current={session.sessionId === selectedSessionId}
            onclick={() => onselect(session.sessionId)}
          >
            <span class="rail-label">{session.label}</span>
            <span class="rail-meta">
              <span
                class="liveness liveness-{session.liveness}"
                data-testid="rail-liveness">{livenessLabel(session.liveness)}</span
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

  .liveness-live {
    color: var(--vscode-charts-green, inherit);
    opacity: 1;
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
