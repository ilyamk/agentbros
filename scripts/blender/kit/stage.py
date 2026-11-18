# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Scene composition: grounds and simple sets, staging by role, contact, and the safe-frame and floor checks.

    floor = stage.sweep("#e9e4dc", size=0.3)                  # seamless cyclorama with a little real-world imperfection
    plan = stage.roles(hero=1, support=2, detail=3, at=6)     # entry frames in reading order (curves.hierarchy)
    stage.rest_on(obj, floor_z=0.0)                           # contact: lowest point on the floor
    stage.report(scene, cam, {"hero": [plush]}, floor_z=0.0)  # craft-report.json beside the frames

A subject floating over a ground without a contact shadow is the first thing that reads as CG; `report` measures the
gap per frame and the subject's place against the safe frame of the render's format (vertical, square or landscape).
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeAlias

import avc_export
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

from . import curves
from .light import hex_linear

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence


Params: TypeAlias = dict[str, Any]


def _link(obj: bpy.types.Object) -> bpy.types.Object:
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _imperfect(mat: bpy.types.Material, roughness: float, scale: float = 6.0, amount: float = 0.08, bump: float = 0.0) -> bpy.types.Material:
    """Breaks a single roughness value (the plastic look) with large soft noise, and optionally a faint bump."""
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    coord = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 3.0
    links.new(coord.outputs["Object"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeMapRange")
    ramp.inputs["To Min"].default_value = max(0.0, roughness - amount)
    ramp.inputs["To Max"].default_value = min(1.0, roughness + amount)
    links.new(noise.outputs["Fac"], ramp.inputs["Value"])
    links.new(ramp.outputs[0], bsdf.inputs["Roughness"])
    if bump:
        fine = nodes.new("ShaderNodeTexNoise")
        fine.inputs["Scale"].default_value = scale * 60
        fine.inputs["Detail"].default_value = 6.0
        links.new(coord.outputs["Object"], fine.inputs["Vector"])
        b = nodes.new("ShaderNodeBump")
        b.inputs["Strength"].default_value = bump
        b.inputs["Distance"].default_value = 0.001
        links.new(fine.outputs["Fac"], b.inputs["Height"])
        links.new(b.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def surface(
    name: str, colour: str | Sequence[float], roughness: float = 0.6, imperfection: float = 0.08, bump: float = 0.0, scale: float = 6.0, **inputs: float | Sequence[float]
) -> bpy.types.Material:
    """Build a stage material from the requested surface preset."""
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*(hex_linear(colour) if isinstance(colour, str) else colour), 1)
    bsdf.inputs["Roughness"].default_value = roughness
    for key, value in inputs.items():
        bsdf.inputs[key.replace("_", " ")].default_value = value
    if imperfection or bump:
        _imperfect(mat, roughness, scale=scale, amount=imperfection, bump=bump)
    return mat


def sweep(
    colour: str | Sequence[float],
    size: float = 0.3,
    floor_z: float = 0.0,
    depth: float = 4.0,
    curve_radius: float = 2.2,
    width: float = 14.0,
    roughness: float = 0.55,
    imperfection: float = 0.08,
    name: str = "sweep",
) -> bpy.types.Object:
    """A seamless cyclorama sized to the subject (`size` metres): floor running back into a curved wall, no horizon."""
    radius = size * curve_radius
    back = size * depth
    profile = [(-size * 10, 0.0)]
    for i in range(28):
        t = i / 27 * (math.pi / 2)
        profile.append((back - radius + math.sin(t) * radius, radius - math.cos(t) * radius))
    profile.append((back, size * 12))
    w = size * width
    verts, faces = [], []
    for y, z in profile:
        verts.extend([(-w, y, z + floor_z), (w, y, z + floor_z)])
    faces = [(i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2) for i in range(len(profile) - 1)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.shade_smooth()
    obj = _link(bpy.data.objects.new(name, mesh))
    obj.data.materials.append(surface(f"{name}-paper", colour, roughness, imperfection, scale=1.5 / max(1e-3, size)))
    return obj


def floor(colour: str | Sequence[float], size: float = 0.3, floor_z: float = 0.0, kind: str = "plaster", name: str = "floor") -> bpy.types.Object:
    """A set floor: plaster (matte, fine bump), wood (warm, grain stretched along X), or paper (fibre)."""
    s = size * 30
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(-s, -s, floor_z), (s, -s, floor_z), (s, s, floor_z), (-s, s, floor_z)], [], [(0, 1, 2, 3)])
    obj = _link(bpy.data.objects.new(name, mesh))
    if kind == "wood":
        mat = surface(f"{name}-wood", colour, 0.45, 0.12, bump=0.08, scale=2.0 / size)
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        coord = nodes.new("ShaderNodeTexCoord")
        stretch = nodes.new("ShaderNodeMapping")
        stretch.inputs["Scale"].default_value = (2.0 / size, 40.0 / size, 2.0 / size)
        links.new(coord.outputs["Object"], stretch.inputs["Vector"])
        wave = nodes.new("ShaderNodeTexWave")
        wave.inputs["Distortion"].default_value = 6.0
        links.new(stretch.outputs["Vector"], wave.inputs["Vector"])
        tint = nodes.new("ShaderNodeMix")
        tint.data_type = "RGBA"
        base = hex_linear(colour)
        tint.inputs["A"].default_value = (*base, 1)
        tint.inputs["B"].default_value = (*(c * 0.7 for c in base), 1)
        links.new(wave.outputs["Fac"], tint.inputs["Factor"])
        links.new(tint.outputs["Result"], nodes["Principled BSDF"].inputs["Base Color"])
    elif kind == "paper":
        mat = surface(f"{name}-paper", colour, 0.8, 0.06, bump=0.05, scale=3.0 / size)
    else:
        mat = surface(f"{name}-plaster", colour, 0.75, 0.1, bump=0.03, scale=3.0 / size)
    obj.data.materials.append(mat)
    return obj


def plinth(colour: str | Sequence[float], radius: float, height: float, location: tuple[float, ...] = (0, 0, 0), name: str = "plinth", roughness: float = 0.35) -> bpy.types.Object:
    """A round pedestal with a soft bevel: the hero's stand."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=radius, depth=height, location=(location[0], location[1], location[2] + height / 2))
    obj = bpy.context.active_object
    obj.name = name
    bevel = obj.modifiers.new("bevel", "BEVEL")
    bevel.width = min(radius, height) * 0.08
    bevel.segments = 4
    bevel.limit_method = "ANGLE"
    obj.data.shade_smooth()
    obj.data.materials.append(surface(f"{name}-mat", colour, roughness, 0.06))
    return obj


def lowest_z(objects: Iterable[bpy.types.Object]) -> float:
    """Measure the lowest evaluated world-space point of the objects."""
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    z = math.inf
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        if obj.type in ("MESH", "META", "CURVE", "FONT"):
            for corner in evaluated.bound_box:
                z = min(z, (evaluated.matrix_world @ Vector(corner)).z)
    return z


def rest_on(root: bpy.types.Object, objects: Iterable[bpy.types.Object], floor_z: float = 0.0) -> float:
    """Moves `root` so the lowest point of `objects` touches the floor: contact, so the shadow touches."""
    gap = lowest_z(objects) - floor_z
    root.location.z -= gap
    return gap


def roles(hero: int = 1, support: int = 0, detail: int = 0, at: int = 0, fps: float = 30, **options: int) -> Params:
    """Entry frames by role (curves.hierarchy, same as timing.ts) plus relative scale: hero 1, support 0.62, detail 0.36."""
    entries = curves.hierarchy(hero, support, detail, at=at, fps=fps, **options)
    plan: Params = {"hero": entries["hero"], "support": entries["support"], "detail": entries["detail"], "last": entries["last"]}
    plan["scale"] = {"hero": 1.0, "support": 0.62, "detail": 0.36}
    return plan


def _box(scene: bpy.types.Scene, cam: bpy.types.Object, objects: Iterable[bpy.types.Object]) -> tuple[float, float, float, float] | None:
    """Screen box (left, top, right, bottom as shares, y down) of the objects' bound boxes at the current frame."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    xs, ys = [], []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            p = world_to_camera_view(scene, cam, evaluated.matrix_world @ Vector(corner))
            if p.z > 0:
                xs.append(p.x)
                ys.append(1 - p.y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def format_of(width: float, height: float) -> str:
    """Classify the scene aspect as vertical, square or landscape."""
    r = width / height
    return "vertical" if r < 0.8 else ("square" if r < 1.25 else "landscape")


def report(  # noqa: C901 -- Keep the ordered validation or native transaction together.
    scene: bpy.types.Scene,
    cam: bpy.types.Object,
    subjects: Mapping[str, Iterable[bpy.types.Object]],
    floor_z: float | None = None,
    contact: Iterable[bpy.types.Object] | None = None,
    frames: Sequence[int] | None = None,
    path: str | None = None,
    tolerance: float = 0.002,
) -> Params:
    r"""Measure safe-frame coverage and floor contact at sampled frames.

    Measures, per sampled frame: each role's screen box against the render format's safe frame (curves.SAFE), and
    the gap between `contact` objects and the floor (a float over `tolerance` metres with nothing under it is the CG
    tell). Writes craft-report.json beside the frames when run through blender-run; returns the dict.
    """
    fmt = format_of(scene.render.resolution_x, scene.render.resolution_y)
    frames = frames or sorted({scene.frame_start, (scene.frame_start + scene.frame_end) // 2, scene.frame_end})
    rows = []
    current = scene.frame_current
    for frame in frames:
        scene.frame_set(frame)
        row: Params = {"frame": frame, "roles": {}}
        for role, objects in subjects.items():
            box = _box(scene, cam, objects)
            if box:
                row["roles"][role] = {"box": [round(v, 4) for v in box], "excess": {k: round(v, 4) for k, v in curves.safe_excess(box, fmt).items()}}
        if contact and floor_z is not None:
            row["floorGap"] = round(lowest_z(contact) - floor_z, 5)
        rows.append(row)
    scene.frame_set(current)
    problems = []
    for row in rows:
        if "floorGap" in row and abs(row["floorGap"]) > tolerance:
            problems.append(f"frame {row['frame']}: floor gap {row['floorGap']} exceeds tolerance {tolerance}")
        for role, entry in row["roles"].items():
            if role == "hero" and any(v > 0.01 for v in entry["excess"].values()):
                problems.append(f"frame {row['frame']}: hero outside the {fmt} safe frame {entry['excess']}")
    result = {"format": fmt, "safe": curves.safe_rect(fmt), "rows": rows, "problems": problems}
    target = path or (avc_export.output_path("craft-report.json") if avc_export.render_request() else None)
    if target:
        Path(str(Path(os.path.abspath(target)).parent)).mkdir(parents=True, exist_ok=True)  # a live session's kit folder may not exist yet  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.
        with Path(target).open("w", encoding="utf8") as handle:
            json.dump(result, handle, indent=1)
    for problem in problems:
        print(f"[craft] {problem}")  # noqa: T201 -- The owning Node caller consumes this worker output.
    return result
