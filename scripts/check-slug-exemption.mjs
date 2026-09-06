// Over-breadth control for the `own-slug-cut-by-our-own-truncation` exemption
// in `scripts/privacy-sweep.mjs`.
//
// WHY IT LOOKS LIKE THIS
// ----------------------
// The FIRST version of this control planted one foreign value
// (`c--users-dev-projects-someone-elses-thing`) that the predicate could never
// forgive by construction, and reported PASS. A phase-verifier pointed out
// that such a control cannot fail and therefore measures nothing — the exact
// vacuity class this repository keeps recording — and then demonstrated that
// the rule as written DID forgive three values that name real, different
// locations.
//
// Those three are now the substance of this file. They are regression cases,
// not illustrations: each was genuinely forgiven by the first implementation.
//
// Run: node scripts/check-slug-exemption.mjs
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const dir = 'fixtures/__slug-control';
const file = `${dir}/control.json`;
const report = `${dir}/report.json`;

const CASES = [
  {
    label: 'full own slug',
    value: 'c--Users-dev-projects-agent-deck',
    expectFlagged: false,
    why: 'ours, complete — forgiven by namesOwnProject, not by the rule under test',
  },
  {
    label: 'own slug cut mid-token',
    value: 'c--Users-dev-projects-agent-',
    expectFlagged: false,
    why: 'THE CASE THE RULE IS FOR: our own preview truncation cut inside "agent-deck"',
  },
  {
    label: 'sibling project named agent',
    value: 'c--Users-dev-projects-agent',
    expectFlagged: true,
    why: 'REGRESSION: a COMPLETE slug for a different project, forgiven by the first version',
  },
  {
    label: 'the parent directory',
    value: 'c--Users-dev-projects',
    expectFlagged: true,
    why: 'REGRESSION: a complete location, forgiven by the first version',
  },
  {
    label: 'the home directory',
    value: 'c--Users-dev',
    expectFlagged: true,
    why: 'REGRESSION: a complete location, forgiven by the first version',
  },
  {
    label: 'an unrelated project',
    value: 'c--Users-dev-projects-someone-elses-thing',
    expectFlagged: true,
    why: 'not a prefix of ours at all — the easy case, kept as the floor',
  },
];

mkdirSync(dir, { recursive: true });
let anyBad = false;

for (const c of CASES) {
  // A slug-shaped path, so the FOREIGN scan reaches the slug leg rather than
  // the `cwd` leg (which has its own shape gate and its own exemptions).
  writeFileSync(
    file,
    JSON.stringify({ transcript_path: `/home/x/.claude/projects/${c.value}/s.jsonl` }, null, 2),
    'utf8',
  );
  // READ THE JSON REPORT, NOT THE CONSOLE OUTPUT.
  //
  // The first version of this control grepped stdout for the planted value and
  // reported the real truncation case as FLAGGED when it is forgiven -- because
  // the exemption's own REASON string quotes that exact value, so the needle
  // matched the tool's documentation instead of a violation. That is this
  // repository's recorded "a row ticks on the operator's own text" trap, in the
  // check written to prevent a different one.
  try {
    execFileSync('node', ['scripts/privacy-sweep.mjs', '--untracked', '--json', report], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // A non-zero exit is expected whenever a plant is correctly flagged.
  }
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  const foreign = [
    ...(parsed.workingTree?.foreign ?? []),
    ...(parsed.history?.foreign ?? []),
  ];
  const flagged = foreign.some((f) => String(f.value).toLowerCase() === c.value.toLowerCase());
  const ok = flagged === c.expectFlagged;
  if (!ok) anyBad = true;
  console.log(
    `${ok ? 'OK  ' : 'BAD '} ${c.label.padEnd(28)} flagged=${String(flagged).padEnd(5)} expected=${String(c.expectFlagged).padEnd(5)} ${c.why}`,
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(
  anyBad
    ? '\nCONTROL FAILED — the exemption forgives something that names another location'
    : '\nCONTROL PASSED — only a cut inside one of our own path components is forgiven',
);
process.exit(anyBad ? 1 : 0);
