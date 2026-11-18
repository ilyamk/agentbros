# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Reveal a machined surface through one slow travelling specular highlight.

Knobs: object, strength, duration. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params

from _common import (
    finish,
    material,
    target,
    timeline_for,
)

META = {
    "id": "light-sweep",
    "title": "Machined highlight",
    "category": "lighting",
    "intent": "Reveal a machined surface through one slow travelling specular highlight.",
    "params": {
        "object": {"type": "string", "default": "", "doc": "Optional existing mesh name; empty creates a grounded proof subject."},
        "strength": {"type": "number", "default": 1, "min": 0.1, "max": 4, "doc": "Sweep light intensity multiplier."},
        "duration": {"type": "integer", "default": 48, "min": 12, "max": 100, "doc": "Sweep duration in frames."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": 0.673, "eevee": None},
    "status": "ready",
    "needs_bake": False,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    source = target(p, "Light sweep")
    if not p["object"]:
        mat = material("Brushed sweep", (0.045, 0.065, 0.085, 1), 0.92, 0.23)
        source.data.materials[0] = mat
        shader = mat.node_tree.nodes.get("Group").node_tree
        bsdf = next(n for n in shader.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Anisotropic"].default_value = 0.55
        for link in list(shader.links):
            if link.to_socket == bsdf.inputs["Roughness"]:
                shader.links.remove(link)
        brushed = shader.nodes.new("ShaderNodeTexWave")
        brushed.inputs["Scale"].default_value = 150
        brushed.inputs["Distortion"].default_value = 2
        rough = shader.nodes.new("ShaderNodeMapRange")
        rough.inputs["To Min"].default_value = 0.20
        rough.inputs["To Max"].default_value = 0.27
        shader.links.new(brushed.outputs["Fac"], rough.inputs["Value"])
        shader.links.new(rough.outputs["Result"], bsdf.inputs["Roughness"])
    from kit import light

    rig = light.mood("rim-hero", target=tuple(source.location), size=max(source.dimensions), use_world=False, only=["key"], scale={"key": p["strength"] * 3})
    name = next(iter(rig.lights))
    rig.light(name).data.size = max(source.dimensions) * 0.15
    rig.light(name).data.size_y = max(source.dimensions) * 3
    rig.sweep(name, -75, 75, at=4, frames=p["duration"], intent="glide").bake(tl)
    return finish(([source] if not p["object"] else []) + [rig.light(name) for name in rig.lights], [], tl, owned)
