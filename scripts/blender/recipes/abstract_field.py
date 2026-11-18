# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Carry a transition on a calm metallic field whose waves travel with the beat.

Knobs: count, amplitude, seed. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

from typing import Any

import bpy
from avc_recipes import validate_params
from kit import curves

from _common import (
    finish,
    material,
    mesh,
    timeline_for,
)

META = {
    "id": "abstract-field",
    "title": "Tidal field",
    "category": "geometry",
    "intent": "Carry a transition on a calm metallic field whose waves travel with the beat.",
    "params": {
        "count": {"type": "integer", "default": 19, "min": 7, "max": 31, "doc": "Instances along each side."},
        "amplitude": {"type": "number", "default": 0.27, "min": 0.05, "max": 0.65, "doc": "Wave height in metres."},
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed variation seed."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": 0.639, "eevee": None},
    "status": "ready",
    "needs_bake": False,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    mat = material("Abstract field", (0.04, 0.24, 0.2, 1), 0.72, 0.24)
    field = mesh("Abstract field", [], [])
    group = bpy.data.node_groups.new("AVC Abstract field", "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = group.nodes, group.links
    grid = nodes.new("GeometryNodeMeshGrid")
    grid.inputs["Size X"].default_value = 3
    grid.inputs["Size Y"].default_value = 3
    grid.inputs["Vertices X"].default_value = p["count"]
    grid.inputs["Vertices Y"].default_value = p["count"]
    pos = nodes.new("GeometryNodeInputPosition")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    links.new(pos.outputs[0], separate.inputs[0])
    time = nodes.new("ShaderNodeValue")
    tl.add(time.outputs[0], "default_value", lambda f: 1.05 * curves.progress(f, 3, 44, "glide"))
    add = nodes.new("ShaderNodeMath")
    add.operation = "ADD"
    links.new(separate.outputs["X"], add.inputs[0])
    links.new(time.outputs[0], add.inputs[1])
    frequency = nodes.new("ShaderNodeMath")
    frequency.operation = "MULTIPLY_ADD"
    frequency.inputs[1].default_value = 3
    frequency.inputs[2].default_value = p["seed"] % 100
    links.new(add.outputs[0], frequency.inputs[0])
    sine = nodes.new("ShaderNodeMath")
    sine.operation = "SINE"
    links.new(frequency.outputs[0], sine.inputs[0])
    amp = nodes.new("ShaderNodeMath")
    amp.operation = "MULTIPLY_ADD"
    amp.inputs[1].default_value = p["amplitude"]
    amp.inputs[2].default_value = p["amplitude"] + 0.1
    links.new(sine.outputs[0], amp.inputs[0])
    combine = nodes.new("ShaderNodeCombineXYZ")
    half = nodes.new("ShaderNodeMath")
    half.operation = "MULTIPLY_ADD"
    half.inputs[1].default_value = 0.5
    half.inputs[2].default_value = 0.001
    links.new(amp.outputs[0], half.inputs[0])
    links.new(half.outputs[0], combine.inputs["Z"])
    setpos = nodes.new("GeometryNodeSetPosition")
    links.new(grid.outputs[0], setpos.inputs["Geometry"])
    links.new(combine.outputs[0], setpos.inputs["Offset"])
    pearl = nodes.new("GeometryNodeMeshCylinder")
    pearl.inputs["Radius"].default_value = 0.052
    pearl.inputs["Vertices"].default_value = 24
    pearl.inputs["Depth"].default_value = 1
    shading = nodes.new("GeometryNodeSetMaterial")
    shading.inputs["Material"].default_value = mat
    links.new(pearl.outputs["Mesh"], shading.inputs["Geometry"])
    inst = nodes.new("GeometryNodeInstanceOnPoints")
    links.new(setpos.outputs[0], inst.inputs["Points"])
    links.new(shading.outputs["Geometry"], inst.inputs["Instance"])
    pillar_scale = nodes.new("ShaderNodeCombineXYZ")
    pillar_scale.inputs["X"].default_value = 1
    pillar_scale.inputs["Y"].default_value = 1
    links.new(amp.outputs[0], pillar_scale.inputs["Z"])
    links.new(pillar_scale.outputs[0], inst.inputs["Scale"])
    output = nodes.new("NodeGroupOutput")
    links.new(inst.outputs[0], output.inputs[0])
    mod = field.modifiers.new("AVC Abstract field", "NODES")
    mod.node_group = group
    return finish([field], [mat], tl, owned)
