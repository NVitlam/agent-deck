// Agent Deck - the FROZEN reference layout, for Phase 7 to build against.
//
// PROVENANCE. This is `docs/ui/goldens.mjs`, moved here on 2026-08-28 by the
// public/private split. `docs/` is in the maintainer's private repository now,
// and this file is the one thing under it that the PUBLIC repository needs:
// the frozen canvas design's layout arithmetic, which `webview/layout.ts` must
// reproduce and whose numbers `design.md` section 7 tabulates.
//
// It is a REFERENCE, not the implementation. Nothing in the shipped extension
// imports it - `.vscodeignore` keeps it out of the artifact along with the rest
// of `webview/` source - and it must not be edited to make a test pass. If the
// production layout disagrees with this file, one of the two is wrong and the
// answer is in the design, not in whichever one is easier to change.
//
// Pure by construction: no DOM, no clock, no randomness. `last` is an offset
// from "now" in milliseconds and only its ORDERING matters, which is what lets
// the file be deterministic without a clock.
//
// Original header follows.
// docs/ui/goldens.mjs — regenerates every table in design.md §7 from the mockups' layout functions.
// Run: node docs/ui/goldens.mjs  → paste/diff against design.md §7. Pure: no DOM, no time, no randomness.
const r3 = v => Math.round(v * 1000) / 1000;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

// ───────────────────────────── Deck (design.md §1.4, §1.5) ─────────────────────────────
// Mock data identical to deck-mockup.html; `last` is offset from "now" in ms (only ordering matters).
const SESSIONS = [
  { id: '6082be25', engine: 'cc', status: 'live',        last: -4000 },
  { id: 'ses_a91f', engine: 'oc', status: 'live',        last: -11000 },
  { id: '4299490e', engine: 'cc', status: 'idle',        last: -140000 },
  { id: 'ses_77c0', engine: 'oc', status: 'idle',        last: -260000 },
  { id: 'b3d1c0a2', engine: 'cc', status: 'unsupported', last: -5400000 },
  { id: 'ses_20de', engine: 'oc', status: 'degraded',    last: -90000 },
  { id: '9f0e11aa', engine: 'cc', status: 'ended',       last: -9000000 },
];
const W = 220, H = 88, GX = 16, GY = 12;
const RANK = { live: 0, idle: 1, degraded: 2, unsupported: 3, ended: 4 };
const ENG = { cc: 0, oc: 1 };
const sorters = {
  live:   (a, b) => cmp(RANK[a.status], RANK[b.status]) || cmp(b.last, a.last) || cmp(a.id, b.id),
  recent: (a, b) => cmp(b.last, a.last) || cmp(a.id, b.id),
  engine: (a, b) => cmp(ENG[a.engine], ENG[b.engine]) || sorters.live(a, b),
};
export function deckLayout(list, layout, sort, viewportW) {
  const s = [...list].sort(sorters[sort]);
  if (layout === 'list') return s.map((x, i) => ({ id: x.id, x: 0, y: r3(i * (H + GY)) }));
  if (layout === 'grid') {
    const cols = Math.max(1, Math.floor((viewportW - 24) / (W + GX)));
    return s.map((x, i) => ({ id: x.id, x: r3((i % cols) * (W + GX)), y: r3(Math.floor(i / cols) * (H + GY)) }));
  }
  // lanes — degrade to list when only one engine is visible
  if (new Set(s.map(x => x.engine)).size < 2) return s.map((x, i) => ({ id: x.id, x: 0, y: r3(i * (H + GY)) }));
  const j = { cc: 0, oc: 0 };
  return s.map(x => ({ id: x.id, x: x.engine === 'cc' ? 0 : W + 40, y: r3(j[x.engine]++ * (H + GY)) }));
}

// ───────────────────────────── Tree (design.md §2.1–§2.4, A1.1) ─────────────────────────────
// Mock data identical to tree-mockup.html (labels, tokens, tool statuses drive the A1.1 widths).
const T = (id, seq, status) => ({ id, seq, status });
const S = { agents: [
  { id: 'main', label: 'main',                  tokens: 184300, parent: null,  tools: [T('t1',1,'completed'),T('t2',2,'completed'),T('t3',3,'completed'),T('t4',4,'running'),T('t5',5,'completed'),T('t6',6,'running'),T('t7',7,'error')] },
  { id: 'a1',   label: 'harvest-r1-pair',       tokens: 41200,  parent: 'main', spawnedBy: 't3',    tools: [T('a1t1',1,'completed'),T('a1t2',2,'completed'),T('a1t3',3,'completed')] },
  { id: 'a2',   label: 'privacy-sweep-audit',   tokens: 22800,  parent: 'main', spawnedBy: 't4',    tools: [T('a2t1',1,'completed'),T('a2t2',2,'running')] },
  { id: 'a3',   label: 'readme-guard-rederive', tokens: 9100,   parent: 'main', spawnedBy: 't6',    tools: [T('a3t1',1,'completed'),T('a3t2',2,'running'),T('a3t3',3,'completed'),T('a3t4',4,'running')] },
  { id: 'a1a',  label: 'verify-meta-json',      tokens: 3200,   parent: 'a1',   spawnedBy: 'a1t3',  tools: [T('a1at1',1,'completed')] },
  { id: 'a3a',  label: 'diff-readme-lines',     tokens: 1500,   parent: 'a3',   spawnedBy: 'a3t2',  tools: [T('a3at1',1,'running'),T('a3at2',2,'running')] },
  { id: 'a3b',  label: 'run-vitest-subset',     tokens: 6100,   parent: 'a3',   spawnedBy: 'a3t3',  tools: [T('a3bt1',1,'completed'),T('a3bt2',2,'error')] },
  { id: 'a3aa', label: 'count-anchors',         tokens: 400,    parent: 'a3a',  spawnedBy: 'a3at2', tools: [T('a3aat1',1,'running')] },
] };
const NW_MIN = 168, NH = 52, LEVEL = 112, SIB = 24, DOT_GAP = 13, DOT_Y = NH + 11;
const ADV_SUB = 6.3, ADV_LBL = 7.0; // A1.1 fixed advances: mono 10.5 px / sans 600 12 px
const subText = a => { const r = a.tools.filter(t => t.status === 'running').length; return `${fmtTok(a.tokens)} · ${a.tools.length} calls${r ? ' · ' + r + ' running' : ''}`; };
const lblText = a => (a.label.length > 19 ? a.label.slice(0, 18) + '…' : a.label);
export const nodeWidth = a => Math.ceil(Math.max(NW_MIN, subText(a).length * ADV_SUB + 26, lblText(a).length * ADV_LBL + 64));
function childrenOf(st, id) {
  const p = st.agents.find(a => a.id === id);
  const sq = t => p?.tools.find(x => x.id === t)?.seq ?? 1e9;
  return st.agents.filter(a => a.parent === id).sort((a, b) => sq(a.spawnedBy) - sq(b.spawnedBy) || cmp(a.id, b.id));
}
export function treeLayout(st, root, collapseDepth = Infinity) {
  const out = [], width = new Map(), nw = new Map(st.agents.map(a => [a.id, nodeWidth(a)]));
  function measure(id, d) {
    const k = d + 1 <= collapseDepth ? childrenOf(st, id) : [];
    if (!k.length) { width.set(id, nw.get(id)); return nw.get(id); }
    const w = k.reduce((s, c) => s + measure(c.id, d + 1), 0) + SIB * (k.length - 1);
    width.set(id, Math.max(nw.get(id), w)); return width.get(id);
  }
  function place(id, d, x0) {
    const w = width.get(id), Wn = nw.get(id), x = x0 + (w - Wn) / 2, y = d * (NH + LEVEL);
    const k = d + 1 <= collapseDepth ? childrenOf(st, id) : [];
    out.push({ id, x: r3(x), y: r3(y), w: Wn, depth: d });
    let cx = x0; for (const c of k) { place(c.id, d + 1, cx); cx += width.get(c.id) + SIB; }
  }
  measure(root, 0); place(root, 0, 0); return out;
}
export function dotPos(n, tools, i) { const span = (tools.length - 1) * DOT_GAP; return { x: r3(n.x + n.w / 2 - span / 2 + i * DOT_GAP), y: r3(n.y + DOT_Y) }; }

// ───────────────────────────── Emit, in design.md §7 order ─────────────────────────────
const out = [];
const log = (...a) => out.push(a.join(' '));
log('## Deck goldens (viewportW = 800)\n');
for (const lay of ['list', 'grid', 'lanes']) for (const so of ['live', 'recent', 'engine']) {
  log(`### ${lay} · ${so}\n\n| # | id | x | y |\n|---|---|---|---|`);
  deckLayout(SESSIONS, lay, so, 800).forEach((p, i) => log(`| ${i} | ${p.id} | ${p.x} | ${p.y} |`));
  log('');
}
log('### Tree · node widths (A1.1)\n\n| id | sub text | label | w |\n|---|---|---|---|');
for (const a of S.agents) log(`| ${a.id} | \`${subText(a)}\` | ${lblText(a)} | ${nodeWidth(a)} |`);
log('');
for (const [root, md, label] of [['main', Infinity, 'root=main, no collapse'], ['main', 2, 'root=main, collapseDepth=2'], ['a3', Infinity, 'root=a3 (focus)']]) {
  log(`### Tree · ${label}\n\n| id | depth | x | y | w | spawn-dot x | spawn-dot y |\n|---|---|---|---|---|---|---|`);
  const placed = treeLayout(S, root, md), by = new Map(placed.map(p => [p.id, p]));
  for (const p of placed) {
    const a = S.agents.find(z => z.id === p.id); let dx = '—', dy = '—';
    if (a.parent && by.has(a.parent)) {
      const par = S.agents.find(z => z.id === a.parent), pp = by.get(a.parent), tools = [...par.tools].sort((x, y) => x.seq - y.seq);
      const d = dotPos(pp, tools, tools.findIndex(t => t.id === a.spawnedBy)); dx = d.x; dy = d.y;
    }
    log(`| ${p.id} | ${p.depth} | ${p.x} | ${p.y} | ${p.w} | ${dx} | ${dy} |`);
  }
  log('');
}
process.stdout.write(out.join('\n') + '\n');
