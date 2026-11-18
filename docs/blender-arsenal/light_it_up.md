# Light It Up 4.0.0

## Blender 5.3.0 revalidation — 2026-11-15

The [5.3.0 API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.3.0&platform=macos-arm64) returned the same version, URL, SHA-256 and size as the verified 5.2.3 pin. No archive or licence was silently repinned. Factory startup, offline mode, disabled autoexec, isolated user/system extension directories; runs were sequential.

| Measurement | Blender 5.3.0 result |
|---|---:|
| Install-file, launch included | 2479 ms |
| Enable | 23.72 ms |
| Added operators / node groups | 25 / 0 |
| Typical operator/setup | 1.436 ms |
| One-frame render stage, including geometry measurement | 69.751 ms |
| Full one-frame process, launch included | 1179 ms |
| Frame-alone/range differing pixels | 0 / 4,096 |

CPU Cycles, 64×64 RGBA, eight samples, render seed 42. Frame 20 alone equals frame 20 after rendering frame 19 in a fresh process. Geometry SHA-256 `00b6eb21b69c7f8750d325842b9486b5009621b32c5789af52f85e6de6e4f13f` matches both runs. Additional facts: `{"lights": 5}`. Times are single samples on a loaded machine.

## Verdict

Recommended for explicit owner approval for the tested Blender 5.3.0 use. Status remains proposed. Other operators and platforms still need their own evidence.

## Historical Blender 5.2.3 evaluation

The following sections preserve the previous pin and measurements; they are not Blender 5.3 results.

## Purpose for films

Editable studio light presets for a fast directed starting point.

Use: `avc_extensions.require + bpy.ops.light_it_up.high_key()`. High Key created four preset lights plus the test area light (five total). This proves headless construction, not artistic acceptance of the lighting.

## Licence & permissions

- Source: [Light It Up](https://extensions.blender.org/download/sha256:773e46efe54b1048030ed49d06d61c6b05242c14cfe7ba3c18afb3481b9900f9/add-on-light-it-up-v4.0.0.zip); [SPDX licence](https://www.gnu.org/licenses/gpl-3.0.html): GPL-3.0-or-later.
- Maintainer: Rasheed-Shaikh. Pin verified 2026-11-15 through the [official API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.2.3&platform=macos-arm64).
- ZIP: 128,122 bytes; SHA-256 `773e46efe54b1048030ed49d06d61c6b05242c14cfe7ba3c18afb3481b9900f9`.
- Permissions: files: Save your custom lighting presets across Blender versions. Native code/wheels: False; platforms: platform-independent.
- Consent: repo owner, 2026-11-15 — asked the orchestrator to select and set up useful Blender extensions and asset libraries; trial/sample download. This is download/trial consent only.

## Headless & determinism test

Blender 5.2.3 LTS, macOS arm64, factory startup, disabled autoexec, offline mode. Fresh isolated user_default profile, with BLENDER_SYSTEM_EXTENSIONS redirected to an empty directory within the profile. The candidate was explicitly enabled in each process. CPU Cycles, 64×64 RGBA PNG, eight samples, fixed render seed 42, no adaptive sampling or denoising.

The acceptance scene ran the operator in separate processes, rendered frame 20 alone and frames 19–20, then compared decoded pixels. Different pixels: **0 / 4,096**. Geometry SHA-256: `00b6eb21b69c7f8750d325842b9486b5009621b32c5789af52f85e6de6e4f13f` (identical in both processes).

## Trial results

| Measurement | Result |
|---|---:|
| Install-file, launch included | 7158 ms |
| Enable in smoke process | 85.1 ms |
| Added operators / node groups on enable | 25 / 0 |
| Typical operator/setup time | 0.858 ms |
| One-frame render stage (including geometry measurement) | 427.339 ms |
| Full one-frame exercise process, launch included | 5981 ms |
| Differing pixels, alone versus range | 0 / 4,096 |

Additional measured facts: `{"lights": 5}`. Times are one sample on a shared host, not performance thresholds. Added node-group count is measured immediately after registration; an operator may create more groups later.

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
pnpm blender:ext approve --id light_it_up --consent "$OWNER_APPROVAL"
```

## Recipes that use it

avc_extensions.require + bpy.ops.light_it_up.high_key(). No production film or VFX recipe was added; this evaluation supplies an acceptance fixture and a capability for future approved shots.
