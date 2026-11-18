# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
# GPL-3.0-or-later, not BUSL-1.1: it runs the GPL Vork code in vendor/vork-blender in-process (NOTICE.md).
"""File-based Vork bridge, executed only through the trusted Blender runner."""

from __future__ import annotations

import json
import runpy
import sys
from pathlib import Path
from typing import Any

import bpy
from mathutils import Vector

from avc_vork_outputs import subject_masks


def composite_pass(scene: bpy.types.Scene, request: dict[str, Any], output: Path) -> None:
    """Insert a linear RGBA pass before the active Blender 5 compositor output."""
    tree = scene.compositing_node_group
    if tree is None:
        tree = bpy.data.node_groups.new("Vork composition", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        layers = tree.nodes.new("CompositorNodeRLayers")
        layers.scene = scene
        composite = tree.nodes.new("NodeGroupOutput")
        tree.links.new(layers.outputs["Image"], composite.inputs[0])
        scene.compositing_node_group = tree
    composite = next((node for node in tree.nodes if node.type == "GROUP_OUTPUT" and node.is_active_output), None)
    if composite is None or not composite.inputs[0].is_linked:
        message = "A linked active Blender 5 compositor output is required"
        raise RuntimeError(message)
    image = tree.nodes.new("CompositorNodeImage")
    image_path = Path(request["image"]).resolve()
    image.image = bpy.data.images.load(str(image_path), check_existing=False)
    image.image.filepath = bpy.path.relpath(str(image_path), start=str(output))
    if request.get("frames", 1) > 1:
        image.image.source = "SEQUENCE"
        user = getattr(image, "image_user", image)
        user.frame_duration = request["frames"]
        user.frame_start = request.get("start", 1)
    overlay = tree.nodes.new("CompositorNodeAlphaOver")
    tree.links.new(composite.inputs[0].links[0].from_socket, overlay.inputs["Background"])
    tree.links.new(image.outputs["Image"], overlay.inputs["Foreground"])
    tree.links.new(overlay.outputs["Image"], composite.inputs[0])


def main() -> None:  # noqa: PLR0915 - isolated bridge transaction
    """Export a saved scene or import geometry/passes without touching originals."""
    config = json.loads(sys.argv[sys.argv.index("--") + 1])
    output = Path(config["output"])
    if config["action"] == "from-blender":
        previous = sys.argv
        try:
            sys.argv = [config["exporter"], "--", "--out", str(output)] + (["--animation"] if config["animation"] else [])
            runpy.run_path(config["exporter"], run_name="__main__")
        finally:
            sys.argv = previous
        return
    if config["action"] == "to-blender":
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.context.scene.render.fps = 30
        bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, config["frames"]
        bpy.ops.import_scene.gltf(filepath=config["input"])
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if not meshes:
            message = "No mesh delivered by the Vork geometry export"
            raise RuntimeError(message)
        for obj in meshes:
            obj.pass_index = 1
        # glTF importer converts Y-up to Blender Z-up; do not rotate it twice.
        points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
        centre = sum(points, Vector()) / len(points)
        extent = max((p - centre).length for p in points)
        bpy.ops.object.camera_add(location=centre + Vector((extent * 3, -extent * 4, extent * 2)))
        camera = bpy.context.object
        camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.lens = 55
        bpy.context.scene.camera = camera
        for frame, offset in [(1, Vector((3, -4, 2))), (max(2, config["frames"] - 12), Vector((2.6, -3.7, 1.8))), (config["frames"], Vector((2.6, -3.7, 1.8)))]:
            camera.location = centre + offset * extent
            camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
            camera.keyframe_insert(data_path="location", frame=frame)
            camera.keyframe_insert(data_path="rotation_euler", frame=frame)
        floor_height = min(point.z for point in points)
        bpy.ops.mesh.primitive_plane_add(size=extent * 30, location=(centre.x, centre.y, floor_height))
        floor = bpy.data.materials.new("Vork geometry support")
        floor.diffuse_color = (0.08, 0.09, 0.11, 1)
        bpy.context.object.data.materials.append(floor)
        for position, energy, size in [((2, -3, 4), 500, 3), ((-2, 1, 3), 700, 2)]:
            bpy.ops.object.light_add(type="AREA", location=centre + Vector(position) * extent)
            lamp = bpy.context.object
            lamp.data.energy, lamp.data.shape, lamp.data.size = energy, "DISK", size * extent
            lamp.rotation_euler = (centre - lamp.location).to_track_quat("-Z", "Y").to_euler()
        bpy.context.scene.render.engine = "CYCLES"
        bpy.context.scene.world = bpy.data.worlds.new("Vork returned geometry world")
        bpy.context.scene.world.color = (0.08, 0.08, 0.08)
    else:
        request = json.loads(Path(config["input"]).read_text())
        bpy.ops.wm.open_mainfile(filepath=str(Path(request["blend"]).resolve()), use_scripts=False)
        composite_pass(bpy.context.scene, request, output)
    if config.get("diagnostics"):
        scene = bpy.context.scene
        scene.cycles.seed = 42
        scene.cycles.use_animated_seed = False
        scene.view_layers[0].use_pass_object_index = True
        tree = bpy.data.node_groups.new("Vork geometry diagnostic output", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        scene.compositing_node_group = tree
        layers = tree.nodes.new("CompositorNodeRLayers")
        layers.scene = scene
        subject_masks(tree, layers, Path(config["diagnostics"]))
        composite = tree.nodes.new("NodeGroupOutput")
        tree.links.new(layers.outputs["Image"], composite.inputs[0])
    scene = bpy.context.scene
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"))
    report = {
        "action": config["action"],
        "blender": bpy.app.version_string,
        "meshes": len([o for o in scene.objects if o.type == "MESH"]),
        "sourceUnchanged": True,
        "fps": scene.render.fps / scene.render.fps_base,
        "frameStart": scene.frame_start,
        "frameEnd": scene.frame_end,
    }
    (output / "bridge-report.json").write_text(json.dumps(report) + "\n")


if __name__ == "__main__":
    main()
