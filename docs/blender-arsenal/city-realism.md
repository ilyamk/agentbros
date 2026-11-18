# City generators: sources, scope and limits

## Verdict

Experimental procedural skyline; useful offline geometry and deterministic lighting, not a photogrammetric city. `native-city` and `osm-footprints` are approved local code under the owner's 2026-11-15 integration instruction. `BlenderGIS` stays proposed: legacy registration succeeds on Blender 5.3.0, but the modern extension installer cannot accept its archive and importing it triggers an unpinned FreeImage download. Buildify stays manual; no payload acquired. No paid packages or accounts used.

## Sources and acquisition

- [BlenderGIS](https://github.com/domlysz/BlenderGIS/tree/2add45ffec547f419cc77563a7fe976fd6c8f0c4), GPL-3.0-or-later, upstream `bl_info` 2.2.14. Commit `2add45ffec547f419cc77563a7fe976fd6c8f0c4`; archive SHA-256 `b2780c28283c56f7d0d531a98eb1c91a22fc5f9482dc9273fb25db7f5ab19dee`, 433,486 bytes. Download and registration trial only; nothing vendored or installed in the user's profile.
- [BlenderGIS SRTM documentation](https://github.com/domlysz/BlenderGIS/blob/2add45ffec547f419cc77563a7fe976fd6c8f0c4/README.md): OpenTopography requires a user API key. SRTM is **not integrated or fetched**; the wrapper makes flat-ground footprint geometry. Never present it as measured terrain.
- [Buildify](https://paveloliva.gumroad.com/l/buildify) advertises $0+, commercial use with restrictions against selling the graph or derivatives, and Blender 3.2. Anonymous no-account payload access and an allowed open licence were not established. Its showcased Megascans kits are separate and can cost money for Blender. Record manual, use our native GN fallback; do not infer GPL/CC0 from the $0 price.
- [OpenStreetMap copyright](https://www.openstreetmap.org/copyright): all fetched data and derived cached geometry record **© OpenStreetMap contributors, ODbL**, `ODbL-1.0` and credits. This is the brief's explicit OSM-data exception to the asset licence shortlist. A public distribution of the derived database must retain ODbL obligations; this evaluation distributes no geodata.

Consent on the manifest entries: `{by:"repo owner",date:"2026-11-15",note:"realism wave: free generators/plugins approved for trial and integration"}`. OSM acquisition also records the caller's consent in the source receipt. All downloaded/generated files are below `blender-arsenal/local/`; all Blender profile paths are isolated. The legacy trial additionally overrides HOME before import, keeping `.bgis` and `.imageio` in that trial profile. BlenderGIS's implicit native dependency is a reason not to adopt it for rendering. The downloaded FreeImage dylib is 6,083,008 bytes, SHA-256 `0a78d7ba81f53b30eb422897a83a9cded3296152a2c97ff68a10b23f2212f8d8`; its isolated folder has an `asset.json`. [FreeImage's upstream licence](https://freeimage.sourceforge.io/license.html) offers GPL v2/v3 or FIPL; no binary is redistributed or adopted.

## Architecture and use

`generators.json` is a strict Zod manifest for non-add-on generators, including capabilities, pins/install methods, costs and verdicts. `blender:arsenal candidates --capability city` includes approved native choices, the proposed BlenderGIS pin and manual Buildify. Without a capability filter the existing proposed/rejected candidate view remains.

```bash
pnpm blender:arsenal candidates --capability city
pnpm blender:city --lat 40.709 --lon -74.01 --radius 250 --consent "repo owner / 2026-11-15 / realism wave: free generators/plugins approved for trial and integration"
pnpm blender:recipe render --id osm-city --frames 1-3 --samples 8 --resolution 480x270 --output out/qa/realism/osm-proof
pnpm blender:recipe render --id procedural-city --frames 1-3 --samples 8 --resolution 480x270 --output out/qa/realism/procedural-proof
pnpm blender:recipe render --id window-lights --frames 16-18 --samples 8 --resolution 480x270 --output out/qa/realism/windows-proof
pnpm blender:run --script scripts/blender/shots/city_flyover.py --script-args '["{\"variant\":\"b\"}"]' --frames 1-96 --samples 8 --resolution 480x270 --output out/qa/realism/city-flyover
```

Recipes declare `requires: {extensions:[],generators:[...]}`. `procedural-city` uses true GN instances whose dimensions come from seeded point attributes, batched architectural bands, roof machinery, glazing, asphalt and lane markings. No add-on, account or download is required. `night:false` holds emission at zero; lighting/camera belong to the caller. `window-lights` creates a facade or accepts an existing city pane object; 12 seeded switch banks plus unoccupied dark panes use pure frame functions baked by the kit timeline. Frame jumps do not advance a random generator.

`osm-city` reads cached closed building ways, keeps concave outlines, triangulates roof/base polygons, converts lat/lon to local metres and extrudes `height`/`building:levels` plus `min_height`/`building:min_level`. Explicit feet and metres are recognised. Missing heights use 12 m, malformed/non-finite values fall back; height is bounded at 600 m. Relations, courtyards/holes, roads, roof tags and SRTM are unsupported. An OSM database is incomplete; a cache is a snapshot, not a claim of present-day accuracy. Optional `material_asset` appends a licensed local-store material through `avc_assets.append` after geometry cache loading.

Source cache: `local/generated/osm-source/<lat6>_<lon6>_<radius>/source.json`, `asset.json`, `credits.json`. Fetch once with a 16 MiB response bound; later runs verify the exact source SHA-256 and do not contact the service. Geometry cache: `local/generated/{procedural-city,osm-city}/<parameter-and-code-hash>/city.blend`, `asset.json`, `credits.json`. Identity includes recipe/kit code and, for OSM, the source bytes' hash. A complete blend is published before its receipt; loading verifies its hash. Materials and GN data are appended without scripts. No simulation remains at render time.

The shot's function is an establishing identity reveal: an eased 48 mm drone arc, warm sun against cool dusk, bounded haze, restrained bloom, windows coming on and a rooftop AVC wordmark. The last 12% holds the camera. The finite ground horizon and repeated peripheral masses remain visible limitations. `variant:a` is wider/higher; `variant:b` is lower/closer. All camera/light/material values are keyed through the kit timeline, with shutter guards.

## Trial results

Compatibility qualification for the manifest; raw renders, timings and review packets are ignored output.

| Scope | Qualified setting |
|---|---|
| Native recipe variants | 3 |
| CPU pixel comparison | 0 maximum RGB difference for frame-alone versus range |
| Preview size | 480×270, 8 samples |
| BlenderGIS registration | 2 OSM operators; managed installer unsupported |

Re-run `tests/blender-city.test.ts` with `RUN_BLENDER_TESTS=1` for current local results. Numerical equality does not establish photorealism or creative quality.

## Limits

BlenderGIS remains proposed because registration can fetch an unpinned native dependency. Buildify is manual. No SRTM terrain, general add-on OSM query, courtyards/holes, roads, roof tags or non-CPU visual qualification is claimed. The native importer handles only the documented closed-footprint subset; caches are snapshots rather than present-day geographic truth. The skyline remains experimental, with repeated masses and a finite ground horizon.
