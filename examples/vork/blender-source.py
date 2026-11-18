# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""An original machined sculpture and calibrated checker-plane VFX fixture."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def material(name: str, colour: tuple[float, float, float, float], metallic: float = 0.0) -> object:
    """Create one directly representable Principled material."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = colour
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = 0.25 if metallic else 0.45
    return mat


def main() -> None:
    """Save a source copy and leave rendering to blender:run."""
    args = json.loads(sys.argv[sys.argv.index("--") + 1])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1920, 1080, 100
    scene.render.fps, scene.frame_start, scene.frame_end = 30, 1, 120
    scene.render.use_motion_blur = False
    scene.view_settings.view_transform = "AgX"
    scene.world = bpy.data.worlds.new("Studio world")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.08, 0.1, 0.14, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.2
    copper = material("Copper", (0.42, 0.14, 0.045, 1), 0.8)
    ceramic = material("Ceramic", (0.025, 0.12, 0.15, 1))
    for index in range(9):
        z = 0.15 + index * 0.11
        bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=12, location=(0, 0, z), major_radius=0.4 + 0.09 * math.sin(index * 0.7), minor_radius=0.045)
        obj = bpy.context.object
        obj.name = f"Sculpture ring {index}"
        obj.data.materials.append(copper)
        for face in obj.data.polygons:
            face.use_smooth = True
    bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=0.32, depth=1.15, location=(0, 0, 0.58))
    bpy.context.object.data.materials.append(ceramic)
    floor = material("Floor", (0.09, 0.1, 0.12, 1))
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(floor)
    if args.get("checker"):
        white = material("Checker light", (0.7, 0.7, 0.7, 1))
        for y in range(-5, 6):
            for x in range(-7, 8):
                if (x + y) % 2 == 0:
                    bpy.ops.mesh.primitive_plane_add(size=0.12, location=(x * 0.12, y * 0.12, 0.001))
                    bpy.context.object.data.materials.append(white)
    for location, energy, colour, size in [((-2, -3, 4), 500, (0.75, 0.86, 1), 3), ((2, 1, 2.5), 650, (1, 0.67, 0.35), 2)]:
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.data.energy, light.data.size, light.data.color = energy, size, colour
        light.rotation_euler = (Vector((0, 0, 0.5)) - light.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.camera_add(location=(2.4, -3.6, 1.8))
    camera = bpy.context.object
    camera.data.lens = 60
    scene.camera = camera
    for frame, location in [(1, (2.4, -3.6, 1.8)), (100, (2.1, -3.7, 1.8)), (120, (2.1, -3.7, 1.8))]:
        camera.location = location
        camera.rotation_euler = (Vector((0, 0, 0.52)) - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_euler", frame=frame)
    scene.frame_set(1)
    destination = Path(args["blend"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(destination.resolve()))


if __name__ == "__main__":
    main()
