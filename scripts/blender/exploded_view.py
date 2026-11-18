# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Exploded view: the device's parts slide apart along its depth axis and hold, then optionally return.

Parts are grouped by depth (the glTF's own meshes, sorted front to back); each group moves by its rank.
The centre of each group is exported as an anchor part_0..part_N for Remotion callouts.

Shot keys (plus studio_kit.COMMON): spread (metres between neighbouring groups), groups (how many depth
layers), yaw/tilt (degrees, a three-quarter view reads layers best), openAt/openFor/closeAt (frames).
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from mathutils import Vector

import studio_kit as kit

if TYPE_CHECKING:
    import bpy

a = kit.args({"spread": 0.03, "groups": 5, "yaw": -55.0, "tilt": 12.0, "openAt": 8, "openFor": 30, "closeAt": 0, "fill": 0.62, "lens": 60.0, "fstop": 5.6})
scene = kit.reset(a)
root, screen, meshes = kit.import_device(a["device"])
if screen is not None:
    kit.set_screen(screen, a["screen"], a)
lo, hi = kit.world_bounds(meshes)
size = max(hi - lo)


def centre(obj: bpy.types.Object) -> Vector:
    """Evaluate the centre for this shot at a block frame."""
    return sum((obj.matrix_world @ Vector(c) for c in obj.bound_box), Vector()) / 8


ordered = sorted(meshes, key=lambda obj: centre(obj).y)
count = max(1, min(a["groups"], len(ordered)))
groups = [ordered[i * len(ordered) // count : (i + 1) * len(ordered) // count] for i in range(count)]
anchors = []
for rank, group in enumerate(groups):
    offset = (rank - (count - 1) / 2) * a["spread"]
    for obj in group:
        kit.key(obj, 1, location=obj.location.copy())
        if a["openAt"] > 1:
            kit.key(obj, a["openAt"], location=obj.location.copy())
        kit.key(obj, a["openAt"] + a["openFor"], location=obj.location + Vector((0, offset, 0)))
        if a["closeAt"]:
            kit.key(obj, a["closeAt"], location=obj.location + Vector((0, offset, 0)))
            kit.key(obj, min(a["frames"], a["closeAt"] + a["openFor"]), location=obj.location.copy())
            obj.location -= Vector((0, offset, 0))
        else:
            obj.location -= Vector((0, offset, 0))
        kit.ease(obj)
    marker = kit.bpy.data.objects.new(f"part_{rank}", None)
    kit.bpy.context.scene.collection.objects.link(marker)
    marker.parent = group[0]
    marker.location = centre(group[0]) - group[0].matrix_world.translation
    anchors.append(marker.name)

root.rotation_euler = (math.radians(-a["tilt"]), 0, math.radians(a["yaw"]))
extent = size + a["spread"] * count
kit.sweep(a, lo.z - extent * 0.4, extent)
kit.hdri(a)
kit.light_rig(a, extent)
target = ((lo + hi) / 2).to_tuple()
distance = kit.fit_distance(a, extent / a["fill"] * 0.7, (hi.z - lo.z) / a["fill"] * 0.7)
kit.camera(a, target, distance, height=extent * 0.2, yaw=-10)
kit.finish(anchors)
