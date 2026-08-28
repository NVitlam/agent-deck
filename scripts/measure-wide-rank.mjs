// Measure the WIDE-RANK corpus against the layout, and print the numbers.
//
// The reproduction half of the wide-rank defect pass. It takes the committed
// corpus, runs the PRODUCTION `webview/layout.ts` over it, and reports what the
// failure was made of and what the fix did:
//
//   1. the LEGACY dot row — per-node span against the node's own footprint, and
//      how many sibling rows overlapped. Computed from the two literals the
//      renderer shipped, because production no longer has dots at all: design
//      amendment A8.1 removed them. This column is the RECORD OF WHY.
//   2. how many filaments the legacy row could draw. The curve anchored on the
//      spawning dot, so a call the cap elided took its curve with it.
//   3. the tree's bounds and the zoom `fitTo` lands on — with A8.4's sibling
//      wrap, which is what the layout now does, and without it, which is what
//      it did.
//
//   node scripts/measure-wide-rank.mjs [--corpus webview/wire/synthetic-wide-rank.json]
//
// Read-only. Prints markdown to stdout; it writes nothing.

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'esbuild';

const argv = process.argv.slice(2);
const corpusAt = argv.indexOf('--corpus');
const corpusPath = corpusAt === -1 ? 'webview/wire/synthetic-wide-rank.json' : argv[corpusAt + 1];

/** Bundle and evaluate the PRODUCTION module, not a transcription of it. */
async function loadLayout() {
  const result = await build({
    stdin: {
      contents: "export * from './layout.js';",
      resolveDir: resolve('webview'),
      sourcefile: 'measure-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
  });
  const text = result.outputFiles?.[0]?.text;
  if (text === undefined) throw new Error('esbuild produced no output');
  return import(`data:text/javascript;base64,${Buffer.from(text, 'utf8').toString('base64')}`);
}

const layout = await loadLayout();
const { treeLayout, nodeWidth, toolChildren, NODE_H, WRAP_AT } = layout;

/**
 * The dot row as the renderer SHIPPED it, quoted rather than derived.
 *
 * `SessionCanvas.svelte` held `DOT_LIMIT = 24` and `DOT_KEEP = 23` with a pitch
 * of 13 and a radius of 4, and consulted nothing about the node it drew under.
 * Nothing in production computes this any more; it is here so the defect can be
 * re-measured rather than remembered.
 */
const LEGACY = { limit: 24, keep: 23, pitch: 13, radius: 4 };

const legacyRow = (calls) => (calls > LEGACY.limit ? LEGACY.keep + 1 : calls);
const legacySpan = (dots) => (dots === 0 ? 0 : (dots - 1) * LEGACY.pitch + 2 * LEGACY.radius);

const corpus = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
const session = corpus.final.sessions[0];
if (session === undefined) throw new Error('corpus carries no session');

const agents = new Map();
(function walk(node) {
  if (!Array.isArray(node.children)) return;
  agents.set(node.id, node);
  for (const kid of node.children) walk(kid);
})(session.root);

const placements = treeLayout(session, session.root.id).filter((p) => !p.hidden);

const rows = placements.flatMap((p) => {
  const agent = agents.get(p.id);
  if (agent === undefined) return [];
  const calls = toolChildren(agent).length;
  const dots = legacyRow(calls);
  const span = legacySpan(dots);
  return [{ id: p.id, depth: p.depth, calls, width: nodeWidth(agent), dots, span, x: p.x }];
});

/** Sibling dot-row pairs that would have overlapped, at the CURRENT placement. */
const byDepth = new Map();
for (const r of rows) byDepth.set(r.depth, [...(byDepth.get(r.depth) ?? []), r]);
const overlaps = [];
for (const list of byDepth.values()) {
  const sorted = [...list].sort((a, b) => a.x - b.x);
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const aRight = a.x + a.width / 2 + a.span / 2;
    const bLeft = b.x + b.width / 2 - b.span / 2;
    if (aRight > bLeft) overlaps.push(Math.round((aRight - bLeft) * 10) / 10);
  }
}
const overhang = rows.filter((r) => r.span > r.width - 8);

/** Filaments the legacy row could draw: the spawning dot had to survive the cap. */
const rootCalls = toolChildren(session.root).map((t) => t.id);
const kept = new Set(rootCalls.length > LEGACY.limit ? rootCalls.slice(-LEGACY.keep) : rootCalls);
const rootEdges = (session.spawnEdges ?? []).filter((e) => e.parentNodeId === session.root.id);
const drawable = rootEdges.filter((e) => kept.has(e.toolUseId));

/** Bounds and fit, with the wrap and without it. */
const FIELD = { width: 1200, height: 640 };
const PAD = 32;
const FLOOR = 0.4;
const boundsOf = (list) => {
  const left = Math.min(...list.map((p) => p.x));
  const right = Math.max(...list.map((p) => p.x + p.w));
  const top = Math.min(...list.map((p) => p.y));
  const bottom = Math.max(...list.map((p) => p.y + NODE_H));
  return { w: right - left, h: bottom - top };
};
const fitOf = (b) => {
  const need = Math.min((FIELD.width - 2 * PAD) / b.w, (FIELD.height - 2 * PAD) / b.h);
  return { need, k: Math.max(FLOOR, Math.min(2, need)), clamped: need < FLOOR };
};
const wrapped = boundsOf(placements);
/** The un-wrapped extent: one row, every sibling in it, same widths and gap. */
const flatW = (() => {
  const kids = placements.filter((p) => p.depth === 1);
  const gap = 24;
  return kids.reduce((sum, p) => sum + p.w, 0) + gap * (kids.length - 1);
})();
// The un-wrapped HEIGHT is three ranks with no extra row, not the wrapped one:
// reusing `wrapped.h` here would have compared a one-row width against a
// two-row height and reported a fit that never existed.
const flatH = 2 * (NODE_H + 112) + NODE_H;
const flat = { w: flatW, h: flatH };

/* --------------------------- report ------------------------------------- */

const out = [];
out.push(`corpus            ${corpusPath}`);
out.push(`nodes drawn       ${String(placements.length)}`);
out.push(`siblings at d1    ${String(placements.filter((p) => p.depth === 1).length)}  (wrap at ${String(WRAP_AT)})`);
out.push('');
out.push('| node | depth | calls | width | legacy dots | legacy span | outside its box? |');
out.push('|---|---|---|---|---|---|---|');
for (const r of rows) {
  out.push(
    `| \`${r.id}\` | ${String(r.depth)} | ${String(r.calls)} | ${String(r.width)} | ` +
      `${String(r.dots)} | ${String(r.span)} | ${r.span > r.width - 8 ? '**YES**' : 'no'} |`,
  );
}
out.push('');
out.push('THE DOT ROW, as it shipped (A8.1 removed it):');
out.push(`  rows exceeding nodeWidth - 8      ${String(overhang.length)} of ${String(rows.length)}`);
out.push(
  `  overlapping sibling pairs         ${String(overlaps.length)}` +
    (overlaps.length > 0 ? `  (worst ${String(Math.max(...overlaps))} units)` : ''),
);
out.push(
  `  filaments the cap allowed         ${String(drawable.length)} of ${String(rootEdges.length)} from the root`,
);
out.push('');
out.push('THE RANK, with and without A8.4 wrap:');
const f = fitOf(flat);
const w = fitOf(wrapped);
out.push(
  `  one row   ${String(Math.round(flat.w))} x ${String(Math.round(flat.h))}   ` +
    `fit needs ${f.need.toFixed(3)} -> ${f.k.toFixed(3)}${f.clamped ? '  CLAMPED, cannot fit' : ''}`,
);
out.push(
  `  wrapped   ${String(Math.round(wrapped.w))} x ${String(Math.round(wrapped.h))}   ` +
    `fit needs ${w.need.toFixed(3)} -> ${w.k.toFixed(3)}${w.clamped ? '  CLAMPED, cannot fit' : '  fits'}`,
);
out.push('');
out.push('AND THE DOTS ARE ACTUALLY GONE, asserted against the shipped module:');
for (const name of ['spawnDotPos', 'SPAWN_DOT_GAP', 'SPAWN_DOT_Y', 'maxDots']) {
  out.push(`  layout.${name.padEnd(16)} ${layout[name] === undefined ? 'absent' : 'PRESENT - A8.1 regressed'}`);
  if (layout[name] !== undefined) process.exitCode = 1;
}

process.stdout.write(out.join('\n') + '\n');
