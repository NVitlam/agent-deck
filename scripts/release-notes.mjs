// The GitHub Release body for a tag: that version's section of CHANGELOG.md.
//
//     node scripts/release-notes.mjs <version | vVersion> [changelog path]
//
// Prints the section from its `## <version>` heading up to, not including, the
// next `## ` heading, with trailing blank lines removed, and nothing else.
// `.github/workflows/release.yml` hands this to `gh release create
// --notes-file`. Before v0.7.1 (DoD 6.D.5) that step used `--generate-notes`,
// and the two releases it made carry one line each: a "Full Changelog" compare
// link, measured with `gh release view` on 2026-09-11.
//
// REFUSE, DON'T GUESS. A version with no section, or with more than one, exits
// 1 with the reason on stderr and nothing on stdout — so a tag pushed without a
// CHANGELOG entry fails the release job instead of publishing an empty or a
// neighbouring version's body. `0.7.1` does not match a `## 0.7.10` heading:
// the version must be followed by a space or the end of the line.
//
// Line endings are normalised on read. `.gitattributes` is `* text=auto` and a
// Windows runner checks CHANGELOG.md out with CRLF; the output is LF.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The section for `version`, or an error string. Pure, so a test can call it
 * on text it builds rather than only on the committed CHANGELOG.
 *
 * @param {string} text CHANGELOG contents
 * @param {string} version `0.7.1` or `v0.7.1`
 * @returns {{ ok: true, section: string } | { ok: false, reason: string }}
 */
export function changelogSection(text, version) {
  const wanted = version.startsWith('v') ? version.slice(1) : version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(wanted)) {
    return { ok: false, reason: `not a version: ${JSON.stringify(version)}` };
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heading = `## ${wanted}`;
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line === heading || line.startsWith(`${heading} `))
    .map(({ index }) => index);
  if (starts.length === 0) return { ok: false, reason: `no "${heading}" section in the changelog` };
  if (starts.length > 1) {
    return { ok: false, reason: `${String(starts.length)} "${heading}" sections in the changelog` };
  }
  const start = starts[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end);
  while (section.length > 0 && section[section.length - 1].trim() === '') section.pop();
  return { ok: true, section: `${section.join('\n')}\n` };
}

function main() {
  const [version, file] = process.argv.slice(2);
  if (version === undefined) {
    console.error('release-notes: usage: node scripts/release-notes.mjs <version> [changelog]');
    process.exitCode = 1;
    return;
  }
  const path = file ?? join(REPO_ROOT, 'CHANGELOG.md');
  const result = changelogSection(readFileSync(path, 'utf8'), version);
  if (!result.ok) {
    console.error(`release-notes: ${result.reason} (${path})`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.section);
}

// Run only when invoked directly, so the test can import `changelogSection`.
// By file name rather than by comparing paths: on Windows `process.argv[1]` and
// `import.meta.url` can disagree on the drive letter's case.
if (/[\\/]release-notes\.mjs$/.test(process.argv[1] ?? '')) main();
