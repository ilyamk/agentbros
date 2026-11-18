# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Release a restrained fan of foil confetti that tumbles down into the landing beat.

Knobs: count, spread, seed. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import math
import random
from typing import Any

from avc_recipes import validate_params
from kit import curves

from _common import (
    finish,
    material,
    mesh,
    timeline_for,
)

META = {
    "id": "confetti",
    "title": "Celebration cascade",
    "category": "particles",
    "intent": "Release a restrained fan of foil confetti that tumbles down into the landing beat.",
    "params": {
        "count": {"type": "integer", "default": 100, "min": 12, "max": 240, "doc": "Foil pieces."},
        "spread": {"type": "number", "default": 2, "min": 0.4, "max": 3, "doc": "Fan width."},
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed variation seed."},
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
    mats = [material("Confetti gold", (0.6, 0.28, 0.035, 1), 0.8, 0.3), material("Confetti teal", (0.025, 0.38, 0.3, 1), 0.6, 0.3), material("Confetti coral", (0.55, 0.055, 0.035, 1), 0.45, 0.4)]
    rng = random.Random(p["seed"])
    objects = []
    for i in range(p["count"]):
        piece = mesh(f"Confetti {i:03}", [(-0.04, -0.025, 0), (0.04, -0.025, 0), (0.04, 0.025, 0.006), (-0.04, 0.025, 0.006)], [(0, 1, 2, 3)], mats[i % 3])
        dx, dy, lift, delay = rng.uniform(-1, 1) * p["spread"], rng.uniform(-0.8, 0.8), rng.uniform(2.0, 2.8), rng.uniform(0, 9)
        spin = tuple(rng.uniform(-9, 9) for _ in range(3))

        def pos(f: float, dx: float = dx, dy: float = dy, lift: float = lift, delay: float = delay) -> tuple[float, ...]:
            t = max(0, f - delay) / 30
            return (dx * (1 - math.exp(-2 * t)), dy * (1 - math.exp(-2 * t)), max(0.012, 0.07 + lift * t - 1.8 * t * t))

        tl.add(piece, "location", pos)
        landing = delay + 30 * (lift + math.sqrt(lift * lift + 4 * 1.8 * 0.058)) / 3.6

        def rotation(f: float, spin: tuple[float, ...] = spin, delay: float = delay, landing: float = landing) -> tuple[float, ...]:
            t = max(0, min(f, landing) - delay) / 60
            damping = 1 - curves.progress(f, landing - 8, 8, "brake")
            return (spin[0] * t * damping, spin[1] * t * damping, spin[2] * t)

        tl.add(piece, "rotation_euler", rotation)
        tl.add(piece, "scale", lambda f, delay=delay: max(0.001, curves.progress(f, delay, 4, "brake")))
        objects.append(piece)
    return finish(objects, mats, tl, owned)
