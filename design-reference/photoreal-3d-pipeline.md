# Photoreal 3D devices and products

Why `StudioProductStage` looks cheap, where good models can come from, and how agents should make photoreal device shots. Researched 11 November 2026. Every licence claim quotes its page; anything not read is marked unverified.

## Diagnosis

`src/motion/library/three/StudioProductStage.tsx` builds the phone from a `RoundedBox` and a flat screen, lit by four drei `Lightformer`s rendered once into a 256 px environment (`shared.tsx`). Rasterised three.js has no global illumination, no soft area shadows beyond `ContactShadows`, and a primitive body has no chamfers, buttons, lens rings or material breaks. The Blender proof below shows the order of the problem: with physical light, AgX and depth of field the same primitive slab already reads as a photograph of a slab. **Geometry is the next ceiling, then renderer.** A real model fixes the first; Blender fixes the second.

## What the repo already has

| Piece | State |
|---|---|
| `pnpm blender:run` (`scripts/blender-run.ts`) | Headless Blender 4.2+/5.x, any trusted script or `.blend`, Cycles/EEVEE, `--film-transparent`, PNG/EXR, `--encode h264\|prores4444`, `--resume`, contact sheet, hashes, `camera.json` export for overlays. Blender 5.2.3 LTS with Metal is installed |
| `.agents/skills/blender-3d/` | When to choose Blender, consent gates (downloads, add-ons, paid generators), light and render recipes, rights sidecar (`--metadata`); since 15 November 2026 a directing guide: shot intent first, then curves, camera rig, lens and light mood by the shot's function |
| `scripts/blender/kit/` (added 15 November 2026) | The craft layer: intent curves equal to `timing.ts`, anticipation and follow-through, squash and stretch, camera rigs with role defaults, seven light moods, view presets with screen-colour correction, a grade node group, sets and a safe-frame report. Answers the "direction, not renderer" ceiling the twins hit after the photoreal proof |
| `.agents/skills/engine-selection/` | Already routes "photoreal materials and light, or ready-made 3D models" to Blender |
| `pnpm resources:poly-haven` | Search, inspect, hash-verified acquire of CC0 HDRIs, textures and models into `assets/resources/poly-haven` |
| `pnpm fal:models --local` | 98 pinned endpoints: Kling v3/O3 and Seedance 2.5 image-to-video, image models. **No image-to-3D, no Veo, no relighting** |
| `pnpm generate:model` | "Schema-validated modern fal operation. No arbitrary endpoint passthrough." (`scripts/generate-model.ts:1`). Tripo, Meshy or Rodin need a registry entry, pinned schema and price first |
| Remotion render scripts | `film-render`, `film-stills`, `library-preview` default to `--gl angle`, which Remotion recommends: "Three.JS does not render with the default OpenGL renderer - we recommend to set it to `angle`" (https://www.remotion.dev/docs/three) |

## 1. Model sources

| Source | API | Licence facts (quoted) | Fit |
|---|---|---|---|
| Sketchfab | Download API: "allows developers to download 3D models from Sketchfab", glTF/GLB/USDZ only; "end-users must be able to log in or create a Sketchfab account inside your application" (https://sketchfab.com/developers/download-api). Apps must "clearly display the license of the model as well as author attribution" (https://sketchfab.com/developers/download-api/guidelines) | Per model. Editorial assets "cannot be used for any commercial or promotional use"; Standard "does not have all of the restrictions that apply to an editorial license", bars promoting alcohol, tobacco, gambling, weapons (https://sketchfab.com/licenses). Which CC variants a model may carry: unverified from Sketchfab's own pages | Manual pick by a human with an account, not unattended agent download. Branded phones there are usually Editorial: unusable in ads |
| Fab (Epic) | No public download API found (not proven absent) | Standard summary: "Use the assets commercially or privately", no credit required; may not "Resell or redistribute the asset ... on a standalone basis"; CC BY items: "governed by the terms of the Creative Commons license" (https://www.fab.com/eula; the summary "is not legally binding" and the full text was not retrieved) | Good for buying a generic device once, by hand |
| TurboSquid | None found | Editorial items "may not be used for any commercial, promotional, advertising or merchandising use"; items with another party's IP "may only be used with that IP for Editorial Uses"; Royalty Free allows "mobile, web, print, television, and billboard advertising"; "You may NOT use Imagery for AI derived generative content without prior authorization" (https://blog.turbosquid.com/royalty-free-license/) | Buy by hand; never feed its renders to image-to-video |
| CGTrader | None; "may not perform automated mass download (crawling)" (§19.2) | Royalty Free allows use "as rendered still images or moving images" and "for promotional and commercial purposes" (§21A.2, §21A.4); Editorial is for "legitimate, editorial purposes" (§22); subscriptions are "Royalty Free License, No AI" (§19A.19) (https://www.cgtrader.com/pages/terms-and-conditions) | Same as TurboSquid |
| Poly Haven | Public API; "Powered by Poly Haven" credit for products using it (https://github.com/Poly-Haven/Public-API, already in `docs/optional-backends.md`) | CC0 | HDRIs, floors, props. Devices: essentially none |
| Apple Design Resources | Bezels are `.dmg` downloads, no API (https://developer.apple.com/design/resources/) | See below | Not for 3D |

**Apple iPhone: no.** The App Store marketing guidelines list as unauthorised "Rendering in 3D or creating any simulation of an Apple product", forbid "animating, flipping, or spinning the images", require "Apple product images “as is” and without modification", and say generic devices must "not include details that are unique to Apple products" (https://developer.apple.com/app-store/marketing/guidelines/). The bezel licence there is "only in connection with Your applications that are available for download on the App Store" and "only while You are a member of the Apple Developer Program". The trademark guidelines add that Apple "does not support the use of ... images of Apple products by other parties in marketing" and that "You may not imitate the distinctive Apple packaging, web site design, logos, or typefaces" (https://www.apple.com/legal/intellectual-property/guidelinesfor3rdparties.html). A 3D iPhone in a third-party ad, or a phone with Apple-unique details, is out. The same reasoning applies to other makers' trade dress (unverified per maker).

**Mockup services**

| Service | API | Video | Commercial use |
|---|---|---|---|
| Rotato | "hosted API and MCP integrations are not yet available"; "This local CLI is Rotato's supported automation interface today" (https://rotato.app/developers) | H.264, ProRes 4444, animation timeline (https://rotato.app/pricing) | "You can use videos and images produced and exported from Rotato in any of your awesome works, commercially or not"; Generic and Universal devices are "always okay to use anywhere, any time" (https://rotato.app/about/terms) |
| Mockuuups Studio | Yes, `api.mockuuups.studio/v1/renders`, from US$50/month (https://mockuuups.studio/api) | Images only | Paid: "All personal and commercial uses" (https://mockuuups.studio/license). Developer terms forbid "consumer-facing products, apps, or plugins that offer mockup generation as a feature to end users" (https://mockuuups.studio/developer-terms): this repo may count |
| Previewed | None found | "PNG, JPG, MP4 Exports" (https://previewed.app/plans) | Commercial on Plus/Pro; free plan "for personal use only"; 2020 site terms bar "automated or non-human means" (https://previewed.app/terms_and_conditions/) |
| Shots.so | None found | Animation claimed; MP4 not confirmed | Exports not addressed (https://shots.so/terms) |
| Smartmockups | Now redirects to Canva; page refused fetch | Unverified | Unverified |

Only Rotato offers scripted, alpha video with a generic device; it is a paid desktop app, so it is a human-assisted option, not a library route.

## 2. Generating models (image-to-3D on fal)

Prices as shown on each fal page (all tagged "Commercial use"); none is in our registry.

| Endpoint | Price | Output |
|---|---|---|
| `fal-ai/trellis` | $0.02 | GLB |
| `fal-ai/trellis-2` | $0.25-0.35 by resolution | GLB |
| `fal-ai/hunyuan3d/v2` | $0.16; $0.48 textured | GLB |
| `fal-ai/hunyuan3d-v3/image-to-3d`, `fal-ai/hunyuan-3d/v3.1/pro/image-to-3d` | $0.225-0.45; PBR +$0.15 | GLB, OBJ |
| `tripo3d/h3.1/image-to-3d`, `tripo3d/tripo/v2.5/image-to-3d` | $0.20-0.40, extras +$0.05-0.20 | GLB with PBR |
| `fal-ai/hyper3d/rodin/v2.5` | $0.40; HighPack +$0.80 | GLB PBR |
| `fal-ai/meshy/v7.1/image-to-3d` | $0.80; $1.20 textured | GLB, FBX, OBJ, USDZ + PBR maps |

Licences: TRELLIS repo is MIT (https://github.com/microsoft/TRELLIS/blob/main/LICENSE; fal-hosted weights unverified). The open Hunyuan3D-2 licence "DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA", "Tencent claims no rights in Outputs", and its use policy requires public content to be "expressly and conspicuously identifying that the information and/or content is machine generated" (https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE); terms for the fal v3/v3.1 Partner models are unverified. Tripo and Meshy output ownership: unverified (terms pages refused).

**Hero-shot quality: untested.** These models produce soft bevels, baked lighting in textures and mushy small parts; a phone is mostly precise flat planes and chamfers, which a parametric model in Blender does better and for free. Use image-to-3D for organic props (food, shoes, packaging), not for the hero device. One gated acceptance run (TRELLIS at $0.02 or Tripo textured at $0.30) would settle it; ask first.

## 3. Rendering routes

| | (a) three.js in Remotion | (b) Blender via `blender:run` | (c) AI image-to-video |
|---|---|---|---|
| Quality ceiling | Good PBR with a real HDRI and GLB; no GI, approximate shadows and DoF | Photographic: path-traced GI, area light, true DoF, motion blur | Photographic look, but invents geometry, text and screen content |
| Determinism | Frame-pure if all motion reads `useCurrentFrame` | Deterministic per script and version; `use_animated_seed` noise varies by design | None; each take differs |
| Time per 1080p frame | Sub-second | ~25 s at 32 spp on M1 Max (measured below) | Minutes per clip; queue |
| Cost | Free | Free | Kling v3 pro $0.112-0.196/s, turbo pro $0.14/s, Seedance 2.5 token-priced (local registry); Veo 3.1 $0.20/s, and its fal page says "This model will be removed on November 17, 2026" (https://fal.ai/models/fal-ai/veo3.1/image-to-video) |
| Editable with the script | Yes, props | Re-render the clip | Regenerate |
| Agent-friendliness | Highest | High: scripted, logged, `--resume`, contact sheet | Low: budget approval, no frame control, screen UI will drift |

**(a) Why DoF gave a blank canvas (source-read, not reproduced).** In `@react-three/postprocessing` 3.2.2, `EffectComposer` builds its composer in a `useEffect` and stores it with `setState`; its `useFrame` (render priority 1) returns early `if (!enabled || !composerState)`, and a positive priority stops R3F's own render. `@remotion/three` 4.0.539 renders each frame through `ManualFrameRenderer`, a `useEffect` that calls `advance()` once per frame. An `advance()` that lands before the composer state exists draws nothing, and no later advance happens for that frame. The default `multisampling = 4` adds MSAA render targets on top. Fix to try (owner: lib-three): build `new EffectComposer(gl, {multisampling: 0})` and its `RenderPass` and `EffectPass(camera, new DepthOfFieldEffect(...))` synchronously in `useMemo`; render with `composer.render()` from a `useLayoutEffect` keyed on the frame, inside a `delayRender`/`continueRender` pair, with no R3F `useFrame`. Simpler alternative: let Blender do DoF.

**(b) Proof of route, done.** Script: `…/scratchpad/photoreal/scripts/phone_studio.py` (procedural unbranded phone, bevelled titanium body, coated emissive screen, three area lights, dark sweep, 85 mm, f/2 DoF on the phone, AgX Medium High Contrast, 48-frame turntable). Blender 5.2.3, Cycles, Metal, 32 samples, adaptive sampling, OIDN.

| Run | Measured |
|---|---|
| 960x540, frames 1-2 | 22.8 s to first frame (launch, build, kernels cached), +9.0 s for the second |
| 1920x1080, one frame | 24.6 s and 34.0 s inside Blender; 36-53 s whole process; machine shared with other agents |
| 1920x1080 `--film-transparent`, floor as shadow catcher | 25.9 s; RGBA PNG composited over a flat colour with a soft contact shadow |

Result: light, floor bounce, shadow and DoF read as photographic straight away; the slab geometry and the plain gradient screen are what still look cheap. The shadow catcher also records the key's fall-off on the far floor as a faint band: limit the catcher plane's size or the key's spread. Not exercised: GLB import, Poly Haven HDRI, Remotion `<Img>` playback of the PNG sequence, ProRes. For a 5 s shot at 30 fps, budget about 150 frames x 25 s, roughly an hour on this machine; a 540p look pass is about 9 s a frame.

**(c) AI image-to-video** suits a 3-5 s photoreal mood beat (hands, desk, reflections) from an approved still, never for a shot where the screen UI, logo or exact form must hold. Do not feed TurboSquid or CGTrader-subscription renders to it (licence quotes above).

## 4. Recommended pipeline

**Assets to keep locally** (`public/library/3d/`, each with a rights sidecar; downloading needs the user's yes):

1. **Parametric devices built in our own Blender scripts**: phone (two sizes), tablet, laptop, watch-like wearable, card. Generic by rule: no notch or pill cut-out in Apple's shape, no square triple-camera island, no Apple-like side buttons layout copied, no logos. Owning the geometry gives CC0-equivalent rights, exact screen UV rectangles and per-part control for exploded views. This is the main recommendation.
2. Optionally one or two **purchased generic GLBs** (Fab Standard or CGTrader/TurboSquid Royalty Free, never Editorial), bought by a human, recorded with page URL and date.
3. **Three or four Poly Haven CC0 studio HDRIs** at 2k (`resources:poly-haven --kind hdri`, e.g. a softbox studio, a warm interior, a high-contrast studio), used at 0.15-0.4 strength under area lights, per `rendering-craft.md`.
4. A shared **studio kit script**: sweep, three-light rig presets (soft key, rim, top), shadow catcher, camera rigs, AgX looks, `avc_export.export_camera`.

**Shot templates** (each a Blender script with JSON args plus a Remotion wrapper):

| Template | Blender does | Remotion does |
|---|---|---|
| Hero turntable | Orbit or yaw sweep, DoF rack, reflections; alpha PNG + shadow | Background, type, captions, timing |
| Screen-content swap | Device with screen as an emissive image texture from a real UI PNG, or a separate screen-UV/mask pass | Plays live UI in the screen via `camera.json` corner anchors, so copy stays editable |
| Exploded view | Parts separated along the normal with eased keyframes, labels' anchors exported | Callout lines and labels on anchors |
| Macro detail sweep | 100 mm, f/1.4, slow slide along an edge or lens ring | Grain and caption |
| Floating multi-device | Phone, tablet, laptop staggered on soft bobs, shared light | Per-device UI and transitions |

**Orchestration for agents**

1. `engine-selection` routes the shot; `blender-3d` asks for consent and records rights.
2. Look pass: `blender:run --resolution 960x540 --samples 24 --frames F-F` on first, busiest and last frame; read the PNGs.
3. Final as a background job: `blender:run --film-transparent --samples 32 --resolution 1920x1080 --resume`, with a timeout sized from the measured frame time; continue Remotion work meanwhile.
4. Remotion composite: index the alpha PNG sequence with `<Img src={staticFile(...)}/>`, overlay UI and type from `camera.json`, then `motion:strip` and look.
5. Keep three.js (`StudioProductStage`) for quick, data-driven or many-variant shots, upgraded with a GLB from the same parametric devices plus a real HDRI; route hero beats to Blender.

## What would change this

- A gated image-to-3D trial producing clean chamfered devices would add a "from a photo of the product" route for clients' real hardware.
- A working deterministic composer in three.js would narrow the gap for DoF-heavy but simple shots.
- A model page or Apple statement permitting 3D depictions would reopen branded devices; until then, none.
