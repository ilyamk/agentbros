# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Establish a lived-in skyline with a street grid and a taller landmark that holds the reveal.

Always available Geometry Nodes fallback. Cached static geometry, frame-driven office lights.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params

from _city import cached_geometry, native_geometry, stored_material
from _common import finish, timeline_for
from window_lights import animate

META = {
    "id": "procedural-city",
    "title": "Seeded city skyline",
    "category": "geometry",
    "intent": "Establish a lived-in skyline with a street grid and a taller landmark that holds the reveal.",
    "params": {
        "seed": {"type": "integer", "default": 31, "min": 0, "max": 2147483647, "doc": "Fixed city seed."},
        "blocks": {"type": "integer", "default": 5, "min": 1, "max": 9, "doc": "Street blocks along each side."},
        "spacing": {"type": "number", "default": 58, "min": 48, "max": 90, "doc": "Street grid spacing, metres."},
        "hero_height": {"type": "number", "default": 148, "min": 40, "max": 260, "doc": "Central landmark height, metres."},
        "night": {"type": "boolean", "default": True, "doc": "Enable the deterministic office switch-on pattern."},
        "material_asset": {"type": "string", "default": "", "doc": "Optional indexed local material id for facades."},
    },
    "frames_hint": 96,
    "cost_hint": {"cycles": None, "eevee": None},
    "needs_bake": True,
    "requires": {"extensions": [], "generators": ["native-city"]},
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Append a cached skyline without changing the camera, lights or other objects."""
    p = validate_params(META, params)
    geometry = {k: p[k] for k in ("seed", "blocks", "spacing", "hero_height")}
    objects, cached = cached_geometry("procedural-city", geometry, lambda: native_geometry(p))
    stored_material(objects, p["material_asset"])
    tl, owned = timeline_for(scene, timeline)
    for obj in objects:
        if obj.get("avc_city_windows"):
            animate(obj, {"start": 8, "duration": 60, "strength": 2.8 if p["night"] else 0}, tl)
    materials = list({mat for obj in objects if obj.type == "MESH" for mat in obj.data.materials})
    result = finish(objects, materials, tl, owned)
    result["bake"] = cached
    return result
