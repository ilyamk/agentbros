# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Hero turntable: one device turns on a studio sweep while the camera eases in. Alpha-friendly.

Shot keys (plus studio_kit.COMMON): yawFrom/yawTo (degrees, 0 = screen to camera), tilt (degrees back),
push (0..0.4, share of distance the camera closes), height (camera height over the subject in subject
heights), fill (share of frame height the device fills), lift (start below and rise, in subject heights).
"""

import math

import studio_kit as kit

a = kit.args({"yawFrom": -150.0, "yawTo": 25.0, "tilt": 6.0, "push": 0.12, "height": 0.18, "fill": 0.72, "lift": 0.0})
scene = kit.reset(a)
root, screen, meshes = kit.import_device(a["device"])
lo, hi = kit.world_bounds(meshes)
size = max(hi - lo)
if screen is not None:
    kit.set_screen(screen, a["screen"], a)

kit.sweep(a, lo.z - size * 0.18, size)
kit.hdri(a)
kit.light_rig(a, size)

target = ((lo + hi) / 2).to_tuple()
distance = kit.fit_distance(a, (hi.x - lo.x) / a["fill"] * 0.7, (hi.z - lo.z) / a["fill"] * 0.7)
cam, focus = kit.camera(a, target, distance * (1 + a["push"]), height=size * a["height"])

end = a["frames"]
kit.key(root, 1, rotation_euler=(math.radians(-a["tilt"]), 0, math.radians(a["yawFrom"])), location=(0, 0, -size * a["lift"]))
kit.key(root, end, rotation_euler=(math.radians(-a["tilt"]), 0, math.radians(a["yawTo"])), location=(0, 0, 0))
kit.ease(root)
start = cam.location.copy()
kit.key(cam, 1, location=start)
kit.place_camera(cam, target, distance, height=size * a["height"] * 0.7)
kit.key(cam, end, location=cam.location.copy(), rotation_euler=cam.rotation_euler.copy())
cam.location = start
kit.place_camera(cam, target, distance * (1 + a["push"]), height=size * a["height"])
kit.key(cam, 1, rotation_euler=cam.rotation_euler.copy())
kit.ease(cam)

anchors = kit.corner_anchors(screen) if screen is not None else []
kit.finish(anchors)
