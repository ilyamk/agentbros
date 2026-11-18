# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Catch a jewel-like liquid crown at its peak before it relaxes into a pool.

Knobs: radius, height, seed. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import math
import random
from typing import Any

from avc_recipes import validate_params
from kit import curves

from _common import (
    animate_mesh,
    finish,
    material,
    mesh,
    orb,
    timeline_for,
)

META = {
    "id": "liquid-splash",
    "title": "Sculpted crown splash",
    "category": "geometry",
    "intent": "Catch a jewel-like liquid crown at its peak before it relaxes into a pool.",
    "params": {
        "radius": {"type": "number", "default": 0.95, "min": 0.3, "max": 1.5, "doc": "Crown radius in metres."},
        "height": {"type": "number", "default": 0.85, "min": 0.3, "max": 2, "doc": "Peak crown height."},
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed variation seed."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "experimental",
    "needs_bake": False,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    mat = material("Liquid splash", (0.12, 0.48, 0.55, 1), 0, 0.045)
    group = mat.node_tree.nodes.get("Group").node_tree
    bsdf = next(n for n in group.nodes if n.type == "BSDF_PRINCIPLED")
    for link in list(group.links):
        if link.to_socket == bsdf.inputs["Roughness"]:
            group.links.remove(link)
    bsdf.inputs["Roughness"].default_value = 0.045
    bsdf.inputs["Metallic"].default_value = 0
    bsdf.inputs["Transmission Weight"].default_value = 1
    bsdf.inputs["IOR"].default_value = 1.333
    rng = random.Random(p["seed"])
    phase = rng.uniform(0, math.tau)
    count, rings = 96, 9

    def vertices(f: float) -> list[tuple[float, ...]]:
        rise = curves.progress(f, 3, 19, "punch")
        fall = 1 - curves.progress(f, 23, 34, "glide")
        amp = rise * fall
        result: list[tuple[float, ...]] = [(0, 0, 0.008)]
        for j in range(1, rings):
            r = j / (rings - 1)
            for i in range(count):
                angle = math.tau * i / count
                radius = p["radius"] * r * (0.8 + 0.2 * rise) * (1 + 0.035 * r**3 * math.sin(5 * angle + phase))
                fingers = 0.68 + 0.22 * math.cos(angle * 11 + phase) + 0.10 * math.cos(angle * 7 + 1.7 * phase)
                z = 0.008 + amp * p["height"] * (r**4) * fingers + 0.012 * math.sin(r * math.pi) * rise * (0.3 + 0.7 * amp)
                result.append((radius * math.cos(angle), radius * math.sin(angle), z))
        return result

    faces: list[tuple[int, ...]] = [(0, 1 + i, 1 + (i + 1) % count) for i in range(count)]
    faces += [(1 + j * count + i, 1 + (j + 1) * count + i, 1 + (j + 1) * count + (i + 1) % count, 1 + j * count + (i + 1) % count) for j in range(rings - 2) for i in range(count)]
    crown = mesh("Liquid splash", vertices(0), faces, mat)
    animate_mesh(crown, [vertices(f) for f in range(64)])
    solid = crown.modifiers.new("Surface tension", "SOLIDIFY")
    solid.thickness = 0.008
    for polygon in crown.data.polygons:
        polygon.use_smooth = True
    drops = []
    for i in range(11):
        angle = (math.tau * i - phase) / 11
        drop = orb(f"Crown droplet {i}", radius=rng.uniform(0.025, 0.045), mat=mat)
        tl.add(
            drop,
            "location",
            lambda f, a=angle: (
                (p["radius"] + 0.5 * curves.progress(f, 14, 28, "glide")) * math.cos(a),
                (p["radius"] + 0.5 * curves.progress(f, 14, 28, "glide")) * math.sin(a),
                0.06 + p["height"] * math.sin(math.pi * curves.progress(f, 9, 42, "glide")),
            ),
        )
        tl.add(drop, "scale", lambda f: max(0.001, curves.progress(f, 12, 6, "brake") * (1 - curves.progress(f, 43, 12, "glide"))))
        drops.append(drop)
    return finish([crown, *drops], [mat], tl, owned)
