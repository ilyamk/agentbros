# Cell Fracture 0.2.1

## Blender 5.3.0 revalidation — 2026-11-15

The [5.3.0 API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.3.0&platform=macos-arm64) returned the same version, URL, SHA-256 and size as the verified 5.2.3 pin. No archive or licence was silently repinned. Factory startup, offline mode, disabled autoexec, isolated user/system extension directories; runs were sequential.

| Measurement | Blender 5.3.0 result |
|---|---:|
| Install-file, launch included | 2912 ms |
| Enable | 13.812 ms |
| Added operators / node groups | 1 / 0 |
| Typical operator/setup | 43.721 ms |
| One-frame render stage, including geometry measurement | 139.952 ms |
| Full one-frame process, launch included | 1806 ms |
| Frame-alone/range differing pixels | 0 / 4,096 |

CPU Cycles, 64×64 RGBA, eight samples, render seed 42. Frame 20 alone equals frame 20 after rendering frame 19 in a fresh process. Geometry SHA-256 `1331572fd979b3aaaee7a021cd30158eddc3c2c8262f2050fd2d881b80df5dba` matches both runs. Additional facts: `{}`. Times are single samples on a loaded machine.

Seed 43 produced different geometry: `6a416018e1b3f03cd71d0b7a1c9e1093f95740f84e50aaa1f4d5341aafb29f2c`.

## Verdict

Recommended for explicit owner approval for the tested Blender 5.3.0 use. Status remains proposed. Other operators and platforms still need their own evidence.

## Historical Blender 5.2.3 evaluation

The following sections preserve the previous pin and measurements; they are not Blender 5.3 results.

## Purpose for films

Seeded mesh shards for logo shatters and exploded reveals without simulation.

Use: `avc_extensions.fracture_object(mesh, seed=42)`. Eight shards; Python random and mathutils.noise both seeded. Different seed changes geometry. Rigid-body motion would require a separate baked simulation.

## Licence & permissions

- Source: [Cell Fracture](https://extensions.blender.org/download/sha256:878bbd46e0c735da689101aeed9ebe99f18c0d8d0cbd2e9e17ed8cda6b264fb2/add-on-cell-fracture-v0.2.1.zip); [SPDX licence](https://www.gnu.org/licenses/gpl-3.0.html): GPL-3.0-or-later.
- Maintainer: Community. Pin verified 2026-11-15 through the [official API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.2.3&platform=macos-arm64).
- ZIP: 9,722 bytes; SHA-256 `878bbd46e0c735da689101aeed9ebe99f18c0d8d0cbd2e9e17ed8cda6b264fb2`.
- Permissions: None declared. Native code/wheels: False; platforms: platform-independent.
- Consent: repo owner, 2026-11-15 — asked the orchestrator to select and set up useful Blender extensions and asset libraries; trial/sample download. This is download/trial consent only.

## Headless & determinism test

Blender 5.2.3 LTS, macOS arm64, factory startup, disabled autoexec, offline mode. Fresh isolated user_default profile, with BLENDER_SYSTEM_EXTENSIONS redirected to an empty directory within the profile. The candidate was explicitly enabled in each process. CPU Cycles, 64×64 RGBA PNG, eight samples, fixed render seed 42, no adaptive sampling or denoising.

The acceptance scene ran the operator in separate processes, rendered frame 20 alone and frames 19–20, then compared decoded pixels. Different pixels: **0 / 4,096**. Geometry SHA-256: `1331572fd979b3aaaee7a021cd30158eddc3c2c8262f2050fd2d881b80df5dba` (identical in both processes).

Seed 43 geometry SHA-256: `6a416018e1b3f03cd71d0b7a1c9e1093f95740f84e50aaa1f4d5341aafb29f2c`; differs from seed 42 as required. No simulation is performed.

## Trial results

| Measurement | Result |
|---|---:|
| Install-file, launch included | 4080 ms |
| Enable in smoke process | 70.168 ms |
| Added operators / node groups on enable | 1 / 0 |
| Typical operator/setup time | 123.201 ms |
| One-frame render stage (including geometry measurement) | 944.084 ms |
| Full one-frame exercise process, launch included | 5125 ms |
| Differing pixels, alone versus range | 0 / 4,096 |

Additional measured facts: `{}`. Times are one sample on a shared host, not performance thresholds. Added node-group count is measured immediately after registration; an operator may create more groups later.

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
pnpm blender:ext approve --id cell_fracture --consent "$OWNER_APPROVAL"
```

## Recipes that use it

avc_extensions.fracture_object(mesh, seed=42). No production film or VFX recipe was added; this evaluation supplies an acceptance fixture and a capability for future approved shots.
