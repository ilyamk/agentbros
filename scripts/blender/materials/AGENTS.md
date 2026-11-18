# Procedural materials

Last updated: 2026-11-18

`__init__.py` exposes thirteen surface factories returning `ShaderNodeTree`; `material(tree)` wraps one for assignment. Inputs are scene-linear RGBA, metres for object-coordinate grain, nanometres for thin film. These are directed approximations, not measured BRDFs. `preview.py` renders every surface on a grooved shader ball under `soft-product` and `rim-hero`, through `blender:run`. No downloaded textures or runtime dependencies. See the FX evaluation in `docs/blender-arsenal/fx-realism.md` for inspected evidence and limits. Use in product-ad and bespoke film material steps.

Formatting-only version 1.0.1 retains an identical Python AST; the active generator source hash is updated alongside it. Historical evaluations and receipt pins remain unchanged.

2026-11-18: preview callback diagnostics use ty 0.0.105's `missing-attribute` rule; the Python AST is unchanged.
