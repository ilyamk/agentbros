# Researched extension candidates

Source: [official extension API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.3.0&platform=macos-arm64), checked 2026-11-15. These are metadata/research decisions; the seven adopts were re-run on Blender 5.3.0: six passed; Node To Python refuses export despite the API range. All 42 available version/hash pins are unchanged; Tree Clipper has no compatible 5.3 release and retains its historical pin as rejected. Every ZIP hash, size, compatible version, licence, permission and platform selection is pinned in `blender-arsenal/extensions.json`. Molecular Nodes and Tissue now have scoped FX trials and owner-approved integrations; see their dedicated evaluations. Untrialled wheel metadata for other entries, including Splashsurf, remains unknown.

## Verdict

Pending dedicated trial for every proposed “maybe” entry. Rejected entries remain rejected with reasons in the manifest. Do not approve against this aggregate document; create and point to a dedicated measured evaluation first.

## Candidates

| Id | Recommendation | Reason / unresolved evidence |
|---|---|---|
| `extra_curve_objectes` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `commotion` | maybe | MAYBE (own 20-line stagger wrapper preferred); API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `animall` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `loop_noise` | reject | do it with F-modifiers |
| `easeit` | reject | UI-only, redundant with built-ins or unsuitable for headless motion-design films. |
| `blender_speed_curve` | reject | UI-only, redundant with built-ins or unsuitable for headless motion-design films. |
| `simple_bounce_curve` | reject | niche |
| `momentum` | reject | UI-only, redundant with built-ins or unsuitable for headless motion-design films. |
| `sapling_tree_gen` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `ivygen` | reject | UI-only, redundant with built-ins or unsuitable for headless motion-design films. |
| `dynamic_sky` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `quick_lighting_environment` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `ambientcg_material_importer` | reject | network at runtime; fetch ambientCG yourself |
| `bool_tool` | reject | Boolean modifier from Python |
| `looptools` | reject | modelling UI aid |
| `tissue` | adopt (scoped FX) | Owner-approved 0.3.76; native headless tessellation and exact CPU proof. [Evaluation](tissue.md). Wrapper remains experimental. |
| `Bagapie` | reject | 10.8 MB, files+network perms |
| `scatter_objects` | reject | Essentials "Scatter on Surface" |
| `t3d_gn_presets` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `io_lottie_export` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `TextHelper` | reject | bpy text API suffices |
| `latex_text_generator` | maybe | MAYBE (maths explainers); API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `h_style_rbd_nodes` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `tree_clipper` | reject | No release for Blender 5.3.0; 0.1.12 has exclusive maximum 5.3.0. Historical 5.2.3 pin retained. |
| `bake_instance_animation` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `layer_comp` | reject | UI-only, redundant with built-ins or unsuitable for headless motion-design films. |
| `formula_to_nodes` | reject | network AI calls |
| `molecularnodes` | adopt (scoped FX) | Earlier size/niche rejection superseded by owner-authorised science integration; 520.2.0 loads on 5.3.0. [Evaluation](molecularnodes.md). Wrapper remains experimental. |
| `noise_nodes` | maybe | MAYBE; API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `turntable_camera` | reject | a 5-line rig |
| `modern_primitive` | reject | UI-only, redundant with built-ins or unsuitable for headless motion-design films. |
| `motion_sounds` | reject | audio lives in Remotion |
| `btracer` | maybe | MAYBE (curve growth or handwriting); API metadata pinned for Blender 5.3.0 / macos-arm64 on 2026-11-15. Archive inspection pending unless trialled. |
| `splashsurf_studio` | reject | niche, native binary |
| `antlandscape` | reject | not product promo |
| `custom_sky_texture` | reject | built-in Sky Texture |

## Routes outside this add-on manifest

Bradley Node Presets, Poly Haven, ambientCG, Cartesian Caramel and Charge are remote asset libraries. Their extension packages now install on Blender 5.3; direct consented SHA-256-pinned files and append-by-name remain preferred for headless work. They are not an eighth compatible add-on adoption.

Blendkit/BlenderKit, the paid Poly Haven browser, Sketchfab's plug-in, Animation Nodes and Sverchok are rejected for automatic use: network/account/licence or native-dependency concerns, redundant capabilities or unverified 5.x support. No archive URL or hash was invented for these off-platform tools; they are not installable entries here. Paid add-ons remain outside this free shortlist.

## Blender 5.3 native asset-library verdict

Blender 5.3.0 native asset-library trial: Poly Haven Lite 1.0.0 installed and enabled its 393-byte, SHA-256-verified descriptor in 104.902 ms (1,043 ms including launch), while Blender remained offline. It registered a remote Asset Browser library but installed no .blend assets and did not pin individual asset files; its default cache path also resolved to the OS cache outside the arsenal despite profile overrides. Keep LIB’s verified per-file .blend download + append for headless films: it supplies reproducible content, explicit consent and controlled paths. Native extensions may help interactive browsing, but this trial provides no reason to change the LIB adapters.

CITY wave: `BlenderGIS` 2.2.14 is pinned separately in the manifest with city/buildings/terrain capabilities. Legacy registration passes on 5.3, but the modern installer cannot consume its archive and import triggers an unpinned FreeImage download. Keep proposed; use the offline native OSM wrapper. Buildify remains manual. [Measured city evaluation](city-realism.md).
