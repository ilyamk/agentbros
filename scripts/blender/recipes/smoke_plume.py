# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Reveal a rising smoke column through grazing light, retaining soft turbulent density.

Mantaflow mode bakes VDB density once. Grid mode evaluates a seeded volume field
at the requested frame, without a stateful simulation zone or unbaked solver.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params

from _fluid import apply_fluid

META = {
    "id": "smoke-plume",
    "title": "Baked smoke plume",
    "category": "volume",
    "intent": "Reveal a rising smoke column through grazing light, retaining soft turbulent density.",
    "params": {
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed emitter/noise variation."},
        "resolution": {"type": "integer", "default": 64, "min": 24, "max": 192, "doc": "Longest-axis voxel resolution."},
        "simulation_frames": {"type": "integer", "default": 40, "min": 20, "max": 96, "doc": "Fixed simulation range."},
        "method": {"type": "string", "default": "mantaflow", "doc": "mantaflow (cached VDB) or grid (frame-driven density field)."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "experimental",
    "needs_bake": True,
    "requires": {"extensions": [], "generators": ["mantaflow", "volume-grids"]},
    "capabilities": ["volumes", "smoke"],
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add physical cached density or the explicit low-cost grid alternative."""
    import bpy

    p = validate_params(META, params)
    if p["method"] not in {"mantaflow", "grid"}:
        msg = "method must be mantaflow or grid"
        raise ValueError(msg)
    if p["method"] == "grid":
        from _volume import grid_plume

        return grid_plume(scene, p, timeline)
    mat = bpy.data.materials.new("AVC Smoke scattering")
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    volume = mat.node_tree.nodes.new("ShaderNodeVolumePrincipled")
    volume.inputs["Color"].default_value = (0.57, 0.62, 0.68, 1)
    volume.inputs["Density"].default_value = 1.3
    volume.inputs["Anisotropy"].default_value = 0.25
    output = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(volume.outputs["Volume"], output.inputs["Volume"])
    return apply_fluid(scene, p, "smoke", mat)
