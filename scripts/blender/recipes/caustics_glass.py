# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Read the weight of optical glass through a moving caustic highlight on a grounded receiver.

Knobs: ior, roughness. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import math
from typing import Any

import bpy
from avc_recipes import validate_params

from _common import (
    finish,
    material,
    timeline_for,
)

META = {
    "id": "caustics-glass",
    "title": "Optical glass study",
    "category": "lighting",
    "intent": "Read the weight of optical glass through a moving caustic highlight on a grounded receiver.",
    "params": {
        "ior": {"type": "number", "default": 1.46, "min": 1.1, "max": 2, "doc": "Glass index of refraction."},
        "roughness": {"type": "number", "default": 0.015, "min": 0.01, "max": 0.25, "doc": "Polished glass roughness."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "ready",
    "needs_bake": False,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    mat = material("Caustics glass", (0.96, 0.985, 1, 1), 0, p["roughness"])
    group = mat.node_tree.nodes.get("Group").node_tree
    bsdf = next(n for n in group.nodes if n.type == "BSDF_PRINCIPLED")
    for link in list(group.links):
        if link.to_socket == bsdf.inputs["Roughness"]:
            group.links.remove(link)
    bsdf.inputs["Roughness"].default_value = p["roughness"]
    bsdf.inputs["Transmission Weight"].default_value = 1
    bsdf.inputs["IOR"].default_value = p["ior"]
    bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=24, location=(0, 0, 0.88), rotation=(math.pi / 2, 0, 0), major_radius=0.62, minor_radius=0.26)
    glass = bpy.context.object
    glass.name = "AVC Caustics glass"
    glass.data.materials.append(mat)
    for polygon in glass.data.polygons:
        polygon.use_smooth = True
    if hasattr(glass.cycles, "is_caustics_caster"):
        glass.cycles.is_caustics_caster = True
    from kit import light

    rig = light.mood("soft-product", size=2, target=(0, 0, 0.8), use_world=False, only=["key"], scale={"key": 4})
    key = next(iter(rig.lights))
    rig.light(key).data.size = 0.12
    rig.light(key).data.size_y = 0.12
    if hasattr(rig.light(key).data.cycles, "is_caustics_light"):
        rig.light(key).data.cycles.is_caustics_light = True
    for obj in scene.objects:
        if obj.get("avc_floor") and hasattr(obj.cycles, "is_caustics_receiver"):
            obj.cycles.is_caustics_receiver = True
    rig.sweep(key, -50, 40, at=3, frames=50, intent="glide").bake(tl)
    scene.cycles.caustics_refractive = True
    return finish([glass, *(rig.light(name) for name in rig.lights)], [mat], tl, owned)
