# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Describe a graceful orbit with a tapered ribbon that follows the hero and holds its arc.

Knobs: object, width, seed. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import math
from typing import Any

import bpy
from avc_recipes import validate_params
from kit import curves

from _common import (
    finish,
    material,
    timeline_for,
)

META = {
    "id": "ribbon-trail",
    "title": "Silk orbit trail",
    "category": "curves",
    "intent": "Describe a graceful orbit with a tapered ribbon that follows the hero and holds its arc.",
    "params": {
        "object": {"type": "string", "default": "", "doc": "Optional animated object to follow; empty creates a seeded orbit."},
        "width": {"type": "number", "default": 0.09, "min": 0.02, "max": 0.25, "doc": "Ribbon half width."},
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed variation seed."},
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
    mat = material("Ribbon trail", (0.4, 0.09, 0.03, 1), 0.90, 0.22)
    source = bpy.data.objects.get(p["object"]) if p["object"] else None
    if p["object"] and source is None:
        msg = "object must name an existing animated object"
        raise ValueError(msg)
    previous = scene.frame_current
    positions = []
    for frame in range(64):
        if source:
            scene.frame_set(frame + 1)
            positions.append(tuple(source.matrix_world.translation))
        else:
            t = frame / 63 * math.tau * 0.8
            positions.append((1.1 * math.cos(t), 0.55 * math.sin(t), 0.2 + frame / 63 * 1.8))
    scene.frame_set(previous)
    data = bpy.data.curves.new("AVC Ribbon trail", "CURVE")
    data.dimensions, data.bevel_depth, data.bevel_resolution = "3D", p["width"], 3
    data.resolution_u = 12
    profile = bpy.data.curves.new("AVC Ribbon cross section", "CURVE")
    profile.dimensions = "2D"
    section = profile.splines.new("POLY")
    section.points.add(3)
    for point, co in zip(section.points, ((-p["width"], -0.004, 0, 1), (p["width"], -0.004, 0, 1), (p["width"], 0.004, 0, 1), (-p["width"], 0.004, 0, 1)), strict=True):
        point.co = co
    section.use_cyclic_u = True
    profile_obj = bpy.data.objects.new(profile.name, profile)
    scene.collection.objects.link(profile_obj)
    profile_obj.hide_render = True
    data.bevel_mode = "OBJECT"
    data.bevel_object = profile_obj
    spline = data.splines.new("POLY")
    spline.points.add(63)
    for i, point in enumerate(spline.points):
        point.co = (*positions[i], 1)
        point.radius = 0.12 + 0.88 * (i / 63)
        point.tilt = 0.3 * math.sin(i / 16 + p["seed"])
    ribbon = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(ribbon)
    data.materials.append(mat)
    data.bevel_factor_mapping_end = "RESOLUTION"
    tl.add(data, "bevel_factor_end", (lambda f: curves.clamp01(f / 63)) if source else (lambda f: curves.progress(f, 2, 50, "glide")))
    return finish([ribbon, profile_obj], [mat], tl, owned)
