# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Reveal life across a facade as seeded office windows come on before the camera settles.

A pure frame function, keyed with shutter guards. No random calls in frame handlers.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params

from _city import box_data, window_mesh
from _common import finish, material, mesh, timeline_for

META = {
    "id": "window-lights",
    "title": "Office lights at dusk",
    "category": "lighting",
    "intent": "Reveal life across a facade as seeded office windows come on before the camera settles.",
    "params": {
        "object": {"type": "string", "default": "", "doc": "City pane mesh; empty creates a proof facade."},
        "seed": {"type": "integer", "default": 31, "min": 0, "max": 2147483647, "doc": "Stable window occupancy seed."},
        "start": {"type": "number", "default": 8, "min": 0, "max": 240, "doc": "First lights, in block frames."},
        "duration": {"type": "number", "default": 38, "min": 1, "max": 240, "doc": "Spread of the switch-on times."},
        "strength": {"type": "number", "default": 2.8, "min": 0, "max": 12, "doc": "Final warm/cool emission strength."},
    },
    "frames_hint": 96,
    "cost_hint": {"cycles": None, "eevee": None},
    "needs_bake": False,
    "requires": {"extensions": [], "generators": ["native-city"]},
}


def illumination(frame: float, bank: int, start: float, duration: float, strength: float) -> float:
    """Smooth two-frame switch per bank; dark unoccupied panes remain dark."""
    if bank >= 12:
        return 0.0
    u = max(0.0, min(1.0, (frame - start - duration * bank / 12) / 2))
    return strength * u * u * (3 - 2 * u)


def animate(obj: Any, p: dict[str, Any], timeline: Any) -> None:
    """Resolve actual material groups, including cache-appended names with numeric suffixes."""
    for mat in obj.data.materials:
        if "avc_window_bank" not in mat:
            continue
        bank = int(mat["avc_window_bank"])
        if bank < 12:
            bank = (bank + int(p.get("seed", 0))) % 12
        group = next(n.node_tree for n in mat.node_tree.nodes if n.type == "GROUP")
        shader = next(n for n in group.nodes if n.type == "BSDF_PRINCIPLED")
        timeline.add(shader.inputs["Emission Strength"], "default_value", lambda frame, b=bank: illumination(frame, b, p["start"], p["duration"], p["strength"]), combine="set")


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Animate a city window mesh or create a compact standalone proof facade."""
    import bpy

    p = validate_params(META, params)
    backing = None
    if p["object"]:
        obj = bpy.data.objects.get(p["object"])
        if obj is None or obj.type != "MESH" or not obj.get("avc_city_windows"):
            msg = "object must name an AVC city pane mesh"
            raise ValueError(msg)
    else:
        obj = window_mesh([{"x": 0, "y": 0, "w": 18, "d": 9, "h": 22}], p["seed"])
        vertices, faces = [], []
        box_data(vertices, faces, (0, 0, 11), (18, 9, 22))
        for z in (0.2, 3.4, 6.8, 10.2, 13.6, 17, 20.4, 22):
            box_data(vertices, faces, (0, 0, z), (18.2, 9.2, 0.18))
        backing = mesh("Office facade backing", vertices, faces, material("Office facade", (0.06, 0.1, 0.14, 1), 0.5, 0.32))
    tl, owned = timeline_for(scene, timeline)
    animate(obj, p, tl)
    objects = [obj, backing] if backing else [obj]
    materials = list(obj.data.materials) + (list(backing.data.materials) if backing else [])
    return finish(objects, materials, tl, owned)
