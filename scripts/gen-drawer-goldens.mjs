// Generate the drawer-header goldens — v0.9.0 DoD 9.9.
//
//     node scripts/gen-drawer-goldens.mjs            write
//     node scripts/gen-drawer-goldens.mjs --check    compare, write nothing, exit 1 on any difference
//
// WHAT THIS SCRIPT DOES NOT DO
// ----------------------------
// It does not model anything. Every number it writes comes from
// `webview/inspector-header.ts` — `parseHeaderCss` over `Inspector.svelte`'s
// own `<style>` block, then `layoutHeader` — which is the SAME pair
// `inspector-header.test.ts` calls to assert byte equality. One definition,
// two callers: a generator with its own copy of the arithmetic would drift
// from the test, and the failure mode is the worst kind, where the script
// rewrites the goldens into a shape the suite then rejects.
//
// Until 0.9.0 the two tables were hand-written. Three widths is where that
// stops being reasonable, and a third table written by hand from a model that
// now resolves shrink PER ROW is a table nobody can check.
//
// The field TEXTS come from the committed 2400 golden, so all three tables
// describe one header rather than three headers that happen to agree.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { layoutHeader, parseHeaderCss } from '../webview/inspector-header.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'webview', 'goldens', 'drawer');

/**
 * The three widths, and what each is FOR.
 *
 * Narrow / mid / wide, per DoD 9.9. 700 is the narrow case: it is below the
 * width at which the seven fields fit one row, so it is the one that exercises
 * the wrap. 1200 is the width DoD 7.9's shrink fix was pinned at. 2400 is the
 * width the user's v0.7.1 smoke recorded the original overlap at.
 */
const WIDTHS = [
  {
    px: 2400,
    name: 'header-2400.json',
    what: 'the seven header fields at a 2400px panel (wide)',
  },
  {
    px: 1200,
    name: 'header-1200.json',
    what: 'the seven header fields at a 1200px panel (mid)',
  },
  {
    px: 700,
    name: 'header-700.json',
    what: 'the seven header fields at a 700px panel (narrow) - the row wraps',
  },
];

const check = process.argv.includes('--check');

const source = readFileSync(join(ROOT, 'webview', 'Inspector.svelte'), 'utf8');
const css = parseHeaderCss(source);

// The field texts and the reserved width, from the committed wide table.
const seed = JSON.parse(readFileSync(join(DIR, 'header-2400.json'), 'utf8'));
const { fields, reservedPx } = seed;
if (!Array.isArray(fields) || fields.length === 0) {
  throw new Error('header-2400.json carries no fields to seed from');
}

const differences = [];
for (const width of WIDTHS) {
  const layout = layoutHeader({ panelPx: width.px, reservedPx, fields, css });
  const body = `${JSON.stringify(
    { what: width.what, panelPx: width.px, reservedPx, fields, layout },
    null,
    2,
  )}\n`;
  const path = join(DIR, width.name);
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  // Line endings normalised before comparing: the repository checks out CRLF
  // and this script writes LF, and a `--check` that reported every file as
  // changed on a fresh clone would be the `sameGolden` defect all over again.
  const same = current !== null && current.replace(/\r\n/g, '\n') === body.replace(/\r\n/g, '\n');
  if (check) {
    if (!same) differences.push(width.name);
    continue;
  }
  if (!same) writeFileSync(path, body);
  console.log(
    `${same ? 'unchanged' : 'wrote'} ${width.name}: rows=${String(layout.rows)} ` +
      `overlaps=${String(layout.overlaps.length)} clipped=${String(layout.clipped.length)} ` +
      `outside=${String(layout.outside.length)}`,
  );
}

if (check) {
  if (differences.length === 0) {
    console.log(`gen-drawer-goldens --check: ${String(WIDTHS.length)} tables, all current`);
    process.exit(0);
  }
  console.error(`gen-drawer-goldens --check: ${String(differences.length)} difference(s)`);
  for (const name of differences) console.error(`  changed: ${name}`);
  process.exit(1);
}
