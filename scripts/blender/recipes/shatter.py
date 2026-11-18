# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Break a monolith into real Voronoi facets on a decisive impact beat.

Knobs: pieces, distance, seed. Costs and readiness are recorded in AGENTS.md after proof measurement.
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
    mesh,
    timeline_for,
    voronoi_cells,
)

META = {
    "id": "shatter",
    "title": "Architectural fracture",
    "category": "geometry",
    "intent": "Break a monolith into real Voronoi facets on a decisive impact beat.",
    "params": {
        "pieces": {"type": "integer", "default": 24, "min": 4, "max": 64, "doc": "Number of convex Voronoi cells."},
        "distance": {"type": "number", "default": 0.8, "min": 0.1, "max": 2, "doc": "Explode distance in metres."},
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed variation seed."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": 0.823, "eevee": None},
    "status": "experimental",
    "needs_bake": False,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    mat = material("Shatter", (0.025, 0.055, 0.065, 1), 0.72, 0.3)
    interior = material("Fresh fracture", (0.32, 0.105, 0.035, 1), 0.45, 0.38)
    root = bpy.data.objects.new("AVC Fracture root", None)
    scene.collection.objects.link(root)
    tl.add(
        root,
        "scale",
        lambda f: (1 + 0.025 * (curves.progress(f, 6, 5, "glide") - curves.progress(f, 11, 4, "brake")),) * 2 + (1 - 0.05 * (curves.progress(f, 6, 5, "glide") - curves.progress(f, 11, 4, "brake")),),
    )
    objects = [root]
    rng = random.Random(p["seed"])
    for i, (vertices, faces, site) in enumerate(voronoi_cells(p["seed"], p["pieces"])):
        centre = tuple(sum(v[k] for v in vertices) / len(vertices) for k in range(3))
        piece = mesh(f"Shatter {i:02}", [tuple(v[k] - centre[k] for k in range(3)) for v in vertices], faces, mat)
        piece.parent = root
        piece.data.materials.append(interior)
        for polygon, face in zip(piece.data.polygons, faces, strict=True):
            boundary = any(all(abs(vertices[index][axis] - bound) < 1e-5 for index in face) for axis, bounds in enumerate(((-0.8, 0.8), (-0.8, 0.8), (0, 1.6))) for bound in bounds)
            polygon.material_index = 0 if boundary else 1
        bevel = piece.modifiers.new("Cut glint", "BEVEL")
        bevel.width, bevel.segments = 0.008, 2
        delta = (site[0] * p["distance"] * 1.5, site[1] * p["distance"] * 1.5, 0.45 + rng.random() * 0.35)
        spin = tuple(rng.uniform(-0.5, 0.5) for _ in range(3))
        floor_centre = -min(v[2] - centre[2] for v in vertices) + 0.01

        def location(f: float, c: tuple[float, ...] = centre, d: tuple[float, ...] = delta, floor: float = floor_centre) -> tuple[float, ...]:
            u = curves.progress(f, 12, 39, "glide")
            return (c[0] + d[0] * curves.progress(f, 12, 28, "brake"), c[1] + d[1] * curves.progress(f, 12, 28, "brake"), c[2] * (1 - u) + floor * u + d[2] * math.sin(math.pi * u))

        tl.add(piece, "location", location)
        tl.add(
            piece,
            "rotation_euler",
            lambda f, spin=spin: (
                spin[0] * math.sin(math.pi * curves.progress(f, 12, 39, "glide")),
                spin[1] * math.sin(math.pi * curves.progress(f, 12, 39, "glide")),
                spin[2] * curves.progress(f, 12, 36, "brake"),
            ),
        )
        objects.append(piece)
    return finish(objects, [mat, interior], tl, owned)
