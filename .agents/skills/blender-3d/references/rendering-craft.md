# Rendering craft

Settings below were used or measured on the [worked pour](examples/coffee_pour.py) unless marked as general guidance.

## Light

- Start with one large soft key from the side and slightly behind, then a rim from the opposite back corner. Add fill only if shadows lose shape. Light from the camera flattens everything.
- A big source close to the subject is soft; a small or distant one is hard. Area size is your softness control.
- Use an HDRI for reflections at low strength (0.15-0.4), with area lights doing the shaping. A full-strength HDRI alone looks like a stock render.
- Dark surroundings make the subject read. Darken the table and backdrop before brightening the subject.
- Reach the look with exposure and light ratios together. AgX washes out over-lit colours: in the pour, lowering exposure by about 0.9 stops turned milk-chocolate beans into roasted ones.

## Materials

- Use real PBR maps where the camera is close: base colour, roughness, normal. Mark every map except colour as Non-Color.
- Vary objects with Object Info `Random` driving a colour ramp. Identical copies give the fake away.
- Break up roughness with noise. A single roughness value reads as plastic.
- Real dark materials are dark: base colours for roasted coffee sit near 0.03-0.1, not 0.3.

## Camera

- Long lens (50-100 mm) and a low angle give the product look. Move slowly, with eased keyframes.
- Depth of field: set `dof.focus_object` to an empty on the subject. Blur scales with scene size, so a scene built ten times too large needs a far lower f-stop (the pour uses 0.75).
- Motion blur: `render.motion_blur_shutter` of 0.5 is a film look; lower it to 0.2-0.3 when fast objects must stay readable.

## Simulation

- Bullet is unstable with tiny objects. Build at ten times real size and scale gravity to match (98.1). Lowering gravity gives a slow-motion look.
- Dense contact is what costs: a packed hopper of 1900 beans did not finish in 500 s, while a kinematic feed of 1320 beans took about 130 s of CPU time (7.5 minutes on a busy shared machine).
- Collide with a low-poly mesh, then swap to the detailed mesh for rendering: `obj.data = high` in a later stage. Linked mesh data instances in Cycles.
- Bake once, save the `.blend`, then do look passes with `--blend`. Without a bake, an arbitrary `--frames` value shows the initial state.
- In Blender 5.2.3, setting `point_cache.use_disk_cache` from Python on a rigid-body world crashed in background mode. Bake in memory; the cache saves inside the `.blend`.

## Render settings by budget

Cycles on an Apple M1 Max through Metal, with `--device auto`:

| Pass | Size | Samples | Measured | Use |
|---|---|---|---|---|
| Look | 960x540 | 24 | about 8-12 s a frame, including load | Decide light and colour |
| Check | 1920x1080 | 32 | about 22 s, including load | Confirm detail and time the final |
| Final | 1920x1080 | 24, OIDN | 12.1 s a frame in one process; 90 frames in 18.5 minutes on a shared machine | 1320 instanced beans, motion blur, depth of field |

- The first Metal render compiles kernels silently for several minutes. Give that run a long `--timeout`; later runs reuse the cache.
- `--no-factory-startup` is not needed for the GPU: `--device auto` selects it. Plain factory startup in a script of your own means CPU.
- Always enable OIDN with albedo and normal passes, adaptive sampling (threshold 0.03-0.05), `use_persistent_data` and `use_animated_seed`. Cap bounces to what the shot needs, and turn caustics off unless they are the point.
- A killed run keeps its frames. `--resume` renders only the missing ones.

## Colour management

- AgX is the default and handles highlights best. Use it for photoreal shots with looks such as `AgX - Punchy` or `AgX - Medium High Contrast`.
- Standard keeps exact RGB values. Use it when a brand colour rendered in Blender must match the same hex in Remotion. AgX will shift that colour.
- PNG frames hold display-referred sRGB, the same space Remotion composites in. Set the look in Blender, because nothing grades later.
- EXR frames are linear, for a finishing tool. The review sheet applies an sRGB curve only, so judge its colour loosely.

## Compositing with Remotion

- Render `--film-transparent` to a PNG sequence and show it with `<Img src={staticFile(...)}/>` indexed by frame. Remotion frame 0 maps to the first Blender frame in `camera.json`. PNG alpha is straight.
- For contact shadows on a transparent render, add a plane with `is_shadow_catcher = True`.
- `--encode prores4444` keeps alpha for a finishing tool. `--import` refuses it, and it has not been tested through Remotion's video components, so use the PNG sequence inside Remotion.
- H.264 has no alpha, so the runner refuses `--encode h264` with `--film-transparent`.

## Matching a Remotion overlay to the camera

`camera.json` holds per-frame `threeMatrixWorld` and `projectionMatrix` for three.js, plus `anchors` as top-left pixels for 2D work. Both matrices are row-major, which is the argument order of `Matrix4.set`:

```ts
const shot = camera.frames[frame];
threeCamera.matrixAutoUpdate = false;
threeCamera.matrixWorld.set(...shot.threeMatrixWorld);
threeCamera.matrixWorldInverse.copy(threeCamera.matrixWorld).invert();
threeCamera.projectionMatrix.set(...shot.projectionMatrix);
threeCamera.projectionMatrixInverse.copy(threeCamera.projectionMatrix).invert();
```

The render's size must equal the composition's for anchor pixels to line up. Scale them otherwise.
