# Shared media

The repository does not commit media binaries that can be fetched or rebuilt: music, sound effects, HDRIs, 3D models, video plates, images or fonts. It commits manifests and the tools. Each manifest names the source URL or recipe, the licence, the sha256, the size and the target path. A clone downloads or regenerates what it needs into git-ignored folders. Those folders build up on your machine, next to your (also ignored) project folders. [CREDITS.md](../CREDITS.md) remains the record of sources and licences.

## Commands

```bash
pnpm assets:sync --check               # present / missing / corrupt / drifted per family; downloads nothing
pnpm assets:sync --all                 # everything that is cheap (skips recipes marked slow)
pnpm assets:sync --all --include-slow  # also long renders
pnpm assets:sync --family hdri         # one family
pnpm assets:sync --id hdri:studio      # one asset; runs it even if slow
pnpm assets:sync --id hdri:studio --force
pnpm preflight                         # includes a "Shared media" line: present/total per family
```

The command follows the scripts JSON contract ([scripts/AGENTS.md](../scripts/AGENTS.md)). It is idempotent: a file that verifies is left alone. A download is written to `<target>.part`, checked against the manifest's sha256 and only then renamed into place. Outcomes per asset:

| Outcome | Meaning |
|---|---|
| `unchanged` | Already present and verified (or a recipe output that has drifted, see below) |
| `downloaded`, `regenerated` | Fetched or rebuilt now |
| `source-gone` | The URL answered 404/410. Find a replacement and update the manifest it names |
| `corrupt-source` | The download's sha256 differs from the manifest. The source changed; nothing was written |
| `needs-tool` | The recipe needs Blender, ffmpeg or Chromium (see `pnpm preflight`) |
| `skipped-slow` | The recipe takes minutes; run it by `--id` or with `--include-slow` |
| `manual` | Rebuilding needs steps a script cannot run; the result lists them |
| `unavailable` | No public source exists; supply your own file at the target |

SFX under `--all` (2026-11-16): the command can succeed while `metadata.sfx.ok` is `false`. Some sounds need `FREESOUND_API_KEY` or only exist as paid generations (`needs-generation`, never run); they are reported in `metadata.sfx.counts`, not treated as failures. `--family sfx` and `--id sfx:…` are strict and fail instead.

Downloads and the synth pack are byte-exact, so a sha mismatch means `corrupt`. Recipe outputs (Blender, captures) do not reproduce byte for byte. For those, the manifest's sha256 belongs to the reference file, and a local rebuild shows as `drifted`. That is a warning, not an error. Recipe inputs are always sha-checked.

## On demand

Remotion's `staticFile()` cannot fetch at render time, so the CLIs that render make sure the files are there first:

- `pnpm library:preview` handles each library item.
- `pnpm motion:render` handles a composition.
- `pnpm render` handles a project, by scanning `src/projects/<id>` and `public/projects/<id>` for library components and manifest targets.

Missing downloads are fetched automatically. Anything else fails with `ASSET_MISSING`, and the message names the exact `pnpm assets:sync --id <id>` command. In `library:preview --category`, a block with missing assets is reported as failed while the rest still render. The table of which block needs which asset is `src/lib/shared-assets/needs.ts`. `tests/shared-assets.test.ts` fails when a block loads a manifest target that the table does not list.

Tests never need these files: they use fixtures (`tests/fixtures/shared-assets/`) or skip.

## Local cache

`src/lib/cache-dir.ts` resolves the shared cache to `~/.cache/agentbros`. The `AGENTBROS_MODEL_CACHE` environment variable overrides that root (the deprecated `AI_VIDEO_CREATOR_MODEL_CACHE` is still read when it is unset); `SPEECH_LOCAL_CACHE` still overrides the speech directory separately. Local engines use `<root>/local-engines`, speech uses `<root>/speech` and Hyperframes uses `<root>/hyperframes`.

On first use, if the new directory is absent and `~/.cache/ai-video-creator` exists, the helper renames the old directory into place. It never copies the cache. An existing new directory is left alone. A failed rename warns on stderr and keeps using the old directory. An explicit override bypasses migration. When the default local-engine directory is resolved, prepared configurations' absolute paths into the moved directory are refreshed with atomic writes; checksum pins and external paths stay unchanged. A configuration that cannot be refreshed emits a warning; rerun `pnpm media:prepare` for the affected engine if its probe reports stale paths.

## Families

| Family | Manifest | Source | Notes |
|---|---|---|---|
| `hdri` | `public/shared/hdri/sources.json` | Poly Haven downloads, CC0 | Ids `hdri:studio`, `softbox`, `warm`, `loft` |
| `3d` | `public/shared/3d/sources.json` | Recipe: downloads the CC BY 4.0 source GLB (checked by `sourceSha256`) into `.cache/assets/3d/inputs/`, then runs `scripts/blender/prepare_devices.py` | Needs Blender. Without it, `studio-product-stage` and `scene-product-reveal` cannot render |
| `plates` | `public/shared/3d/plates/sources.json` | Manual: about 17 minutes of Cycles with `hero_turntable.py` (docs/photoreal-3d.md) | Default plate for `blender-plate` |
| `synth` | `public/shared/sfx/synth/pack.json` | Regenerated in-process by `src/lib/audio/sfx-synth.ts` (seeded, byte-exact) | Same files as `pnpm sfx:synth --kind all` |
| `sfx` | `public/shared/sfx/<kind>/manifest.json` | Delegated to the SFX collection's `fetchSfx()` (`src/lib/audio/sfx-fetch.ts`, also `pnpm sfx:fetch`); `--id sfx:<file or source id>` | Counted in `--check` and preflight; generation that would cost money is reported as `needs-generation`, never run |
| `collage` | `public/shared/collage/sources.json` | None: the sample cut-out derives from a third-party mockup | Supply your own PNG for `paper-collage-assemble` |
| `showcase` | `public/motion-lab/showcase/sources.json` | `order-capture`: recipe (`capture-order.ts`). `roast-shader`: manual Hyperframes render. `coffee-pour`: none | Motion Lab showcase only |
| `lab` | `public/motion-lab/sources.json` | `poster-vertical`: manual render of `PosterStackV` at half scale. `studio`, `studio-recording`: none (private captures; place your own) | Motion Lab `StudioDemo`, `PhonePlayback`, `KineticLab`, `CollageDemo`, `LabReel` |
| `models` | `src/lib/matte/models.json` | GitHub release download, sha256-pinned; `models:birefnet-general-lite` (BiRefNet, MIT, 224 MB) | Target `$MODELS/...` resolves to the model cache (`AGENTBROS_MODEL_CACHE`, default `~/.cache/agentbros`), never `public/`. `--all` skips it unless `--include-slow`; `pnpm matte` names the command when the weights are missing |
| `fonts` | `public/shared/fonts/sources.json` (empty) | Design-token fonts load through `@remotion/google-fonts` (`src/lib/fonts.ts`); a project font is imported with its licence by `scripts/import-font-resource.ts` | No font files in git |

`public/shared/images/`, `music/` and `lottie/` hold project-time downloads (stock, Lottie, music providers) with their own provenance sidecars. They were never committed.

## Adding an asset

1. Add an entry to the family's manifest, or create a manifest in the generic format: `{ schemaVersion: 1, family, assets: [{ name, target, licence, sha256, size, source: { kind: "url" | "recipe" | "manual" | "none", ... } }] }`. A new family also needs an entry in `MANIFESTS` in `src/lib/shared-assets/index.ts`.
2. Ignore the media path in `.gitignore`, but keep the manifest tracked. Use file-level patterns: a negation cannot re-include a file inside an ignored directory.
3. If a library block or composition loads it, add it to `src/lib/shared-assets/needs.ts`.
4. Record the source in CREDITS.md.

The public export (`public-export.json`) also denies media extensions under `public/shared/` and the showcase renders. This is a second line of defence in case a file is force-added.

## Inventory (2026-11-11, tracked counts refreshed 2026-11-15)

All binary media tracked before this change: 147 files, 44.8 MB. Tracked now: only class (c), 115 files, 5.0 MB; `pnpm repo:hygiene --check` (rule `media-binary`, list in `src/lib/workspace/hygiene.ts`) and `tests/harness-only.test.ts` fail on a media file anywhere else.

| Class | Files | MB | What | Action |
|---|---|---|---|---|
| (a) public download | 4 | 24.0 | `public/shared/hdri/*.hdr` (Poly Haven, CC0) | Untracked; `hdri` manifest |
| (b) regenerable | 5 | 9.0 | `public/shared/3d/{phone,laptop}.glb` (Blender recipe), `public/shared/3d/plates/hero-turntable.mp4` (manual), `public/motion-lab/showcase/{order-capture,roast-shader}.mp4` | Untracked; `3d`, `plates`, `showcase` manifests |
| (b) regenerable | 9 | 0.9 | `public/shared/sfx/synth/*.wav` (byte-exact `sfx:synth`) | Untracked; manifest is `pack.json` |
| (c) keep tracked | 113 | 5.0 | `docs/library/previews/*.jpg` (100 when counted on 2026-11-13, 147 on 2026-11-18, one export-denied; library preview sheets, 4.0 MB when counted; three render the CC BY 4.0 phone model, attributed in NOTICE.md), `design-reference/device-mockup/*.png` (8) and `design-reference/screenshots/square/*.jpeg` (3) (both already export-denied as third-party), `docs/photoreal/*.jpg` (2), `tests/fixtures/film-chain/track.wav` (1); since 2026-11-15 also `docs/readme/*.{png,jpg,gif}` (the rule allows the whole folder; an animated header GIF stays under 10 MB, since 2026-11-17), the README landing-page images (generated with Codex `image_gen`, prompts in `docs/readme/PROMPTS.md`; originals in git-ignored `docs/readme/src/`) | Kept |
| (d) original, not needed by tests | 5 | 6.7 | `public/motion-lab/showcase/coffee-pour.mp4` (4.7 MB, Blender scene not in the repository); `public/motion-lab/{studio-recording.mp4,studio.png,poster-vertical.mp4}` (private captures); `public/shared/collage/phone-cutout.png` (licence unrecorded) | Untracked 2026-11-13 and kept on disk; `showcase`, `lab` and `collage` manifests name them with source `none` or `manual` |

Untracked 2026-11-15: the 23 firecrawl pilot stills, frames of a third-party film; `design-reference/library/` now tracks only `.json` and `.md` ([contributing references](contributing-references.md)). Already untracked and ignored before this change: `public/shared/images/IMG_4713.jpeg` and `IMG_4714.jpeg` (provenance gap in CREDITS.md), the SFX collection under `public/shared/sfx/`, and all project media.
