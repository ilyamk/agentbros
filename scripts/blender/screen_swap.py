# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Screen swap: the device faces the camera with live UI on its display; a slow drift and push-in.

`screen` is a PNG/JPG or a folder of numbered frames (an image sequence plays one frame per scene
frame from frame 1). The four display corners are exported as camera.json anchors screen_tl, screen_tr,
screen_br, screen_bl, so Remotion can lay live, editable UI exactly over the glass instead.

Shot keys (plus studio_kit.COMMON): yawFrom/yawTo, tiltFrom/tiltTo (degrees), push, height, fill, fit.
"""

import math

import studio_kit as kit

a = kit.args({"yawFrom": -22.0, "yawTo": 9.0, "tiltFrom": 10.0, "tiltTo": 3.0, "push": 0.1, "height": 0.1, "fill": 0.8, "fit": "contain", "lens": 70.0})
scene = kit.reset(a)
root, screen, meshes = kit.import_device(a["device"])
if screen is None:
    error_message = f"{a['device']} has no object named 'screen'"
    raise RuntimeError(error_message)
kit.set_screen(screen, a["screen"], a, fit=a["fit"])
lo, hi = kit.world_bounds(meshes)
size = max(hi - lo)
kit.sweep(a, lo.z - size * 0.15, size)
kit.hdri(a)
kit.light_rig(a, size)

target = ((lo + hi) / 2).to_tuple()
distance = kit.fit_distance(a, (hi.x - lo.x) / a["fill"] * 0.7, (hi.z - lo.z) / a["fill"] * 0.7)
end = a["frames"]
cam, focus = kit.camera(a, target, distance * (1 + a["push"]), height=size * a["height"])
kit.key(cam, 1, location=cam.location.copy(), rotation_euler=cam.rotation_euler.copy())
kit.place_camera(cam, target, distance, height=size * a["height"] * 0.5)
kit.key(cam, end, location=cam.location.copy(), rotation_euler=cam.rotation_euler.copy())
kit.key(root, 1, rotation_euler=(math.radians(-a["tiltFrom"]), 0, math.radians(a["yawFrom"])))
kit.key(root, end, rotation_euler=(math.radians(-a["tiltTo"]), 0, math.radians(a["yawTo"])))
kit.ease(root)
kit.ease(cam)
kit.finish(kit.corner_anchors(screen))
