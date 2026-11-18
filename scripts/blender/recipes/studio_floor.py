# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Give a hero weight through an infinite cyclorama and a soft contact shadow.

Knobs: colour, shadow_catcher. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params

from _common import (
    finish,
    timeline_for,
)

META = {
    "id": "studio-floor",
    "title": "Grounded studio",
    "category": "stage",
    "intent": "Give a hero weight through an infinite cyclorama and a soft contact shadow.",
    "params": {
        "colour": {"type": "string", "default": "#202930", "doc": "Cyclorama colour as #RRGGBB."},
        "shadow_catcher": {"type": "boolean", "default": False, "doc": "Transparent Cycles contact receiver; false keeps the cyclorama visible."},
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
    if len(p["colour"]) != 7 or not p["colour"].startswith("#"):
        msg = "colour must be #RRGGBB"
        raise ValueError(msg)
    int(p["colour"][1:], 16)
    from kit import stage

    floor = stage.sweep(p["colour"], size=2, width=12, depth=7, curve_radius=3, name="AVC Studio floor")
    floor["avc_floor"] = True
    floor.is_shadow_catcher = p["shadow_catcher"]
    return finish([floor], list(floor.data.materials), tl, owned)
