# Add Camera Rigs 1.9.2

## Blender 5.3.0 revalidation — 2026-11-15

The [5.3.0 API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.3.0&platform=macos-arm64) returned the same version, URL, SHA-256 and size as the verified 5.2.3 pin. No archive or licence was silently repinned. Factory startup, offline mode, disabled autoexec, isolated user/system extension directories; runs were sequential.

| Measurement | Blender 5.3.0 result |
|---|---:|
| Install-file, launch included | 3120 ms |
| Enable | 24.843 ms |
| Added operators / node groups | 8 / 0 |
| Typical operator/setup | 5.673 ms |
| One-frame render stage, including geometry measurement | 283.654 ms |
| Full one-frame process, launch included | 3806 ms |
| Frame-alone/range differing pixels | 0 / 4,096 |

CPU Cycles, 64×64 RGBA, eight samples, render seed 42. Frame 20 alone equals frame 20 after rendering frame 19 in a fresh process. Geometry SHA-256 `d2b523c741d3d1f394c0ae752f578daf1b271305b67b608225c9ff90a9d0e5a4` matches both runs. Additional facts: `{"armatures": 1}`. Times are single samples on a loaded machine.

## Verdict

Recommended for explicit owner approval for the tested Blender 5.3.0 use. Status remains proposed. Other operators and platforms still need their own evidence.

## Historical Blender 5.2.3 evaluation

The following sections preserve the previous pin and measurements; they are not Blender 5.3 results.

## Purpose for films

Editable dolly, crane and 2D armature rigs for controlled product-camera moves.

Use: `avc_extensions.require + bpy.ops.object.build_camera_rig(mode="DOLLY")`. Dolly operator generated one armature. The loader must create an in-memory preferences entry (default_set=True); no preferences are saved.

## Licence & permissions

- Source: [Add Camera Rigs](https://extensions.blender.org/download/sha256:548ecf6372563948f5b3cf292dd01a3209f77ef730eb38b0197cd50ffd7377cd/add-on-add-camera-rigs-v1.9.2.zip); [SPDX licence](https://www.gnu.org/licenses/gpl-3.0.html): GPL-3.0-or-later.
- Maintainer: WayneDixon. Pin verified 2026-11-15 through the [official API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.2.3&platform=macos-arm64).
- ZIP: 15,062 bytes; SHA-256 `548ecf6372563948f5b3cf292dd01a3209f77ef730eb38b0197cd50ffd7377cd`.
- Permissions: None declared. Native code/wheels: False; platforms: platform-independent.
- Consent: repo owner, 2026-11-15 — asked the orchestrator to select and set up useful Blender extensions and asset libraries; trial/sample download. This is download/trial consent only.

## Headless & determinism test

Blender 5.2.3 LTS, macOS arm64, factory startup, disabled autoexec, offline mode. Fresh isolated user_default profile, with BLENDER_SYSTEM_EXTENSIONS redirected to an empty directory within the profile. The candidate was explicitly enabled in each process. CPU Cycles, 64×64 RGBA PNG, eight samples, fixed render seed 42, no adaptive sampling or denoising.

The acceptance scene ran the operator in separate processes, rendered frame 20 alone and frames 19–20, then compared decoded pixels. Different pixels: **0 / 4,096**. Geometry SHA-256: `d2b523c741d3d1f394c0ae752f578daf1b271305b67b608225c9ff90a9d0e5a4` (identical in both processes).

## Trial results

| Measurement | Result |
|---|---:|
| Install-file, launch included | 7976 ms |
| Enable in smoke process | 119.996 ms |
| Added operators / node groups on enable | 8 / 0 |
| Typical operator/setup time | 1.579 ms |
| One-frame render stage (including geometry measurement) | 711.978 ms |
| Full one-frame exercise process, launch included | 6283 ms |
| Differing pixels, alone versus range | 0 / 4,096 |

Additional measured facts: `{"armatures": 1}`. Times are one sample on a shared host, not performance thresholds. Added node-group count is measured immediately after registration; an operator may create more groups later.

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
pnpm blender:ext approve --id add_camera_rigs --consent "$OWNER_APPROVAL"
```

## Recipes that use it

avc_extensions.require + bpy.ops.object.build_camera_rig(mode="DOLLY"). No production film or VFX recipe was added; this evaluation supplies an acceptance fixture and a capability for future approved shots.
