# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Reveal a form from the ground with a clean leading edge and a settling overshoot.

Knobs: object, duration, axis. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

from typing import Any

import bpy
from avc_recipes import validate_params
from kit import curves

from _common import (
    finish,
    material,
    target,
    timeline_for,
)

META = {
    "id": "grow-in",
    "title": "Sculpted reveal",
    "category": "geometry",
    "intent": "Reveal a form from the ground with a clean leading edge and a settling overshoot.",
    "params": {
        "object": {"type": "string", "default": "", "doc": "Optional existing mesh name; empty creates a grounded proof subject."},
        "duration": {"type": "integer", "default": 42, "min": 8, "max": 100, "doc": "Reveal duration in frames."},
        "axis": {"type": "string", "default": "Z", "doc": "Reveal axis: X, Y or Z."},
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
    if p["axis"] not in ("X", "Y", "Z"):
        msg = "axis must be X, Y or Z"
        raise ValueError(msg)
    source = target(p, "Grow in")
    if not p["object"]:
        source.data.materials[0] = material("Grow in", (0.035, 0.13, 0.19, 1), 0.65, 0.28)
    axis = "XYZ".index(p["axis"])
    lower = min(v.co[axis] for v in source.data.vertices) - 0.01
    upper = max(v.co[axis] for v in source.data.vertices) + 0.01
    bounds = [(min(v.co[k] for v in source.data.vertices), max(v.co[k] for v in source.data.vertices)) for k in range(3)]
    dimensions = [hi - lo + 2 for lo, hi in bounds]
    centre = [(lo + hi) / 2 for lo, hi in bounds]
    bpy.ops.mesh.primitive_cube_add(size=1)
    cutter = bpy.context.object
    cutter.name = "AVC Grow in cutter"
    cutter.parent = source
    cutter.dimensions = dimensions
    cutter.hide_render = True
    mod = source.modifiers.new("AVC Capped reveal", "BOOLEAN")
    mod.operation, mod.solver, mod.object = "DIFFERENCE", "EXACT", cutter
    source.cycles.use_deform_motion = False

    def cut_location(f: float) -> tuple[float, ...]:
        point = list(centre)
        point[axis] = lower + (upper - lower) * curves.progress(f, 5, p["duration"], "glide") + dimensions[axis] / 2
        return tuple(point)

    tl.add(cutter, "location", cut_location)
    base = tuple(source.scale)
    tl.add(source, "scale", lambda f: tuple(v * (1 + (0.025 if i < 2 else 0) * curves.follow_through(f, p["duration"] + 5, amplitude=1, damping=8, frequency=2.4)) for i, v in enumerate(base)))
    return finish([cutter] if p["object"] else [source, cutter], [], tl, owned)
