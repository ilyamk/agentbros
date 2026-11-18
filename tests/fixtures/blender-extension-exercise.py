# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Headless acceptance scene for the researched extension shortlist; no downloads."""

import hashlib
import json
import os
import sys
import time
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/workers/blender"))

import avc_extensions  # noqa: E402 -- Native module paths are established before these imports.
import bpy  # noqa: E402 -- Native module paths are established before these imports.
from mathutils import Vector  # noqa: E402 -- Native module paths are established before these imports.

extension_id = os.environ["AGENTBROS_EXERCISE_ID"]
output = Path(os.environ["AGENTBROS_EXERCISE_OUTPUT"])
output.mkdir(parents=True, exist_ok=True)
seed = int(os.environ.get("AGENTBROS_EXERCISE_SEED", "42"))
enabled = avc_extensions.enable([extension_id])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
scene.cycles.seed = 42
scene.cycles.use_adaptive_sampling = False
scene.cycles.use_denoising = False
scene.render.resolution_x = scene.render.resolution_y = 64
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.image_settings.color_depth = "8"
scene.render.film_transparent = False
scene.render.fps = 30
scene.world.color = (0.12, 0.12, 0.12)
bpy.ops.object.camera_add(location=(5, -6, 4))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.lens = 45
scene.camera = camera
bpy.ops.object.light_add(type="AREA", location=(3, -4, 5))
bpy.context.object.data.energy = 800
bpy.context.object.data.shape = "DISK"
bpy.context.object.data.size = 4
bpy.ops.mesh.primitive_cube_add()
target = bpy.context.object
started = time.perf_counter()
result = None
extra = {}
if extension_id == "cell_fracture":
    fragments = avc_extensions.fracture_object(target, seed=seed)
    result = [obj.name for obj in fragments]
    bpy.data.objects.remove(target, do_unlink=True)
    for obj in fragments:
        obj.location *= 1.15
elif extension_id == "extra_mesh_objects":
    bpy.data.objects.remove(target, do_unlink=True)
    result = sorted(bpy.ops.mesh.primitive_gear(number_of_teeth=12))
    extra["vertices"] = len(bpy.context.object.data.vertices)
elif extension_id == "add_camera_rigs":
    result = sorted(bpy.ops.object.build_camera_rig(mode="DOLLY"))
    extra["armatures"] = len([obj for obj in bpy.data.objects if obj.type == "ARMATURE"])
    scene.camera = camera
elif extension_id == "camera_shakify":
    avc_extensions.camera_shake(camera, "THE_CLOSEUP", 0.25)
    result = {"preset": camera.camera_shakes[0].shake_type, "intensity": camera.camera_shakes[0].influence}
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "shake.blend"))
elif extension_id == "light_it_up":
    result = sorted(bpy.ops.light_it_up.high_key())
    extra["lights"] = len([obj for obj in bpy.data.objects if obj.type == "LIGHT"])
elif extension_id == "enhanced_svg":
    svg = output / "fixture.svg"
    svg.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="0" y="0" width="45" height="100" fill="#ff0000"/><circle cx="75" cy="50" r="24" fill="#00ff00"/></svg>',
        encoding="utf8",
    )
    result = sorted(bpy.ops.import_scene.import_svg(filepath=str(svg), allow_external_images=False))
    curves = [obj for obj in bpy.data.objects if obj.type == "CURVE"]
    for obj in curves:
        obj.scale *= 40
    extra["curves"] = len(curves)
    extra["materials"] = len(bpy.data.materials)
    extra["lxmlVersion"] = __import__("lxml").__version__
elif extension_id == "node_to_python":
    group = bpy.data.node_groups.new("AVCTrialGeometry", "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    inp = group.nodes.new("NodeGroupInput")
    out = group.nodes.new("NodeGroupOutput")
    group.links.new(inp.outputs["Geometry"], out.inputs["Geometry"])
    scene.ntp_options.mode = "ADDON"
    scene.ntp_options.dir_path = str(output)
    scene.ntp_options.name = "AVCTrialExport"
    slot = scene.ntp_geometry_node_group_slots.add()
    slot.node_tree = group
    result = sorted(bpy.ops.ntp.export())
    assert result == ["FINISHED"], f"Node To Python refused Blender {bpy.app.version_string}: {result}"
    with zipfile.ZipFile(output / "AVCTrialExport.zip") as archive:
        sources = {name: archive.read(name) for name in archive.namelist() if name.endswith(".py")}
    for name, source in sources.items():
        compile(source, name, "exec")
    extra["generatedBytes"] = sum(len(source) for source in sources.values())
    extra["generatedPythonFiles"] = len(sources)
    assert extra["generatedBytes"] > 0
else:
    raise ValueError(extension_id)
operator_ms = (time.perf_counter() - started) * 1000
avc_extensions.require_render_extensions()
render_started = time.perf_counter()
frames = (19, 20) if os.environ.get("AGENTBROS_EXERCISE_RANGE") == "1" else (20,)
for frame in frames:
    scene.frame_set(frame)
    scene.render.filepath = str(output / f"frame-{frame}.png")
    bpy.ops.render.render(write_still=True)
scene.frame_set(20)
geometry = [
    {"name": obj.name, "location": list(obj.location), "vertices": [[round(v, 6) for v in vertex.co] for vertex in obj.data.vertices]}
    for obj in sorted(bpy.data.objects, key=lambda item: item.name)
    if obj.type == "MESH"
]
payload = {
    "blenderVersion": bpy.app.version_string,
    "id": extension_id,
    "enabled": enabled,
    "operatorMs": round(operator_ms, 3),
    "result": result,
    "extra": extra,
    "objects": len(bpy.data.objects),
    "nodeGroups": list(bpy.data.node_groups.keys()),
    "geometrySha256": hashlib.sha256(json.dumps(geometry, sort_keys=True).encode()).hexdigest(),
    "renderMs": round((time.perf_counter() - render_started) * 1000, 3),
    "frames": list(frames),
    "cameraMatrix": [round(value, 9) for row in camera.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world for value in row],
}
(output / "result.json").write_text(json.dumps(payload, indent=2), encoding="utf8")
