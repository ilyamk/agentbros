# Notice

Agent Bros. Pictures (agentbros): an agent-driven video production system built on Remotion.
Copyright (c) 2026 ILIA MAKSIMENKA

## Licence

The Licensed Work is licensed under the Business Source License 1.1 (SPDX-License-Identifier: `BUSL-1.1`). The full licence text and its parameters are in [LICENSE](LICENSE); this summary does not change them.

- **Licensor:** ILIA MAKSIMENKA.
- **Licensed Work:** the software and documentation in this repository, except the components listed below under [Components under other licences](#components-under-other-licences).
- **Everyone** may copy, modify, create derivative works of, redistribute and make non-production use of the Licensed Work (evaluation, testing, development, study), at any organisation size. Every copy, original or modified, must carry the licence.
- **Additional Use Grant (free production use):** an individual using it on their own behalf, including to produce films and other media for their clients; a Small Organisation, meaning a legal entity that, together with its Affiliates, has no more than three (3) Personnel, counted by head; and a non-profit organisation or an accredited educational or research institution, for its non-commercial activities. None of them may offer the Licensed Work, or a modified version or derivative work of it, to third parties as a hosted, managed or embedded service, API or platform, or distribute, sublicense, sell or resell it as part of or bundled with a product or service offered to third parties. Delivering films and other media made with it is not distribution of the Licensed Work. Use on behalf of an organisation, or in the course of work for it, is that organisation's use.
- **Any other production use**, including use by an organisation with more than three (3) Personnel, needs a commercial licence from the Licensor: [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
- **Change Date:** for each version, the fourth anniversary of its first publicly available distribution under the Business Source License.
- **Change License:** GNU Affero General Public License, version 3 or any later version (`AGPL-3.0-or-later`), with an additional permission under its section 7 for linking or combining with Remotion and GSAP, which stay under their own licences ([LICENSE](LICENSE)). From a version's Change Date, that version is available under the Change License and the Business Source License terms for it end.

The Business Source License is not an Open Source licence. Until its Change Date, each version of Agent Bros. Pictures is source-available, not open source; it converts to AGPL-3.0-or-later four years after its release.

The licence grants no rights in the names "Agent Bros. Pictures" or "agentbros", or in the project's logos and mascot artwork: see [TRADEMARKS.md](TRADEMARKS.md). Contributions are accepted under the [Contributor Licence Agreement](CLA.md).

## Components under other licences

The following material is not part of the Licensed Work. It keeps its own licence, and neither the Business Source License nor a commercial licence from the Licensor changes its terms. [CREDITS.md](CREDITS.md) records provenance; [DEPENDENCY_LICENCES.md](DEPENDENCY_LICENCES.md) inventories locked dependencies, collected notices and declared integration evidence. Inventory status does not grant legal approval.

| Material | Licence | Where the terms are |
|---|---|---|
| The Licensor's Python code that runs inside Blender (see [Blender code](#blender-code-under-gpl-30-or-later) below) | GPL-3.0-or-later | [LICENSES/GPL-3.0-or-later.txt](LICENSES/GPL-3.0-or-later.txt); each file's SPDX header |
| Skills `.agents/skills/copywriter/` and `.agents/skills/ugc-content-creator/` | CC-BY-SA-4.0 | Each folder's `LICENSE.md` |
| Other vendored third-party code, skills and references | Each component's own licence | [Third-party components](#third-party-components) below |
| npm dependencies | Each package's own licence | [DEPENDENCY_LICENCES.md](DEPENDENCY_LICENCES.md) |
| Python dependencies (`uv.lock`, installed by `uv sync`, not redistributed) | Each package's own licence | [Python dependencies](docs/dependency-licences.md#python-dependencies) |
| Fonts, music, sound effects, 3D models, HDRIs, images and other media | Per asset | Asset manifests listed in [CREDITS.md](CREDITS.md) section 3 |

### Blender code under GPL-3.0-or-later

Blender is licensed under the GNU GPL, and Python code that uses its `bpy` API runs inside Blender as part of it. The Licensor therefore licenses its own Python code that runs inside Blender under the GNU General Public License, version 3 or any later version (`GPL-3.0-or-later`), not under the Business Source License. This covers:

- every Python module under `scripts/blender/**` (the studio kit, materials, recipes and shots);
- the Blender workers under `scripts/workers/blender/` that import `bpy` or are loaded by such code, including `avc_vork_bridge.py`, `avc_vork_vfx.py` and `avc_vork_outputs.py`. The bridge runs the GPL-3.0-or-later Vork integration (`vendor/vork-blender/**`) in the same Blender process;
- the Blender workers `scripts/workers/blender_capture.py` and `scripts/workers/blender_scene.py`, which import `bpy`;
- Blender example scripts that import `bpy`: `.agents/skills/blender-3d/references/examples/*.py` and `examples/vork/blender-source.py`;
- the Python tests and test fixtures that import those modules.

Short Blender scripts embedded as strings in TypeScript tests (for example in `tests/blender-run.test.ts` and `tests/vork.test.ts`) are additionally licensed under GPL-3.0-or-later; the rest of those files stays under the Business Source License.

Each such file starts with `# SPDX-License-Identifier: GPL-3.0-or-later`; that header decides which files are covered (`grep -rl --include="*.py" "SPDX-License-Identifier: GPL-3.0-or-later" .` lists them). The full licence text is in [LICENSES/GPL-3.0-or-later.txt](LICENSES/GPL-3.0-or-later.txt). This code is not covered by a commercial licence from the Licensor. The TypeScript code that starts Blender as a separate program and exchanges files with it stays under the Business Source License.

## Remotion and GSAP

Agent Bros. Pictures uses two libraries whose licences have their own conditions. They are not part of the Licensed Work, and neither the Business Source License nor a commercial licence from the Licensor grants any right in them. Anyone who uses, distributes or hosts Agent Bros. Pictures must comply with their terms directly.

- **Remotion** (`remotion` and `@remotion/*` packages, https://www.remotion.dev) is under the Remotion License. For Remotion 4 it is free for individuals, for-profit organisations with up to 3 employees, non-profit organisations and evaluation; any other for-profit organisation needs a paid Remotion Company License. Check the current terms at https://www.remotion.dev/license.
- **GSAP**, the GreenSock Animation Platform, including its plugins (https://gsap.com), is free, including for commercial use, under Webflow's Standard "No Charge" GSAP License (https://gsap.com/standard-license), which prohibits its use in no-code visual animation builders that compete with Webflow without Webflow's written consent.

The free production grant of the Business Source License and the Remotion License use different thresholds and different counting rules. Being free under one does not make use free under the other.

## Remote network interaction

The Business Source License does not require anyone to publish the source of a modified version they run over a network. It does not allow anyone without a commercial licence to offer the Licensed Work, or a modified version of it, to third parties as a hosted, managed or embedded service, API or platform. From a version's Change Date, the AGPL-3.0-or-later terms apply to that version, including section 13 on remote network interaction.

## Rendered films

The Business Source License governs the software, not the films and other media made with it. A rendered film is still subject to the rights in the material it uses: fonts, music, footage, 3D models, voices, provider terms and the Remotion licence for the company that renders it.

## Third-party components

The following parts of this repository are not owned by the Licensor. They keep their own licences and notices.

| Component | Where | Licence | Notice |
|---|---|---|---|
| Hyperframes FrameAdapter (HeyGen) | `vendor/hyperframes/` | Apache-2.0 | `vendor/hyperframes/LICENSE`, hash-pinned in `provenance.json` |
| Hyperframes engine test notices (acorn, nanoid, postcss, TypeScript and others) | `tests/fixtures/hyperframes-engine/notices/` | Each file's own licence: MIT (pretext, acorn, acorn-walk, nanoid, postcss), ISC (picocolors), BSD-3-Clause (source-map-js), Apache-2.0 (TypeScript) | The files themselves |
| ElevenLabs API references (`dubbing`, `music`, `sound-effects`, `speech-to-text`, `text-to-speech`, `voice-changer`, `voice-isolator`), Copyright (c) 2024 ElevenLabs | `docs/reference/elevenlabs/` | MIT (local entry points modified) | Each folder's `LICENSE`; [docs/reference/elevenlabs/README.md](docs/reference/elevenlabs/README.md) |
| Vork Blender integration (voyager-so/vork, `integrations/blender`), modified | `vendor/vork-blender/**` | GPL-3.0-or-later | `vendor/vork-blender/LICENSE`; source commit, changes and file hashes in `vendor/vork-blender/PROVENANCE.json` |
| Claude starter kit skills (`copywriter`, `ugc-content-creator`), Copyright (c) 2025 Sunny Patneedi and Contributors | `.agents/skills/copywriter/`, `.agents/skills/ugc-content-creator/` | CC-BY-SA-4.0 (both modified) | Each folder's `LICENSE.md`; [.agents/skills/THIRD_PARTY.md](.agents/skills/THIRD_PARTY.md) |
| Remotion skills (`remotion-best-practices`) | Not included in the public repository | No licence granted: install it from upstream (`npx skills add remotion-dev/skills`) | [.agents/skills/THIRD_PARTY.md](.agents/skills/THIRD_PARTY.md) |
| Film-ageing and CRT/tape formulas ported from lemo-opuscar, Copyright (c) 2026 LemoLab | `src/motion/library/effects/FilmDamage.tsx`, `CrtTape.tsx` | MIT | [design-reference/sources/lemo-opuscar.md](design-reference/sources/lemo-opuscar.md) |
| shadcn/ui "new-york" tokens and components, Copyright (c) 2023 shadcn | `src/motion/library/ui/surface.tsx`, `apps/console/components/ui/` | MIT | https://github.com/shadcn-ui/ui/blob/main/LICENSE.md |
| affectUI components (decision inbox, tool-call card, thinking loader, notification stack, rating), rewritten, Copyright (c) 2026 Florian Höller (adfects) | `apps/console/components/{decision-card,tool-call,thinking-loader,notification-stack,rating}.tsx` | MIT | https://github.com/flohoeller/affectui/blob/e610c3ba35636bd05aaaec67795086de93d4c0e9/LICENSE |
| Arc UI components (metric card, usage meter, timeline, empty state, stepper), rewritten, Copyright (c) 2026 Elia Kuratli | `apps/console/components/{metric-card,usage-meter,timeline,empty-state,step-rail}.tsx` | MIT | https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/LICENSE |
| Reference measurements translated from ReelMimic, Copyright (c) 2026 ReelMimic contributors | `scripts/workers/reference-moves.py`, parts of `scripts/workers/reference-analysis.py`, `src/lib/reference/{crop,align,findings}.ts`, `src/lib/film/tension.ts`, `src/lib/vision/versus.ts` | MIT | Header of `scripts/workers/reference-moves.py`; [CREDITS.md](CREDITS.md) |
| Library preview renders of the device model "Apple iPhone 15 Pro Max Black" by polyman, modified (scaled, centred, screen UVs and materials changed) | `docs/library/previews/{studio-product-stage,blender-plate,_three}.jpg` and their copies on the project site | CC-BY-4.0 | https://creativecommons.org/licenses/by/4.0/; source page, attribution and changes in `public/shared/3d/sources.json`. Apple and iPhone are trademarks of Apple Inc.; the project is not affiliated with or endorsed by Apple |
| Fonts, stock music, SFX, 3D models, HDRIs | Fetched by `pnpm assets:sync`, not committed | Per asset (OFL, CC0, CC BY and others) | Manifests listed in [CREDITS.md](CREDITS.md) section 3 |

The ported formulas, measurements, tokens and components stay under the MIT licence; the Business Source License applies to the Licensor's own code in the same files. The MIT notice that applies to the lemo-opuscar, shadcn/ui, affectUI, Arc UI and ReelMimic ports is:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Icon resources and SVG exports

The integration uses Phosphor (`@phosphor-icons/core`, MIT), Lucide
(`lucide-static`, ISC and inherited MIT notices), Tabler (`@tabler/icons`, MIT),
Simple Icons (project CC0; individual brand rights remain separate),
`@jsquash/webp` and `wasm-feature-detect` (Apache-2.0), and `@xmldom/xmldom` (MIT). Dependency packages retain their original
licence texts. Acquired SVGs retain project-local notices and provenance.
Iconify collection licences and SVGL brand guidelines apply per acquired resource;
access to either API does not grant blanket rights to all artwork or trademarks.
