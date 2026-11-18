# Contributing to the Blender arsenal

Start with the [agent growth process](../../.agents/skills/blender-3d/references/arsenal.md) and [repository contribution agreement](../../CONTRIBUTING.md). Owner approval and consent cannot be supplied by a contributor acting as the owner.

Contribute any of:

- Extension/source entries and exact item pins: version/platform where applicable, stable URL, SHA256, size, licence and original licence-page evidence, attribution, automation/account restrictions and a completed [evaluation](./_template.md). Extensions may use GPL-compatible external code; do not vendor GPL code into this dual-licensed repository. Asset data is CC0/CC-BY; OFL fonts retain OFL.txt. Proposed/rejected source listings need no payload; do not invent hashes for files not acquired.
- Collections of known `source:asset` ids with a clear film use, verified state and notes; no copied payloads.
- Built-in recipes with literal strict META, intent docstring, bounded parameters, seeded frame functions or baked fixed-seed simulations, tests, numerical proof and a critique table (intent, success, flaw, repair, limit). Read the [recipe contract](../../scripts/blender/recipes/AGENTS.md). A proof is not a human creative verdict.
- Kit/helper improvements with regression tests and before/after measurements.
- Rejected candidates with a reason and dated evidence, so future agents do not repeat the same research.

Never contribute downloaded files, binaries, ZIPs, models, fonts, renders, bake caches, secrets, account credentials, machine-specific local paths or unpinned download URLs. Account-bound, manual-only or non-redistributable sources must not be presented as anonymous automated downloads; unresolved automation/AI terms block automated adoption. Licence conditions remain per item. Keep all local payloads under the ignored `blender-arsenal/local/` footprint.

The gate is `pnpm blender:arsenal audit`. It validates manifests, collection source references and recipe META; checks approval consent, rejection reasons, evaluation references and completed Verdict/Trial results with numbers; and rejects anything under `local/` returned by `git ls-files`. It does not establish licence validity, execute extensions, check every remote URL or judge a render. No network is used. Audit fixture tests cover bad evidence and tracked local payloads.

Before review:

```bash
pnpm blender:arsenal audit
pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-arsenal.test.ts tests/blender-arsenal-eval.test.ts
pnpm lint
pnpm typecheck
pnpm test:fast
```

For a recipe, also run `python3 tests/blender-recipes.test.py` and `RUN_BLENDER_TESTS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-recipes.test.ts`; run `pnpm blender:recipe proof --id ID --output out/qa/recipes/ID-RUN` and inspect its sheets. Include numeric results and honest missing verification in the PR. Nothing under `local/` or `out/` goes into the PR. The planning benchmark described in the [guide](README.md#planning-evaluation) measures agent plan adherence; use identical models and frozen task/schema/scorer hashes for comparisons.

Improvement contributions include `blender-arsenal/improvements/<date>-<slug>.json`, validated by `ImprovementLogSchema`, with frozen reference, numeric both-order result, check evidence and kept/reverted decision. Retain failures, strip personal/machine-specific data and exclude media. Follow the [guarded loop](../../.agents/skills/blender-3d/references/self-improvement.md).

Built-in/internal generators use `blender-arsenal/generators.json`: immutable version + build commit or source SHA256, install method, licence, capability tags, headless/seed behaviour, measured cost settings and an evaluation. Declare them in recipe `META.requires.generators` (including procedural material dependencies); declare add-ons in `requires.extensions`. Runtime admission checks approval and exact build/source pins. Audit checks source hashes, evaluation and dependency ids. Tests: `tests/blender-fx.test.ts`, with native cases gated by `RUN_BLENDER_TESTS=1`. External generator installers are not implemented by this manifest.
