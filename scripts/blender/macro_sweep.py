# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Macro detail sweep: a long lens slides slowly along an edge or the camera island at shallow focus.

`path` picks the detail: "camera" (rear lens island, needs the back to camera), "edge" (side frame and
buttons) or "bottom" (bottom edge). Focus follows a point that moves with the camera.

Shot keys (plus studio_kit.COMMON): path, travel (share of the device height the camera slides), distance
(metres from the surface).
"""

import math

from mathutils import Vector

import studio_kit as kit

a = kit.args({"path": "camera", "travel": 0.35, "distance": 0.11, "lens": 100.0, "fstop": 1.8})
scene = kit.reset(a)
root, screen, meshes = kit.import_device(a["device"])
if screen is not None:
    kit.set_screen(screen, a["screen"], a)
lo, hi = kit.world_bounds(meshes)
size = max(hi - lo)
kit.sweep(a, lo.z - size * 0.3, size)
kit.hdri(a)
kit.light_rig(a, size)

h = hi.z - lo.z
if a["path"] == "camera":
    root.rotation_euler = (0, 0, math.radians(180 - 18))
    start, end = Vector((hi.x * 0.25, 0, hi.z - h * 0.12)), Vector((hi.x * 0.25, 0, hi.z - h * (0.12 + a["travel"] * 0.5)))
    view = Vector((-0.25, 1, 0.15))
elif a["path"] == "edge":
    root.rotation_euler = (0, 0, math.radians(-70))
    start, end = Vector((0, 0, h * (a["travel"] / 2))), Vector((0, 0, -h * (a["travel"] / 2)))
    view = Vector((0.55, -1, 0.1))
else:
    root.rotation_euler = (math.radians(-25), 0, math.radians(-15))
    start, end = Vector((-hi.x * 0.6, 0, lo.z)), Vector((hi.x * 0.6, 0, lo.z))
    view = Vector((0, -1, -0.45))
view.normalize()
cam, focus = kit.camera(a, start, a["distance"])
for frame, point in ((1, start), (a["frames"], end)):
    focus.location = point
    cam.location = point - view * a["distance"]
    cam.rotation_euler = view.to_track_quat("-Z", "Y").to_euler()
    kit.key(focus, frame, location=focus.location.copy())
    kit.key(cam, frame, location=cam.location.copy(), rotation_euler=cam.rotation_euler.copy())
kit.ease(cam)
kit.ease(focus)
kit.finish()
