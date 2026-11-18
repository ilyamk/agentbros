# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Lift a juice crown around a product silhouette and catch its backlit impact.

A toroidal charge rises around a cylindrical collision proxy. Fixed baked topology
snapshots make seeks repeatable; freeze_ramp is a held-frame editorial treatment.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params
from materials import liquid, material

from _fluid import apply_fluid

META = {
    "id": "product-splash",
    "title": "Baked product splash",
    "category": "simulation",
    "intent": "Lift a juice crown around a product silhouette and catch its backlit impact.",
    "params": {
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Emitter orientation seed."},
        "resolution": {"type": "integer", "default": 64, "min": 24, "max": 192, "doc": "Domain longest-axis voxels; 32 for proof, 128-192 for final."},
        "mesh_scale": {"type": "integer", "default": 2, "min": 1, "max": 3, "doc": "Surface upsampling factor."},
        "simulation_frames": {"type": "integer", "default": 40, "min": 20, "max": 96, "doc": "Fixed bake range independent of requested render range."},
        "freeze_ramp": {"type": "boolean", "default": True, "doc": "Hold the impact through a continuous pure frame remap."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "experimental",
    "needs_bake": True,
    "requires": {"extensions": [], "generators": ["mantaflow", "procedural-materials"]},
    "capabilities": ["fluids", "liquids"],
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add cached liquid snapshots; the caller owns the visible product and lighting."""
    del timeline  # Baked snapshots own no animation channels.
    return apply_fluid(scene, validate_params(META, params), "splash", material(liquid()))
