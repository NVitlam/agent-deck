/**
 * Where the built webview assets live inside the packaged extension.
 *
 * Moved here from `src/extension.ts` in v0.7.0 Phase 4 so the sidebar
 * controller (`src/sidebar/provider.ts`) can name the SAME two files the panel
 * loads without importing the whole host module. One definition, two
 * consumers: the sidebar and the panel serve one bundle by construction, which
 * is the property "same single bundle" (spec §G2) needs to be true rather than
 * asserted.
 *
 * `extension.ts` re-exports both names so every existing caller and test keeps
 * its import.
 */
export const WEBVIEW_SCRIPT_SEGMENTS = ['dist', 'webview', 'main.js'] as const;
export const WEBVIEW_STYLE_SEGMENTS = ['dist', 'webview', 'main.css'] as const;
