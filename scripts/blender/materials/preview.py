# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Compare tactile surfaces on grooved shader balls under two deliberate product light moods.

The frame number selects one of thirteen materials, never advances a simulation.
Argument: {"mood":"soft-product"|"rim-hero"}; render frames 1-13 for the complete library.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import avc_export
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from kit import anim, camera, light, look

from materials import SURFACES, material


def main() -> None:
    """Build the isolated two-mood material proof stage."""
    args = sys.argv[sys.argv.index("--") + 1 :]
    p = json.loads(args[0]) if args else {}
    if p.keys() - {"mood"} or p.get("mood", "soft-product") not in {"soft-product", "rim-hero"}:
        msg = "Expected mood: soft-product or rim-hero"
        raise ValueError(msg)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, len(SURFACES)
    scene.render.fps = 30
    scene.render.resolution_x, scene.render.resolution_y = avc_export.render_request().get("resolution") or (480, 270)
    scene.cycles.seed = 19
    scene.cycles.use_animated_seed = False
    look.apply(scene, "agx-contrast")
    light.world(strength=0.035, colour="#8d9baa")
    timeline = anim.Timeline(range(15))
    light.mood(p.get("mood", "soft-product"), size=2, target=(0, 0, 0.8), use_world=False).bake(timeline)
    camera.Rig({"width": scene.render.resolution_x, "height": scene.render.resolution_y}, target=(0, 0, 0.86), subject=(2.8, 1.95), yaw=12, pitch=12, lens=85, fstop=8).bake(timeline)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, radius=0.78, location=(0, 0, 0.9))
    ball = bpy.context.object
    ball.name = "AVC Material shader ball"
    for vertex in ball.data.vertices:
        latitude = vertex.co.z / 0.78
        if abs(latitude - 0.22) < 0.055 or abs(latitude + 0.48) < 0.035:
            vertex.co *= 0.96
    ball.rotation_euler[1] = math.radians(-24)
    for poly in ball.data.polygons:
        poly.use_smooth = True
    mats = [material(fn()) for fn in SURFACES.values()]
    ball.data.materials.append(mats[0])
    bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=0.64, depth=0.12, location=(0, 0, 0.06))
    base = bpy.context.object
    from materials import brushed_metal, ceramic

    base.data.materials.append(material(brushed_metal(roughness=0.32)))
    bevel = base.modifiers.new("Rounded plinth", "BEVEL")
    bevel.width, bevel.segments = 0.035, 3
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(material(ceramic((0.026, 0.033, 0.043, 1), 0.38)))

    def select_surface(current: Any, *_: Any) -> None:
        index = max(0, min(len(mats) - 1, current.frame_current - 1))
        ball.data.materials[0] = mats[index]

    select_surface.avc_material_preview = True  # ty: ignore[missing-attribute]
    for handler in list(bpy.app.handlers.frame_change_pre):
        if getattr(handler, "avc_material_preview", False):
            bpy.app.handlers.frame_change_pre.remove(handler)
    bpy.app.handlers.frame_change_pre.append(select_surface)
    timeline.bake()
    scene.frame_set(1)
    Path(avc_export.output_path("materials.json")).write_text(json.dumps({"mood": p.get("mood", "soft-product"), "frames": dict(enumerate(SURFACES, 1))}), encoding="utf8")


main()
