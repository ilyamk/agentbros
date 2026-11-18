# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Ground a real-place reveal in cached OpenStreetMap footprints and tagged building heights.

Fetch once with blender:city; renders are offline. Relations and SRTM are deliberately unsupported.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params

from _city import cached_geometry, footprints, osm_geometry, source_area, stored_material
from _common import finish, timeline_for

META = {
    "id": "osm-city",
    "title": "Cached real-place buildings",
    "category": "geometry",
    "intent": "Ground a real-place reveal in cached OpenStreetMap footprints and tagged building heights.",
    "params": {
        "lat": {"type": "number", "default": 40.709, "min": -85, "max": 85, "doc": "Centre latitude, degrees."},
        "lon": {"type": "number", "default": -74.01, "min": -180, "max": 180, "doc": "Centre longitude, degrees."},
        "radius": {"type": "integer", "default": 250, "min": 50, "max": 1500, "doc": "Consented cached OSM query radius, metres."},
        "seed": {"type": "integer", "default": 31, "min": 0, "max": 2147483647, "doc": "Reserved stable material variation seed."},
        "material_asset": {"type": "string", "default": "", "doc": "Optional indexed local facade material id."},
    },
    "frames_hint": 96,
    "cost_hint": {"cycles": None, "eevee": None},
    "needs_bake": True,
    "requires": {"extensions": [], "generators": ["osm-footprints"]},
    "inspired_by": ["https://www.openstreetmap.org/copyright"],
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Preserve geographical outlines, tags and attribution in an appendable local .blend."""
    p = validate_params(META, params)
    source, digest = source_area(p["lat"], p["lon"], p["radius"])
    buildings = footprints(source, p["lat"], p["lon"])
    if not buildings:
        msg = "No usable closed OSM ways; multipolygon relations are not supported"
        raise ValueError(msg)
    geometry = {k: p[k] for k in ("lat", "lon", "radius", "seed")}
    objects, cached = cached_geometry("osm-city", geometry, lambda: osm_geometry(buildings), {"sourceSha256": digest})
    stored_material(objects, p["material_asset"])
    tl, owned = timeline_for(scene, timeline)
    result = finish(objects, list(objects[0].data.materials), tl, owned)
    result["bake"] = cached
    return result
