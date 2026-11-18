# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Show a continuous juice stream becoming a pool, with real baked fluid interaction.

Resolution 64 and mesh scale 2 are look defaults; use 32/1 for cheap layout proofs.
Increase resolution to 128-192 only after approving framing. No whitewater is faked.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params
from materials import liquid, material

from _fluid import apply_fluid

META = {
    "id": "liquid-pour",
    "title": "Baked juice pour",
    "category": "simulation",
    "intent": "Show a continuous juice stream becoming a pool, with real baked fluid interaction.",
    "params": {
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Emitter orientation seed."},
        "resolution": {"type": "integer", "default": 64, "min": 24, "max": 192, "doc": "Domain longest-axis voxels; 32 for proof, 128-192 for final."},
        "mesh_scale": {"type": "integer", "default": 2, "min": 1, "max": 3, "doc": "Surface upsampling factor."},
        "simulation_frames": {"type": "integer", "default": 40, "min": 20, "max": 96, "doc": "Fixed bake range independent of requested render range."},
        "freeze_ramp": {"type": "boolean", "default": False, "doc": "Pure frame remap through the cached impact."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "experimental",
    "needs_bake": True,
    "requires": {"extensions": [], "generators": ["mantaflow", "procedural-materials"]},
    "capabilities": ["fluids", "liquids"],
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add a cached Mantaflow pour, leaving unrelated scene objects untouched."""
    del timeline  # Baked snapshots own no animation channels.
    return apply_fluid(scene, validate_params(META, params), "pour", material(liquid()))
