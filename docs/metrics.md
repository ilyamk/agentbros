# Inventory metrics and API surface

Both commands run offline. They never read `.env`, call providers, run production scripts, or infer successful verification from source coverage.

```bash
pnpm metrics
pnpm metrics --write
pnpm metrics --diff out/metrics/previous.json
pnpm metrics --write-readme
pnpm metrics --usage /path/to/library-usage.json --write
pnpm api:surface
pnpm api:surface --check
pnpm api:surface --compare /path/to/previous-surface.json
```

`metrics` returns its report in the CLI JSON envelope's `metadata.metrics`. `--write` also writes `out/metrics/metrics.json`. `--diff` returns numeric changes in `metadata.deltas`; unknown counts remain unknown. `--write-readme` replaces only the content between the unique, ordered `<!-- metrics:start -->` and `<!-- metrics:end -->` markers. The existing HTML table layout is preserved. Playbook and block headlines use verified counts; crew uses the raw agent count. The three formats and zero API keys needed for local rendering are constant inputs.

Raw inventory comes from playbook JSON files, the generated library catalogue, the command registry, pricing provider prefixes, the union of discovery endpoint IDs, pinned fal operation endpoints and fal music endpoints, canonical agent/skill definitions, the template registry, top-level test files and technique cards. The reference-film count comes from `design-reference/library/_corpus.json`; a missing corpus produces `null` and an explicit unknown. Endpoints are distinct IDs, not transport/region operation rows. Providers are billing-service prefixes in `PRICING` (for example fal rather than every upstream model vendor).

Verified counts use these static evidence rules, with evidence and missing requirements recorded per item:

| Capability | Required evidence |
| --- | --- |
| Block | A catalogue preview image field or a local preview image; a library/determinism test mentioning the block, or the registry-wide library tests; an explicit playbook `library.blocks` entry or a supplied offline usage record |
| Provider | At least one pricing entry with `source` and an ISO `asOf` date, plus a test mentioning its provider prefix |
| Playbook | `status: ready` and a non-empty `benchmarks` array |
| Sensor | A `// calibrated on` comment on a constant used by that sensor's own function; a provisional comment is insufficient |
| Command | Its alias in a playbook `commands` array, and a test mentioning that alias or script |

Inventory tests are excluded from evidence so they cannot verify themselves. Coverage means a test exists, not that it passed. Preview declarations are counted as requested even when preview binaries are unavailable. Personal library usage is read only when explicitly supplied with `--usage`.

Sensor inventory combines `plan:check` dimensions from `src/lib/film/plan-check.ts`, `film:measure` leg IDs from `src/lib/film/measure.ts` and `cut-sound.ts`, and distinct `motion:check` counter names from `src/lib/sensors/findings.ts`. Literal IDs, dimensions and named range/skipped legs are read statically. Shared motion finding codes count once per counter; sensor groups remain separate. Candidate/sync research sensors in `src/lib/reference/calibrate.ts` are not extra production sensors. Calibration evidence does not claim eligibility as a blocking gate: the measured motion-spread and fast-sharpness legs remain advisory in their implementation.

Static health reports test file counts and instruction files above the targets in `tests/agents-md.test.ts`'s `SHRINKING`, parsed with TypeScript rather than duplicated. Runtime pass rates, durations, lint/typecheck results, harness context measurements and GitHub statistics are explicitly unknown; run their respective checks for current evidence.

`api:surface` writes stable, sorted `docs/api/surface.json`. It records command aliases, scripts, sections, spend classes and flags; CLI envelope fields derived from the shared TypeScript declarations; exported Zod schemas; block IDs, props and prop schemas; MCP tools and their schemas; playbook IDs; and literal environment-variable reads. `--check` compares bytes without writing and exits non-zero if stale. `--compare` reports `metadata.comparison` without changing the snapshot.

Flags are read using the TypeScript compiler API from `parseArgs` arguments, including `SPECS`, inline arrays and locally/imported constant spreads. Expressions requiring execution are recorded in each command's `unknown` list. Direct tool aliases without a script have unknown flags. Scripts are never imported to discover flags. Schema modules under `src/types/` are imported offline and their exported Zod values are converted using Zod 4's `z.toJSONSchema` in input mode. Custom refinements/transforms cannot be fully represented; unrepresentable types become `{}` and that limitation is declared. Schema conversion failures are listed explicitly. Source scans exclude generated project code, outputs, personal memory and credentials. Environment-variable discovery covers literal `process.env.NAME` and `process.env['NAME']` reads under `src/` and `scripts/`; dynamic keys and native worker languages remain unknown.

Compatibility comparisons classify removals/narrowing as **breaking**, additions as **minor**, and other edits as **patch**, in that precedence order. Breaking rules include removed commands/flags/schemas/blocks/props/MCP tools/playbooks/environment reads, new or newly required flags, removed enum values, new enum/constant restrictions, narrowed types, tighter numeric/string/collection bounds, closed additional properties, and removed or newly required schema fields. Schema properties, array/map items, tuple entries, definitions and positional union branches are checked recursively. Changed reference targets are conservatively breaking. Union alternatives added are minor; intersection constraints added are breaking, and removing an intersection constraint is minor. Removed CLI envelope fields are breaking. Additions of optional flags, fields, blocks and commands are minor. Descriptions/defaults and reordered object keys alone are patch. This is a conservative structural comparison, not a proof of semantic compatibility: custom refinements, dynamic flags, renamed references and reordered union branches need review.

After changing a registry, script specification, exported schema, library prop or MCP tool, regenerate the snapshot and run `pnpm api:surface --check`. After merging work packages that add commands or schemas, regenerate it again. The snapshot contains no timestamps or working-directory paths.
