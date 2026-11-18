# Publishing a public copy

Last updated: 2026-11-18

This repository is a private working copy. Its history and some of its files stay private. The public version is a separate tree with one commit, built by `pnpm export:public`. The tool never rewrites this repository's history, never runs a git command that writes here, and never pushes.

## What is excluded and why

The denylist lives in `public-export.json`, with one glob and one reason per rule. It covers:

- **Private client work**: none is tracked. Project code, scripts and notes live in the git-ignored `src/projects/{id}` and `public/projects/{id}` (`tests/harness-only.test.ts` enforces it); the leak patterns still catch client names.
- **Private working notes**: `docs/workstreams/`, `docs/*-plan.md` and `docs/archive/`.
- **Local verification records**: ignored `out/qa/` and the legacy `docs/verification/` path. Run receipts and local snapshots are not source inputs.
- **Third-party material**: reference imagery and media under `design-reference/{bg-patterns,device-mockup,screenshots,videos}`, any `design-reference/library/*/speech-text.json` that still holds a film's words (`denyByContent`; the tracked layer is structure only, `pnpm ref:redact`), and the vendored `remotion-best-practices` skill, whose upstream grants no redistribution licence (install it from upstream: `.agents/skills/THIRD_PARTY.md`).
- **Private captures and client analyses**: none is tracked. The Motion Lab captures are git-ignored behind `public/motion-lab/sources.json`, and private reference analyses stay in `design-reference/library/` ignored by `.git/info/exclude` (`ref:add --private`, [contributing references](contributing-references.md)).
- **A user's memory**: `memory/` is git-ignored except its rules, `memory/AGENTS.md`, and the rule `memory/**` (with `except: ["memory/AGENTS.md"]`) denies it again in case an entry is ever tracked or un-ignored. That rule is normally reported in `unusedDenyRules`, which is expected. The leak scan also reads every entry under `memory/` (and `AGENTBROS_MEMORY_ROOT`, when set) and decodes each entry with the memory parser and reports any allowed file that contains a line of its summary, quote or body as a `memory-entry <id>` hit. A line counts only with at least four words made of letters, outside code spans and table rows, so separators, code and markup never match; an entry the parser rejects is scanned as raw text.
- **Nonportable test inputs**: home-directory and worktree paths are rejected by source hygiene. Export also denies accidental private test input and its import closure.

The file set is `git ls-files --cached --others --exclude-standard`, so **the export reflects the working tree**. That includes uncommitted edits and new untracked files that are not ignored. Commit or stash anything you do not want published before you run it.

Symlinks in that set (`.claude/agents` and `.claude/skills`, which point into `.agents/`) are recreated in the output with a relative target when the link's own path is allowed and its target resolves inside the tree to an allowed file, or to a directory that is not itself denied and still holds allowed files (so `.claude/skills` survives although one vendored skill is denied). The result lists them under `symlinks.kept` and `symlinks.dropped`. A tracked link that would be lost for any other reason (target outside the tree, denied or empty) fails the export with `VALIDATION`, and nothing is written.

Source files reached through a symlink ancestor are refused. Output containment resolves the nearest existing ancestor, including for a new destination. Unexplained leak hits prevent all copying. Publication writes the exact scanned buffers, retaining executable permissions, so a source edit after scanning cannot introduce unscanned bytes.

## Running the export

```bash
pnpm export:public --dry-run                         # file set, closure and leak scan; writes nothing
pnpm export:public --output ../agentbros
pnpm export:public --output ../agentbros --git   # plus git init and one commit there
```

Rules for `--output`:

- It must be outside the repository.
- It must either not exist yet or be empty.

What `--git` does:

- Runs `git init -b main` and makes one commit, *Initial public release*.
- Writes that commit inside the output directory only.
- Sets the author to `Agent Bros. Pictures contributors <noreply@example.com>`.
- Disables signing and hooks.

The JSON result reports:

- `deniedFiles`, with the reason for each
- `brokenImports`: non-test code that imports a denied file; this must be empty
- `references`: allowed files that mention a denied path, usually dangling doc links
- the leak scan `hits` and `explainedHits`

The leak scan reads every copied file and every path. It looks for:

- home-directory paths
- worktree paths
- client and private project names, and the owner's handle: loaded from the local pattern file described below; these hashes never belong in the tracked config
- e-mail addresses
- provider key formats (sk-style, AWS access-key IDs, GitHub and Slack tokens), and private-key headers

Hits listed under `allowedHits` are explained rather than failed; third-party licence notices are one example. Any other hit exits non-zero unless `--allow-leaks` is given.

The dependency inventory preserves collected copyright notices verbatim. The two
generated licence files, `DEPENDENCY_LICENCES.json` and `contrib/licence-reviews.json`,
explain every e-mail address (package authors change with each regeneration); the
same address anywhere else, and any credential or private key in them, still fails. After export, run
`pnpm deps:licences --check` in the public tree to verify the copied evidence.

## Local patterns and ongoing checks

`public-export.json` is tracked and holds generic patterns and the narrowly scoped `allowedHits`. The scanner, export tool and this guide remain in the exported tree so contributors can run the same checks. Private hashes live only in the git-ignored repository-root `leak-patterns.local.json`. The export also denies that file if it is accidentally tracked.

For a new maintainer checkout, copy `leak-patterns.local.example.json` to `leak-patterns.local.json` and populate its `sha256` arrays locally. The example has the format and empty arrays, with no real hashes. Each digest is SHA-256 of a lower-case token. Matching splits non-alphanumerics and camelCase, and also hashes adjacent pairs in hyphenated words. A token glued into a longer word is not caught. Existing maintainer hashes were moved verbatim; keep that local file when moving checkouts.

The loader merges local patterns with generic patterns for `export:public` and `memory:upstream` whenever the local file exists. `leak:check` uses generic patterns unless `--local` is supplied; that flag requires a valid local file and fails if it is missing. Results report `localPatterns: true|false` in metadata (in `details` on a failed scan). Allowlist rules retain their pattern names, including names supplied only by the local file. Invalid local JSON or hashes fail validation rather than silently disabling protection.

```bash
pnpm leak:check                                      # tracked + untracked, not ignored; no denylist copying
pnpm leak:check --local                              # generic + required private patterns
pnpm leak:check --mode diff --base origin/main        # origin/main to HEAD, added lines and paths only
pnpm leak:check --mode diff --base <base> --head <head> # explicit committed endpoints for CI
```

Tree mode reads working-tree bytes and every candidate path, as the export does. Diff mode reads committed endpoints; unchanged/context lines, removed lines and untracked edits are excluded. Renames are treated as a deletion plus an addition so the new path is checked. Binary contents are skipped in both modes; added binary paths are still checked. Hits carry `file`, `line` (zero for a path), `pattern` and a bounded text excerpt. Unexplained hits produce `VALIDATION` and a non-zero exit. This is a format-based guard, not an exhaustive secret detector.

Install the tracked pre-push hook explicitly, from the repository root:

```bash
chmod +x scripts/hooks/pre-push
git config --local core.hooksPath scripts/hooks
```

No command sets `core.hooksPath` automatically. If the checkout already has hooks, integrate this hook into them instead of replacing their configuration. The hook checks every pushed non-deleted ref with `pnpm leak:check --mode diff --local`, using its configured upstream and the pushed commit. Without an upstream it uses the existing remote tip, then the locally known remote default branch for a new branch. Missing base refs fail closed; fetch/configure the upstream and retry. It never contacts the remote itself. Generic CI checks use explicit base/head refs and omit `--local`.

## Portable test inputs

Tracked tests use portable synthetic fixtures, current product contracts and explicitly installed external tools. Historical private-run launchers, media replays and OS/worktree snapshots are not part of the source distribution. `pnpm repo:hygiene --check` enforces this boundary before export and in CI; generated diagnostics remain ignored under `out/qa/`.

Native composition profile CPU checks run without external files. Runtime integration opts in through the explicit inputs documented in [cleanup](cleanup.md#source-hygiene-and-maintenance-cleanup); it never reads an old QA run. Versioned product and dependency pins remain functional authority, rather than being replaced by fresh test-run hashes.

## Verifying the output

Run these checks **before** you link `node_modules`. Otherwise use `--git` first, because the symlink is not ignored by `node_modules/`:

```bash
cd ../agentbros
pnpm install            # or, for a quick check: ln -s <private repo>/node_modules node_modules
pnpm typecheck
pnpm test:fast          # or: pnpm exec tsx --test tests/compatibility.test.ts tests/cli.test.ts
git log --stat | head   # one commit, expected author
```

Before pushing, run `pnpm leak:check --local` in the maintainer checkout and inspect the export result. Generic checks remain available in exported trees without private patterns.

## Decisions that remain manual

- **Reference analyses**: `design-reference/library/*/` holds our analyses of third-party films: measured layers (speech and screen text as structure only), judged layers, blueprints and breakdowns. No frame, media or verbatim text is tracked, and quotations stay within four words (`pnpm ref:contribute`, `tests/reference-contribute.test.ts`). Still decide whether publishing analyses that name the films is fair use, or keep only the method.
- **`roast-shader.mp4`**: the video itself is not committed; only its provenance sidecar `public/motion-lab/showcase/roast-shader.mp4.provenance.json` is. It was made with GSAP, which the owner cleared on 2026-11-16 under Webflow's standard "no charge" licence ([NOTICE.md](../NOTICE.md)); the sidecar still records `commercialAllowed: unknown` until its rights record is redone.
- **Remotion licence**: Remotion is free for individuals, for-profit organisations with up to 3 employees, non-profits and evaluation; other companies need a Remotion Company License. State this in the README for downstream users. Neither the Business Source License 1.1 on this code nor a commercial licence from the Licensor covers Remotion, and its threshold and counting differ from ours.
- **Licence files**: the public tree must keep `LICENSE` (Business Source License 1.1, `BUSL-1.1`, with its parameters filled in), `LICENSES/GPL-3.0-or-later.txt` (the Licensor's GPL-3.0-or-later Blender code), `NOTICE.md` (licence summary and the map of components under other licences), `COMMERCIAL-LICENSE.md`, `TRADEMARKS.md`, `CLA.md` version 2.0 and `CONTRIBUTING.md`; `package.json` declares `"license": "BUSL-1.1"`. Every Python file that runs inside Blender carries `SPDX-License-Identifier: GPL-3.0-or-later`. Describe the project as source-available, never as open source.
- **Dangling links**: `references` must be empty before the launch export (it was emptied on 2026-11-18). Replace verification links by plain text naming the evidence; replace plan links by the guide named in the plan's `Status:` line. Never rewrite historical evidence to make it pass.
- **Legacy fixtures**: `tests/fixtures/legacy/` keeps anonymised copy from old projects (12 files), including Russian-language lines for a plant-care app and a learning-habit film, and a talking-head demo. Reviewed for tone on 2026-11-18.
