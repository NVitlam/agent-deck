<script lang="ts">
  let { sessionId }: { sessionId: string } = $props();
</script>

<!-- G3, refuse don't guess. A schema mismatch renders THIS and nothing else:
     no tree, not even a partial one, and not a tree with a warning attached.
     A half-parsed tree looks authoritative and is not, which is worse than
     showing nothing. The caller must not render any tree node alongside this. -->
<section class="refusal" data-testid="refusal-screen" role="alert">
  <h2>Unsupported session</h2>
  <p>
    Agent Deck did not recognise the transcript layout for
    <code data-testid="refusal-session-id">{sessionId}</code>, so it is not
    rendering a tree for it.
  </p>
  <p class="why">
    This is deliberate. Agent Deck reads an undocumented on-disk format; when
    that format does not match what it was pinned against, a partly-understood
    tree would be a confident guess. It refuses instead.
  </p>
  <p class="why">
    Other sessions in the rail are unaffected.
  </p>
</section>

<style>
  .refusal {
    padding: 16px 20px;
    max-width: 46em;
  }

  h2 {
    margin: 0 0 8px 0;
    font-size: 1.1em;
  }

  p {
    margin: 0 0 8px 0;
  }

  .why {
    opacity: 0.8;
    font-size: 0.92em;
  }

  code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, transparent);
    padding: 0 3px;
  }
</style>
