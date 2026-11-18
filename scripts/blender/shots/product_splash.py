# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Hook: a cold citrus can holds its silhouette as a backlit juice crown hits a freeze ramp.

The viewer reads PULP first, then the thin juice rim and suspended droplets. An 85 mm
hero lens compresses the crown around the can; a restrained push lands on the impact.
All fluid is cached Mantaflow; frame remapping is pure. No invented whitewater.
Argument: {"variant":"a"|"b", "resolution":64, "mesh_scale":2,
"simulation_frames":40, "seed":19}; proof at 32/1, 480x270, 8 samples.
"""

from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path
from typing import Any

import avc_export
import bpy
from avc_recipes import apply

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from kit import anim, camera, light, look, stage
from materials import anodised_metal, brushed_metal, car_paint, ceramic, material, tinted_glass


def cylinder(name: str, radius: float, depth: float, z: float, mat: Any) -> Any:
    """Turn a parametric can part with a small manufactured edge radius."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=radius, depth=depth, location=(0, 0, z))
    obj = bpy.context.object
    obj.name = "AVC " + name
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new("Machined edge", "BEVEL")
    bevel.width, bevel.segments = 0.035, 3
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def main() -> None:
    """Build the product, editorial camera, backlight and baked FX as one reusable shot."""
    args = sys.argv[sys.argv.index("--") + 1 :]
    p = json.loads(args[0]) if args else {}
    if p.keys() - {"variant", "seed", "resolution", "mesh_scale", "simulation_frames"} or p.get("variant", "b") not in {"a", "b"}:
        msg = "Unknown shot parameters or variant"
        raise ValueError(msg)
    variant = p.get("variant", "b")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, 64
    scene.render.fps = 30
    scene.render.resolution_x, scene.render.resolution_y = avc_export.render_request().get("resolution") or (480, 270)
    scene.cycles.seed = p.get("seed", 19)
    scene.cycles.use_animated_seed = False
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 8
    look.apply(scene, "agx-contrast")
    look.motion_blur(scene, 0.25)
    light.world(strength=0.035 if variant == "a" else 0.012, colour="#bca687")
    tl = anim.Timeline(range(-1, 67))
    light.mood("soft-product" if variant == "a" else "rim-hero", size=2, target=(0, 0, 0.9), use_world=False, scale={"key": 0.65, "fill": 0.5, "rim-left": 1.8, "rim-right": 1.4}).bake(tl)
    rig = camera.Rig({"width": scene.render.resolution_x, "height": scene.render.resolution_y}, target=(0, 0, 1.25), subject=(3.8, 2.5), yaw=-8, pitch=10, lens=85, fstop=8)
    rig.push_in(0.96, at=2, frames=35, intent="brake").bake(tl)
    silver = material(brushed_metal(roughness=0.22))
    body = cylinder("Citrus can", 0.43, 1.68, 0.90, material(car_paint((0.62, 0.105, 0.008, 1), 0.24)))
    foot = cylinder("Can foot", 0.405, 0.06, 0.03, silver)
    cylinder("Can shoulder", 0.4, 0.13, 1.76, material(anodised_metal((0.7, 0.17, 0.014, 1))))
    lid = cylinder("Can lid", 0.39, 0.045, 1.84, silver)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.367, minor_radius=0.022, major_segments=64, minor_segments=12, location=(0, 0, 1.869))
    bpy.context.object.data.materials.append(silver)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.09, minor_radius=0.025, major_segments=32, minor_segments=8, location=(0, -0.05, 1.89))
    bpy.context.object.scale.y = 1.6
    bpy.context.object.data.materials.append(silver)
    label = material(ceramic((0.97, 0.84, 0.56, 1), 0.32))
    for text, size, z in (("PULP", 0.31, 1.04), ("CITRUS", 0.115, 0.76), ("SPARKLING / 330 ml", 0.05, 0.55)):
        bpy.ops.object.text_add(location=(0, -0.434, z), rotation=(math.pi / 2, 0, 0))
        obj = bpy.context.object
        obj.data.body, obj.data.align_x, obj.data.align_y = text, "CENTER", "CENTER"
        obj.data.size, obj.data.extrude = size, 0.0005
        obj.data.materials.append(label)
    rng = random.Random(p.get("seed", 19))
    wet = material(tinted_glass((0.94, 0.98, 1, 1), 0.04, 1.333))
    for _ in range(38):
        a = rng.uniform(-2.7, -0.4)
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=rng.uniform(0.007, 0.019), location=(0.438 * math.cos(a), 0.438 * math.sin(a), rng.uniform(0.35, 1.65)))
        obj = bpy.context.object
        obj.scale.z = 1.3
        obj.data.materials.append(wet)
        for face in obj.data.polygons:
            face.use_smooth = True
    apply("studio-floor", {"colour": "#20130c"}, timeline=tl)
    result = apply(
        "product-splash",
        {"seed": p.get("seed", 19), "resolution": p.get("resolution", 64), "mesh_scale": p.get("mesh_scale", 2), "simulation_frames": p.get("simulation_frames", 40), "freeze_ramp": True},
    )
    tl.bake()
    scene.frame_set(18)
    stage.report(scene, rig.obj, {"hero": [body, foot, lid]}, floor_z=0, contact=[foot], frames=[1, 12, 26, 44, 64])
    Path(avc_export.output_path("splash-shot.json")).write_text(
        json.dumps(
            {
                "variant": variant,
                "params": {"seed": p.get("seed", 19), "resolution": p.get("resolution", 64), "mesh_scale": p.get("mesh_scale", 2), "simulation_frames": p.get("simulation_frames", 40)},
                "seed": p.get("seed", 19),
                "subject": body.name,
                "fluid": result,
                "editorial": {"freezeFrame": 18, "holdFrames": 12, "rate": 0.12},
                "rights": {"licence": "CC0-1.0", "source": "Original parametric geometry and shaders"},
            }
        ),
        encoding="utf8",
    )


main()
