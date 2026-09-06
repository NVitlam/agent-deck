// Vacuity/over-breadth control for the `own-slug-cut-by-our-own-truncation`
// exemption, run as a script rather than a test because the sweep is a CLI.
//
// Plants three values in a scratch file under `fixtures/` and asserts which
// are forgiven. The rule is only worth having if the third is NOT.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const dir = 'fixtures/__slug-control';
const file = `${dir}/control.json`;

const CASES = [
  // 1. the full own slug — forgiven by namesOwnProject, not by the new rule
  { label: 'full own slug', value: 'c--Users-dev-projects-agent-deck', expectFlagged: false },
  // 2. our own slug cut mid-name — the case the rule exists for
  { label: 'own slug, truncated', value: 'c--Users-dev-projects-agent-', expectFlagged: false },
  // 3. A GENUINELY FOREIGN slug that shares our leading path but names a
  //    different project. It is NOT a prefix of ours, so it must still be
  //    flagged. If this is forgiven the rule is a hole, not an exemption.
  { label: 'foreign project', value: 'c--Users-dev-projects-someone-elses-thing', expectFlagged: true },
];

mkdirSync(dir, { recursive: true });
let anyBad = false;

for (const c of CASES) {
  writeFileSync(file, JSON.stringify({ cwd: `C:\\Users\\dev\\projects\\x`, slug: c.value }, null, 2), 'utf8');
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['scripts/privacy-sweep.mjs', '--untracked'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    out = String(err.stdout ?? '');
    code = err.status ?? 1;
  }
  const flagged = /VERDICT FAIL/.test(out) && out.includes(c.value.toLowerCase());
  const ok = flagged === c.expectFlagged;
  if (!ok) anyBad = true;
  console.log(
    `${ok ? 'OK  ' : 'BAD '} ${c.label.padEnd(22)} flagged=${String(flagged)} expected=${String(c.expectFlagged)} exit=${String(code)}`,
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(anyBad ? '\nCONTROL FAILED' : '\nCONTROL PASSED — the rule forgives only our own cut slug');
process.exit(anyBad ? 1 : 0);
