# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Own procedural worker; no third-party scenes or embedded Python are executed."""

import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1 :]
with Path(args[0]).open(encoding="utf8") as handle:
    request = json.load(handle)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
try:
    scene.render.engine = "BLENDER_EEVEE"  # Blender 5.x
except TypeError:
    scene.render.engine = "BLENDER_EEVEE_NEXT"  # Blender 4.2-4.x
scene.render.resolution_x = request["width"]
scene.render.resolution_y = request["height"]
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
# Blender writes stamps into PNG metadata even when their visual overlay is off.
# Wall-clock date/render duration would make identical pixels hash differently.
scene.render.use_stamp_date = False
scene.render.use_stamp_render_time = False
scene.render.fps = request["fps"]
scene.render.film_transparent = False
scene.world.color = (0.04, 0.04, 0.04)
scene.view_settings.view_transform = "Standard"
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
subject = bpy.context.object
material = bpy.data.materials.new("subject-color")
material.diffuse_color = (*tuple(request["color"]), 1.0)
subject.data.materials.append(material)
bpy.ops.object.light_add(type="AREA", location=(3, -4, 5))
bpy.context.object.data.energy = 600
bpy.context.object.data.shape = "DISK"
bpy.context.object.data.size = 4
bpy.ops.object.camera_add(location=(4, -6, 4))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = camera
outputs = []
for frame in request["frames"]:
    # Absolute formula; seeking does not depend on previous renders or wall clock.
    scene.frame_set(frame + 1)
    subject.rotation_euler = (0.15, 0.25, (frame / request["fps"]) * request["radiansPerSecond"])
    scene.render.filepath = str(Path(request["directory"]).joinpath(f"frame-{frame:06d}.png"))
    bpy.ops.render.render(write_still=True)
    outputs.append({"frame": frame, "path": scene.render.filepath})
print(json.dumps({"ok": True, "outputs": outputs}))  # noqa: T201 -- The owning Node caller consumes this worker output.
