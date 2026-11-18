# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Ground a clearing in seeded relief with scanned stone and soil blended by slope and height.

Seeded nature wrapper; see docs/blender-arsenal/nature.md for evaluated scope.
"""

from __future__ import annotations

from typing import Any

import bpy
from avc_recipes import validate_params

from _common import bake, finish, material, mesh, timeline_for

META = {
    "id": "terrain",
    "title": "Terrain with slope materials",
    "category": "geometry",
    "intent": "Ground a clearing in seeded relief with scanned stone and soil blended by slope and height.",
    "params": {
        "size": {"type": "number", "default": 12, "doc": "Square width in metres.", "min": 2, "max": 60},
        "relief": {"type": "number", "default": 0.3, "doc": "Relief in metres.", "min": 0, "max": 4},
        "resolution": {"type": "integer", "default": 64, "doc": "Grid divisions.", "min": 8, "max": 200},
        "seed": {"type": "integer", "default": 41, "doc": "Fixed variation seed.", "min": 0, "max": 2147483647},
        "rock_material": {"type": "string", "default": "", "doc": "Optional local scanned material id; empty uses procedural stone."},
        "ground_material": {"type": "string", "default": "", "doc": "Optional local scanned material id; empty uses procedural soil."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "needs_bake": True,
    "requires": {"extensions": [], "generators": []},
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:  # noqa: PLR0912 — copying the supported scanned shader node variants.
    """Displace real geometry; blend two material shaders using world slope and elevation."""
    from _nature import height_at

    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    n, size = p["resolution"], p["size"]
    cached = bake(
        "terrain",
        {k: p[k] for k in ("seed", "size", "resolution", "relief")},
        lambda: [(size * (i / n - 0.5), size * (j / n - 0.5), height_at(size * (i / n - 0.5), size * (j / n - 0.5), p["seed"], p["relief"])) for j in range(n + 1) for i in range(n + 1)],
    )
    vertices = cached["data"]
    faces = [(j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i) for j in range(n) for i in range(n)]
    obj = mesh("Terrain", vertices, faces)
    uv = obj.data.uv_layers.new(name="UVMap")
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
        for loop in polygon.loop_indices:
            v = obj.data.vertices[obj.data.loops[loop].vertex_index].co
            uv.data[loop].uv = (v.x / 2, v.y / 2)
    mats = []
    for key, colour in [("rock_material", (0.15, 0.16, 0.12, 1)), ("ground_material", (0.055, 0.075, 0.022, 1))]:
        if p[key]:
            import avc_assets

            mats.append(avc_assets.append(p[key], scale=1, normal_strength=0.7))
        else:
            mats.append(material(key, colour, 0, 0.85))
    blend = bpy.data.materials.new("AVC Terrain slope and height")
    blend.use_nodes = True
    nodes, links = blend.node_tree.nodes, blend.node_tree.links
    nodes.clear()
    shaders = []
    for mat in mats:
        group = bpy.data.node_groups.new("AVC Terrain " + mat.name, "ShaderNodeTree")
        group.interface.new_socket(name="Shader", in_out="OUTPUT", socket_type="NodeSocketShader")
        # Copy nodes and socket values, preserving scanned image references and colour spaces.
        copies = {}
        for node in mat.node_tree.nodes:
            if node.type == "OUTPUT_MATERIAL":
                continue
            clone = group.nodes.new(node.bl_idname)
            if node.type == "GROUP":
                clone.node_tree = node.node_tree
            if node.type == "TEX_IMAGE":
                clone.image = node.image
            for attribute in ("operation", "blend_type", "data_type", "vector_type", "uv_map", "projection", "extension", "interpolation"):
                if hasattr(node, attribute):
                    setattr(clone, attribute, getattr(node, attribute))
            copies[node] = clone
            for src, dst in zip(node.inputs, clone.inputs, strict=False):
                if hasattr(src, "default_value"):
                    dst.default_value = src.default_value
        output = group.nodes.new("NodeGroupOutput")
        for link in mat.node_tree.links:
            if link.to_node.type == "OUTPUT_MATERIAL" and (not link.to_node.is_active_output or link.to_socket.name != "Surface"):
                continue
            src = copies[link.from_node].outputs[list(link.from_node.outputs).index(link.from_socket)]
            dst = output.inputs[0] if link.to_node.type == "OUTPUT_MATERIAL" else copies[link.to_node].inputs[list(link.to_node.inputs).index(link.to_socket)]
            group.links.new(src, dst)
        node = nodes.new("ShaderNodeGroup")
        node.node_tree = group
        shaders.append(node.outputs[0])
    geometry = nodes.new("ShaderNodeNewGeometry")
    normal, position = nodes.new("ShaderNodeSeparateXYZ"), nodes.new("ShaderNodeSeparateXYZ")
    links.new(geometry.outputs["Normal"], normal.inputs[0])
    links.new(geometry.outputs["Position"], position.inputs[0])
    slope = nodes.new("ShaderNodeMath")
    slope.operation = "MULTIPLY_ADD"
    slope.inputs[1].default_value, slope.inputs[2].default_value = -4, 4.05
    links.new(normal.outputs["Z"], slope.inputs[0])
    height = nodes.new("ShaderNodeMath")
    height.operation = "MULTIPLY_ADD"
    height.inputs[1].default_value, height.inputs[2].default_value = 0.5, 0.12
    links.new(position.outputs["Z"], height.inputs[0])
    maximum = nodes.new("ShaderNodeMath")
    maximum.operation = "MAXIMUM"
    links.new(slope.outputs[0], maximum.inputs[0])
    links.new(height.outputs[0], maximum.inputs[1])
    mix, out = nodes.new("ShaderNodeMixShader"), nodes.new("ShaderNodeOutputMaterial")
    links.new(maximum.outputs[0], mix.inputs[0])
    links.new(shaders[1], mix.inputs[1])
    links.new(shaders[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs["Surface"])
    obj.data.materials.append(blend)
    obj["avc_floor"] = True
    return finish([obj], [blend, *mats], tl, owned, cached)
