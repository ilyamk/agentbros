# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Lead the eye through an open clearing with clustered grasses, tiny flowers and weathered stones.

Seeded nature wrapper; see docs/blender-arsenal/nature.md for evaluated scope.
"""

from __future__ import annotations

from typing import Any

import bpy
from avc_recipes import validate_params

from _common import bake, finish, material, mesh, timeline_for

META = {
    "id": "vegetation-scatter",
    "title": "Masked clearing vegetation",
    "category": "geometry",
    "intent": "Lead the eye through an open clearing with clustered grasses, tiny flowers and weathered stones.",
    "params": {
        "count": {"type": "integer", "default": 240, "doc": "Candidate clump count before density and camera masks.", "min": 1, "max": 2000},
        "radius": {"type": "number", "default": 4, "doc": "Planting radius in metres.", "min": 0.3, "max": 30},
        "clearing": {"type": "number", "default": 0.7, "doc": "Unplanted central radius.", "min": 0, "max": 10},
        "view_degrees": {"type": "number", "default": 360, "doc": "Conservative +Y camera cone; keep 360 for moving cameras.", "min": 30, "max": 360},
        "relief": {"type": "number", "default": 0.3, "doc": "Must match terrain relief and seed.", "min": 0, "max": 4},
        "wind": {"type": "number", "default": 0.025, "doc": "Grass sway amplitude.", "min": 0, "max": 0.15},
        "seed": {"type": "integer", "default": 41, "doc": "Fixed variation seed.", "min": 0, "max": 2147483647},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "needs_bake": True,
    "requires": {"extensions": [], "generators": []},
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Reuse clump meshes, mask the clearing, and key sway without a particle simulation."""
    import math
    import random

    from _nature import foliage_material, height_at, placements

    p = validate_params(META, params)
    if p["clearing"] >= p["radius"]:
        msg = "clearing must be smaller than radius"
        raise ValueError(msg)
    tl, owned = timeline_for(scene, timeline)
    rng = random.Random(p["seed"])
    green = foliage_material("Meadow grass", (0.095, 0.17, 0.021, 1))
    flower = material("Ivory petals", (0.8, 0.69, 0.35, 1), 0, 0.7)
    stone = material("Weathered pebbles", (0.14, 0.12, 0.085, 1), 0, 0.88)
    vertices, faces = [], []
    for _ in range(22):
        angle, length = rng.uniform(0, math.tau), rng.uniform(0.12, 0.36)
        dx, dy = math.cos(angle), math.sin(angle)
        base = len(vertices)
        for step in range(5):
            t = step / 4
            width = 0.004 * (1 - t) + 0.00015
            bend = length * 0.48 * t * t
            centre = (dx * bend, dy * bend, length * (t - 0.2 * t * t))
            vertices.extend([(centre[0] - dy * width, centre[1] + dx * width, centre[2]), (centre[0] + dy * width, centre[1] - dx * width, centre[2])])
            if step:
                offset = base + step * 2
                faces.append((offset - 2, offset - 1, offset + 1, offset))
    prototype = mesh("Grass clump prototype", vertices, faces, green)
    prototype.hide_render = True
    prototype.hide_set(state=True)
    objects = [prototype]
    cached = bake(
        "vegetation-scatter", {k: p[k] for k in ("seed", "count", "radius", "clearing", "view_degrees")}, lambda: placements(p["seed"], p["count"], p["radius"], p["clearing"], p["view_degrees"])
    )
    for i, (x, y, scale, angle) in enumerate(cached["data"]):
        obj = bpy.data.objects.new("AVC Grass", prototype.data)
        scene.collection.objects.link(obj)
        obj.location = (x, y, height_at(x, y, p["seed"], p["relief"]))
        obj.scale = (scale,) * 3
        tl.add(obj, "rotation_euler", lambda f, angle=angle, i=i: (p["wind"] * math.sin(f / 30 * 2 + i), 0, angle))
        objects.append(obj)
        if i % 9 == 0:
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.08, location=(x + 0.05, y, height_at(x, y, p["seed"], p["relief"]) + 0.035))
            pebble = bpy.context.object
            pebble.scale = (1.3, 0.8, 0.5)
            pebble.data.materials.append(stone)
            objects.append(pebble)
        if i % 7 == 0:
            # Small seed heads catch light above the clump.
            bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=4, radius=0.025, location=(x, y, height_at(x, y, p["seed"], p["relief"]) + 0.28 * scale))
            head = bpy.context.object
            head.scale = (1, 1, 0.35)
            head.data.materials.append(flower)
            objects.append(head)
    return finish(objects, [green, flower, stone], tl, owned, cached)
