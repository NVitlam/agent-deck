// Agent Deck - in-place path redaction for a captured Claude Code session.
//
// PLAN.md Phase 5.5, DoD 5.5.4.
//
// WHY
// ---
// `AUDIT-2026-08-27` copied a real 8-hour session into
// `fixtures/synthetic-dropped-actions/` so the fix phase would have the corpus
// the defect was reported against. Ten transcripts, 3.1 MB, and **10,248
// developer-identifier hits** in the privacy sweep - every one of them an
// absolute path this machine happens to have.
//
// The corpus is worth committing and those bytes are not. This script removes
// the machine and keeps the evidence.
//
// WHAT IT MUST NOT TOUCH, and why the DoD says so explicitly
// ----------------------------------------------------------
// **Join keys and tool ordinals.** `toolUseId`, `agent_id`, `session_id`,
// `parentUuid`, `uuid`, and the ORDER and COUNT of `tool_use` blocks are the
// whole reason this corpus exists: the audit's measurement is "537 tool calls
// in the JSONL, 537 in the tree". A redaction that shifted one of them would
// destroy the thing it was preserving. Nothing here is keyed on a field name -
// the transform is textual and the patterns are absolute-path shapes, which no
// id in this corpus has.
//
// **The project slug.** `c--Users-<user>-<rest-of-path>` is Claude Code's own
// directory name and it IS a join key: `projectSlug` is derived from it and
// `src/opencode/slug.ts` pins the two engines' agreement on it. It also uses
// `-` as its separator, so no pattern below matches it. That is deliberate,
// not an oversight - and it is why the corpus still needs an ALLOW rule in
// `scripts/privacy-sweep.mjs` after this runs (DoD 5.5.5).
//
// IDEMPOTENCE IS A REQUIREMENT, NOT A NICETY
// ------------------------------------------
// A fixture that changes every time someone runs the tool is a fixture whose
// diffs are all noise. Every replacement produces a token (`<HOME>`, `<USER>`,
// `<HOST>`) that no pattern here matches, so a second run rewrites nothing and
// reports `changed: 0`. The test asserts exactly that.
//
// NO SHEBANG. The recorded vite/CRLF trap: `hashbangRE` is `/^#!.*\n/` and
// JavaScript's `.` does not match `\r`, so a shebang makes this file
// uncollectable in a CRLF checkout while working fine for whoever wrote it.
//
// USAGE
//   node scripts/redact-paths.mjs <dir> [--user <name>] [--host <name>]
//                                       [--dry-run] [--json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Files whose bytes are rewritten. Anything else is left alone and counted. */
const TEXT_EXTENSIONS = new Set(['.jsonl', '.json', '.txt', '.md']);

/** The placeholders. Chosen so no pattern in {@link buildRules} matches them. */
export const HOME_TOKEN = '<HOME>';
export const USER_TOKEN = '<USER>';
export const HOST_TOKEN = '<HOST>';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ordered replacement rules for one (user, host) pair.
 *
 * ORDER MATTERS AND IS THE WHOLE DESIGN. Home-directory prefixes run first, so
 * `C:\Users\<user>\proj\x` becomes `<HOME>\proj\x` rather than
 * `C:\Users\<USER>\proj\x`. Only what is left after that - a bare username
 * somewhere no path prefix explained - falls through to the `<USER>` rule.
 *
 * Each home shape appears TWICE: once raw, once JSON-escaped. A `.jsonl` line
 * carries its cwd with DOUBLED backslashes, so a pattern written only against
 * the raw form silently misses every transcript - which is the same class as
 * the recorded `grep -a` and forward-slash-vs-backslash traps.
 */
export function buildRules(user, host) {
  const u = escapeRegExp(user);
  const rules = [
    // Windows, JSON-escaped backslashes: "C:\\Users\\<user>"
    { id: 'home-win-json', find: new RegExp(`[A-Za-z]:\\\\\\\\Users\\\\\\\\${u}`, 'gi'), replace: HOME_TOKEN },
    // Windows, raw backslashes: C:\Users\<user>
    { id: 'home-win-raw', find: new RegExp(`[A-Za-z]:\\\\Users\\\\${u}`, 'gi'), replace: HOME_TOKEN },
    // Windows, forward slashes: C:/Users/<user>
    { id: 'home-win-fwd', find: new RegExp(`[A-Za-z]:/Users/${u}`, 'gi'), replace: HOME_TOKEN },
    // MSYS / Git Bash: /c/Users/<user>
    { id: 'home-msys', find: new RegExp(`/[a-z]/Users/${u}`, 'gi'), replace: HOME_TOKEN },
    // WSL: /mnt/c/Users/<user>
    { id: 'home-wsl', find: new RegExp(`/mnt/[a-z]/Users/${u}`, 'gi'), replace: HOME_TOKEN },
    // Unix: /home/<user>
    { id: 'home-unix', find: new RegExp(`/home/${u}`, 'gi'), replace: HOME_TOKEN },
    // Anything left: a bare username.
    //
    // Word-bounded so `<user>son` survives, and with a negative lookbehind on
    // `Users-` so the CLAUDE CODE PROJECT SLUG survives too. `-` is a word
    // boundary, so without the lookbehind the pattern reaches straight into
    // the slug `c--Users-<user>-<rest>` and rewrites a join key: `projectSlug` is
    // derived from that string and `src/opencode/slug.ts` pins the two
    // engines' agreement on it. Measured, not reasoned - the first version of
    // this script did exactly that and `redact-paths.test.ts` caught it.
    { id: 'user', find: new RegExp(`(?<!Users-)\\b${u}\\b`, 'g'), replace: USER_TOKEN },
  ];
  if (host && host.toLowerCase() !== user.toLowerCase()) {
    rules.push({ id: 'host', find: new RegExp(`\\b${escapeRegExp(host)}\\b`, 'gi'), replace: HOST_TOKEN });
  }
  return rules;
}

/** Apply every rule to one string. Returns the text and per-rule hit counts. */
export function redactText(text, rules) {
  const hits = {};
  let out = text;
  for (const rule of rules) {
    let count = 0;
    out = out.replace(rule.find, () => {
      count += 1;
      return rule.replace;
    });
    if (count > 0) hits[rule.id] = count;
  }
  return { text: out, hits };
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Redact every text file under `dir`, in place.
 *
 * Exported so the test drives the real function rather than a subprocess -
 * `src/release/redact-paths.test.ts` runs it twice over a temp copy and
 * asserts the second run reports `changed: 0`.
 */
export function redactDirectory(dir, options = {}) {
  const user = options.user ?? os.userInfo().username;
  const host = options.host ?? os.hostname();
  const rules = buildRules(user, host);
  const report = { dir, user, host, files: 0, skipped: 0, changed: 0, hits: {}, changedFiles: [] };

  for (const file of walk(dir)) {
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      report.skipped += 1;
      continue;
    }
    report.files += 1;
    // `latin1` is DELIBERATELY NOT USED, and the reason is recorded in
    // CLAUDE.md: it truncates every code point to its low byte, so an em-dash
    // becomes the control byte 0x14 with no error. Read utf8, write utf8.
    const before = fs.readFileSync(file, 'utf8');
    const { text, hits } = redactText(before, rules);
    if (text === before) continue;
    report.changed += 1;
    report.changedFiles.push(path.relative(dir, file).split(path.sep).join('/'));
    for (const [id, n] of Object.entries(hits)) report.hits[id] = (report.hits[id] ?? 0) + n;
    if (options.dryRun !== true) fs.writeFileSync(file, text, 'utf8');
  }

  return report;
}

function main(argv) {
  const args = argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (dir === undefined) {
    process.stdout.write('usage: node scripts/redact-paths.mjs <dir> [--user u] [--host h] [--dry-run] [--json]\n');
    return 2;
  }
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const options = { dryRun: args.includes('--dry-run') };
  const user = at('--user');
  const host = at('--host');
  if (user !== undefined) options.user = user;
  if (host !== undefined) options.host = host;

  const report = redactDirectory(path.resolve(dir), options);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `redact-paths ${report.dir}\n` +
        `  files=${String(report.files)} skipped=${String(report.skipped)} changed=${String(report.changed)}` +
        `${options.dryRun ? ' (dry run)' : ''}\n` +
        `  hits=${JSON.stringify(report.hits)}\n`,
    );
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith('redact-paths.mjs');
if (invokedDirectly) process.exitCode = main(process.argv);
