# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Land a short title as sculpted metal letters with a readable stagger and a grounded final pose.

Knobs: text, font, stagger. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import bpy
from avc_recipes import validate_params
from kit import curves, stage

from _common import (
    finish,
    material,
    timeline_for,
)

META = {
    "id": "text-3d",
    "title": "Typeset arrival",
    "category": "typography",
    "intent": "Land a short title as sculpted metal letters with a readable stagger and a grounded final pose.",
    "params": {
        "text": {"type": "string", "default": "FORM", "doc": "Short title, maximum 24 characters."},
        "font": {"type": "string", "default": "", "doc": "Optional local font file; empty uses Blender bundled Bfont."},
        "stagger": {"type": "integer", "default": 4, "min": 0, "max": 10, "doc": "Frames between letters."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": 0.863, "eevee": None},
    "status": "ready",
    "needs_bake": False,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    if not p["text"].strip() or len(p["text"]) > 24:
        msg = "text must contain 1 to 24 characters"
        raise ValueError(msg)
    font = None
    if p["font"]:
        if not Path(p["font"]).is_file():
            msg = "font must be an existing local font file"
            raise ValueError(msg)
        font = bpy.data.fonts.load(p["font"], check_existing=True)
    mat = material("Text 3D", (0.38, 0.22, 0.075, 1), 0.85, 0.28)
    objects = []
    advance = min(0.65, 3.6 / len(p["text"]))
    for i, character in enumerate(p["text"]):
        if character.isspace():
            continue
        data = bpy.data.curves.new(f"AVC Letter {i}", "FONT")
        data.body, data.align_x = character, "CENTER"
        data.size, data.extrude, data.bevel_depth, data.bevel_resolution = advance * 1.4, 0.075, 0.012, 3
        if font:
            data.font = font
        letter = bpy.data.objects.new(data.name, data)
        scene.collection.objects.link(letter)
        data.materials.append(mat)
        letter.rotation_euler = (math.pi / 2, 0, 0)
        stage.rest_on(letter, [letter], floor_z=0.001)
        ground_z = letter.location.z
        x = (i - (len(p["text"]) - 1) / 2) * advance
        start = 3 + i * p["stagger"]
        tl.add(
            letter,
            "location",
            lambda f, x=x, start=start, z=ground_z: (x, 0, z + 1.1 * (1 - curves.progress(f, start, 20, "expoIn")) + max(0, curves.follow_through(f, start + 20, 0.07, damping=11, frequency=3.0))),
        )
        tl.add(letter, "rotation_euler", lambda f, start=start: (math.pi / 2, 0, -0.14 * (1 - curves.progress(f, start, 30, "glide"))))
        objects.append(letter)
    return finish(objects, [mat], tl, owned)
