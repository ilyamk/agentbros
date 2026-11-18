# Cached exact fonts and passive icons

Legacy `src/lib/fonts.ts` continues to use its existing Google Fonts selections.
Nothing automatically downloads a family or changes project branding. Cached mode
is an explicit validated JSON font context and controlled generated loader module.

Import an owned/licensed static original into an existing project:

```bash
pnpm exec tsx scripts/import-font-resource.ts --project demo --source /path/Inter-Regular.ttf --metadata font.json
```

Metadata requires `kind: "font"`, exact internal `family`, `weight`, `style`, an
explicit `subset` label, `requiredText`, and supplied `source`, `licence`,
`licenceEvidence`, full `licenceText`, `attribution`, `checkedAt`. Actual SFNT name,
OS/2 weight, style and Unicode cmap are inspected. Different branding, unsupported
characters and invalid/truncated files fail. The subset label does not imply full
Unicode block support: actual required characters are tested. Single-face static
TTF/OTF are supported; WOFF/WOFF2, collections and variable axes require a real decoder
or a supplied static instance and are rejected rather than guessed.

Originals and licence texts live under `public/projects/demo/resources/originals/`.
The versioned registry checks their hashes/content and font metadata each time;
immutable `revision-N.json` snapshots preserve provenance. Resource records are
separate from the raster/video/audio asset registry. Same original bytes can retain
multiple explicit metadata/subset/licence records. No billing or consent is inferred.

`--url https://…` instead of `--source` performs an explicit bounded GET with no
credentials, redirects, provider generation or automatic fallback. Its URL must
match provenance. Licence text/evidence still must be supplied. Tests use injected
mock GETs; no resource API is contacted in verification.

## Font context and render integration

A selector JSON must explicitly supply all eight existing semantic font roles:
`primaryFont`, `displayFont`, `condensedFont`, `serifFont`, `serifNormalFont`,
`roundedFont`, `narrowFont`, `geometricFont`. Each selects `family`, `style`,
`weights`, `subset`, `requiredText`. Every requested face must be cached exactly.
Use all actual weights used by your typography tokens; requesting one weight does
not supply all other weights or italic styles.

```bash
pnpm exec tsx scripts/import-font-resource.ts --project demo --metadata selectors.json --context /new/path/fonts.json
```

`generateFontRoleModule(projectId, contextFile, modulePath, {rootDir, requiredText})`
validates that JSON against real registered originals, rechecks actual glyphs for
all supplied render text and creates only the controlled loader. It never accepts
arbitrary JavaScript as a context. It returns `captureFiles` for render identity:
context, registry, exact originals, licences and generated module. The optional
render CLI wiring consumes this API and aliases the production font-role module;
legacy preview keeps its original module. `--module` can additionally produce an
exclusive module during context creation for controlled bundler integration.

The production browser loader fetches only local `staticFile()` originals, verifies
SHA-256, creates actual `FontFace` objects, waits for `loaded` and `document.fonts.ready`,
and checks readiness. Node cmap validation prevents `document.fonts.check()` from
being mistaken for proof that a fallback has the missing glyph. Errors cancel the
render. The loader does not substitute a system CSS family when the cached original
is absent.

## Icons

[Project icons and logos](icon-resources.md) documents the integrated search,
profiles, six sources, passive SVG validation and SVG/PNG/WebP exports. The existing
resource registry remains the source of SVG originals and licence notices. Font
behaviour is unchanged. SVG stays a typed vector resource; actual PNG/WebP exports
are inspected and imported through the regular media registry.

## Verification

```bash
pnpm typecheck
pnpm exec tsx --test tests/font-resources.test.ts
RUN_RENDER_TESTS=1 pnpm exec tsx --test tests/font-resources-browser.test.ts
```

The browser fixture uses an available macOS Arial original only inside a deleted
temporary directory, validates actual Cyrillic glyphs and renders through the
production FontFace loader. No font binary is committed or redistributed, and the
test metadata makes no font licence grant. Other hosts skip this specific system
fixture unless an equivalent licensed local fixture is provided. Acquisition tests
mock HTTP; the browser fixture makes no remote font request.

## Production render context

```bash
pnpm render -- --project <id> --format square --font-context public/projects/<id>/font-context.json
pnpm render -- --project <id> --font-context public/projects/<id>/font-context.json --dry-run
RUN_RENDER_TESTS=1 pnpm exec tsx --test tests/font-render-cli.test.ts
```

The optional flag accepts a verified JSON manifest, never JavaScript. It validates
originals, exact manifest faces and displayed glyphs, including template text,
canonical scenes, timeline payloads and existing raw/edited word-alignment files.
The renderer freezes the validated manifest and a controlled generated font-role
module under content-addressed `.cache/font-contexts/` paths. The production
webpack alias applies that module; renderer identity captures the frozen context,
module, font originals, registry and licence notices. Dry-run may populate this
local cache but does not render, reserve budgets or call generation APIs.

Requested manifest weights/styles must have matching originals. CSS weights not
selected in the manifest may still synthesize or match a nearest supplied face;
the glyph check does not prove every displayed CSS weight has an exact face.
Supply the intended faces and visually review deliberate role mappings. Omitting
`--font-context` preserves the existing Google-font preview/render behavior.
The CLI fixture deliberately maps all roles to a temporary system Arial face and
checks an actual measured MP4 and bound receipt, without claiming redistribution
rights or exact bold/italic matching for that fixture.
