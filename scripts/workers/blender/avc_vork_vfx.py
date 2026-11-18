# SPDX-License-Identifier: GPL-3.0-or-later
"""Build an explicit Cycles shadow/reflection receiver around exported Vork geometry."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

from avc_vork_outputs import linear_passes, subject_masks


def image_node(tree: bpy.types.CompositorNodeTree, filename: str, first: int, count: int, root: Path, *, mask: bool = False) -> bpy.types.CompositorNodeImage:
    """Bind movie/holdout frame zero to the declared Blender start without retiming."""
    source = Path(filename)
    match = re.search(r"%0?(\d*)d", source.name)
    if match:
        expression = re.compile(re.escape(source.name).replace(re.escape(match[0]), r"(\d+)"))
        members = sorted((int(found[1]), file) for file in source.parent.iterdir() if (found := expression.fullmatch(file.name)))
        if len(members) != count or members[0][0] != 0 or [item[0] for item in members] != list(range(members[0][0], members[0][0] + count)):
            message = "Holdout sequence is incomplete or has gaps"
            raise RuntimeError(message)
        source = members[0][1]
    node = tree.nodes.new("CompositorNodeImage")
    node.image = bpy.data.images.load(str(source), check_existing=False)
    node.image.filepath = bpy.path.relpath(str(source), start=str(root))
    if match:
        node.image.source = "SEQUENCE"
    if mask:
        node.image.colorspace_settings.name = "Non-Color"
    user = getattr(node, "image_user", node)
    user.frame_start = first
    user.frame_duration = count
    user.frame_offset = 0
    user.use_auto_refresh = True
    return node


def scaled_image(tree: bpy.types.CompositorNodeTree, image: bpy.types.NodeSocket, source: list[int], target: list[int]) -> bpy.types.NodeSocket:
    """Scale plate/holdout rasters explicitly; compositor images otherwise crop previews."""
    scale = tree.nodes.new("CompositorNodeScale")
    scale.inputs["X"].default_value = target[0] / source[0]
    scale.inputs["Y"].default_value = target[1] / source[1]
    tree.links.new(image, scale.inputs["Image"])
    return scale.outputs["Image"]


def main() -> None:  # noqa: PLR0915 - isolated native scene transaction
    """Author geometry, calibrated animation and a scene-linear compositor; runner renders."""
    request = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=request["input"])
    scene = bpy.context.scene
    heroes = [obj for obj in scene.objects if obj.type == "MESH"]
    if not heroes:
        message = "The strict Vork export supplied no mesh"
        raise RuntimeError(message)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = request["samples"]
    scene.cycles.seed = request["seed"]
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = True
    scene.view_layers[0].cycles.use_pass_shadow_catcher = True
    scene.view_layers[0].use_pass_object_index = True
    for obj in heroes:
        obj.pass_index = 1
    scene.render.film_transparent = True
    scene.render.fps = round(request["fps"])
    scene.render.fps_base = scene.render.fps / request["fps"]
    scene.frame_start = request["firstFrame"]
    scene.frame_end = scene.frame_start + request["frames"] - 1
    scene.render.resolution_x, scene.render.resolution_y = request["resolution"]
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.world = bpy.data.worlds.new("Plate lighting estimate")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (*request["lighting"]["world"]["colour"], 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = request["lighting"]["world"]["strength"]
    # glTF already converts meshes to Z-up. Camera poses need the same world rotation once.
    conversion = Quaternion((1, 0, 0), 1.5707963267948966)
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.rotation_mode = "QUATERNION"
    camera.data.sensor_fit = "HORIZONTAL"
    camera.data.sensor_width = 36
    camera.data.lens = request["camera"]["K"][0] * 36 / request["resolution"][0]
    # A preview resolution changes raster size, never field of view.
    camera.data.lens *= request["resolution"][0] / request["camera"]["image_size"][0]
    camera.data.clip_start = 0.001
    camera.data.clip_end = 1000
    scene.camera = camera
    for index, pose in enumerate(request["camera"]["frames"][: request["frames"]]):
        camera.location = conversion @ Vector(pose["translation"])
        x, y, z, w = pose["rotation"]
        camera.rotation_quaternion = conversion @ Quaternion((w, x, y, z))
        camera.keyframe_insert(data_path="location", frame=scene.frame_start + index)
        camera.keyframe_insert(data_path="rotation_quaternion", frame=scene.frame_start + index)
    receiver = request["receiver"]
    bpy.ops.mesh.primitive_plane_add(size=1, location=conversion @ Vector(receiver["position"]))
    ground = bpy.context.object
    dimensions = receiver["size"] if isinstance(receiver["size"], list) else [receiver["size"], receiver["size"]]
    ground.scale = (dimensions[0], dimensions[1], 1)
    ground.name = "Physical plate receiver"
    ground.is_shadow_catcher = True
    material = bpy.data.materials.new("Estimated plate receiver")
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*receiver["colour"], 1)
    shader.inputs["Roughness"].default_value = receiver["roughness"]
    ground.data.materials.append(material)
    if request.get("proxy"):
        previous = set(scene.objects)
        bpy.ops.import_scene.gltf(filepath=request["proxy"])
        for obj in set(scene.objects) - previous:
            if obj.type == "MESH":
                obj.is_shadow_catcher = True
    for area in request["lighting"]["areas"]:
        bpy.ops.object.light_add(type="AREA", location=conversion @ Vector(area["position"]))
        lamp = bpy.context.object
        lamp.name = area["name"]
        lamp.data.energy = area["energy"]
        lamp.data.size = area["size"]
        lamp.data.color = area["colour"]
        lamp.rotation_euler = (conversion @ Vector(area["target"]) - lamp.location).to_track_quat("-Z", "Y").to_euler()
    tree = bpy.data.node_groups.new("Linear plate integration", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    scene.compositing_node_group = tree
    layers = tree.nodes.new("CompositorNodeRLayers")
    layers.scene = scene
    plate = image_node(tree, request["plate"], scene.frame_start, request["frames"], Path(request["output"]))
    plate_pixels = scaled_image(tree, plate.outputs["Image"], request["camera"]["image_size"], request["resolution"])
    interaction = tree.nodes.new("ShaderNodeMix")
    interaction.data_type = "RGBA"
    interaction.blend_type = "MULTIPLY"
    interaction.inputs["Factor"].default_value = 1
    tree.links.new(plate_pixels, interaction.inputs["A"])
    tree.links.new(layers.outputs["Shadow Catcher"], interaction.inputs["B"])
    overlay = tree.nodes.new("CompositorNodeAlphaOver")
    tree.links.new(interaction.outputs["Result"], overlay.inputs["Background"])
    tree.links.new(layers.outputs["Image"], overlay.inputs["Foreground"])
    result = overlay.outputs["Image"]
    if request.get("matte"):
        matte = image_node(tree, request["matte"], scene.frame_start, request["frames"], Path(request["output"]), mask=True)
        holdout = tree.nodes.new("ShaderNodeMix")
        holdout.data_type = "RGBA"
        tree.links.new(scaled_image(tree, matte.outputs["Image"], request["camera"]["image_size"], request["resolution"]), holdout.inputs["Factor"])
        tree.links.new(result, holdout.inputs["A"])
        tree.links.new(plate_pixels, holdout.inputs["B"])
        result = holdout.outputs["Result"]
    subject_masks(tree, layers, Path(request["output"]))
    output = tree.nodes.new("NodeGroupOutput")
    tree.links.new(result, output.inputs[0])
    linear_passes(Path(request["output"]))
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(request["output"]) / "scene.blend"))


if __name__ == "__main__":
    main()
