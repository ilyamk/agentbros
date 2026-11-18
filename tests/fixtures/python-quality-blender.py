# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Exercise animation shape contracts and contact diagnostics inside real Blender."""

from __future__ import annotations

import sys
from pathlib import Path

import avc_export
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/blender"))
from kit import anim, camera, stage

scene = bpy.context.scene
rig = camera.Rig({"width": 64, "height": 64, "fps": 30}, fstop=0)
rig.rack((0, 0, 0), lambda _frame: (0, 0, 1), frames=20)
assert rig.pose(10)[3] > 0

assert anim.Timeline._sum([lambda _frame: (1, 2), lambda _frame: (3, 4)], 0) == (4, 6)
try:
    anim.Timeline._sum([lambda _frame: (1, 2), lambda _frame: (3,)], 0)
except ValueError:
    pass
else:
    error_message = "Animation layers must not silently truncate vector dimensions"
    raise AssertionError(error_message)

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.6))
cube = bpy.context.object
scene.frame_set(7)
report = stage.report(scene, rig.obj, {}, floor_z=0, contact=[cube], frames=[0], tolerance=0.002, path=avc_export.output_path("floor-report.json"))
assert any("floor gap" in problem for problem in report["problems"])
assert scene.frame_current == 7
