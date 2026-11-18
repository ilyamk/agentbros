# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Turns downloaded device GLBs into the normalised files in public/shared/3d/.

    pnpm exec tsx scripts/blender-run.ts --script scripts/blender/prepare_devices.py --no-render \
      --output out/qa/prepare-devices --script-args '["<folder with the source GLBs>"]'

Normalised means: metres, Z up in Blender (Y up in glTF), screen facing -Y (+Z in three.js), centred on
the bounding box, no Draco (three.js loads it without a decoder from a CDN), the display named "screen"
with a single 0..1 UV rectangle laid in the display's own plane (u to the viewer's right, v up), so any
UI image maps on without distortion. Sources and licences: public/shared/3d/sources.json.
"""

from __future__ import annotations

import math
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeAlias

import bpy
from mathutils import Matrix, Vector

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

Params: TypeAlias = dict[str, Any]

ROOT = os.path.abspath(str(Path(str(Path(__file__).parent)).joinpath("..", "..")))  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.
OUT = str(Path(ROOT).joinpath("public", "shared", "3d"))

DEVICES = {
    "phone": {
        "file": "iphone-15-pro-max.glb",
        "screen": "xXDHkMplTIDAXLN",
        "turn": 180,
        "size": ("z", 0.1596),
        # The source leaves most surfaces at the importer's metallic 0 / roughness 0.5: grey plastic.
        "finish": {"GuYJryuYunhpphO": (1.0, 0.24), "buRWvyqhBBgcJFo": (1.0, 0.3), "ttmRoLdJipiIOmf": (0.0, 0.08), "WJwwVjsahIXbJpU": (0.0, 0.42), "wLfSXtbwRlBrwof": (0.0, 0.42)},
    },
    "laptop": {"file": "macbook-pro-16.glb", "screen": "Object_123", "turn": 0, "size": ("x", 0.3557), "finish": {}},
}


def clear() -> None:
    """Remove the current scene objects before importing a device."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(block):
            block.remove(item)


def bake_transforms(objects: Sequence[bpy.types.Object]) -> None:
    """Apply object transforms to the imported device geometry."""
    for obj in objects:
        if obj.type == "MESH":
            if obj.data.users > 1:
                obj.data = obj.data.copy()
            world = obj.matrix_world.copy()
            obj.parent = None
            obj.data.transform(world)
            obj.matrix_world = Matrix.Identity(4)
    for obj in objects:
        if obj.type != "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)


def bounds(meshes: Sequence[bpy.types.Object]) -> tuple[Vector, Vector]:
    """Measure the combined world-space bounds of the objects."""
    pts = [Vector(v.co) for obj in meshes for v in obj.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def screen_uvs(obj: bpy.types.Object) -> tuple[float, float]:
    """Map the screen mesh to normalised image coordinates."""
    mesh = obj.data
    normal = Vector((0, 0, 0))
    for poly in mesh.polygons:
        normal += poly.normal * poly.area
    normal.normalize()
    if normal.y > 0:  # the display must face the camera at -Y
        normal = -normal
    up = Vector((0, 0, 1))
    v_axis = (up - normal * up.dot(normal)).normalized()
    u_axis = v_axis.cross(normal).normalized()
    if u_axis.x < 0:
        u_axis = -u_axis
    us = [v.co.dot(u_axis) for v in mesh.vertices]
    vs = [v.co.dot(v_axis) for v in mesh.vertices]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    layer = mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        co = mesh.vertices[loop.vertex_index].co
        layer.data[loop.index].uv = ((co.dot(u_axis) - u0) / (u1 - u0), (co.dot(v_axis) - v0) / (v1 - v0))
    return (u1 - u0, v1 - v0)


def screen_material(obj: bpy.types.Object) -> None:
    """Create the emissive screen material."""
    mat = bpy.data.materials.new("screen")
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.004, 0.004, 0.005, 1)
    bsdf.inputs["Roughness"].default_value = 0.04
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def polish(meshes: Sequence[bpy.types.Object], finish: Mapping[str, tuple[float, float]]) -> None:
    """Per-object (metallic, roughness) where the source left defaults; everything else gets a light coat."""
    seen = set()
    for obj in meshes:
        for slot in obj.material_slots:
            mat = slot.material
            if mat is None or mat.name in seen or not mat.use_nodes:
                continue
            seen.add(mat.name)
            bsdf = mat.node_tree.nodes.get("Principled BSDF")
            if bsdf is None:
                continue
            if obj.name in finish:
                metallic, roughness = finish[obj.name]
                bsdf.inputs["Metallic"].default_value = metallic
                if not bsdf.inputs["Roughness"].links:
                    bsdf.inputs["Roughness"].default_value = roughness
            elif not bsdf.inputs["Roughness"].links and abs(bsdf.inputs["Roughness"].default_value - 0.5) < 1e-3:
                bsdf.inputs["Roughness"].default_value = 0.32


def prepare(name: str, spec: Params, source_dir: str) -> None:
    """Import and normalise one device according to its specification."""
    clear()
    bpy.ops.import_scene.gltf(filepath=str(Path(source_dir).joinpath(spec["file"])))
    objects = list(bpy.data.objects)
    bake_transforms(objects)
    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    lo, hi = bounds(meshes)
    axis, target = spec["size"]
    scale = target / (getattr(hi, axis) - getattr(lo, axis))
    centre = (lo + hi) / 2
    transform = Matrix.Rotation(math.radians(spec["turn"]), 4, "Z") @ Matrix.Scale(scale, 4) @ Matrix.Translation(-centre)
    for obj in meshes:
        obj.data.transform(transform)
        obj.data.update()
    polish(meshes, spec["finish"])
    screen = bpy.data.objects[spec["screen"]]
    screen.name = "screen"
    screen.data.name = "screen"
    size = screen_uvs(screen)
    screen_material(screen)
    lo, hi = bounds(meshes)
    print(f"AGENTBROS_DEVICE {name} size_m={tuple(round(v, 4) for v in hi - lo)} screen_m={tuple(round(v, 4) for v in size)}", flush=True)  # noqa: T201 -- The owning Node caller consumes this worker output.
    Path(OUT).mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(Path(OUT).joinpath(f"{name}.glb")),
        export_format="GLB",
        export_draco_mesh_compression_enable=False,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_image_format="AUTO",
    )


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    source_dir = argv[0]
    only = argv[1:] or list(DEVICES)
    for name in only:
        prepare(name, DEVICES[name], source_dir)
    clear()
    cam = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam


main()
