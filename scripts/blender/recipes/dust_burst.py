# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Punctuate an impact with a warm, drag-softened burst of dust that settles to the floor.

Knobs: count, spread, seed. Costs and readiness are recorded in AGENTS.md after proof measurement.
"""

from __future__ import annotations

import random
from typing import Any

import bpy
from avc_recipes import validate_params
from kit import curves

from _common import (
    bake,
    ballistic,
    finish,
    material,
    mesh,
    orb,
    timeline_for,
)

META = {
    "id": "dust-burst",
    "title": "Impact dust",
    "category": "particles",
    "intent": "Punctuate an impact with a warm, drag-softened burst of dust that settles to the floor.",
    "params": {
        "count": {"type": "integer", "default": 90, "min": 12, "max": 240, "doc": "Dust motes in the burst."},
        "spread": {"type": "number", "default": 2.1, "min": 0.3, "max": 4, "doc": "Initial lateral spread."},
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Fixed variation seed."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": 1.683, "eevee": None},
    "status": "experimental",
    "needs_bake": True,
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Add this effect, preserving the current scene and any supplied timeline."""
    p = validate_params(META, params)
    tl, owned = timeline_for(scene, timeline)
    count = p["count"]
    cached = bake("dust-burst", p, lambda: ballistic(p["seed"], count, 64, p["spread"]), {"fps": 30})
    positions = cached["data"]
    mat = material("Dust burst", (0.24, 0.11, 0.035, 1), 0.05, 0.8)
    prototype = orb("Dust prototype", (0, 0, -20), 0.007, mat)
    objects = [prototype]
    rng = random.Random(p["seed"])
    for i in range(count):
        mote = bpy.data.objects.new(f"AVC Dust {i:03}", prototype.data)
        scene.collection.objects.link(mote)
        radius = rng.uniform(0.4, 1.8)

        def location(f: float, i: int = i) -> tuple[float, ...]:
            t = min(63.0, max(0.0, f))
            a, b = int(t), min(63, int(t) + 1)
            return tuple(positions[a][i][k] * (1 - t + a) + positions[b][i][k] * (t - a) for k in range(3))

        tl.add(mote, "location", location)
        tl.add(mote, "scale", lambda f, r=radius: max(0.001, r * curves.progress(f, 6, 3, "brake") * (1 - curves.progress(f, 35, 25, "glide"))))
        objects.append(mote)
    cloud = bpy.data.materials.new("AVC Dust cloud")
    cloud.use_nodes = True
    nodes, links = cloud.node_tree.nodes, cloud.node_tree.links
    nodes.clear()
    group = bpy.data.node_groups.new("AVC Dust cloud", "ShaderNodeTree")
    group.interface.new_socket(name="Shader", in_out="OUTPUT", socket_type="NodeSocketShader")
    shader = nodes.new("ShaderNodeGroup")
    shader.node_tree = group
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(shader.outputs[0], output.inputs["Surface"])
    nodes, links = group.nodes, group.links
    coord = nodes.new("ShaderNodeTexCoord")
    distance = nodes.new("ShaderNodeVectorMath")
    distance.operation = "DISTANCE"
    distance.inputs[1].default_value = (0.5, 0.5, 0)
    fade = nodes.new("ShaderNodeMapRange")
    fade.clamp = True
    fade.inputs["From Min"].default_value = 0.04
    fade.inputs["From Max"].default_value = 0.49
    fade.inputs["To Min"].default_value = 0.45
    fade.inputs["To Max"].default_value = 0
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 4
    noise.inputs["Detail"].default_value = 2
    multiply = nodes.new("ShaderNodeMath")
    multiply.operation = "MULTIPLY"
    alpha = nodes.new("ShaderNodeMath")
    alpha.operation = "MULTIPLY"
    envelope = nodes.new("ShaderNodeValue")
    diffuse = nodes.new("ShaderNodeBsdfDiffuse")
    diffuse.inputs["Color"].default_value = (0.32, 0.21, 0.11, 1)
    diffuse.inputs["Roughness"].default_value = 1
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    out = nodes.new("NodeGroupOutput")
    flatten = nodes.new("ShaderNodeVectorMath")
    flatten.operation = "MULTIPLY"
    flatten.inputs[1].default_value = (1, 1, 0)
    links.new(coord.outputs["Generated"], flatten.inputs[0])
    links.new(flatten.outputs["Vector"], distance.inputs[0])
    links.new(coord.outputs["Generated"], noise.inputs["Vector"])
    links.new(distance.outputs["Value"], fade.inputs["Value"])
    links.new(fade.outputs["Result"], multiply.inputs[0])
    links.new(noise.outputs["Fac"], multiply.inputs[1])
    links.new(multiply.outputs[0], alpha.inputs[0])
    links.new(envelope.outputs[0], alpha.inputs[1])
    links.new(alpha.outputs[0], mix.inputs[0])
    links.new(transparent.outputs[0], mix.inputs[1])
    links.new(diffuse.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs[0])
    tl.add(envelope.outputs[0], "default_value", lambda f: curves.progress(f, 8, 7, "brake") * (1 - curves.progress(f, 34, 26, "glide")))
    for i in range(7):
        puff = mesh(f"Dust veil {i}", [(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)], [(0, 1, 2, 3)], cloud)
        if scene.camera:
            face = puff.constraints.new("TRACK_TO")
            face.target = scene.camera
            face.track_axis, face.up_axis = "TRACK_Z", "UP_Y"
        else:
            puff.rotation_euler = (1.570796, 0, 0)
        index = int(i * count / 7)

        def cloud_position(f: float, index: int = index) -> tuple[float, ...]:
            t = min(63, max(0, int(f)))
            x, y, z = positions[t][index]
            return (x * 0.75, y * 0.75, max(0.16, z * 0.7))

        tl.add(puff, "location", cloud_position)
        tl.add(puff, "scale", lambda f, i=i: max(0.001, (0.35 + i * 0.035) * curves.progress(f, 7 + i * 0.5, 12, "brake") + 0.6 * curves.progress(f, 14, 38, "glide")))
        objects.append(puff)
    return finish(objects, [mat, cloud], tl, owned, cached)
