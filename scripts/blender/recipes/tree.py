# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Frame a clearing with species-shaped branches and leaves moving in a gentle frame-driven breeze.

Seeded nature wrapper; see docs/blender-arsenal/nature.md for evaluated scope.
"""

from __future__ import annotations

from typing import Any

import bpy
from avc_recipes import validate_params

from _common import bake, cache_hash, finish, material, mesh, timeline_for

META = {
    "id": "tree",
    "title": "Seeded woodland tree",
    "category": "geometry",
    "intent": "Frame a clearing with species-shaped branches and leaves moving in a gentle frame-driven breeze.",
    "params": {
        "height": {"type": "number", "default": 3.5, "doc": "Height in metres.", "min": 0.3, "max": 12},
        "species": {"type": "string", "default": "birch", "doc": "birch, oak or pine."},
        "engine": {"type": "string", "default": "native", "doc": "native GN leaves, or sapling (approved extension required)."},
        "wind": {"type": "number", "default": 0.008, "doc": "Sway amplitude in radians.", "min": 0, "max": 0.08},
        "seed": {"type": "integer", "default": 41, "doc": "Fixed variation seed.", "min": 0, "max": 2147483647},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "needs_bake": True,
    "requires": {"extensions": [], "generators": []},
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Build species silhouettes with instanced GN leaves; optional pinned Sapling generation."""
    import math

    from _nature import foliage_material, leaf_mesh, tree_layout, tube

    p = validate_params(META, params)
    if p["species"] not in {"birch", "oak", "pine"} or p["engine"] not in {"native", "sapling"}:
        msg = "species must be birch/oak/pine; engine must be native/sapling"
        raise ValueError(msg)
    tl, owned = timeline_for(scene, timeline)
    root = bpy.data.objects.new("AVC Tree root", None)
    scene.collection.objects.link(root)
    h = p["height"]
    bark = material("Birch bark" if p["species"] == "birch" else "Tree bark", (0.42, 0.38, 0.28, 1) if p["species"] == "birch" else (0.075, 0.037, 0.014, 1), 0, 0.9)
    leaf = foliage_material("Woodland leaves", (0.12, 0.24, 0.025, 1))
    objects = [root]
    cached = None
    if p["engine"] == "sapling":
        from avc_extensions import require

        require("sapling_tree_gen", "1.0.0")
        import importlib
        import time
        from pathlib import Path

        from avc_arsenal import paths

        started = time.monotonic()
        directory = Path(paths()["local"]) / "generated" / "sapling-tree" / cache_hash("tree", p, {"extension": "1.0.0", "blender": bpy.app.version_string})
        directory.mkdir(parents=True, exist_ok=True)
        file = directory / "tree.blend"
        reused = file.exists()
        if reused:
            with bpy.data.libraries.load(str(file)) as (source, target):
                target.objects = source.objects
            generated = [obj for obj in target.objects if obj is not None]
            for obj in generated:
                scene.collection.objects.link(obj)
        else:
            presets = importlib.import_module("bl_ext.user_default.sapling_tree_gen.presets")
            settings = presets.PresetStore.for_addon().load({"birch": "silver_birch", "oak": "black_oak", "pine": "small_pine"}[p["species"]]).values.copy()
            valid = {prop.identifier for prop in bpy.ops.curve.tree_add.get_rna_type().properties}
            settings = {key: value for key, value in settings.items() if key in valid}
            settings.update(seed=p["seed"], scale=h, scaleV=0, levels=2, showLeaves=True, useRig=False, windAnim=False)
            before = set(scene.objects)
            bpy.ops.curve.tree_add(**settings)
            generated = [o for o in scene.objects if o not in before]
            temporary = directory / "tree.tmp.blend"
            bpy.data.libraries.write(str(temporary), set(generated))
            temporary.replace(file)
        cached = {"path": str(file), "reused": reused, "seconds": time.monotonic() - started}
        if not generated:
            msg = "Sapling generated no objects"
            raise RuntimeError(msg)
        for obj in generated:
            if obj.parent not in generated:
                obj.parent = root
        objects.extend(generated)
    else:
        trunk = tube("Tree trunk", [(0, 0, 0), (0.035 * h, 0, h * 0.45), (0.01 * h, 0.015 * h, h)], [h * 0.028, h * 0.017, h * 0.002], bark, 9)
        objects.append(trunk)
        cached = bake("tree", {k: p[k] for k in ("seed", "height", "species")}, lambda: tree_layout(p["seed"], h, p["species"]))
        for branch_data in cached["data"]["branches"]:
            z, tip = branch_data["z"], branch_data["tip"]
            branch = tube("Tree branch", [(0, 0, z), (tip[0] * 0.65, tip[1] * 0.65, z + h * 0.06), tip], [h * 0.008, h * 0.004, 0.002], bark, 5)
            objects.append(branch)
        leaves = cached["data"]["leaves"]
        points = mesh("Tree leaf points", leaves, [])
        prototype = leaf_mesh("Tree leaf prototype", h * 0.025, h * 0.008, leaf)
        # Object Info uses original-space geometry; keep the source linked but invisible.
        prototype.hide_render = True
        prototype.hide_set(state=True)
        group = bpy.data.node_groups.new("AVC Tree leaves", "GeometryNodeTree")
        group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
        nodes, links = group.nodes, group.links
        inp, out = nodes.new("NodeGroupInput"), nodes.new("NodeGroupOutput")
        info, instance = nodes.new("GeometryNodeObjectInfo"), nodes.new("GeometryNodeInstanceOnPoints")
        info.inputs["Object"].default_value = prototype
        rotation = nodes.new("FunctionNodeRandomValue")
        rotation.data_type = "FLOAT_VECTOR"
        rotation.inputs["Min"].default_value, rotation.inputs["Max"].default_value = (-1.2, -1.2, -math.pi), (1.2, 1.2, math.pi)
        rotation.inputs["Seed"].default_value = p["seed"]
        links.new(inp.outputs[0], instance.inputs["Points"])
        links.new(info.outputs["Geometry"], instance.inputs["Instance"])
        links.new(rotation.outputs["Value"], instance.inputs["Rotation"])
        links.new(instance.outputs["Instances"], out.inputs[0])
        points.modifiers.new("AVC Tree leaves", "NODES").node_group = group
        objects.extend([points, prototype])
        for obj in objects[1:]:
            obj.parent = root
    tl.add(root, "rotation_euler", lambda f: (p["wind"] * math.sin(f / 30 * 1.4 + p["seed"]), p["wind"] * 0.6 * math.sin(f / 30 * 0.9), 0))
    return finish(objects, [bark, leaf], tl, owned, cached)
