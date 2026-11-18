# Project icons and brand logos

All six sources are free to access without API keys: local Phosphor, Lucide,
Tabler and Simple Icons packages; public Iconify and SVGL APIs. No Logo.dev,
paid model or embedding download is used. Install with `pnpm install`.

## Choose, inspect and acquire

Use a visual metaphor that serves the scene. Expand Russian or abstract phrases
into a few concrete English searches; the search is lexical with names, tags,
categories and a small Russian–English synonym dictionary, not an embedding model.
Search results explain matches and report each source's failure or offline status.

```bash
pnpm resources:icon-profile --project demo --action set --preset phosphor-duotone
pnpm resources:icons --project demo --action search --query "защита данных" --offline
pnpm resources:icons --project demo --action inspect --id phosphor:shield --offline
pnpm resources:icons --project demo --action acquire --id phosphor:shield --offline
pnpm resources:icons --project demo --action export --id <acquisition-id> --format png --size 1024
pnpm resources:icons --project demo --action check
pnpm resources:logos --project demo --action search --query Google
pnpm resources:logos --project demo --action inspect --id <candidate-id>
pnpm resources:logos --project demo --action acquire --id <candidate-id> --variant <available-variant>
```

Use `--queries '["shield","fingerprint","lock"]'` for agent-supplied expansions,
`--provider iconify --collection mdi` for a specific remote collection. The query
limit is 100 results. Inspect exact IDs before acquiring; search hits do not prove
availability or rights. Capability output describes local/network sources.

The profile is shared by template, footage and bespoke projects, under
`resources/icon-profile.json`. Presets cover all six Phosphor weights, Lucide
outline, and Tabler outline/filled. An unset profile is read-only absence; nothing
is written by search. Existing profiles require `--expected-revision N` to update.
A profile mismatch needs `--allow-style-override --reason "..."`. Available variants
are provider data: the system never invents a filled/duotone/wordmark version.
Phosphor uses filled paths, so changing stroke width is not supported there.

## Files, exports and render use

Acquisition returns an immutable resource ID, acquisition ID, original public path
and source metadata. Export accepts the acquisition ID (preferred: unambiguous
variant) and returns `absolutePath`, public-relative `file`, hash and `usage` fields.

Originals and notices live in the existing `resources/originals/` registry;
`resources/icons/manifest.json` links acquisitions and exports. PNG/WebP also enter
the normal asset registry. Keep the returned IDs: use list after context loss.
Project-local copies survive shared cache removal, relocation and worktree removal.
No absolute machine path is stored in the manifests. User data is resolved from the
workspace; installed packages and workers are resolved from the code checkout.

Exports use the existing Remotion Chromium for PNG and the bundled Apache-2.0 jSquash WASM codec for lossless WebP. Prepare Chromium once with `pnpm exec remotion browser ensure`; export never downloads it implicitly.

Exports: SVG, PNG and lossless WebP; default 1024 square, contain, transparent,
zero padding. `--size`, `--padding`, `--background`, `--colour` and supported
`--stroke-width` create new derivatives, never overwrite originals. Brand colours
are preserved; requesting colour changes requires an explicit reason and remains
subject to brand guidelines. Review images at playback size before choosing.

Use the `icon-visual` motion-library block with the returned `usage` fields
(`resourceId`, `derivativeId`, `src`, and a real scene-specific `placementId`), plus
optional `label` and display `size`. Pass the same fields in timeline block props or
bespoke build/composition props so capture can identify usage. Existing scenes may
also use the returned public path as their imageUrl. Render with `<Img>` and
`staticFile()` only; do not perform network requests inside a component.

Render identity captures the used export, SVG original, source evidence, notice and
profile. Delivery checks exact bytes and rights for used files. In bespoke code,
put icon usage in the build/props as well as mounting the image: arbitrary code
that hides a path from declared props cannot be inferred as a placement.
Unused search candidates do not become render assets or rights blockers.

## Failure handling and rights

Requests use bounded HTTPS GETs, no redirects, allowlisted source hosts, 15-second
attempt deadlines and at most one transient retry. Rate limits honour Retry-After
within the operation's wait budget. Partial searches report failures; total source
failure is an error. Offline mode forbids network and reports unavailable originals.
Missing/corrupt project files fail checks; they are never silently re-downloaded.
A lock conflict reports TIMEOUT; inspect its owning process before removing a stale
lock. Re-running acquisition/export reuses the committed immutable result.

SVG parsing admits passive paths, groups, gradients, masks and internal references.
Scripts, foreignObject, external media, stylesheets, entities and recursive
references fail validation. Unsupported SVG is diagnosed, not silently cleaned.
SVG use instances require flattened paths. Rasterisation runs in a timed worker.

Local package notices are retained, including Lucide's ISC/MIT notices. Iconify
licences are per collection; arbitrary collection metadata alone does not provide
its full licence text. Brand files from SVGL/Simple Icons retain unknown permission
until asset-specific evidence is supplied. Library access is not trademark or
advertising permission. Existing delivery current-hash human rights reviews remain
the route for unresolved rights; agents cannot create a user's approval.

## Verification

```bash
pnpm resources:icons:verify
pnpm resources:icons:verify --live
pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/icon-resources.test.ts
```

The first checks actual installed collections and local raster exports in a deleted
temporary workspace. `--live` additionally contacts Iconify and SVGL, acquires and
exports real originals. Ordinary unit tests use injected HTTP and need no `.env`.
MCP tools split search/inspect/list/check from acquire/export and profile mutation.
The `:read` command aliases identify those read-only MCP tools; CLI users may use
any documented action with the main command aliases.

Bespoke builds with exported icons must declare `iconUsages` in build.json (an
array of returned usage records with actual placementId values), or pass usage in
composition props. Missing declarations fail capture rather than omit sources.
Use acquisition IDs for export when a resource has several variants.
