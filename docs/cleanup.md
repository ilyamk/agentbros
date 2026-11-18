# Project cleanup

**The repository is the harness, never a project store.** Tracked files are tools, prompts, apps, schemas, docs and structure. Every project, generated file, render and edit lives in its git-ignored footprint, where agents and scripts expect it: `public/projects/{id}`, `src/projects/{id}`, `out/{id}`, `memory/usage/{id}.json` and `.cache/{paid-responses,realtime,realtime-channels,realtime-editors,rhythm-evidence}/{id}` (`projectFootprint()` in `src/lib/pipeline/paths.ts` is the single list). Never commit project or generated material. Tests use `tests/fixtures/legacy/`, never `public/projects/`.

| Scope | Removes | Keeps |
|-------|---------|-------|
| `projects` | Every project footprint | `--keep` projects, `public/shared/` |
| `renders` | `out/*` except `out/qa` | `--keep` projects |
| `bundles` | `out/*/bundle` (rebuilt on demand) | Nothing: `--keep` does not apply |
| `qa` | QA runs, reports and historical runtime snapshots under `out/qa/*` | Installed `out/qa/offline-inference/runtime`, unless `--include-runtime` |
| `cache` | Other `.cache/*` | Per-project state above |
| `memory` | The user's memory | `memory/AGENTS.md`; only when named, not in `all` |

Both commands only print the plan without `--yes`. They refuse the whole request on committed files (unless `--allow-tracked`), uncommitted edits, unsettled paid operations or paths escaping the workspace. Never use `git clean -X` here: it also deletes `.env` and `node_modules`.

`project:remove` also checks for campaign dependencies, refuses symlinked project paths and detects running project commands in the console journal. Close a project's running Remotion Studio before removing it. The command removes Studio state and logs it can associate with that project. Shared media, shared diagnostics and files outside the project footprint stay in place.

A published result can still have an outstanding billing reservation. Use `pnpm cost:report --project <id>` to identify the operations and follow the [billing reconciliation procedure](paid-execution.md). Once the provider records are reconciled, retry deletion.

## Kept film versions

Every full render of a bespoke film is also kept as `out/{id}/versions/<sha256 prefix>.mp4` with an `index.json`, so an earlier, better render can be restored. Nothing prunes them automatically. `pnpm film:versions --project <id>` lists them (size, steps, best); `--prune` plans removal and reports the bytes it would free; `--apply` (which implies `--prune`) deletes the planned copies, then rewrites `index.json` atomically from a fresh read, so a render kept meanwhile survives. A prune always keeps the newest `--keep` versions (default 5), the best (`bestFilmVersion`: measure pass, then critic total), the one equal to the current `out/{id}/film.mp4`, and every version whose sha256 is named by an approval (`pipeline/approvals/`), a chain receipt (`pipeline/chain/`), a delivery snapshot or report (`pipeline/delivery/`) or a render receipt (`out/{id}/*.receipt.json`). It deletes only files inside that project's `versions/` folder. `workspace:clean --scope renders` and `project:remove` still remove the whole `out/{id}`, versions included; there is no separate versions scope, because a prune must also rewrite the index.

## Source hygiene and maintenance cleanup

`pnpm repo:hygiene --check` scans tracked and non-ignored untracked text across formats for machine-specific home/worktree paths and maintenance output tracked as source. It runs in CI and `pnpm check`. `--write` saves a redacted inventory under ignored `out/qa/repository-hygiene/`; it reports the source file and line without copying the private path into another report. Ordinary HTTP paths are not filesystem roots; private paths embedded in query data remain detectable. Symlink targets are inspected without following them and must stay repository-relative.

`pnpm repo:hygiene --clean` previews cleanup of ignored QA outputs. Add `--yes` to apply it through the existing workspace safeguards. It preserves projects, credentials, dependencies, personal memory and the installed local-inference runtime. It never automatically edits or deletes source files based on a heuristic finding. Use `workspace:clean` for other explicit scopes.

Run logs, source snapshots, transient review narratives, local hashes/inodes and historical replay launchers are not production inputs. Store them in ignored `out/qa/`; legacy `docs/verification/`, `docs/workstreams/` and `docs/archive/` are ignored too. A current guide or test referring to an old run does not make that run functional. Preserve portable regression coverage, active plans, curated model/asset data, exact dependency licence decisions and source provenance. Remove obsolete replay consumers with their private fixtures; integrations requiring external engines take explicit versioned runtime inputs.

Native composition profile integrations use `RUN_NATIVE_PROFILE_TESTS=1` with `AGENTBROS_NATIVE_INSTANCES_V1_RUNTIME`, `AGENTBROS_NATIVE_INSTANCES_V2_RUNTIME` and `AGENTBROS_NATIVE_GSAP_RUNTIME`; each file must match the selected product pin. Schema, request routing and invalid-runtime CPU cases run without external inputs.

Model sync/refresh writes diagnostics to `out/qa/model-refresh/`; price-gap diagnostics use `out/qa/model-prices/`. Generated comparison documentation and structured catalogue/price sources remain tracked. The refresh workflow attaches run diagnostics for seven days and commits only functional source changes.

## Markdown and folder audit

Run `pnpm docs:audit` to count Markdown and folders, then `pnpm docs:audit --write` for the complete inventory in `out/qa/docs-audit/report.json`, `files.tsv` and `directories.tsv`. The command scans tracked and non-ignored untracked working-tree text, including contents, headings, explicit status markers and literal references from code, configuration and Markdown. It never deletes or edits source files. Ignored dependencies, caches, projects and personal memory stay outside the scan; the tracked `memory/AGENTS.md` remains an instruction input.

Each file has a role, content hash, `keep` or `review` recommendation, reason and incoming references with source lines. Folders include role counts and a `keep`, `mixed`, `review-only` or `no-markdown` disposition. Folder totals include descendants; `ownMarkdown` counts direct Markdown children. `reviewOnlyDirectories` lists folders with direct Markdown children, no retained Markdown and no other files anywhere below them. Inspect these folders first, then review the remaining individual candidates in mixed folders.

Keep agent prompts and instructions, current product guides and active plans, visual reference/technique cards, portable test fixtures, release inputs, licences and attribution. Completed plans, superseded procedures and one-off agent diagnostics belong in Git history once current guides cover their useful contracts. All run reports belong in ignored output, including unique acceptance runs; their citations do not override source hygiene.

References from historical snapshots, archived reports, test fixtures and release-note inputs do not establish a current dependency. Static references can also be comments or declared output paths; dynamically assembled names and directory-wide loaders may be missed. Review the contents and real consumers before removing a candidate, transfer any unique current guidance, and update incoming links in the same change. A missing reference alone does not make a file disposable. Byte-identical files are reported separately; fixtures and prompts can legitimately share content.
