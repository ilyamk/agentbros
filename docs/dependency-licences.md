# Dependency licences

Last updated: 2026-11-18

[DEPENDENCY_LICENCES.md](../DEPENDENCY_LICENCES.md) is the human-readable inventory.
[DEPENDENCY_LICENCES.json](../DEPENDENCY_LICENCES.json) is its machine-readable
companion, including collected licence and notice texts. Neither changes this
repository's licence or the terms of third-party material.

## Collect and validate

After installing the locked dependencies, run:

```bash
pnpm deps:licences --write
pnpm deps:licences --check
pnpm deps:licences --check --strict
pnpm deps:licences --check --strict --scope repository-source
```

Collection is offline, executes no package scripts and grants no approval. It
also runs last in `pnpm regen`, after the credit ledger is regenerated. It
includes every identity in every pnpm lockfile document: production, development,
optional/platform packages and the package manager. It records exact versions,
lock-entry fingerprints, declared licences, authors/repositories when supplied,
and package-root licence, copyright and notice files, including files directly
inside `licence(s)`, `license(s)` and `legal` directories. Texts are deduplicated
by SHA-256 without removing copyright statements. Unusual nested notices need
manual inspection; an SPDX declaration alone is not a complete notice bundle.

`--check` verifies freshness. CI additionally selects
`--strict --scope repository-source`. It verifies the generated inventory and review against the
lockfile, policy, declared integration records and vendored evidence. It also
compares installed package evidence where the inventory already has it. Packages
absent on the current platform retain previously collected evidence only when
their exact identity and lock-entry fingerprint match. Missing evidence remains
explicitly missing; a Linux checkout does not need to install macOS binaries.
Run collection on another platform to add its evidence. This is an inventory
freshness check, not a licence approval or a release clearance.

With the default `--scope package-policy`, `--strict` blocks every package whose policy status is not `allowed`
or without a non-empty collected notice text. Existing unresolved dependencies are
not grandfathered into approval. A passing strict check covers the selected scope
only: it does not certify compatibility, complete source/notice delivery,
commercial eligibility, model rights or API terms.

The existing `pnpm deps:check --base BASE` remains the required new-dependency
licence and vulnerability gate. A protected exact-version source-only decision
can supply integrity-verified archive metadata on another platform; unreviewed
missing metadata still blocks. It never trusts the generated inventory as approval. [Policy](../contrib/licence-allowlist.json)
changes need the existing protected-path maintainer review. Adding an expression
to that policy is a licensing decision, never an automatic remedy for a failure.

## Exact-version review and source distribution

2026-11-18: 88 fresh exact-version dependency reviews retain verified archives and notices for repository-source distribution only; no runtime authorisations are added.

The 2026-11-18 dependency refresh adds 88 independently verified exact-version records, preserving historical evidence. All new npm archives were checked against their complete locked SRI; actual manifests, notices and pinned Remotion 4.0.544 documentation were inspected without executing payloads. The current source-only check covers 729 package identities, with 234 matching reviews and no unresolved source-scope findings. It adds no runtime authorisations and does not cover binary, installer or browser/WASM redistribution.

The [review report](dependency-licence-review.md) closes all 205 original findings
for distributing this repository's own source, dependency manifests and notices
under the Business Source License 1.1 (BUSL-1.1) and the Licensor's commercial licence.
The protected `contrib/licence-reviews.json` records each archive's lock-entry hash,
integrity, exact manifest hash, observed licence declaration, evidence texts,
chosen terms, conditions and scope. All 205 archives were fetched from the npm
registry and their full compressed bytes verified against the locked integrity.
Missing platform evidence is no longer inferred from a sibling package.

The report retains original `UNLICENSED`/missing fields. For Remotion effects,
transitions and media, the pinned v4.0.539 and v4.0.544 package-specific documentation supplies
the separately recorded Remotion License. `webgl-constants` has an MIT grant in
its exact archive despite the missing manifest field. Python-2.0, CC-BY-4.0,
Zlib and MPL are assessed per version with obligations; the global allowlist is
unchanged. The inventory's policy column continues to report its raw policy result.

### Assessment for BUSL-1.1 and the commercial licence

On 2026-11-17 every record was reassessed for the project's licensing: the
Licensor's code is distributed under BUSL-1.1 (source-available, not open source;
each version converts to AGPL-3.0-or-later four years after its release) and
under a commercial licence to larger organisations, and the Licensor's Python
code that runs inside Blender is a separately licensed GPL-3.0-or-later component
(`LICENSES/GPL-3.0-or-later.txt`). The archives and evidence verified on 2026-11-15 were reused
unchanged. **No package is blocked**, and no reviewed dependency carries copyleft
that binds the Licensor's BUSL-1.1 code.

| Licence class | Packages | Combined with BUSL-1.1 and commercial code | Obligations |
|---|---|---|---|
| MIT, Apache-2.0, BSD-2-Clause, Python-2.0, Zlib, CC-BY-4.0 | 154, including argparse, postprocessing, caniuse-lite and webgl-constants (MIT grant in the archive, no manifest field) | Yes: permissive, no copyleft | Keep copyright, licence and attribution notices; Apache `NOTICE` files; mark altered Zlib/PSF sources; CC BY attribution and licence link for the caniuse-lite data |
| MPL-2.0 | 28 (lightningcss and its platform packages, mediabunny and its encoders) | Yes: file-level copyleft that does not reach our files | Keep MPL files under MPL; make their source available when distributing them in executable form; reassess modifications |
| EPL-2.0 OR GPL-3.0-or-later | elkjs 0.12.1, EPL-2.0 selected | Yes, through EPL-2.0 only: its copyleft covers the unmodified EPL module, not our calling code | Keep the EPL licence and notices; source availability when distributing the library; EPL section 4 duties for a commercial offering. The GPL option would bind `src/lib/viz/compile.ts` and is not used |
| Remotion License (including missing, `UNLICENSED` and `SEE LICENSE` declarations) | 15 Remotion packages | Yes: source-available terms without copyleft; our code uses Remotion's interfaces and copies or modifies none of its code | Each operator needs Remotion free-licence eligibility or their own Company License; our licences convey no Remotion right; never sell or relicense a derivative of Remotion |
| Remotion compositor binaries (GPLv2+ FFmpeg inside) | 7 platform packages | Yes for the source distribution: a separate program, not conveyed | Corresponding source, notices and build configuration before shipping the binary in an image, installer or bundle |
| GSAP Standard "No Charge" License | gsap 3.15.1 | Yes: no copyleft, commercial use permitted | Keep GSAP notices; no use in a no-code visual animation builder competing with Webflow without written consent |
| LGPL (LAME inside the Mediabunny MP3 encoder) | @mediabunny/mp3-encoder | Yes: a replaceable WASM module, not linked into our code | Source, attribution and relinking checks before browser or binary redistribution |

The locked dependency set has no GPL, LGPL or AGPL package of its own. The GPL
material in the repository is the Licensor's Blender code and `vendor/vork-blender`,
both separately licensed under GPL-3.0-or-later. When a version converts to
AGPL-3.0-or-later, the dependencies keep their own terms; the Remotion License and
the GSAP Standard License are not open-source licences, so anyone distributing
converted code under the AGPL assesses them against it.

`--strict --scope repository-source` requires every otherwise unresolved package
to have a matching supported/conditional review. It rejects blocked decisions,
changed manifests/notices/lock entries, tracked `node_modules`, dependency patches,
corrupt evidence and lost baseline records. New versions receive no inherited
exception. Check mode is offline and does not execute package scripts. Review
provenance stays stable if a package collected from an archive later becomes
installed on another platform.

This scope does not assess distribution of dependency binaries, Docker images,
installers, browser bundles or embedded WASM/native code. Remotion compositor
archives include GPLv2+ FFmpeg/native payloads; Mediabunny encoders embed FFmpeg,
LAME or libFLAC in addition to their MPL wrappers. Those forms need exact native
source/build/notice/relinking checks before distribution. Local execution and
rendering remain subject to the operator's Remotion v4 entitlement and GSAP
permitted-use terms. The review grants no rightsholder waiver or legal certificate.

To repeat collection for a new version: obtain its exact npm tarball, verify the
complete archive against its lockfile SRI, read its manifest and notices without
running scripts or binaries, then capture package-specific, version-pinned
upstream evidence for gaps. Preserve excerpts of documentation and complete
licence/notice texts with hashes. Add a fresh record and its conditions, protect
it through maintainer review, then regenerate and run the strict source check.
Never copy an existing decision to a different archive or use the source scope
to clear a bundled distribution.

## Integrations outside pnpm

The same inventory imports all `credits/*.json` records, the third-party skills
ledger, vendored licence/notices and provenance, fixture notices, `NOTICE.md`
and the commercial licensing description. It preserves their declarations and
source paths rather than interpreting free-text licence descriptions as approvals.
Creative inspiration and assets in the credits are included too.

For a new Python tool, application, service API, model, asset or copied repository:

1. Add a credit with the upstream URL, exact version/revision where possible,
   licence evidence, what is used and where it lives. Preserve original notices
   for copied code and the provenance file for vendored material.
2. Distinguish code from model weights/assets, and local execution from linking,
   bundling, modification, redistribution and hosted access. Account/API terms
   are separate from an SDK's licence. External application builds such as FFmpeg
   can have different terms depending on how they were built.
3. Review it for BUSL-1.1 and commercial distribution of the Licensor's code:
   GPL or AGPL code combined with ours would bind the Licensor's own files and
   is not accepted outside the separately licensed GPL-3.0-or-later Blender
   component. LGPL code is acceptable where its source and relinking terms can
   be met. Record the chosen licence, obligations,
   source availability, notices, modifications and any purchased entitlement in
   the credit/evidence, before shipping.
4. Regenerate and review the inventory diff. CI detects changes to registered
   evidence; it cannot discover every new integration from arbitrary source code
   or enumerate a separately installed application's transitive dependencies.

No automatic compatibility conclusion is made for these declarations. Existing
asset manifests, public-export exclusions and upstream licences remain authoritative.
Remotion and GSAP retain their own terms ([NOTICE.md](../NOTICE.md)). BUSL-1.1 and
the Licensor's commercial licence cover only code the Licensor may license.

Public export preserves collected copyright and package-author addresses: the
`public-export.json` e-mail exception covers any address in `DEPENDENCY_LICENCES.json`
and `contrib/licence-reviews.json`, so a regenerated inventory needs no new literals.
It is scoped to those two files and to e-mail only: provider credentials and private
keys in the inventory still fail, and so does an address anywhere else.

## Python dependencies

`uv.lock` pins the Python workers' dependencies: 158 third-party packages, plus the workers' own project, across the base
environment and the optional profiles (`pnpm python:check --mode profiles`). They
are installed on the user's machine by `uv sync`; none is committed or
redistributed with this repository, and the pnpm scan above does not resolve
them. They were reviewed against PyPI metadata, the wheels' licence files and the
upstream repositories on 2026-11-18:

| Licence | Packages |
|---|---|
| MIT | 63, including the pyannote packages and `pyannoteai-sdk` (licence file in the wheel), and `earshot` (git dependency, MIT upstream) |
| Apache-2.0 | 40, including `sphn` |
| BSD-2-Clause or BSD-3-Clause | 39, including `torch` and `torchcodec` |
| Dual or combined permissive (Apache-2.0 AND MIT, Apache-2.0 OR BSD-2-Clause, BSD with LLVM exception, NumPy's bundled set) | 5: `aiohttp`, `packaging`, `cmake`, `llvmlite`, `numpy` |
| PSF-2.0, ISC, MPL-2.0, Unlicense | 9: `aiohappyeyeballs`, `matplotlib`, `typing-extensions`, `librosa` (two locked versions), `shellingham`, `certifi`, `treetable`, `yt-dlp` |
| LGPL | 2: `lameenc` (LGPL-3.0-or-later), `soxr` (LGPL-2.1-or-later); unmodified and loaded dynamically from the user's environment |

No GPL, AGPL, SSPL or non-commercial licence is in the lock. A change to
`uv.lock` is reviewed the same way, under step 3 above, before it lands; model
weights fetched at run time (for example pyannote's) keep their own terms and
are recorded in `credits/`.

## Free use, source availability and policy findings

A package policy finding means that the automated policy has not approved that
declaration. It is not a finding of infringement. Free use, source availability,
open-source licensing and permission to redistribute a component are separate
questions. Charging no money does not remove licence conditions, and a project
may depend on software under other terms when the relevant permissions allow it.

This repository is source-available under BUSL-1.1, with a commercial licence for
organisations outside its Additional Use Grant. Neither licence grants rights in
Remotion, GSAP or any other dependency, and changing our own licence does not
remove upstream restrictions. Remotion's free tier and the BUSL-1.1 grant are
separate: Remotion counts employees, BUSL-1.1 counts Personnel, and each user
checks both. Separate third-party notices are appropriate; a separate process or
folder alone does not settle whether a combined or derivative work is being
distributed.

Checked against the upstream sources on 2026-11-15:

| Component | What needs checking |
|---|---|
| Remotion | The [licence and FAQ](https://www.remotion.dev/docs/license/faq) permit free use for eligible individuals, small teams and qualifying non-profits, including automation. A project earning no revenue does not by itself establish eligibility. Users outside the free terms need their own entitlement; AI agents do not themselves require seats. |
| GSAP | The [standard licence](https://gsap.com/community/standard-license/) permits free commercial use and explicitly permits AI-generated GSAP code. It restricts certain competing visual animation builders; review an actual visual-builder feature against those terms. |
| MPL-2.0 | [Mozilla's FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) describes file-level copyleft and source/notice obligations on distribution. It permits combining MPL code with other licences; it does not generally require every file of a larger application to become MPL. |
| GitHub | The [DMCA policy](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy) describes removal following copyright complaints. Our local policy findings are not GitHub takedown decisions. Keep permission, attribution and source evidence to address a substantiated complaint. |

Keep the project's licensing model while reviewing actual dependency use.
Escalate a specific uncertain integration to the rightsholder or qualified legal
review before distributing it; do not change the root licence merely to clear CI.

## elkjs 0.12.1

Status: **conditional, EPL-2.0 selected** for this exact, unmodified, separately
packaged version. The archive-bound owner runtime authorisation is recorded in
`contrib/licence-reviews.json` and [its credit](../credits/libraries-elkjs-0-12-1.json);
`src/lib/viz/compile.ts` calls it for diagram layout.

The upstream [versioned package declaration](https://github.com/kieler/elkjs/blob/0.12.1/package.json)
offers `EPL-2.0 OR GPL-3.0-or-later`; [its licence text](https://github.com/kieler/elkjs/blob/0.12.1/LICENSE.md)
must also be retained. `OR` offers alternatives. A policy failure does not itself
establish incompatibility.

- EPL-2.0 is the route for BUSL-1.1 and commercial distribution. Its copyleft
  covers the EPL module and modifications of it; a separate module that only
  calls it may be under other terms. [EPL 2.0 sections 3 and 4](https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.html)
  require the licence, notices and source availability when the library is
  distributed, and a Commercial Contributor who includes it in a commercial
  offering takes on the defence and indemnification duties of section 4.
- The GPL-3.0-or-later option is not used: it would require the code combined
  with ELK to be distributed under the GPL, which would bind the Licensor's
  BUSL-1.1 code.

A new version, a modified copy, bundling ELK into a distributed build or a
changed integration needs a fresh exact-version review. Do not add EPL or GPL
to the global allowlist to make the check pass.
