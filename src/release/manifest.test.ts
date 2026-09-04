/**
 * The release manifest: marketplace identity, licence, and what the package
 * file is allowed to throw away.
 *
 * Every assertion here is a defect this repo can ship SILENTLY. None of it
 * changes behaviour at runtime, so nothing else in the suite goes red when it
 * drifts — the failure surfaces on the marketplace listing or in a legal
 * question, both of which are after the fact.
 *
 *   identity          `publisher` and `name` compose the marketplace ID
 *                     `nvitlam.agent-deck`. Asserting the halves separately
 *                     passes while the composed string is wrong, so the
 *                     composed string is what is asserted. NOTE: this is a
 *                     check on the MANIFEST only. There is no publisher
 *                     account and no PAT, so a publisher-side name collision
 *                     remains possible and is not measured by anything here.
 *
 *   naming            PLAN: "never lead naming with Claude". This is a
 *                     trademark posture, not a preference — an extension whose
 *                     first word is the vendor's product name reads as
 *                     first-party. A regex on the FIRST WORD, because
 *                     "Agent Deck for Claude Code" must keep passing.
 *
 *   keywords          Ordered, exact. Marketplace search ranks on them and
 *                     PLAN pins the list, so "someone appended one" and
 *                     "someone dropped one" are both regressions. The list is
 *                     SIX at v0.5.0: Phase 8 DoD 8.1 added `opencode`, by a
 *                     deliberate edit here in the same commit as the manifest,
 *                     which is the only way this list is allowed to move.
 *
 *   licence           `"license": "MIT"` with no LICENSE file is the defect
 *                     this pins: the manifest asserts a grant the artifact
 *                     does not carry. Both halves, plus the actual MIT
 *                     sentences, because a file named LICENSE containing
 *                     anything at all would otherwise satisfy the check.
 *
 *   version           `0.0.0` is npm's placeholder. A VSIX published at
 *                     `0.0.0` cannot be superseded by a patch release.
 *
 *   repository        `vsce package` warns without one, and the warning is
 *                     easy to scroll past. The repo is PRIVATE today; that is
 *                     expected and is not what this asserts.
 *
 *   hook port         `agentDeck.port`'s default and `DEFAULT_HOOK_PORT` in
 *                     `src/hooks/listener.ts` were two agreeing literals with
 *                     nothing between them. The constant is IMPORTED here and
 *                     compared to the manifest, because this repo has already
 *                     shipped one silently inert extension from a manifest and
 *                     a build disagreeing, and "both sides are internally
 *                     consistent" is what that failure looks like from inside
 *                     either side. `src/release/readme.test.ts` binds the
 *                     README's pasted literal to the same two, closing the
 *                     triangle rather than leaving a chain of two edges.
 *
 *   .vscodeignore     The two files a user is entitled to — the licence and
 *                     the README — are the two most likely to be swept up by
 *                     a broad exclusion glob. Checked by expanding every
 *                     pattern in the file, not by substring, so a future
 *                     `**` rule that happens to cover them fails here.
 *
 * Deliberately NOT here: `main` resolving to a real file that exports
 * `activate`. `src/extension.test.ts` already loads whatever path `main`
 * names and asserts it — that is the "manifest and build disagree" guard and
 * it belongs next to the build, not next to the licence.
 *
 * Also not here: unzipping or listing the VSIX. `src/release/vsix.test.ts`
 * owns that; an ignore file cannot answer "what does the package contain".
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_HOOK_PORT } from '../hooks/listener.js';

const REPO_ROOT = new URL('../../', import.meta.url);

const readRepoFile = (relative: string): Promise<string> =>
  readFile(fileURLToPath(new URL(relative, REPO_ROOT)), 'utf8');

interface Manifest {
  name?: unknown;
  displayName?: unknown;
  description?: unknown;
  publisher?: unknown;
  version?: unknown;
  license?: unknown;
  keywords?: unknown;
  repository?: unknown;
  contributes?: {
    configuration?: {
      properties?: Record<string, { default?: unknown; minimum?: unknown; maximum?: unknown } | undefined>;
    };
  };
}

const readManifest = async (): Promise<Manifest> =>
  JSON.parse(await readRepoFile('package.json')) as Manifest;

/**
 * PLAN, Phase 5: exactly these, in this order.
 *
 * `opencode` was added at Phase 8 (DoD 8.1) and is SIXTH deliberately. Order is
 * asserted because the Marketplace ranks on it, and `v0.5.0` ships a second
 * observation engine without changing what the extension leads with: it is
 * still, first, for Claude Code.
 */
const EXPECTED_KEYWORDS = [
  'claude code',
  'observability',
  'agents',
  'monitor',
  'subagents',
  'opencode',
  // v0.6.0. One keyword per observed engine, and the order is the order the
  // engines arrived, which is also the order the README introduces them.
  'codex',
];

/** The first word, case-insensitively — "Claude Code" is fine anywhere else. */
const LEADS_WITH_CLAUDE = /^claude\b/i;

describe('marketplace identity', () => {
  it('composes to nvitlam.agent-deck', async () => {
    const manifest = await readManifest();
    expect(manifest.name).toBe('agent-deck');
    expect(manifest.publisher).toBe('nvitlam');
    // The composed string is the identity. Asserting the halves alone passes
    // while the thing a user installs is named something else.
    expect(`${String(manifest.publisher)}.${String(manifest.name)}`).toBe(
      'nvitlam.agent-deck',
    );
  });

  /**
   * GATE H1 (DoD 5.4), decided by the user on 2026-09-05.
   *
   * It was 'Agent Deck for Claude Code', which named one of three observed
   * engines in the string a user reads first. The gate existed to protect one
   * property - that the name does not LEAD with 'Claude' - and the new one
   * clears it by not naming an engine at all.
   *
   * The Marketplace ID `nvitlam.agent-deck` is permanent and is untouched by
   * this; a display name is not an identity. The test above pins that.
   *
   * THE ANGLE BRACKETS IN THE RULING ARE NOT PART OF THE STRING. It was
   * written `Agent Deck - <Watch Your Agents Work.>`, and the brackets are
   * read as delimiting the text that fills the blank rather than as literal
   * characters. Recorded here rather than silently normalised, because a
   * displayName carrying `<` and `>` would be a deliberate choice and this is
   * where a reader would come to correct it.
   *
   * The dash is an EM DASH (U+2014), asserted by code point rather than by
   * eye: this repository has shipped seven em dashes silently turned into the
   * control byte 0x14 by a latin1 write, and a hyphen here would be a
   * different name that looks the same in a diff.
   */
  it('displays as the Gate H1 name, with a real em dash', async () => {
    const manifest = await readManifest();
    expect(manifest.displayName).toBe('Agent Deck \u2014 Watch Your Agents Work.');
    const dashes = [...String(manifest.displayName)].filter((c) => c === '\u2014');
    expect(dashes, 'the separator must be one em dash, not a hyphen').toHaveLength(1);
    expect(String(manifest.displayName)).not.toContain('<');
    expect(String(manifest.displayName)).not.toContain('>');
  });

  it('leads none of displayName, name or description with "Claude"', async () => {
    const manifest = await readManifest();
    for (const field of ['displayName', 'name', 'description'] as const) {
      const value = manifest[field];
      expect(typeof value, `package.json must declare a string ${field}`).toBe('string');
      expect(
        LEADS_WITH_CLAUDE.test(String(value)),
        `${field} leads with "Claude": ${String(value)}`,
      ).toBe(false);
    }
  });

  /**
   * THE DESCRIPTION, HELD TO THE SAME STANDARD AS THE DISPLAY NAME, and for
   * the same reason: the Marketplace shows both, one under the other.
   *
   * It read 'Live observability for Claude Code multi-agent sessions' until
   * 0.6.0 - naming ONE of the three engines this extension observes, in the
   * sentence directly beneath the name Gate H1 had just changed for exactly
   * that property. H1 addressed `displayName` and stopped there, so the
   * description was left saying what the name had been corrected for saying.
   * Nothing asserted it at all: it was raised at the Phase 5 gate by a
   * `phase-verifier`, as a thing nobody had claimed.
   *
   * The em dash is checked BY CODE POINT, the same discipline `displayName`
   * gets above and for the same recorded reason - this repository has shipped
   * seven em dashes silently turned into the control byte 0x14 by a latin1
   * write, and a hyphen substituted here would be a different string that
   * looks identical in a diff.
   */
  it('describes all three engines, with a real em dash', async () => {
    const manifest = await readManifest();
    expect(manifest.description).toBe(
      'Live observability for coding-agent swarms \u2014 Claude Code, OpenCode and Codex, ' +
        'side by side in VS Code. Read-only, zero egress.',
    );

    const description = String(manifest.description);
    const dashes = [...description].filter((c) => c === '\u2014');
    expect(dashes, 'the separator must be one em dash, not a hyphen').toHaveLength(1);

    // The engine SET, asserted separately from the sentence. The wording may
    // be rewritten; a rewrite that silently drops an engine is the defect this
    // item exists to prevent, and it would read perfectly well.
    for (const engine of ['Claude Code', 'OpenCode', 'Codex']) {
      expect(description, `the description does not name ${engine}`).toContain(engine);
    }
  });
  it('carries exactly the PLAN keywords, in order, and the count beside the set', async () => {
    const manifest = await readManifest();
    expect(manifest.keywords).toEqual(EXPECTED_KEYWORDS);
    // Rule 19's shape: the count beside the set, so a comparison written
    // accidentally against an empty or filtered list cannot pass vacuously.
    expect(manifest.keywords).toHaveLength(7);
  });

  it('names the repository vsce asks for', async () => {
    const manifest = await readManifest();
    const repository = manifest.repository as { url?: unknown } | undefined;
    expect(typeof repository?.url, 'package.json must declare repository.url').toBe(
      'string',
    );
    // DERIVED, not hardcoded, and that is the point rather than a tidy-up.
    // The owner segment is the developer's GitHub handle - one of the two
    // identity strings the scrub of 2026-08-28 leaves standing, and it stands
    // in `package.json` ALONE. Writing it here as a literal would put it back
    // into a second file and make the scrub's success criterion - a `git grep`
    // returning zero outside the licence and the manifest - false. It would
    // also be a literal the redactor rewrote, which is how this line briefly
    // came to read `github.com/dev/agent-deck` and assert a repository nobody
    // owns.
    //
    // Asserting the SHAPE, with the repo segment bound to the manifest's own
    // `name`, still catches every failure the literal caught: a missing url, a
    // non-GitHub url, an http url, or a url naming a different extension.
    const url = String(repository?.url);
    const shape = new RegExp(
      `^https://github\\.com/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/${String(manifest.name)}\\.git$`,
    );
    expect(url, `repository.url is not an https GitHub url for ${String(manifest.name)}`).toMatch(
      shape,
    );
  });

  it('declares a version that is not the 0.0.0 placeholder', async () => {
    const manifest = await readManifest();
    const version = String(manifest.version);
    expect(version, `not semver: ${version}`).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    );
    expect(version).not.toBe('0.0.0');
  });
});

describe('licence', () => {
  it('declares MIT in the manifest', async () => {
    const manifest = await readManifest();
    expect(manifest.license).toBe('MIT');
  });

  it('ships a real LICENSE file carrying the MIT grant and disclaimer', async () => {
    // A `license` field with no licence file is the defect. Reading the file
    // is the whole point: ENOENT here fails the test.
    const licence = await readRepoFile('LICENSE');
    expect(licence).toContain('Permission is hereby granted, free of charge');
    expect(licence).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(licence, 'LICENSE carries no "Copyright (c) <year>" line').toMatch(
      /Copyright \(c\) \d{4}\b/,
    );
  });
});

describe('the hook port', () => {
  /**
   * The manifest advertises the default to the user's settings UI; the
   * listener is what actually binds. They were two literals that happened to
   * agree. A user reading `47821` in the settings UI and pasting a hook block
   * that POSTs there gets silence — not an error — if the listener defaults
   * elsewhere, because the hook takes ECONNREFUSED and exits 0 by design.
   */
  it('has one default, imported from the listener rather than restated', async () => {
    const manifest = await readManifest();
    const property = manifest.contributes?.configuration?.properties?.['agentDeck.port'];
    expect(property, 'package.json contributes no agentDeck.port setting').toBeDefined();
    expect(
      typeof property?.default,
      'agentDeck.port declares no numeric default',
    ).toBe('number');
    expect(
      property?.default,
      'package.json agentDeck.port default and DEFAULT_HOOK_PORT disagree',
    ).toBe(DEFAULT_HOOK_PORT);
  });

  it('declares bounds that admit the default it advertises', async () => {
    // A default outside the declared range is a settings UI that rejects its
    // own initial value; cheap to state here, invisible until a user opens it.
    const manifest = await readManifest();
    const property = manifest.contributes?.configuration?.properties?.['agentDeck.port'];
    expect(typeof property?.minimum).toBe('number');
    expect(typeof property?.maximum).toBe('number');
    expect(Number(property?.minimum)).toBeLessThanOrEqual(DEFAULT_HOOK_PORT);
    expect(Number(property?.maximum)).toBeGreaterThanOrEqual(DEFAULT_HOOK_PORT);
  });
});

/**
 * Expand one `.vscodeignore` line into a matcher. `**` crosses directory
 * separators, `*` and `?` do not — the same distinction vsce's globber makes.
 * `**\/` is optional so a root-level file still matches `**\/*.md`, which is
 * exactly the shape that would silently swallow the README.
 */
const globToRegExp = (glob: string): RegExp => {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      source += '.*';
      i += 2;
      continue;
    }
    const char = glob.charAt(i);
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${source}$`);
};

describe('.vscodeignore', () => {
  it('excludes neither LICENSE nor README.md', async () => {
    const patterns = (await readRepoFile('.vscodeignore'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    // A file whose patterns all failed to parse would pass vacuously.
    expect(patterns.length, '.vscodeignore declares no patterns').toBeGreaterThan(0);

    for (const pattern of patterns) {
      // `!` re-includes; it can only ever help these two files.
      if (pattern.startsWith('!')) continue;
      const matcher = globToRegExp(pattern);
      for (const shipped of ['LICENSE', 'README.md']) {
        expect(
          matcher.test(shipped),
          `.vscodeignore pattern "${pattern}" excludes ${shipped}`,
        ).toBe(false);
      }
    }
  });
});
