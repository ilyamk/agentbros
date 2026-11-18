# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Separate a woodland silhouette with a physical sky, low sun and bounded atmospheric haze.

Seeded nature wrapper; see docs/blender-arsenal/nature.md for evaluated scope.
"""

from __future__ import annotations

from typing import Any

import bpy
from avc_recipes import validate_params

from _common import finish, timeline_for

META = {
    "id": "sky-atmosphere",
    "title": "Sunlit air",
    "category": "lighting",
    "intent": "Separate a woodland silhouette with a physical sky, low sun and bounded atmospheric haze.",
    "params": {
        "preset": {"type": "string", "default": "golden-hour", "doc": "golden-hour, midday or blue-hour."},
        "haze": {"type": "number", "default": 0.008, "doc": "Bounded volume density; zero disables haze.", "min": 0, "max": 0.06},
        "seed": {"type": "integer", "default": 41, "doc": "Fixed variation seed.", "min": 0, "max": 2147483647},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "needs_bake": False,
    "requires": {"extensions": [], "generators": []},
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Use Blender's physical multiple-scattering sky and a local, bounded volume."""
    import math

    p = validate_params(META, params)
    presets = {"golden-hour": (8, 2.2, 0.18), "midday": (55, 3, 0.3), "blue-hour": (-4, 0.05, 0.08)}
    if p["preset"] not in presets:
        msg = "Unknown time-of-day preset"
        raise ValueError(msg)
    elevation, energy, strength = presets[p["preset"]]
    tl, owned = timeline_for(scene, timeline)
    world = bpy.data.worlds.new("AVC Physical sky")
    world.use_nodes = True
    scene.world = world
    nodes, links = world.node_tree.nodes, world.node_tree.links
    sky = nodes.new("ShaderNodeTexSky")
    # 5.x renamed Nishita to Multiple Scattering; retain the 4.x spelling for older builds.
    choices = {item.identifier for item in sky.bl_rna.properties["sky_type"].enum_items}
    sky.sky_type = "MULTIPLE_SCATTERING" if "MULTIPLE_SCATTERING" in choices else "NISHITA"
    sky.sun_elevation = math.radians(elevation)
    sky.sun_rotation = math.radians(135)
    sky.sun_disc = False
    sky.air_density = 1
    if hasattr(sky, "aerosol_density"):
        sky.aerosol_density = 2.5
    elif hasattr(sky, "dust_density"):
        sky.dust_density = 2.5
    links.new(sky.outputs[0], nodes.get("Background").inputs["Color"])
    nodes.get("Background").inputs["Strength"].default_value = strength
    data = bpy.data.lights.new("AVC Low sun", "SUN")
    data.energy, data.angle = energy, math.radians(3)
    data.color = (1, 0.73, 0.42) if p["preset"] == "golden-hour" else (0.8, 0.88, 1)
    sun = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(90 - elevation), 0, math.radians(-135))
    objects, mats = [sun], []
    if p["haze"]:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 4, 3))
        volume = bpy.context.object
        volume.name = "AVC Bounded haze"
        volume.scale = (18, 18, 8)
        mat = bpy.data.materials.new("AVC Atmospheric haze")
        mat.use_nodes = True
        n = mat.node_tree.nodes
        n.clear()
        scatter = n.new("ShaderNodeVolumeScatter")
        scatter.inputs["Density"].default_value = p["haze"]
        scatter.inputs["Anisotropy"].default_value = 0.35
        out = n.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(scatter.outputs[0], out.inputs["Volume"])
        volume.data.materials.append(mat)
        objects.append(volume)
        mats.append(mat)
    return finish(objects, mats, tl, owned)
