# Extra Mesh Objects 0.4.1

## Blender 5.3.0 revalidation — 2026-11-15

The [5.3.0 API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.3.0&platform=macos-arm64) returned the same version, URL, SHA-256 and size as the verified 5.2.3 pin. No archive or licence was silently repinned. Factory startup, offline mode, disabled autoexec, isolated user/system extension directories; runs were sequential.

| Measurement | Blender 5.3.0 result |
|---|---:|
| Install-file, launch included | 4050 ms |
| Enable | 723.964 ms |
| Added operators / node groups | 33 / 0 |
| Typical operator/setup | 2.658 ms |
| One-frame render stage, including geometry measurement | 136.459 ms |
| Full one-frame process, launch included | 2877 ms |
| Frame-alone/range differing pixels | 0 / 4,096 |

CPU Cycles, 64×64 RGBA, eight samples, render seed 42. Frame 20 alone equals frame 20 after rendering frame 19 in a fresh process. Geometry SHA-256 `ff806f1451ab082b00ba4349c5831dc01bcc0a46961e7f00c0163989b2a0a583` matches both runs. Additional facts: `{"vertices": 336}`. Times are single samples on a loaded machine.

## Verdict

Recommended for explicit owner approval for the tested Blender 5.3.0 use. Status remains proposed. Other operators and platforms still need their own evidence.

## Historical Blender 5.2.3 evaluation

The following sections preserve the previous pin and measurements; they are not Blender 5.3 results.

## Purpose for films

Parametric gears, gems and rocks as supporting props for product films.

Use: `avc_extensions.require + bpy.ops.mesh.primitive_gear(number_of_teeth=12)`. Twelve-tooth gear: 336 vertices. Other generators, particularly rocks, need their explicit seed and separate tests.

## Licence & permissions

- Source: [Extra Mesh Objects](https://extensions.blender.org/download/sha256:c85ce4bb2820d5af26b4dad66bf1a0fdeb4bfeffc668c5e4f098f1e416ed434b/add-on-extra-mesh-objects-v0.4.1.zip); [SPDX licence](https://www.gnu.org/licenses/gpl-3.0.html): GPL-3.0-or-later.
- Maintainer: Community. Pin verified 2026-11-15 through the [official API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.2.3&platform=macos-arm64).
- ZIP: 133,442 bytes; SHA-256 `c85ce4bb2820d5af26b4dad66bf1a0fdeb4bfeffc668c5e4f098f1e416ed434b`.
- Permissions: None declared. Native code/wheels: False; platforms: platform-independent.
- Consent: repo owner, 2026-11-15 — asked the orchestrator to select and set up useful Blender extensions and asset libraries; trial/sample download. This is download/trial consent only.

## Headless & determinism test

Blender 5.2.3 LTS, macOS arm64, factory startup, disabled autoexec, offline mode. Fresh isolated user_default profile, with BLENDER_SYSTEM_EXTENSIONS redirected to an empty directory within the profile. The candidate was explicitly enabled in each process. CPU Cycles, 64×64 RGBA PNG, eight samples, fixed render seed 42, no adaptive sampling or denoising.

The acceptance scene ran the operator in separate processes, rendered frame 20 alone and frames 19–20, then compared decoded pixels. Different pixels: **0 / 4,096**. Geometry SHA-256: `ff806f1451ab082b00ba4349c5831dc01bcc0a46961e7f00c0163989b2a0a583` (identical in both processes).

## Trial results

| Measurement | Result |
|---|---:|
| Install-file, launch included | 5820 ms |
| Enable in smoke process | 608.748 ms |
| Added operators / node groups on enable | 33 / 0 |
| Typical operator/setup time | 1.383 ms |
| One-frame render stage (including geometry measurement) | 462.041 ms |
| Full one-frame exercise process, launch included | 8935 ms |
| Differing pixels, alone versus range | 0 / 4,096 |

Additional measured facts: `{"vertices": 336}`. Times are one sample on a shared host, not performance thresholds. Added node-group count is measured immediately after registration; an operator may create more groups later.

Enable-only full-run overhead is measured independently with the no-op fixture in round-two verification. It is not meaningful to subtract a no-extension scene from this operator-modified scene: geometry, lights or camera differ.

Reproduce after consented archives are cached:

```bash
RUN_BLENDER_EXTENSION_TRIALS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-ext-adoption.test.ts
```

The scene code is `tests/fixtures/blender-extension-exercise.py`. Local result JSON includes the complete added-operator list, frame paths, camera matrix, geometry hashes and timings under `blender-arsenal/local/trials/acceptance-*/`. Tests never fetch.

## Historical Blender 5.2.3 verdict

Recommended for explicit owner approval for the tested use, with the limitations above. Status remains **proposed**. Headless function and frame determinism were verified; creative quality and wider operator coverage are not claimed.

Approval after the owner supplies their actual decision:

```bash
pnpm blender:ext approve --id extra_mesh_objects --consent "$OWNER_APPROVAL"
```

## Recipes that use it

avc_extensions.require + bpy.ops.mesh.primitive_gear(number_of_teeth=12). No production film or VFX recipe was added; this evaluation supplies an acceptance fixture and a capability for future approved shots.
