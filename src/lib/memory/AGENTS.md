# Memory library — Agent Rules

Last updated: 2026-11-17

The code behind `pnpm memory` and the `memory` field of next-step answers. What memory is and who writes it: [memory/AGENTS.md](../../../memory/AGENTS.md). Schema: `src/types/memory.ts`; change it only together with this code and that guide.

## Files

| File | Role |
|---|---|
| `index.ts` | `memoryDir`, `loadMemory`, `getMemory`, `addMemory`, `markSeen`, `setStatus`, `moveProposal`, `writeIndex`, `readFreshIndex`, `queryMemory`, `memoryFor`, `consolidate`, `recordMetric`; constants `PROPOSAL_NEXT`, `PROPOSAL_CAUSE_TYPES`, `VERIFY_DAYS` |
| `capture.ts` | Commands' best-effort metrics (`noteMetric` and helpers return a warning, never throw), `readMetrics` (after the id's last `removed` tombstone, written by `noteRemoved` when cleanup deletes the project), `draftEpisode` (one measured episode per project), `projectFromPaths` |
| `upstream.ts` | `pnpm memory:upstream`: an applied or verified proposal's commits as local format-patch files and a generalised `PR.md`, leak-scanned with `src/lib/leak-scan.ts`, merging optional root leak-patterns.local.json when present; never pushes |
| `frontmatter.ts` | The strict front-matter subset: `key: <JSON>` lines, `scope:`, `source:` and `proposal:` as maps indented by two spaces; U+2028 and U+2029 escaped; no YAML dependency |

## Rules

- **Root:** `AGENTBROS_MEMORY_ROOT`, else `<root or cwd>/memory`. Every test process gets a temporary `AGENTBROS_MEMORY_ROOT` from `tests/helpers/memory-root.ts`, and the variable wins over a root argument, so a test that needs its own root sets the variable; never touch the checkout's `memory/`. Under a test runner (`NODE_TEST_CONTEXT`) every write refuses the checkout's `memory/` unless `AGENTBROS_MEMORY_ROOT` names it explicitly; reads are unaffected.
- **Metrics:** `recordMetric(metric, root, { once })` appends one validated line; when `once(existing)` matches a valid line already there (checked under the lock), it writes nothing. It returns whether it wrote.
- **Loading never throws:** an unreadable, invalid or misplaced file (wrong folder, file name not `<id>.md`) or a type folder that is not a folder is a warning.
- **Writes** hold `memory/.lock` (O_EXCL; a lock older than 30 s is broken, a writer waits 15 s, then TIMEOUT). Each file is written to a temporary file, parsed back and compared, then renamed; supersede targets are marked only after the new entry is safe. Every write regenerates `index.json`. Query, get, list and consolidate write nothing, so the MCP tool is read-only.
- **Index:** `index.json` records each entry file's name, mtime and size; `readFreshIndex` returns its rows only while every fingerprint matches, else `undefined` (next-step answers then load the files).
- **Supersede:** a preference, decision or lesson can be superseded only by an entry whose source is the user's words. A proposal is never a supersede target (close it with `moveProposal`); proposals of different `change` are never near-duplicates, so a `retire` proposal can share the words of the change it retires.
- **Ids:** `<type>-<yyyymmdd>-<slug>`; the slug is ASCII words of the summary, a hash for a summary without any, and `-2`, `-3` on a collision.
- **Refusals:** schema errors are `VALIDATION` with the schema's message; an existing id or an active near-duplicate of the same type with overlapping scope (same project, and shared playbooks when both name some; token-set Jaccard >= 0.8) is `FILE_EXISTS`, naming the entry for `--seen` (observations, gaps) or `--supersedes`; an unknown id is `FILE_NOT_FOUND`.
- **Query:** active only by default; proposals only when `types` names `proposal`, so next-step `memory` never carries them; an entry matches when each asked value is in its scope list or the list is empty, and its project is unset or the asked one. Query text with terms drops entries with no hit in summary or body (2026-11-17); text without terms filters nothing. Rank: the user's types (decision, preference, lesson) above the rest; within each, specific scope matches, then text hits, then type (decision, preference, lesson, gap, observation, episode, proposal), then newest. `queryMemory` and `memoryFor` take optional preloaded entries (index.json rows, no body) as a third argument. Dates are local calendar dates. Caps: 7 entries and 1200 summary characters by default.
- **Sightings:** `markSeen` adds one to `occurrences` and appends today's date to `sightings`.
- **Proposals:** `addMemory` takes a `proposal` only in state proposed, without approval, commits or verdict, from an agent or the user; every cause must be an existing, active observation, gap or lesson; its scope becomes its own plus the union of the causes' playbooks, steps and platforms, and a project only when every cause shares one. `moveProposal(id, move)` follows `PROPOSAL_NEXT` (proposed → approved | rejected; approved → applied | rejected; applied → verified | ineffective | retired; verified and ineffective → retired); an illegal move is `VALIDATION` naming the legal next states. Approved stores `approval: { quote, at }`; verified, ineffective and the rejection of an approved proposal store the user's words as `confirmation: { quote, at }` (retired and a plain rejection need none); applied stores the commits and `appliedAt` (the CLI checks the sha format, then resolves each to a full commit of the repository it runs in that is reachable from HEAD, else `VALIDATION`); rejected and retired also retire the entry. `setStatus` and `markSeen` refuse proposals.
- **Consolidate** is a report: near-duplicate groups, repeats (observations and gaps seen >= 2), stale (last reviewed or created over 180 days ago; `now` is injectable), broken files, dangling `supersedes` and missing causes; `suggest` (repeats no proposed, approved, applied or verified proposal names as a cause or a cause's successor) and `review` (each active applied proposal: `recurred` sightings of each cause and of every entry superseding it, transitively, dated strictly after `appliedAt` (a same-day sighting does not count) → candidate `ineffective`; else `VERIFY_DAYS` (30) days after `appliedAt` → `verified`; else `watching` with `daysLeft`). Days count between calendar dates through UTC midnights.

The CLI (`scripts/memory.ts`) checks `--playbook` against the playbooks and `--step` against the film chain, `footage:next` steps and pipeline stages; outputs are absolute when the memory root lies outside the working directory.

Tests: `tests/memory.test.ts`.
