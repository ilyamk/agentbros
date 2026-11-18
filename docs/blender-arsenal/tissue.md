# Tissue 0.3.76 — integration scope

## Verdict

Adopt for the scoped, isolated `pattern-surface` tessellation wrapper. GPL-3.0-or-later, no account, wheels or network permission. Owner authorised the named free package for trial and integration on 2026-11-15. Registration passes Blender 5.3.0; wrapper/render evidence is recorded separately in [FX realism](fx-realism.md). Registration alone establishes no visual quality or support for all 46 operators.

## Trial results

| Qualification | Value |
|---|---:|
| Inspected archive bytes | 128351 |
| Registered operators | 46 |
| Qualified Blender series | 5.3 |

Registration is a compatibility observation, not blanket upstream feature support. Scoped isolated tessellation only; no general support for all operators or reaction-diffusion/numba installation. Exact archive/licence pins live in `extensions.json`; raw install profiles, receipts and timings are ignored output.

## Provenance and limits

[Official extension](https://extensions.blender.org/add-ons/tissue/), [upstream](https://github.com/alessandro-zomparelli/tissue), GPL pin and SHA256 in `extensions.json`. Archive source was inspected for operator signature/context and dependency use. Headless support remains partial: other operators are outside this integration. Native geometry and decoded-pixel checks are in `tests/blender-fx.test.ts` (gated).
