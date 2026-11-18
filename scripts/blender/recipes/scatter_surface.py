# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Build anticipation as metallic pearls bloom across a product surface.

Knobs: object, density, scale, seed. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import math
import random
from typing import Any

import bpy
from avc_recipes import validate_params
from kit import curves

from _common import (
    finish,
    material,
    surface_points,
    target,
    timeline_for,
)

META = {
    "id": "scatter-surface",
    "title": "Pearled surface reveal",
    "category": "geometry",
    "intent": "Build anticipation as metallic pearls bloom across a product surface.",
    "params": {
        "object": {"type": "string", "default": "", "doc": "Optional static mesh name (object transforms may animate); empty creates a grounded proof subject."},
        "density": {"type": "number", "default": 28, "min": 1, "max": 120, "doc": "Points per square metre."},
        "scale": {"type": "number", "default": 0.055, "min": 0.01, "max": 0.18, "doc": "Pearl radius in metres."},
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed variation seed."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": 0.959, "eevee": None},
    "status": "ready",
    "needs_bake": False,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    source = target(p, "Scatter surface")
    if p["object"] and (
        source.data.shape_keys
        or any(
            mod.type in {"ARMATURE", "NODES", "CLOTH", "SOFT_BODY", "MESH_CACHE", "MESH_SEQUENCE_CACHE", "FLUID", "BOOLEAN", "LATTICE", "MESH_DEFORM", "SURFACE_DEFORM", "WAVE"}
            for mod in source.modifiers
        )
    ):
        msg = "scatter-surface requires static mesh geometry; apply before reveals/deformation, or use a static duplicate"
        raise ValueError(msg)
    mat = material("Scatter surface", (0.55, 0.24, 0.06, 1), 0.82, 0.23)
    created_materials = [mat]
    if not p["object"]:
        core = material("Porcelain core", (0.68, 0.64, 0.55, 1), 0, 0.24)
        source.data.materials[0] = core
        created_materials.append(core)
    evaluated = source.evaluated_get(bpy.context.evaluated_depsgraph_get())
    surface = evaluated.to_mesh()
    points = surface_points([tuple(v.co) for v in surface.vertices], [list(face.vertices) for face in surface.polygons], p["density"], p["seed"])
    evaluated.to_mesh_clear()
    separated = []
    for point in points:
        if not p["object"] and point[2] < -0.68:
            continue
        if all(sum((point[k] - other[k]) ** 2 for k in range(3)) >= (2.1 * p["scale"]) ** 2 for other in separated):
            separated.append(point)
    points = separated
    rng = random.Random(p["seed"])
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=p["scale"])
    prototype = bpy.context.object
    prototype.name = "AVC Scatter pearl prototype"
    prototype.hide_render = True
    prototype.data.materials.append(mat)
    for polygon in prototype.data.polygons:
        polygon.use_smooth = True
    objects = [prototype] if p["object"] else [source, prototype]
    for index, point in enumerate(points):
        pearl = bpy.data.objects.new(f"AVC Scatter pearl {index:03}", prototype.data)
        scene.collection.objects.link(pearl)
        pearl.parent = source
        pearl.location = point
        pearl.rotation_euler = tuple(rng.uniform(-math.pi, math.pi) for _ in range(3))
        size = rng.uniform(0.65, 1.15)
        delay = 6 + max(0, min(1, (point[2] + 0.8) / 1.6)) * 15
        tl.add(pearl, "scale", lambda f, size=size, delay=delay: max(0.001, size * curves.progress(f, delay, 22, "punch")))
        objects.append(pearl)
    return finish(objects, created_materials, tl, owned)
