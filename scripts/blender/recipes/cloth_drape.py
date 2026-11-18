# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Let a satin cloth fall onto a grounded form and settle into readable folds.

Knobs: grid, stiffness, seed. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import random
from typing import Any

import bpy
from avc_recipes import validate_params

from _common import (
    animate_mesh,
    bake,
    finish,
    material,
    mesh,
    orb,
    timeline_for,
)

META = {
    "id": "cloth-drape",
    "title": "Satin unveiling",
    "category": "simulation",
    "intent": "Let a satin cloth fall onto a grounded form and settle into readable folds.",
    "params": {
        "grid": {"type": "integer", "default": 24, "min": 12, "max": 40, "doc": "Cloth subdivisions per side."},
        "stiffness": {"type": "number", "default": 8, "min": 1, "max": 30, "doc": "Cloth bending stiffness."},
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed variation seed."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "ready",
    "needs_bake": True,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    support = orb("Cloth support", (0, 0, 0.64), 0.64, material("Cloth support", (0.018, 0.025, 0.03, 1), 0.35, 0.25))
    ground = mesh("Cloth collision ground", [(-4, -4, 0), (4, -4, 0), (4, 4, 0), (-4, 4, 0)], [(0, 1, 2, 3)])
    ground.hide_render = True
    ground.modifiers.new("Ground collision", "COLLISION")
    colliders = bpy.data.collections.new("AVC Cloth colliders")
    scene.collection.children.link(colliders)
    colliders.objects.link(ground)
    colliders.objects.link(support)
    collision = support.modifiers.new("Cloth collider", "COLLISION")
    mat = material("Cloth drape", (0.08, 0.006, 0.014, 1), 0.0, 0.54)
    shader = mat.node_tree.nodes.get("Group").node_tree
    bsdf = next(n for n in shader.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Sheen Weight"].default_value = 0.3
    weave = shader.nodes.new("ShaderNodeTexWave")
    weave.inputs["Scale"].default_value = 180
    weave.inputs["Distortion"].default_value = 2
    bump = shader.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.18
    bump.inputs["Distance"].default_value = 0.0015
    shader.links.new(weave.outputs["Fac"], bump.inputs["Height"])
    shader.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    size = p["grid"]
    rng = random.Random(p["seed"])
    vertices = [((x / size - 0.5) * 2.8, (y / size - 0.5) * 2.8, 1.9 + rng.uniform(-0.004, 0.004)) for y in range(size + 1) for x in range(size + 1)]
    faces = [(y * (size + 1) + x, y * (size + 1) + x + 1, (y + 1) * (size + 1) + x + 1, (y + 1) * (size + 1) + x) for y in range(size) for x in range(size)]
    cloth = mesh("Cloth drape", vertices, faces, mat)

    def simulate() -> list[Any]:
        mod = cloth.modifiers.new("Fixed cloth bake", "CLOTH")
        mod.settings.quality = 6
        mod.settings.mass = 0.22
        mod.settings.bending_stiffness = p["stiffness"]
        mod.collision_settings.use_self_collision = True
        mod.collision_settings.distance_min = 0.015
        mod.collision_settings.collection = colliders
        mod.settings.effector_weights.collection = colliders
        mod.point_cache.frame_start, mod.point_cache.frame_end = 1, 64
        snapshots = []
        previous = scene.frame_current
        try:
            for frame in range(1, 65):
                scene.frame_set(frame)
                evaluated = cloth.evaluated_get(bpy.context.evaluated_depsgraph_get())
                snapshots.append([list(vertex.co) for vertex in evaluated.data.vertices])
        finally:
            cloth.modifiers.remove(mod)
            scene.frame_set(previous)
        return snapshots

    cached = bake(
        "cloth-drape",
        p,
        simulate,
        {"blender": bpy.app.version_string, "fps": scene.render.fps, "fps_base": scene.render.fps_base, "gravity": list(scene.gravity), "unit_scale": scene.unit_settings.scale_length},
    )
    support.modifiers.remove(collision)
    bpy.data.objects.remove(ground, do_unlink=True)
    bpy.data.collections.remove(colliders)
    animate_mesh(cloth, cached["data"])
    for polygon in cloth.data.polygons:
        polygon.use_smooth = True
    solid = cloth.modifiers.new("Satin hem", "SOLIDIFY")
    solid.thickness = 0.008
    sub = cloth.modifiers.new("Soft folds", "SUBSURF")
    sub.levels, sub.render_levels = 1, 1
    return finish([cloth, support], [mat], tl, owned, cached)
