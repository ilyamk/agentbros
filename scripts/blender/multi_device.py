# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Floating multi-device: laptop, phone and optionally a tablet hang in one light, each on a slow bob.

Each device takes its own screen: screens = {"laptop": "...png", "phone": "...png"}. Corner anchors are
exported per device: laptop_tl..., phone_tl....

Shot keys (plus studio_kit.COMMON): devices (list), screens (object), bob (metres), turn (degrees of
slow yaw drift across the shot).
"""

import math

from mathutils import Vector

import studio_kit as kit

a = kit.args({"devices": ["laptop", "phone"], "screens": {}, "bob": 0.006, "turn": 8.0, "lens": 50.0, "fstop": 4.0})
scene = kit.reset(a)
LAYOUT = {"laptop": ((0.0, 0.08, 0.0), -8.0), "phone": ((0.22, -0.08, -0.02), -24.0), "tablet": ((-0.25, 0.0, 0.02), 18.0)}
anchors, all_meshes = [], []
for index, name in enumerate(a["devices"]):
    root, screen, meshes = kit.import_device(name, name)
    if screen is not None:
        kit.set_screen(screen, a["screens"].get(name), a)
        anchors += kit.corner_anchors(screen, prefix=name)
    position, yaw = LAYOUT[name]
    phase = index * 1.7
    for frame in range(1, a["frames"] + 1, 10):
        t = (frame - 1) / max(1, a["frames"] - 1)
        root.location = Vector(position) + Vector((0, 0, math.sin(phase + t * math.pi * 1.5) * a["bob"]))
        root.rotation_euler = (0, 0, math.radians(yaw + (t - 0.5) * a["turn"]))
        root.keyframe_insert("location", frame=frame)
        root.keyframe_insert("rotation_euler", frame=frame)
    kit.ease(root)
    kit.bpy.context.view_layer.update()
    all_meshes += meshes

lo, hi = kit.world_bounds(all_meshes)
size = max(hi - lo)
kit.sweep(a, lo.z - size * 0.12, size)
kit.hdri(a)
kit.light_rig(a, size)
target = ((lo + hi) / 2).to_tuple()
distance = kit.fit_distance(a, hi.x - lo.x, hi.z - lo.z)
kit.camera(a, target, distance, height=size * 0.25)
kit.finish(anchors)
