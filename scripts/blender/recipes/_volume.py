# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Frame-driven volume grids for inexpensive smoke layout and dusty impacts."""

from __future__ import annotations

from typing import Any

from _common import finish, mesh, timeline_for


def grid_plume(scene: Any, p: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Sample a broad billowing column into a named density grid at every frame."""
    import bpy

    tl, owned = timeline_for(scene, timeline)
    mat = bpy.data.materials.new("AVC Plume density")
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    shader = mat.node_tree.nodes.new("ShaderNodeVolumePrincipled")
    shader.inputs["Color"].default_value = (0.62, 0.66, 0.7, 1)
    shader.inputs["Anisotropy"].default_value = 0.25
    density = mat.node_tree.nodes.new("ShaderNodeAttribute")
    density.attribute_name = "density"
    out = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(density.outputs["Fac"], shader.inputs["Density"])
    mat.node_tree.links.new(shader.outputs["Volume"], out.inputs["Volume"])
    obj = mesh("Plume grid", [], [], mat)
    group = bpy.data.node_groups.new("AVC Plume density grid", "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = group.nodes, group.links

    def math_node(op: str, a: Any, b: Any) -> Any:
        node = nodes.new("ShaderNodeMath")
        node.operation = op
        for index, value in enumerate((a, b)):
            if isinstance(value, (int, float)):
                node.inputs[index].default_value = value
            else:
                links.new(value, node.inputs[index])
        return node.outputs[0]

    pos = nodes.new("GeometryNodeInputPosition")
    xyz = nodes.new("ShaderNodeSeparateXYZ")
    links.new(pos.outputs[0], xyz.inputs[0])
    z = xyz.outputs["Z"]
    radial = math_node("SQRT", math_node("ADD", math_node("MULTIPLY", xyz.outputs["X"], xyz.outputs["X"]), math_node("MULTIPLY", xyz.outputs["Y"], xyz.outputs["Y"])), 0)
    radius = math_node("MULTIPLY_ADD", z, 0.21)
    radius.node.inputs[2].default_value = 0.18
    envelope = math_node("SUBTRACT", 1, math_node("DIVIDE", radial, radius))
    envelope.node.use_clamp = True
    top = math_node("SUBTRACT", 1, math_node("DIVIDE", z, 3.2))
    top.node.use_clamp = True
    drift = nodes.new("ShaderNodeVectorMath")
    drift.operation = "ADD"
    links.new(pos.outputs[0], drift.inputs[0])
    phase = nodes.new("ShaderNodeCombineXYZ")
    tl.add(phase.inputs["Z"], "default_value", lambda f: -f / 38)
    links.new(phase.outputs[0], drift.inputs[1])
    noise = nodes.new("ShaderNodeTexNoise")
    noise.noise_dimensions = "4D"
    noise.inputs["W"].default_value = p["seed"] / 103
    noise.inputs["Scale"].default_value = 3.3
    noise.inputs["Detail"].default_value = 3
    links.new(drift.outputs[0], noise.inputs["Vector"])
    turbulent = math_node("SUBTRACT", noise.outputs["Fac"], 0.32)
    turbulent.node.use_clamp = True
    field = math_node("MULTIPLY", math_node("MULTIPLY", envelope, top), math_node("MULTIPLY", turbulent, 9))
    cube = nodes.new("GeometryNodeVolumeCube")
    cube.inputs["Min"].default_value = (-1, -1, 0)
    cube.inputs["Max"].default_value = (1, 1, 3.2)
    for key in ("Resolution X", "Resolution Y", "Resolution Z"):
        cube.inputs[key].default_value = p["resolution"]
    links.new(field, cube.inputs["Density"])
    surface = nodes.new("GeometryNodeSetMaterial")
    surface.inputs["Material"].default_value = mat
    links.new(cube.outputs["Volume"], surface.inputs["Geometry"])
    output = nodes.new("NodeGroupOutput")
    links.new(surface.outputs["Geometry"], output.inputs["Geometry"])
    obj.modifiers.new("AVC Density grid", "NODES").node_group = group
    obj["avc_voxels"] = p["resolution"] ** 3
    return finish([obj], [mat], tl, owned)
