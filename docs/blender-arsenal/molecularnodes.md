# Molecular Nodes 520.2.0 — integration scope

## Verdict

Adopt for scoped, offline `molecule` renders from pinned local structures. GPL-3.0-or-later; 124 MB archive and native Python wheels are a substantial dependency, justified for this science brief. The earlier rejection (“niche, big wheels”) was a general shortlist decision without a runtime trial; it is superseded for this scoped use. Owner authorised this named free package for trial and integration on 2026-11-15. Blender 5.3.0 registration passes; scientific/render limits are in [FX realism](fx-realism.md).

## Trial results

| Qualification | Value |
|---|---:|
| Inspected archive bytes | 124045041 |
| Registered operators | 22 |
| Qualified Blender series | 5.3 |

Registration is a compatibility observation, not blanket upstream feature support. Local PDB/CIF visualisation only; upstream fetch is not used inside Blender. No trajectories, docking, force-field or simulation accuracy claim. Exact archive/licence pins live in `extensions.json`; raw install profiles, receipts and timings are ignored output.

## Provenance and limits

[Official extension](https://extensions.blender.org/add-ons/molecularnodes/), [upstream API](https://github.com/BradyAJohnston/MolecularNodes), [wwPDB usage/CC0](https://www.wwpdb.org/about/usage-policies). Exact archive pin and inspected wheel list in `extensions.json`. Only the pinned API and styles exercised by tests are supported. Atom coordinates are data, not a force-field simulation; this wrapper applies only rigid presentation motion and a uniform display scale. No trajectories, docking, inference or simulation accuracy claim.
