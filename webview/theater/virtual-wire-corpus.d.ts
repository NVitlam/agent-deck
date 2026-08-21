/**
 * The corpus directory, embedded at build time.
 *
 * `webview/theater/corpus-plugin.mjs` resolves this specifier and inlines
 * every `*.json` under `WIRE_CORPUS_DIR`, keyed by basename. There is no
 * `fetch` and no file read at runtime: the theater is opened as a plain
 * `file://` page, where both would fail, and the shipped webview's G5 guard
 * is not something a dev page should be allowed to teach bad habits about.
 *
 * A specifier rather than a generated file on disk so that nothing generated
 * has to be committed, and so adding a synthetic corpus is a matter of
 * dropping a file into the directory and rebuilding.
 */
declare module 'virtual:wire-corpus' {
  const corpora: Record<string, import('./corpus-types.js').WireCorpus>;
  export default corpora;
}
