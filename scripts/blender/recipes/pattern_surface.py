# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Rake light across a tessellated ceramic lattice so each repeated cell reads as crafted.

Tissue maps one rounded aperture cell to a curved quad carrier. The generated mesh
is made independent of its construction inputs; no extension handlers drive playback.
"""

from __future__ import annotations

import math
from typing import Any

from avc_recipes import validate_params
from materials import ceramic, material

from _common import finish, mesh, timeline_for

META = {
    "id": "pattern-surface",
    "title": "Tissue ceramic lattice",
    "category": "geometry",
    "intent": "Rake light across a tessellated ceramic lattice so each repeated cell reads as crafted.",
    "params": {
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Tissue random rotation seed."},
        "cells": {"type": "integer", "default": 10, "min": 3, "max": 32, "doc": "Quad cells per side."},
        "curve": {"type": "number", "default": 0.3, "min": 0, "max": 0.7, "doc": "Carrier bow depth in metres."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "experimental",
    "needs_bake": False,
    "requires": {"extensions": ["tissue"], "generators": ["procedural-materials"]},
    "capabilities": ["pattern", "tessellation"],
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Invoke the pinned Tissue operator on explicitly owned mesh inputs."""
    import bpy
    from avc_extensions import require

    require("tissue", "0.3.76")
    p = validate_params(META, params)
    n = p["cells"]
    vertices = [(3 * i / n - 1.5, p["curve"] * math.sin(math.pi * i / n), 0.035 + 3 * j / n) for j in range(n + 1) for i in range(n + 1)]
    faces = [(j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i) for j in range(n) for i in range(n)]
    carrier = mesh("Pattern carrier", vertices, faces)
    outer = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
    inner = [(0.18, 0.18, 0.12), (0.82, 0.18, 0.12), (0.82, 0.82, 0.12), (0.18, 0.82, 0.12)]
    cell = mesh("Pattern cell", outer + inner, [(i, (i + 1) % 4, (i + 1) % 4 + 4, i + 4) for i in range(4)])
    bpy.ops.object.select_all(action="DESELECT")
    carrier.select_set(state=True)
    cell.select_set(state=True)
    bpy.context.view_layer.objects.active = carrier
    result = bpy.ops.object.tissue_tessellate(generator=carrier.name, component=cell.name, mode="BOUNDS", fill_mode="QUAD", rotation_mode="RANDOM", rand_seed=p["seed"], merge=True)
    if result != {"FINISHED"}:
        msg = "Tissue tessellation failed"
        raise RuntimeError(msg)
    obj = bpy.context.object
    if obj in {carrier, cell} or not len(obj.data.polygons):
        msg = "Tissue did not create a tessellated mesh"
        raise RuntimeError(msg)
    obj.name = "AVC Ceramic lattice"
    obj.tissue.tissue_type = "NONE"
    mat = material(ceramic())
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    solid = obj.modifiers.new("AVC Ceramic wall", "SOLIDIFY")
    solid.thickness = 0.035
    bevel = obj.modifiers.new("AVC Fired edges", "BEVEL")
    bevel.width, bevel.segments = 0.018, 3
    for source in (carrier, cell):
        bpy.data.objects.remove(source, do_unlink=True)
    tl, owned = timeline_for(scene, timeline)
    tl.add(obj, "rotation_euler", lambda f: (0, 0, 0.08 * math.sin(f / 64 * math.pi)))
    return finish([obj], [mat], tl, owned)
