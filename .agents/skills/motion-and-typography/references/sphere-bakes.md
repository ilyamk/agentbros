# Bounded sphere interaction bakes

Use this route for an illustrative collision, constrained motion diagram or abstract product graphic. Read the v1 scene contract before authoring. State educational assumptions separately from measured product facts. V1 models translation and sliding. For ideal solid-sphere spin and contact torque, read the separate v2 contract and native proof, explicitly select `avc-solid-sphere-contacts-v2` and optionally supply world-space `collider.angularVelocity` in rad/s. Orientation uses normalized `[w,x,y,z]` quaternions initialized from the existing XYZ Euler rotation. Static spheres cannot spin. Meshes, fluids, native rigid-body dynamics and rolling resistance remain unsupported.

Keep v2 native quaternion, matrix-basis and initial-Euler readbacks with the capture receipt. A uniformly colored sphere does not visually demonstrate rotation; check numerical orientation and actual placement separately. Isolated impulses conserve momentum within the documented tolerance, while discrete penetration correction has a finite-step error; do not present the animation as calibrated real-world physics. Reduce spin or increase supported substeps when angular travel is refused. A changed worker/cache key requires new checked capture, not reuse of old native proofs.

## Author and validate

Create a project-local scene request under the existing strict `BlenderSceneSchema`. Select `physics:{solver:"avc-sphere-contacts-v1"}` explicitly. Each participating object is a `sphere` with `collider:{kind:"dynamic"|"static",radius,mass,velocity,restitution,friction}` and uniform `scale:[radius,radius,radius]`. The floor is an infinite horizontal collision plane at `physics.floorZ`; author the visible floor separately and keep it large enough for the shot. Other geometry is decorative and cannot supply collision surfaces. Visual material roughness does not change physical friction.

```bash
pnpm blender:scene --request SCENE.json --dry-run
```

The single JSON envelope reports a validated bake hash and performs no capture. Absent `physics` retains the old floor-only behavior. Colliders cannot use keyframes or mix with old `motion`. Bounds include 12 colliders, 301 states, 16 substeps and 8 iterations. Start bodies without overlap; keep per-substep travel inside the declared limit. Difficult grazing or packed contacts can refuse rather than publish a missed collision. Do not remove safety checks or label a refusal as a rendered result.

## Bake and review

Only use an already installed, authorized Blender 4.5.14 executable. Request unique fresh output/cache paths; no runtime download or executable choice comes from an MCP/UI payload.

```bash
pnpm blender:scene --request SCENE.json --output OUTPUT_DIRECTORY --cache CACHE_DIRECTORY --executable TRUSTED_BLENDER
```

Keep the receipt's scene/bake/solver/runtime hashes and frame ownership. Random frame requests bake from zero; they do not continue a prior mutable simulation. Use a complete contiguous sequence when choosing `--video`; sampled frames cannot become invented intermediate motion or holds. Optional `--project ID` imports immutable candidates, with rights and delivery review still required. The video is silent; add deliberate sound using the normal independent audio workflow.

Review before, at and after contact. In an explanation, hold long enough to read the labels and distinguish assumed masses/coefficients from measured quantities. In an abstract creative, choose the interaction for a specific narrative beat rather than adding arbitrary motion. Check sphere separation, the floor, framing, shadows and readability in the actual requested formats. If motion is difficult to resolve, revise speed/substeps/camera within the validated contract or choose a simpler scene; the renderer cannot approve the creative result.
