# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
r"""Build an isometric grid of phones with per-device screens and a trucking camera.

Isometric device array (cashfree device-carousel): copies of the phone lie flat in a grid on a pale ground, each
with its own screen, and an orthographic camera trucks across them. Blender plate for library block
`studio-product-stage` (layout "array", prop `plate`).

Uses the normalised device GLBs and the studio kit's screen material (public/shared/3d/, built by prepare_devices.py;
`pnpm assets:sync --family 3d`). The truck is the block's (truckOffset in three-plan.ts): right `truck.x` of the frame
width and down `truck.y` of its height across the shot, sine.inOut, centred so the move passes the middle. Screens
are images cycled over the cells (real captures for a real product, real-ui rule); empty draws `screenColour`, a soft
vertical gradient. Exports each cell's screen corners to camera.json as `cell<i>_tl` and so on.

Shot intent (reveal, 3 s, 90 frames): a product line assembles. The phones drop into the grid in rings from the centre out
(2 frames apart), fall with gravity, bounce once and rock to rest; each screen wakes 3 frames after its phone lands.
Screens keep their colour: the gradient is an image tagged with the view's inverse colourspace and emitted at 1 under
agx-base (kit.look.screen_material); the old procedural gradient at 2.4 rendered pale and grey. The camera keeps the
block's orthographic truck exactly and adds an 8% push (ortho scale, glide), so the isometric grid stays true. Light:
kit mood high-key with the key sweeping round, the softbox HDRI in the glass, clean grade, motion blur. Timing change:
the shot was 60 frames and the grid was there from frame 0; the truck still spans the whole shot.

Shot keys (plus studio_kit.COMMON, minus device keys it ignores): columns, rows, spacing (in device widths), screens
(list of image paths), screenColour [top, bottom], ground, truck {x, y}, elevation, yaw (degrees; the block's true isometric 35.26 and 45 by default), scale (share of the
grid the frame shows).
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from mathutils import Vector

import studio_kit as kit
import toy_kit as toy
from kit import anim, curves, look, stage
from kit import light as lights

if TYPE_CHECKING:
    import bpy

a = kit.args(
    {
        "columns": 4,
        "rows": 4,
        "spacing": 1.45,
        "screens": [],
        "screenColour": ["#c4f27e", "#f3fbe6"],
        "ground": "#eef1ee",
        "truck": {"x": 0.25, "y": 0.14},
        "elevation": 35.26,
        "yaw": 45.0,
        "scale": 0.62,
        "look": "light",
        "lights": "bright",
        "hdri": "softbox",
        "hdriStrength": 0.5,
        "frames": 90,
    }
)
for key in ("rows", "columns"):
    if isinstance(a[key], bool) or not isinstance(a[key], int) or a[key] < 1:
        message = f"{key} must be a positive integer"
        raise ValueError(message)
scene = kit.reset(a)
scene.cycles.seed = a["seed"]
# Frame the truck for the aspect actually rendered (the runner applies --resolution after this script).
scene.render.resolution_x, scene.render.resolution_y = toy.requested_size((1920, 1080))


# Screens: the gradient as an image tagged with the inverse of the view (kit.look), emitted at strength 1 under AgX with
# no look, so it renders as its own sRGB colours. The old procedural gradient at strength 2.4 went through AgX's
# shoulder and came out pale and grey-green.
look.apply(scene, "agx-base")
gradient = look.gradient_image("screen-gradient", *a["screenColour"])
screen_mats = []


def gradient_screen(screen: bpy.types.Object, index: int) -> None:
    """Evaluate the gradient screen for this shot at a block frame."""
    mat, _ = look.screen_material(f"screen-{index}", gradient, scene)
    screen.data.materials.clear()
    screen.data.materials.append(mat)
    screen_mats.append(mat)


cells, anchors = [], []
first = None
for index in range(a["columns"] * a["rows"]):
    root, screen, meshes = kit.import_device(a["device"], f"cell{index}")
    if first is None:
        lo, hi = kit.world_bounds(meshes)
        first = hi - lo
    if screen is not None:
        if a["screens"]:
            kit.set_screen(screen, a["screens"][index % len(a["screens"])], a, fit="cover")
        else:
            gradient_screen(screen, index)
        anchors += kit.corner_anchors(screen, prefix=f"cell{index}")
    cells.append(root)

# Lay every device on its back (screen up) in a grid centred on the origin; rows run along Y.
if first is None:
    message = "The device grid must contain at least one cell"
    raise ValueError(message)
w, depth = first.x, first.z
step_x, step_y = w * a["spacing"], depth * a["spacing"] * 0.62
for index, root in enumerate(cells):
    column, row = index % a["columns"], index // a["columns"]
    root.rotation_euler = (math.radians(-90), 0, 0)
    root.location = ((column - (a["columns"] - 1) / 2) * step_x, (row - (a["rows"] - 1) / 2) * step_y * 1.62, first.y / 2)

floor_size = max(step_x * a["columns"], step_y * a["rows"] * 1.62) * 3
ground = toy.mesh_object("ground", [(-floor_size, -floor_size, 0), (floor_size, -floor_size, 0), (floor_size, floor_size, 0), (-floor_size, floor_size, 0)], [(0, 1, 2, 3)], smooth=False)
ground.data.materials.append(kit.material("ground", kit.hex_rgb(a["ground"]), roughness=0.75, specular=0.2))
kit.hdri(a)
size = max(w, depth)
toy.world_colour(a["ground"], 0.6)

# Orthographic camera at an isometric-like elevation and yaw; the truck slides it in its own image plane.
extent = max(step_x * a["columns"], step_y * a["rows"] * 1.62)
ortho = extent * a["scale"]
elev, yaw = math.radians(a["elevation"]), math.radians(a["yaw"])
direction = Vector((math.sin(yaw) * math.cos(elev), -math.cos(yaw) * math.cos(elev), math.sin(elev)))
centre = Vector((0, 0, 0))
cam = toy.camera({"lens": 50.0, "fstop": 0.0}, centre + direction * 5.0, centre, ortho=ortho)
cam.data.clip_end = 50
home = cam.location.copy()
right = cam.matrix_world.to_3x3() @ Vector((1, 0, 0))
up = cam.matrix_world.to_3x3() @ Vector((0, 1, 0))
frame_w = ortho
frame_h = ortho / (scene.render.resolution_x / scene.render.resolution_y)


F = a["frames"]
# Entry: the phones drop in rings from the centre out (the middle first, the hero), each falling a short way, bouncing
# once and rocking to rest; its screen wakes a beat after it lands. Then the block's truck, unchanged.
order = sorted(range(len(cells)), key=lambda i: (round(cells[i].location.x ** 2 + cells[i].location.y ** 2, 6), i))
rank = {cell: r for r, cell in enumerate(order)}
DROP, STEP, FALL = w * 0.6, 2, 7
rest = {i: cells[i].location.copy() for i in range(len(cells))}


def landing(i: int, f: float) -> tuple[float, float, float, float]:
    """(first visible frame, lift, rock in degrees, scale) of cell i at frame f, from the frame alone."""
    start = 2 + rank[i] * STEP
    fall = curves.clamp01((f - start) / FALL) ** 2  # gravity: accelerating into the floor
    bounce = abs(curves.follow_through(f, start + FALL, w * 0.05, damping=9, frequency=3.2))
    rock = curves.follow_through(f, start + FALL, 3.0, damping=8, frequency=2.8)
    return start, DROP * (1 - fall) + bounce, rock, 0.9 + 0.1 * curves.progress(f, start, FALL, "brake")


def wake(i: int, f: float) -> float:
    """Evaluate the wake for this shot at a block frame."""
    return curves.progress(f, 2 + rank[i] * STEP + FALL + 3, 8, "brake")


tl = anim.Timeline(range(F))
for i, root in enumerate(cells):
    base_scale = tuple(root.scale)
    tl.add(root, "location", lambda f, i=i: tuple(rest[i] + Vector((0, 0, landing(i, f)[1]))))
    tl.add(root, "rotation_euler", lambda f, i=i: (math.radians(-90 + landing(i, f)[2]), math.radians(0.5 * landing(i, f)[2]), 0.0))
    tl.add(root, "scale", lambda f, i=i, b=base_scale: tuple(c * landing(i, f)[3] for c in b))
    for part in root.children_recursive:  # hide_render does not pass from a parent to its children
        tl.add(part, "hide_render", lambda f, i=i: f < landing(i, f)[0])
for i, mat in enumerate(screen_mats):
    socket = mat.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
    tl.add(socket, "default_value", lambda f, i=i: wake(i, f))


def truck(f: float) -> tuple[float, ...]:
    # three-plan.ts truckOffset: shares of the frame, centred; x right, y down. The contract.
    """Evaluate the truck for this shot at a block frame."""
    p = toy.EASES["sine.inOut"](toy.clamp01(f / max(1, F - 1))) - 0.5
    return tuple(home + right * (a["truck"]["x"] * p * frame_w) - up * (a["truck"]["y"] * p * frame_h))


tl.add(cam, "location", truck)
# The orthographic frame tightens by 8% on a glide: a push without perspective, so the isometric grid stays true.
tl.add(cam.data, "ortho_scale", lambda f: ortho * (1 - 0.08 * curves.progress(f, 0, F - 1, "glide")))
mood = lights.mood("high-key", target=(0, 0, 0), size=extent * 0.5, use_world=False, exposure=7.0, camera_yaw=a["yaw"])
mood.sweep("key", -60, -20, at=0, frames=F - 1, intent="glide")
mood.bake(tl)
look.motion_blur(scene, 0.5)
look.grade(scene, "clean")
tl.bake()
stage.report(scene, cam, {"hero": [c for c in cells[order[0]].children_recursive if c.type == "MESH"]}, frames=[1, F])
kit.finish(anchors)
