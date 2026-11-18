# Live session

`pnpm blender:live` keeps one Blender scene open between commands. You build it, render a still, look at the still, fix the scene and look again, without restarting Blender each time. Every change is journaled, so the result goes back to `blender:run` as a reproducible recipe. MCP tool: `avc_blender_live`, with the same actions and a `params` JSON string. Why we built our own bridge rather than adopt an existing MCP server: [evaluation](../../../../docs/blender-mcp-evaluation.md).

## Live session or blender:run

| Use | When |
|---|---|
| `blender:live` | Finding a look: framing, light, materials, a kit shot's keys. You need to see a still after each change. A scene built from primitives, kit shots, local assets and built-in recipes |
| `blender:run` | Everything that is decided: sequences, plates, production renders, `--encode`, `--import`. Any scene that needs its own Python (simulations, bakes, geometry the ops cannot make) |

A session renders stills and short strips, never a delivery. Every finished look leaves the session as a recipe and is rendered by `blender:run`.

## Start

```bash
pnpm blender:live --action start --project <id>              # empty scene: no objects, a dark grey world
pnpm blender:live --action start --project <id> --blend public/projects/<id>/assets/blender/base.blend
pnpm blender:live --action kits                              # shot scripts run-kit accepts
```

Starting a session is starting Blender work: if the brief did not ask for 3D, ask the user first ([SKILL.md](../SKILL.md) section 3). The session runs Blender in the background, the same build `blender:run` finds. It exits by itself after 30 idle minutes (`--idle-minutes`). `--session <name>` runs several side by side. `status` reports whether one is running. Starting again reuses a running session.

## The loop: inspect, change, still, critique

1. **Inspect.** `--action inspect` lists objects (transforms, sizes, materials), cameras, lights, materials and the scene's engine, resolution, frame range, camera and world. Read it before you change anything.
2. **Change one thing.** Use one of these actions with `--params '<json>'`:

   | Action | Params |
   |---|---|
   | `run-kit` | `{"script": "hero_turntable.py", "params": {...}}`: a shot from `scripts/blender/` with its JSON keys (each script's docstring). It **replaces** the scene and the journal |
   | `add` | `{"kind": "cube", "name": "box", "location": [0,0,1], "rotation_deg": [0,0,30], "scale": [1,1,1], "material": "clay"}`. Kinds: cube, sphere, ico-sphere, cylinder, cone, plane, torus, monkey, empty, camera (`lens`, `target`, `active_camera`), light (`light_type` AREA/POINT/SUN/SPOT, `energy`, `color`, `size`, `target`) |
   | `material` | `{"name": "clay", "base_color": "#c8643c", "roughness": 0.4, "metallic": 0, "assign_to": ["box"]}`, plus `transmission`, `ior`, `coat`, `emission_color`, `emission_strength`, `alpha`. It creates the material or updates it |
   | `set` | `{"target": {"kind": "object", "name": "box"}, "path": "location", "value": [0,0,2], "frame": 10}`. Target kinds: object, material, camera, light, world, scene, mesh. `path` is RNA attributes and literal subscripts, for example `data.lens`, `render.resolution_x`, `node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value`, `camera` (assign by name). `frame` sets a keyframe |
   | `append-asset` | `{"id":"ambientcg:Wood096","target":"box","material_scale":2}`. Local indexed ids only; `kind` checks the expected kind, `name` selects a native datablock/member, model `scale` normalises longest dimension in metres, `location` places its root, and `target` assigns a material to an existing mesh. Missing ids name the consent-gated `blender:assets add` command; nothing downloads |
   | `apply-recipe` | `{"id":"dust-burst","params":{"count":12,"seed":42}}`. Recipe metadata validates every key, resolves defaults and returns created objects/cache evidence. Bakes stay in `blender-arsenal/local/bakes/` |
   | `enable-extension` | `{"id":"cell_fracture"}`. Approved, installed, undrifted pins only; start with `--extensions cell_fracture` or `--extensions approved`. Startup enables the selected pins and records them in the journal. No install or download |
   | `arsenal` | Read-only `{"kind":"materials","filter":"wood","limit":5}`. Counts and first N local ids per kind, recipes with params/status, approved installed extensions, collections with present/missing ids. Limit 1–100, default 10; kind filters asset groups, text filter matches each inventory category |
   | `delete` | `{"name": "box"}` |
   | `reset` | Back to the empty scene, with an empty journal |

3. **Render a still and look at it.** Run `--action still --params '{"name":"key-light","frame":40,"width":960,"height":540,"samples":16,"engine":"cycles"}'`. It renders on the CPU by default (`"device":"gpu"` is faster, but its pixels can differ slightly), and the overrides apply to that still only. Open the returned PNG with your image tool: `Read` in Claude Code, `view_image` in Codex. A path is not a look. For motion, `--action strip --params '{"frames":[1,60],"count":6,"width":480,"height":270}'` returns frames and a contact sheet.
4. **Critique in words** before the next change, for example "the key light flattens the face, the floor is brighter than the subject". Change one group of settings, render the same frame again and compare. Do not start a sequence until a still is good. The quality loop in [SKILL.md](../SKILL.md) still applies.

A failed action changes nothing: the session rebuilds the scene from the journal.

The journal is on disk after every change, at `out/<id>/blender-live/<session>/journal.live.json`, in the same recipe format `export` writes. If the session exits (idle timeout, crash), nothing is lost: render that file with the `blender:run` replay command below. Copy it to keep it: a new session of the same name overwrites it at its first change.

## From session to committed scene

1. **Export** with `--action export --params '{"name":"hero-look"}'`. This writes `public/projects/<id>/assets/blender/hero-look.live.json`, the base plus every journaled op, and returns the `blender:run` command that renders it. The command repeats the last still's frame, size, samples and engine; params override them.

   ```bash
   pnpm blender:run --script scripts/workers/blender/avc_live_replay.py \
     --script-args '["public/projects/<id>/assets/blender/hero-look.live.json"]' \
     --output out/<id>/hero-look-replay --frames 40-40 --device cpu --engine cycles --resolution 960x540 --samples 16
   ```

   The replay applies the same op code the session ran. On the CPU it matches the session's still pixel for pixel (tested). A `.blend` base is pinned by its sha256, and the replay refuses a changed file.
2. **Render the final** with `blender:run` and the recipe, as in SKILL.md section 6: full size, the frame range, `--encode`, `--import`. The recipe and its project folder travel with the project.
3. **Optional `.blend` snapshot.** `--action save --params '{"name":"hero-look"}'` writes `public/projects/<id>/assets/blender/hero-look.blend` for a person to open. It is not the reproducible source; the recipe is.
4. **Graduate when the ops run out.** If a shot needs a new parameter, write it into a scene script under `public/projects/<id>/assets/blender/` (or, for a reusable shot, a kit script with the owner of `scripts/blender/`), keep the recipe's values as its defaults, and render it with `blender:run`.

`export-recipe` takes the same params as `export` and also writes a readable `.py` shot using `avc_assets.append`/`avc_recipes.apply`, with the same pin checks. Its returned `blender:run` command renders that script. Exports carry extension selectors when required. Asset journal entries pin the receipt SHA256, metadata and every payload hash; recipes pin resolved params and recipe/kit code. Replay refuses changed or missing pins. Recipe/kit source edits after a recipe attempt or `run-kit` require restarting the session, including after reset; this prevents stale imported helpers from being replayed under new hashes.

`save`, `export-recipe` and `export` refuse to overwrite. `--overwrite` exists on the CLI only: ask the user first.

## Safety

- **Local and authenticated.** The server listens on `127.0.0.1` only, on a port the OS picks. Every request carries a 256-bit token, compared in constant time. The token lives in `.cache/blender-live/<project|_qa>/<session>/session.json`, mode 0600, and never appears in argv or in any command output. Never print, copy or commit it.
- **No arbitrary code.** There is no Python, expression or shell action. `run-kit` runs only shot scripts tracked in `scripts/blender/`; the shared kits and `prepare_devices.py` are excluded. `set` refuses drivers, expressions, scripts, texts, libraries, file paths and private names, so it cannot load or write files. Blender starts with `--factory-startup --disable-autoexec`, with isolated user/system resources. Explicit `--extensions` loads only approved installed pins; scripts embedded in a `.blend` do not run.
- **No downloads.** Blender runs with `--offline-mode` (Online Access off), and no action fetches anything. Models, HDRIs and textures arrive through `pnpm assets:sync` or `asset:import`, with source and licence recorded in the assets manifest and `CREDITS.md` ([assets and plugins](assets-and-plugins.md)). The user grants each download.
- **Contained outputs.** You pass names (`[a-z0-9-]`), never paths. Renders go to `out/<id>/blender-live/<session>/` (or `out/qa/...` without a project). Saves and recipes go to `public/projects/<id>/assets/blender/`. Node and Blender each check containment.
- **Stop it when done** with `--action stop`. A session holds the scene in memory and a Blender process.
- **Third-party servers.** The Blender Lab and community MCP servers run arbitrary Python on an unauthenticated port. Use them only on the user's explicit request, pinned and installed by the user ([MCP routes](mcp-routes.md)). Their work still ends as a script or recipe that `blender:run` replays.

## Failures

| Error | Meaning |
|---|---|
| `INVALID_INPUT: No live session` | Run `--action start` first |
| `VALIDATION: Missing or wrong session token` | The session was restarted; the CLI reads the new token. Never hand-craft requests |
| `VALIDATION` from `set` | A forbidden or read-only property. Choose another path, or graduate to a scene script |
| `ASSET_MISSING` from `run-kit` | A shared HDRI or GLB is not on disk. Run `pnpm assets:sync`, then retry |
| `TIMEOUT` | The still took longer than `--timeout` seconds (default 600). The session keeps running. Lower the size or samples, or raise `--timeout`; for MCP, the server's `--timeout-ms` |

## Arsenal worked example

Intent: a warm textured hero, grounded on a dark cyclorama, with a small dust accent at frame 20. The two asset ids below must already be in the local store; use `arsenal` to choose available ids. Acquiring a missing asset remains a separate consent-gated operation. No extension is needed.

```bash
pnpm blender:live --action start --session arsenal-look
pnpm blender:live --action arsenal --session arsenal-look --params '{"limit":5}'
pnpm blender:live --action add --session arsenal-look --params '{"kind":"sphere","name":"Hero","location":[0,0,1],"smooth":true}'
pnpm blender:live --action append-asset --session arsenal-look --params '{"id":"ambientcg:Wood096","target":"Hero","material_scale":2}'
pnpm blender:live --action append-asset --session arsenal-look --params '{"id":"polyhaven:brown_photostudio_02"}'
pnpm blender:live --action apply-recipe --session arsenal-look --params '{"id":"studio-floor","params":{"colour":"#171f24"}}'
pnpm blender:live --action apply-recipe --session arsenal-look --params '{"id":"dust-burst","params":{"count":12,"seed":42}}'
pnpm blender:live --action add --session arsenal-look --params '{"kind":"camera","name":"Camera","location":[5,-6,4],"target":[0,0,0.8]}'
pnpm blender:live --action add --session arsenal-look --params '{"kind":"light","name":"Key","location":[3,-3,5],"target":[0,0,1],"energy":600,"size":2}'
pnpm blender:live --action still --session arsenal-look --params '{"name":"look","frame":20,"width":640,"height":360,"samples":16,"engine":"cycles"}'
# Open the returned PNG, critique the light/texture/effect, then export the chosen look.
pnpm blender:live --action export-recipe --session arsenal-look --params '{"name":"arsenal-look"}'
pnpm blender:live --action stop --session arsenal-look
```

For a project, add `--project <id>` to each command. Without one, outputs stay under `out/qa/blender-live/arsenal-look/`. Render the returned command to replay. `reset` and `run-kit` preserve enabled-extension journal entries so later exports retain their dependencies.
