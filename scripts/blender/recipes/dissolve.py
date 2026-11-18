# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Let a solid object disappear through an ember-thin luminous noise boundary.

Knobs: object, noise_scale, edge_width. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

from typing import Any

from avc_recipes import validate_params
from kit import curves

from _common import (
    bloom,
    finish,
    material,
    target,
    timeline_for,
)

META = {
    "id": "dissolve",
    "title": "Ember dissolve",
    "category": "shader",
    "intent": "Let a solid object disappear through an ember-thin luminous noise boundary.",
    "params": {
        "object": {"type": "string", "default": "", "doc": "Optional existing mesh name; empty creates a grounded proof subject."},
        "noise_scale": {"type": "number", "default": 6, "min": 0.5, "max": 20, "doc": "Dissolve feature frequency."},
        "edge_width": {"type": "number", "default": 0.045, "min": 0.01, "max": 0.15, "doc": "Width of the glowing noise boundary."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "experimental",
    "needs_bake": False,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    source = target(p, "Dissolve")
    source.data = source.data.copy()
    mat = material("Dissolve", (0.025, 0.075, 0.095, 1), 0.55, 0.28)
    source.data.materials.clear()
    source.data.materials.append(mat)
    tree = mat.node_tree.nodes.get("Group").node_tree
    nodes, links = tree.nodes, tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    output = next(n for n in nodes if n.type == "GROUP_OUTPUT")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = p["noise_scale"]
    subtract = nodes.new("ShaderNodeMath")
    subtract.operation = "SUBTRACT"
    threshold = nodes.new("ShaderNodeValue")
    links.new(noise.outputs["Fac"], subtract.inputs[0])
    links.new(threshold.outputs[0], subtract.inputs[1])
    visible = nodes.new("ShaderNodeMath")
    visible.operation = "GREATER_THAN"
    visible.inputs[1].default_value = 0
    links.new(subtract.outputs[0], visible.inputs[0])
    absolute = nodes.new("ShaderNodeMath")
    absolute.operation = "ABSOLUTE"
    links.new(subtract.outputs[0], absolute.inputs[0])
    edge = nodes.new("ShaderNodeMath")
    edge.operation = "LESS_THAN"
    edge.inputs[1].default_value = p["edge_width"]
    links.new(absolute.outputs[0], edge.inputs[0])
    strength = nodes.new("ShaderNodeMath")
    strength.operation = "MULTIPLY"
    strength.inputs[1].default_value = 4
    links.new(edge.outputs[0], strength.inputs[0])
    bsdf.inputs["Emission Color"].default_value = (1, 0.21, 0.015, 1)
    links.new(strength.outputs[0], bsdf.inputs["Emission Strength"])
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    links.new(visible.outputs[0], mix.inputs[0])
    links.new(transparent.outputs[0], mix.inputs[1])
    links.new(bsdf.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs[0])
    tl.add(threshold.outputs[0], "default_value", lambda f: curves.track(f, [(0, -0.1, "glide"), (12, -0.1, "glide"), (16, 0.22, "brake"), (54, 0.8, "glide"), (58, 1.1, "brake")]))
    bloom(scene, "Dissolve bloom", 0.07)
    return finish([] if p["object"] else [source], [mat], tl, owned)
