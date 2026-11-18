# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Owned declarative scene worker. No .blend, user expressions or Python are loaded."""

import json
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Vector

with Path(sys.argv[sys.argv.index("--") + 1]).open(encoding="utf8") as handle:
    request = json.load(handle)
scene_config = request["scene"]
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.resolution_x = scene_config["width"]
scene.render.resolution_y = scene_config["height"]
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.use_stamp_date = False
scene.render.use_stamp_render_time = False
scene.render.fps = scene_config["fps"]
scene.render.film_transparent = False
scene.world.color = tuple(scene_config["background"])
scene.view_settings.view_transform = "Standard"
objects = {}
for config in scene_config["objects"]:
    shape = config["shape"]
    if shape == "cube":
        bpy.ops.mesh.primitive_cube_add(size=2)
    elif shape == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=1)
    elif shape == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=1, depth=2)
    elif shape == "plane":
        bpy.ops.mesh.primitive_plane_add(size=2)
    obj = bpy.context.object
    obj.name = config["id"]
    material = bpy.data.materials.new(config["id"] + "-material")
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*tuple(config["material"]["color"]), 1)
    bsdf.inputs["Metallic"].default_value = config["material"]["metallic"]
    bsdf.inputs["Roughness"].default_value = config["material"]["roughness"]
    obj.data.materials.append(material)
    objects[config["id"]] = obj
for config in scene_config["lights"]:
    bpy.ops.object.light_add(type="AREA", location=config["location"])
    light = bpy.context.object
    light.rotation_euler = (Vector(config["target"]) - light.location).to_track_quat("-Z", "Y").to_euler()
    light.data.energy = config["energy"]
    light.data.color = tuple(config["color"])
    light.data.size = config["size"]
bpy.ops.object.camera_add()
camera = bpy.context.object
camera.data.lens = scene_config["camera"]["lens"]
scene.camera = camera
for state in request["states"]:
    scene.frame_set(state["frame"] + 1)
    for values in state["objects"]:
        obj = objects[values["id"]]
        obj.location = values["location"]
        if "orientation" in values:
            obj.rotation_mode = "QUATERNION"
            obj.rotation_quaternion = values["orientation"]
        else:
            obj.rotation_mode = "XYZ"
            obj.rotation_euler = values["rotation"]
        obj.scale = values["scale"]
    if scene_config.get("physics", {}).get("solver") == "avc-solid-sphere-contacts-v2":
        bpy.context.view_layer.update()
        readback = []
        for values in state["objects"]:
            if "orientation" not in values:
                continue
            obj = objects[values["id"]]
            matrix = obj.matrix_world.to_3x3()
            columns = [matrix.col[i].normalized() for i in range(3)]
            readback.append(
                {
                    "id": values["id"],
                    "mode": obj.rotation_mode,
                    "orientation": list(obj.rotation_quaternion),
                    "initialEulerOrientation": list(Euler(values["rotation"], "XYZ").to_quaternion()),
                    "basis": [columns[c][r] for r in range(3) for c in range(3)],
                }
            )
        with (Path(request["directory"]) / f"frame-{state['frame']:06d}.rotation.json").open("x", encoding="utf8") as handle:
            json.dump({"frame": state["frame"], "objects": readback}, handle)
    camera.location = state["camera"]["location"]
    camera.rotation_euler = (Vector(state["camera"]["target"]) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(Path(request["directory"]).joinpath(f"frame-{state['frame']:06d}.png"))
    bpy.ops.render.render(write_still=True)
