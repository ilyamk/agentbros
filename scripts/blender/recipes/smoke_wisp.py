# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Draw a restrained rising wisp through a dark frame to suggest heat and atmosphere.

Knobs: density, speed. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

from typing import Any

import bpy
from avc_recipes import validate_params

from _common import (
    finish,
    mesh,
    timeline_for,
)

META = {
    "id": "smoke-wisp",
    "title": "Silken smoke",
    "category": "volume",
    "intent": "Draw a restrained rising wisp through a dark frame to suggest heat and atmosphere.",
    "params": {
        "density": {"type": "number", "default": 1.8, "min": 0.1, "max": 4, "doc": "Peak volume density."},
        "speed": {"type": "number", "default": 0.6, "min": 0.1, "max": 2, "doc": "Noise drift speed."},
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
    mat = bpy.data.materials.new("AVC Smoke wisp")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    shader = nodes.new("ShaderNodeVolumePrincipled")
    shader.inputs["Color"].default_value = (0.55, 0.66, 0.72, 1)
    shader.inputs["Anisotropy"].default_value = 0.35
    attribute = nodes.new("ShaderNodeAttribute")
    attribute.attribute_name = "density"
    out = nodes.new("ShaderNodeOutputMaterial")
    links.new(attribute.outputs["Fac"], shader.inputs["Density"])
    links.new(shader.outputs["Volume"], out.inputs["Volume"])
    volume = mesh("Smoke wisp", [], [], mat)
    volume["avc_voxels"] = 24 * 24 * 80
    group = bpy.data.node_groups.new("AVC Smoke wisp", "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = group.nodes, group.links
    position = nodes.new("GeometryNodeInputPosition")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    links.new(position.outputs["Position"], separate.inputs[0])
    phase = nodes.new("ShaderNodeValue")
    tl.add(phase.outputs[0], "default_value", lambda f: 0.19 + f * p["speed"] / 60)
    curl_phase = nodes.new("ShaderNodeMath")
    curl_phase.operation = "MULTIPLY_ADD"
    curl_phase.inputs[1].default_value = 3.5
    links.new(separate.outputs["Z"], curl_phase.inputs[0])
    links.new(phase.outputs[0], curl_phase.inputs[2])
    curl = nodes.new("ShaderNodeMath")
    curl.operation = "SINE"
    links.new(curl_phase.outputs[0], curl.inputs[0])
    curl_size = nodes.new("ShaderNodeMath")
    curl_size.operation = "MULTIPLY"
    curl_size.inputs[1].default_value = 0.09
    links.new(curl.outputs[0], curl_size.inputs[0])
    centre = nodes.new("ShaderNodeCombineXYZ")
    links.new(curl_size.outputs[0], centre.inputs["X"])
    links.new(separate.outputs["Z"], centre.inputs["Z"])
    distance = nodes.new("ShaderNodeVectorMath")
    distance.operation = "DISTANCE"
    links.new(position.outputs[0], distance.inputs[0])
    links.new(centre.outputs[0], distance.inputs[1])
    radial = nodes.new("ShaderNodeMapRange")
    radial.clamp = True
    radial.inputs["From Min"].default_value = 0.02
    radial.inputs["From Max"].default_value = 0.24
    radial.inputs["To Min"].default_value = p["density"]
    radial.inputs["To Max"].default_value = 0
    links.new(distance.outputs["Value"], radial.inputs["Value"])
    z_phase = nodes.new("ShaderNodeMath")
    z_phase.operation = "MULTIPLY"
    z_phase.inputs[1].default_value = 3.14159265 / 2.3
    links.new(separate.outputs["Z"], z_phase.inputs[0])
    vertical = nodes.new("ShaderNodeMath")
    vertical.operation = "SINE"
    links.new(z_phase.outputs[0], vertical.inputs[0])
    noise = nodes.new("ShaderNodeTexNoise")
    noise.noise_dimensions = "4D"
    noise.inputs["Scale"].default_value = 4
    noise.inputs["Detail"].default_value = 2
    links.new(position.outputs[0], noise.inputs["Vector"])
    links.new(phase.outputs[0], noise.inputs["W"])
    threshold = nodes.new("ShaderNodeMapRange")
    threshold.clamp = True
    threshold.inputs["From Min"].default_value = 0.38
    threshold.inputs["From Max"].default_value = 0.65
    links.new(noise.outputs["Fac"], threshold.inputs["Value"])
    mask = nodes.new("ShaderNodeMath")
    mask.operation = "MULTIPLY"
    links.new(radial.outputs["Result"], mask.inputs[0])
    links.new(vertical.outputs[0], mask.inputs[1])
    density = nodes.new("ShaderNodeMath")
    density.operation = "MULTIPLY"
    links.new(mask.outputs[0], density.inputs[0])
    links.new(threshold.outputs["Result"], density.inputs[1])
    cube = nodes.new("GeometryNodeVolumeCube")
    cube.inputs["Min"].default_value = (-0.42, -0.28, 0)
    cube.inputs["Max"].default_value = (0.42, 0.28, 2.3)
    for name, value in (("Resolution X", 24), ("Resolution Y", 24), ("Resolution Z", 80)):
        cube.inputs[name].default_value = value
    links.new(density.outputs[0], cube.inputs["Density"])
    set_material = nodes.new("GeometryNodeSetMaterial")
    set_material.inputs["Material"].default_value = mat
    links.new(cube.outputs["Volume"], set_material.inputs["Geometry"])
    output = nodes.new("NodeGroupOutput")
    links.new(set_material.outputs["Geometry"], output.inputs["Geometry"])
    mod = volume.modifiers.new("AVC Smoke wisp", "NODES")
    mod.node_group = group
    return finish([volume], [mat], tl, owned)
