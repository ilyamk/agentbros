# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Trace a luminous signature in space and leave a confident glowing hold.

Knobs: radius, tube, emission. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import math
from typing import Any

import bpy
from avc_recipes import validate_params
from kit import curves

from _common import (
    bloom,
    finish,
    material,
    timeline_for,
)

META = {
    "id": "neon-glow",
    "title": "Drawn neon",
    "category": "curves",
    "intent": "Trace a luminous signature in space and leave a confident glowing hold.",
    "params": {
        "radius": {"type": "number", "default": 1.05, "min": 0.3, "max": 1.6, "doc": "Loop radius."},
        "tube": {"type": "number", "default": 0.025, "min": 0.005, "max": 0.08, "doc": "Neon tube radius."},
        "emission": {"type": "number", "default": 8, "min": 1, "max": 12, "doc": "Emission strength."},
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
    mat = material("Neon glow", (0.025, 0.65, 0.45, 1), 0.15, 0.2, p["emission"])
    data = bpy.data.curves.new("AVC Neon glow", "CURVE")
    data.dimensions, data.bevel_depth, data.bevel_resolution = "3D", p["tube"], 4
    spline = data.splines.new("POLY")
    spline.points.add(159)
    for i, point in enumerate(spline.points):
        t = i / 159 * math.tau
        point.co = (p["radius"] * math.cos(t), 0.14 * math.sin(3 * t), p["radius"] + p["tube"] + 0.13 + p["radius"] * math.sin(t), 1)
    neon = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(neon)
    data.materials.append(mat)
    data.use_fill_caps = True
    tl.add(data, "bevel_factor_end", lambda f: curves.progress(f, 4, 36, "glide"))
    bloom(scene, "Neon bloom", 0.12)
    return finish([neon], [mat], tl, owned)
