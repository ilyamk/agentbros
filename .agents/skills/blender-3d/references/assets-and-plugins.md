# Assets and plugins

Ask before downloading anything. Record every file you use, even CC0, in the sidecar passed to `--metadata`:

```json
{
  "rights": { "licence": "CC0-1.0", "commercialAllowed": true, "attributionRequired": false, "sourceUrl": "https://polyhaven.com/a/dark_wood" },
  "sources": [
    { "id": "dark_wood", "file": "assets/dark_wood_diff_2k.jpg", "source": "https://polyhaven.com/a/dark_wood", "licence": "CC0-1.0", "credit": "Powered by Poly Haven" }
  ]
}
```

`sources` lands in `blender-run.json`. `rights` describes the whole render, so it can be no more open than its most restricted source. Omit it when unsure: the import then records `unknown`, which blocks commercial release until evidence is supplied.

## Where to look

| Source | Good for | Licence to record | Route |
|---|---|---|---|
| Poly Haven | HDRIs, PBR textures, some models | CC0; products using the live API show the credit "Powered by Poly Haven" | `pnpm resources:poly-haven --action search --query sunset --kind hdri`, then `--action inspect --id ID`, then `--action acquire --id ID --selector '["hdri","2k","hdr"]' --project ID` |
| Sketchfab | Scanned and authored models | Per model: many are CC BY, some forbid commercial use. Read the model's page | Manual download with consent, or the community MCP |
| Poly Pizza | Low-poly models | Per model, often CC0 or CC BY | Manual download with consent, or the community MCP |
| BlenderKit | Models, materials, add-on workflow | Per asset: its own Royalty Free licence or CC0 | Needs its add-on and an account: ask first |

A search hit does not establish rights. Check the licence on the asset's own page and record the date.

## Handling files

- Prefer formats that cannot run code: `.hdr`, `.exr`, `.jpg`, `.png`, `.glb`, `.fbx`, `.obj`. A `.blend` can carry scripts and drivers.
- An untrusted `.blend` is safer with the runner's defaults, which disable auto-run and load factory settings. Blender still parses the file, so prefer importing from a trusted source.
- `.blend` files may link to external images. Check for missing files, and keep textures in the project with relative paths.
- Store originals unchanged. The runner hashes `--script` and `--blend` into its manifest.

## Plugins

Use the [pinned extension route](../../../../docs/blender-arsenal/README.md): `pnpm blender:ext inspect`, `propose`, `trial`, evaluate, then `approve --consent` and `install`. A trial uses a separate disposable profile. Network permission or an account dependency remains trial-only without explicit user approval (`--allow-network-account`).

Run approved installed pins with `pnpm blender:run --extensions ID` (comma-separated ids, or `approved`). Factory startup stays on; versions appear in run metadata. `avc_extensions.require("id", "1.0.0")` checks a shot dependency. Never install into the user's profile, use unpinned installs, or load plugins with `--no-factory-startup`. Third-party code has the user's permissions; isolation protects preferences, not the operating system. Record licence and source in `sources` too.


Shortlist (5.3.0: six pass; Node To Python export blocked; all proposed; [evaluations](../../../../docs/blender-arsenal/README.md)):

| Id | Film capability | Helper / call after `require()` |
|---|---|---|
| `add_camera_rigs` | Dolly, crane, 2D rigs | `bpy.ops.object.build_camera_rig` |
| `camera_shakify` | Captured handheld motion | `avc_extensions.camera_shake` |
| `cell_fracture` | Seeded shards | `avc_extensions.fracture_object`; `seeded` |
| `light_it_up` | Studio light presets | `bpy.ops.light_it_up.high_key` |
| `extra_mesh_objects` | Gears, gems, rocks | `bpy.ops.mesh.primitive_gear` |
| `enhanced_svg` | Colour-aware SVG logos | `bpy.ops.import_scene.import_svg`, external images off |
| `node_to_python` | Export blocked on 5.3; retain 5.2 evidence | `bpy.ops.ntp.export`, file export, `--no-render` |

Built-in first: GN + Essentials for scatter/randomise/array, effectors/falloffs/stagger; simulation zones/Mantaflow/dynamics for particles, fluids, smoke, cloth and hair (bake); F-modifiers for looping noise; kit curves or BACK/ELASTIC/BOUNCE for easing; empty-parent keys for turntables/orbits; FONT/String to Curves for text; bundled SVG/glTF/FBX and native model importers; Essentials/Poly Haven/ambientCG library files for studio worlds and materials; Essentials compositor finishing and screen-space projection; bundled node_wrangler and rigify. Bradley fracture, debris and text groups use the library route, whose native extension package now installs on 5.3; direct pinned append remains preferred for headless work.

`user_default` and `system` were verified under factory startup; the harness retains Blender's `install-file --no-prefs` route with an isolated system-extension directory. Saved enabled state never replaces explicit per-process enabling; register the pinned add-ons before loading a `.blend` that uses their RNA. Camera Shakify must be enabled when reopening/rendering its scene; the wrapper records a checked dependency and never embeds a farm script. Seed each noisy operation; `seeded` restores Python RNG state but Blender has no noise-state getter. Approval of `node_to_python` is authoring-only.
Third-party add-ons run with your user's permissions. A run that depends on the user's installed add-ons needs `--no-factory-startup`, which also loads their preferences, so results are less repeatable.

## Local asset library

Use `pnpm blender:assets --action search --query <q> --local` before fetching a shot asset. Sources in `blender-arsenal/libraries.json` must be approved; downloads also require recorded `--consent "who/when/why"`. `--pin` records exact files and companion hashes. Collections are proposals until pinned. Poly Haven remains available via `resources:poly-haven` and is also a library adapter. `assets:sync` owns harness device GLBs/HDRIs; `blender:assets` owns per-shot picks.

In Blender scripts: `import avc_assets`, `avc_assets.register_library()` (session only), `avc_assets.append("source:asset", project="ID")`. Use `scale` for PBR UV repetition, `normalise_scale` for model size, `strength`/`rotation` for HDRIs; `bundled_assets()` enumerates installed Essentials without downloading. Never save preferences. `pnpm blender:assets --action credits --project ID` reports usage credits to carry into the render sidecar. [Guide](../../../../docs/blender-arsenal/README.md).

The library uses reviewed Poly Haven API v2, ambientCG v3, pinned Khronos/Google Fonts git sources, keyed Poly Pizza, CC0-only Smithsonian and SHA256-checked Blender library-server files. Kenney/Quaternius packs use `blender:assets --action import --file PACK.zip --source SOURCE` with licence/page/consent flags. `index --bundled` indexes installed node groups, matcaps and HDRIs in place. Online Essentials supplies studio materials; Bradley 5.2 node files append without installing their 5.3 extension. Native file appends use licensed name/type views. [Verified source table and examples](../../../../docs/blender-arsenal/README.md).
