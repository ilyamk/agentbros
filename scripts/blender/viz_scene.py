# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Render a trusted plan with matching orthographic projection."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import avc_export  # Supplied by the Blender runner.
import bpy  # Supplied by the Blender host.
from mathutils import Vector  # Blender host module.

from viz_math import linear_colour, to_blender

request = avc_export.render_request()
args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
if len(args) != 1:
    message = "Expected one prepared plan path"
    raise ValueError(message)
with Path(args[0]).open(encoding="utf8") as handle:
    plan = json.load(handle)
if plan["version"] != 1 or not plan["spec"]["recipe"].endswith("-3d"):
    message = "Expected a prepared 3D visualisation"
    raise ValueError(message)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.resolution_x = plan["width"]
scene.render.resolution_y = plan["height"]
scene.render.fps = 30
scene.frame_start = 1
scene.frame_end = plan["spec"]["durationFrames"]
scene.view_settings.view_transform = "Standard"
scene.world.color = (0.08, 0.08, 0.08)
scale = 200
MIN_PATH_POINTS = 2
bpy.ops.object.camera_add(location=(0, -20, 0), rotation=(math.pi / 2, 0, 0))
cam = bpy.context.object
camera_position = plan["projection"]["position"]
cam.location = to_blender(*camera_position)
cam.rotation_euler = (-Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
cam.data.type = "ORTHO"
cam.data.sensor_fit = "HORIZONTAL"
cam.data.ortho_scale = plan["width"] / scale if plan["width"] >= plan["height"] else plan["height"] / scale
scene.camera = cam
bpy.ops.object.light_add(type="AREA", location=(4, -10, 6))
bpy.context.object.data.energy = plan["lighting"]["key"] * 750
bpy.context.object.data.shape = "DISK"
bpy.context.object.data.size = 8
anchors = []
objects = {}
materials = {}


for primitive, state in zip(
    (p for p in plan["primitives"] if p["kind"] in ("rect", "circle")),
    plan["states"][-1],
    strict=True,
):
    bpy.ops.mesh.primitive_cube_add(
        size=1,
        location=to_blender(state["x"], state["y"], state.get("z", 0)),
    )
    obj = bpy.context.object
    obj.name = primitive["id"]
    material = bpy.data.materials.new(primitive["id"])
    material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Metallic"].default_value = 0.9 if plan["spec"]["material"] == "metal" else 0
    bsdf.inputs["Roughness"].default_value = 0.9 if plan["spec"]["material"] == "paper" else 0.45
    if plan["spec"]["material"] == "glass":
        bsdf.inputs["Transmission Weight"].default_value = 0.8
    state_colour = nodes.new("ShaderNodeRGB")
    base_output = state_colour.outputs[0]
    for role, texture_map in plan.get("textureFiles", {}).items():
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = bpy.data.images.load(
            texture_map["absolutePath"],
            check_existing=True,
        )
        texture.image.colorspace_settings.name = "sRGB" if texture_map["colourSpace"] == "srgb" else "Non-Color"
        coordinates = nodes.new("ShaderNodeTexCoord")
        mapping = nodes.new("ShaderNodeVectorMath")
        mapping.operation = "MULTIPLY"
        mapping.inputs[1].default_value = (*texture_map["repeat"], 1)
        material.node_tree.links.new(coordinates.outputs["UV"], mapping.inputs[0])
        material.node_tree.links.new(
            mapping.outputs["Vector"],
            texture.inputs["Vector"],
        )
        if role == "normal":
            normal = nodes.new("ShaderNodeNormalMap")
            material.node_tree.links.new(
                texture.outputs["Color"],
                normal.inputs["Color"],
            )
            material.node_tree.links.new(
                normal.outputs["Normal"],
                bsdf.inputs["Normal"],
            )
        elif role in ("roughness", "metallic"):
            socket = {"roughness": "Roughness", "metallic": "Metallic"}[role]
            material.node_tree.links.new(texture.outputs["Color"], bsdf.inputs[socket])
        elif role in ("ao", "baseColor"):
            mix_colour = nodes.new("ShaderNodeMixRGB")
            mix_colour.blend_type = "MULTIPLY"
            mix_colour.inputs[0].default_value = 1
            material.node_tree.links.new(base_output, mix_colour.inputs[1])
            material.node_tree.links.new(texture.outputs["Color"], mix_colour.inputs[2])
            base_output = mix_colour.outputs["Color"]
    material.node_tree.links.new(base_output, bsdf.inputs["Base Color"])
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    material.node_tree.links.new(transparent.outputs[0], mix.inputs[1])
    material.node_tree.links.new(bsdf.outputs[0], mix.inputs[2])
    material.node_tree.links.new(
        mix.outputs[0],
        nodes.get("Material Output").inputs["Surface"],
    )
    obj.data.materials.append(material)
    objects[primitive["id"]] = obj
    materials[primitive["id"]] = (bsdf, mix, state_colour)
    anchors.append(obj.name)
    for suffix, offset in (("top", 0.5), ("bottom", -0.5)):
        anchor = bpy.data.objects.new(f"{obj.name}-{suffix}", None)
        scene.collection.objects.link(anchor)
        anchor.parent = obj
        anchor.location = (0, 0, offset)
        anchors.append(anchor.name)

paths = {}
for path in plan.get("paths", []):
    if len(path["points"]) < MIN_PATH_POINTS:
        continue
    curve = bpy.data.curves.new(path["id"], "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = path["width"] / scale / 2
    curve.bevel_resolution = 1
    spline = curve.splines.new("POLY")
    spline.points.add(len(path["points"]) - 1)
    for point, coordinates in zip(spline.points, path["points"], strict=True):
        point.co = (*to_blender(*coordinates), 1)
    obj = bpy.data.objects.new(path["id"], curve)
    scene.collection.objects.link(obj)
    material = bpy.data.materials.new(path["id"])
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    emission = nodes.new("ShaderNodeEmission")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    output = nodes.new("ShaderNodeOutputMaterial")
    material.node_tree.links.new(transparent.outputs[0], mix.inputs[1])
    material.node_tree.links.new(emission.outputs[0], mix.inputs[2])
    material.node_tree.links.new(mix.outputs[0], output.inputs["Surface"])
    curve.materials.append(material)
    paths[path["id"]] = (curve, emission, mix, path["states"])


def viz_frame_state(current_scene: bpy.types.Scene) -> None:
    """Seek every camera, material and geometry value from the frame."""
    index = max(0, min(len(plan["states"]) - 1, current_scene.frame_current - 1))
    camera_state = plan["cameraFrames"][index]
    cam.data.ortho_scale = plan["width"] / scale / camera_state["zoom"]
    cam.location = (
        camera_position[0] - camera_state["panX"] / scale,
        -camera_position[2],
        camera_position[1],
    )
    target = Vector((-camera_state["panX"] / scale, 0, 0))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    for curve, emission, mix, states in paths.values():
        state = states[index]
        curve.bevel_factor_end = state["progress"]
        emission.inputs["Color"].default_value = (*linear_colour(state["fill"]), 1)
        mix.inputs[0].default_value = state["opacity"]
    for state in plan["states"][index]:
        obj = objects[state["id"]]
        obj.scale = (
            state["width"],
            state["depth"],
            max(0.000001, state["height"] * state["progress"]),
        )
        _bsdf, mix, state_colour = materials[state["id"]]
        state_colour.outputs[0].default_value = (*linear_colour(state["fill"]), 1)
        mix.inputs[0].default_value = state["opacity"]


for handler in list(bpy.app.handlers.frame_change_pre):
    if handler.__name__ == "viz_frame_state":
        bpy.app.handlers.frame_change_pre.remove(handler)
bpy.app.handlers.frame_change_pre.append(viz_frame_state)
scene.frame_set(1)
avc_export.export_camera(anchors=anchors)
