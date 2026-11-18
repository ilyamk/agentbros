# Node To Python 4.2.0

## Blender 5.3.0 revalidation — 2026-11-15

The [5.3.0 API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.3.0&platform=macos-arm64) returned the same version, URL, SHA-256 and size as the verified 5.2.3 pin. No archive or licence was silently repinned. Factory startup, offline mode, disabled autoexec, isolated user/system extension directories; runs were sequential.

| Measurement | Blender 5.3.0 result |
|---|---:|
| Install-file, launch included | 1062 ms |
| Enable | 40.89 ms |
| Added operators / node groups | 17 / 0 |
| Typical authoring operation | CANCELLED |
| 5.3.0 render / determinism | Not reached |

The add-on’s own version guard rejects Blender >= 5.3.0. No newer compatible pin is published in the queried API. The upstream archive was not modified to bypass that guard. Its 5.2.3 export measurement below remains historical evidence only.

## Verdict

Pending upstream Blender 5.3 support. Keep proposed and do not approve for the installed Blender version. A successful enable does not establish working authoring export.

## Historical Blender 5.2.3 evaluation

The following sections preserve the previous pin and measurements; they are not Blender 5.3 results.

## Purpose for films

Authoring-time conversion of node groups into reviewable bpy source.

Use: `avc_extensions.require + bpy.ops.ntp.export() in ADDON mode with an isolated output directory`. Exported 3,630 bytes across two Python files from a pass-through GN group; both compiled. SCRIPT clipboard mode yielded no text in background Blender, so use file export. Never enable this authoring tool in a render; use --no-render.

## Licence & permissions

- Source: [Node To Python](https://extensions.blender.org/download/sha256:a23d847def65873bf284ab0c80108bd45db61104f7a45fe44f7ec38d849f75e4/add-on-node-to-python-v4.2.0.zip); [SPDX licence](https://www.gnu.org/licenses/gpl-3.0.html): GPL-3.0-or-later.
- Maintainer: Brendan-Parmer. Pin verified 2026-11-15 through the [official API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.2.3&platform=macos-arm64).
- ZIP: 82,229 bytes; SHA-256 `a23d847def65873bf284ab0c80108bd45db61104f7a45fe44f7ec38d849f75e4`.
- Permissions: files: Creates and writes to files in a user-specified directory. Native code/wheels: False; platforms: platform-independent.
- Consent: repo owner, 2026-11-15 — asked the orchestrator to select and set up useful Blender extensions and asset libraries; trial/sample download. This is download/trial consent only.

## Headless & determinism test

Blender 5.2.3 LTS, macOS arm64, factory startup, disabled autoexec, offline mode. Fresh isolated user_default profile, with BLENDER_SYSTEM_EXTENSIONS redirected to an empty directory within the profile. The candidate was explicitly enabled in each process. CPU Cycles, 64×64 RGBA PNG, eight samples, fixed render seed 42, no adaptive sampling or denoising.

The acceptance scene ran the operator in separate processes, rendered frame 20 alone and frames 19–20, then compared decoded pixels. Different pixels: **0 / 4,096**. Geometry SHA-256: `00b6eb21b69c7f8750d325842b9486b5009621b32c5789af52f85e6de6e4f13f` (identical in both processes).

## Trial results

| Measurement | Result |
|---|---:|
| Install-file, launch included | 9772 ms |
| Enable in smoke process | 385.697 ms |
| Added operators / node groups on enable | 17 / 0 |
| Typical operator/setup time | 6.767 ms |
| One-frame render stage (including geometry measurement) | 499.108 ms |
| Full one-frame exercise process, launch included | 10584 ms |
| Differing pixels, alone versus range | 0 / 4,096 |

Additional measured facts: `{"generatedBytes": 3630, "generatedPythonFiles": 2}`. Times are one sample on a shared host, not performance thresholds. Added node-group count is measured immediately after registration; an operator may create more groups later.

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
pnpm blender:ext approve --id node_to_python --consent "$OWNER_APPROVAL"
```

## Recipes that use it

avc_extensions.require + bpy.ops.ntp.export() in ADDON mode with an isolated output directory. No production film or VFX recipe was added; this evaluation supplies an acceptance fixture and a capability for future approved shots.
