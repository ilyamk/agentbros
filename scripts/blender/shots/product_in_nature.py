# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Reveal a tactile ceramic flask on damp stone as a slow push settles into a sunlit clearing.

Art direction: olive/ochre woodland, warm ivory ceramic, dark bronze cap, low amber sun.
JSON keys: seed, iteration (1 or 2), palette (ivory or clay), time_of_day (sky preset), lens,
fstop, trees, samples. Parametric product is original, has no third-party UI or branding.
The clearing and tree wind use seeded frame functions, never simulation or wall-clock time.
"""

from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

import avc_export
import bpy
from avc_recipes import apply

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "recipes"))
from _common import material, mesh, orb
from _nature import foliage_material, height_at, leaf_mesh, tube
from kit import anim, camera, look


def main() -> None:  # noqa: PLR0912 — art-directed scene assembly.
    """Compose catalogue recipes, then leave rendering to the existing isolated runner."""
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = json.loads(args[0]) if args else {}
    allowed = {"seed", "iteration", "palette", "time_of_day", "lens", "fstop", "trees", "samples"}
    if not isinstance(p, dict) or p.keys() - allowed:
        msg = "Unknown product-in-nature keys"
        raise ValueError(msg)
    seed = p.get("seed", 41)
    iteration = p.get("iteration", 2)
    if type(seed) is not int or not 0 <= seed <= 2147483647 or type(iteration) is not int or iteration not in (1, 2) or p.get("palette", "ivory") not in {"ivory", "clay"}:
        msg = "Invalid seed, iteration or palette"
        raise ValueError(msg)
    for name, default, low, high in [("lens", 72, 20, 200), ("fstop", 2.8, 0.8, 16), ("trees", 10, 0, 30), ("samples", 8, 1, 128)]:
        value = p.get(name, default)
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high or (name in {"trees", "samples"} and type(value) is not int):
            msg = f"Invalid {name}"
            raise ValueError(msg)
    scene = bpy.context.scene
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene.frame_start, scene.frame_end, scene.render.fps = 1, 64, 30
    scene.render.engine = "CYCLES"
    scene.cycles.samples = p.get("samples", 8)
    scene.cycles.seed, scene.cycles.use_animated_seed = seed, False
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.render.resolution_x, scene.render.resolution_y = avc_export.render_request().get("resolution") or (480, 270)
    scene.render.resolution_percentage = 100
    look.apply(scene, "agx", exposure=-0.3)
    look.motion_blur(scene, 0.3)
    tl = anim.Timeline(range(-1, 67))
    results = [apply("terrain", {"size": 18, "seed": seed, "resolution": 90, "rock_material": "polyhaven:aerial_grass_rock", "ground_material": "polyhaven:brown_mud_leaves_01"}, tl)]
    results.append(apply("sky-atmosphere", {"preset": p.get("time_of_day", "golden-hour"), "haze": 0.003 if iteration == 2 else 0.012}, tl))
    results.append(apply("vegetation-scatter", {"count": 550 if iteration == 2 else 220, "radius": 7, "clearing": 0.85, "seed": seed}, tl))
    if iteration == 2:
        import avc_assets

        # Use the scan only for camera rays; physical sky continues to illuminate the scene.
        old_world = scene.world
        scan_world = avc_assets.append("polyhaven:forest_slope", strength=0.65, rotation=110)
        scene.world = old_world
        n, links = old_world.node_tree.nodes, old_world.node_tree.links
        environment = n.new("ShaderNodeTexEnvironment")
        environment.image = next(node.image for node in scan_world.node_tree.nodes if node.type == "TEX_ENVIRONMENT")
        backdrop = n.new("ShaderNodeBackground")
        backdrop.inputs["Strength"].default_value = 0.5
        links.new(environment.outputs[0], backdrop.inputs["Color"])
        ray, mix = n.new("ShaderNodeLightPath"), n.new("ShaderNodeMixShader")
        links.new(ray.outputs["Is Camera Ray"], mix.inputs[0])
        links.new(n.get("Background").outputs[0], mix.inputs[1])
        links.new(backdrop.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], n.get("World Output").inputs["Surface"])
    rng = random.Random(seed)
    for i in range(p.get("trees", 10)):
        x = (-1 if i % 2 else 1) * rng.uniform(1.9, 6)
        y = rng.uniform(2, 9)
        tree = apply("tree", {"height": rng.uniform(3.8, 6.5), "seed": seed + i, "species": "birch" if i % 3 else "oak"}, tl)
        root = bpy.data.objects[tree["objects"][0]]
        root.location = (x, y, height_at(x, y, seed))
        results.append(tree)
    # Flatten the scan's broadest axis into a stable, irregular pedestal.
    import avc_assets

    stone_mat = avc_assets.append("polyhaven:aerial_grass_rock", normal_strength=0.7)
    if iteration == 2:
        root = avc_assets.append("polyhaven:boulder_01", normalise_scale=1.8)
        root.scale.z *= 0.5
        bpy.context.view_layer.update()
        rocks = [o for o in root.children_recursive if o.type == "MESH"]
        lowest = min((o.matrix_world @ v.co).z for o in rocks for v in o.data.vertices)
        root.location.z -= lowest + 0.05
        bpy.context.view_layer.update()
        centre = [(o.matrix_world @ v.co) for o in rocks for v in o.data.vertices if (o.matrix_world @ v.co).x ** 2 + (o.matrix_world @ v.co).y ** 2 <= 0.14**2]
        surface = max(v.z for v in centre)
    else:
        rock = orb("Hero stone", (0, 0, 0.17), 1, stone_mat)
        rock.scale = (0.85, 0.64, 0.3)
        texture = bpy.data.textures.new("AVC Rock relief", type="CLOUDS")
        texture.noise_scale = 0.23
        displacement = rock.modifiers.new("AVC Rock erosion", "DISPLACE")
        displacement.texture, displacement.strength = texture, 0.11
        displacement.texture_coords = "GLOBAL"
        bpy.context.view_layer.update()
        evaluated = rock.evaluated_get(bpy.context.evaluated_depsgraph_get())
        surface = max((evaluated.matrix_world @ v.co).z for v in evaluated.data.vertices if (evaluated.matrix_world @ v.co).x ** 2 + (evaluated.matrix_world @ v.co).y ** 2 <= 0.14**2)
    colour = (0.72, 0.61, 0.42, 1) if p.get("palette", "ivory") == "ivory" else (0.34, 0.09, 0.035, 1)
    ceramic = material("Ceramic warm ivory", colour, 0, 0.3)
    cap_mat = material("Brushed dark bronze", (0.085, 0.065, 0.038, 1), 0.8, 0.28)
    # Lathed profile: foot, body, shoulder and neck with softened transitions.
    profile = [(0.14, 0), (0.17, 0.025), (0.18, 0.09), (0.18, 0.58), (0.173, 0.65), (0.135, 0.72), (0.10, 0.76), (0.10, 0.83)]
    vertices = [(r * math.cos(j * math.tau / 64), r * math.sin(j * math.tau / 64), surface + z) for r, z in profile for j in range(64)]
    faces: list[tuple[int, ...]] = [(i * 64 + j, i * 64 + (j + 1) % 64, (i + 1) * 64 + (j + 1) % 64, (i + 1) * 64 + j) for i in range(len(profile) - 1) for j in range(64)]
    faces.extend([tuple(reversed(range(64))), tuple(range((len(profile) - 1) * 64, len(profile) * 64))])
    product = mesh("Ceramic flask", vertices, faces, ceramic)
    bevel = product.modifiers.new("Rounded ceramic edges", "BEVEL")
    bevel.width, bevel.segments = 0.018, 3
    for polygon in product.data.polygons:
        polygon.use_smooth = True
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.106, depth=0.095, location=(0, 0, surface + 0.86))
    cap = bpy.context.object
    cap.name = "Bronze cap"
    cap.data.materials.append(cap_mat)
    bevel = cap.modifiers.new("Cap rim", "BEVEL")
    bevel.width, bevel.segments = 0.012, 3
    # Restrained front label makes the product readable without an app/UI stand-in.
    label_mat = material("Charcoal ink", (0.025, 0.035, 0.02, 1), 0, 0.75)
    for text, z, size in [("FIELD", 0.49, 0.072), ("BOTANICAL", 0.40, 0.026), ("01", 0.27, 0.04)]:
        data = bpy.data.curves.new("AVC Label", "FONT")
        data.body, data.align_x, data.size = text, "CENTER", size
        obj = bpy.data.objects.new(data.name, data)
        scene.collection.objects.link(obj)
        obj.location, obj.rotation_euler = (0, -0.1815, surface + z), (math.pi / 2, 0, 0)
        data.materials.append(label_mat)
    # Fern-like fronds at the pedestal edges supply scale and an asymmetrical foreground.
    fern = foliage_material("Fern olive", (0.075, 0.19, 0.022, 1))
    for side in [-1, 1]:
        for j in range(5):
            base = (side * (0.65 + j * 0.13), -0.4 + j * 0.1, 0)
            tube("Fern rachis", [base, (base[0] + side * 0.18, base[1] + 0.25, 0.35), (base[0] + side * 0.35, base[1] + 0.5, 0.5)], [0.009, 0.006, 0.001], fern, 5)
            for k in range(9):
                t = k / 10
                for sign in [-1, 1]:
                    leaf = leaf_mesh("Fern pinna", 0.17 * (1 - t * 0.7), 0.014 * (1 - t * 0.5), fern)
                    leaf.location = (base[0] + side * 0.35 * t, base[1] + 0.5 * t, 0.5 * math.sin(t * math.pi / 2))
                    leaf.rotation_euler = (0.15, sign * 0.3, sign * 1.15 + side * 0.2)
    # A large warm source models the ceramic without flattening the forest's shadows.
    data = bpy.data.lights.new("AVC Sun bounce", "AREA")
    data.energy, data.shape, data.size = (85 if iteration == 2 else 60), "DISK", 3
    data.color = (1, 0.86, 0.64)
    fill = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(fill)
    from mathutils import Vector

    fill.location = (-3, -3, 4)
    fill.rotation_euler = (Vector((0, 0, surface + 0.4)) - fill.location).to_track_quat("-Z", "Y").to_euler()
    if iteration == 2:
        rim_data = bpy.data.lights.new("AVC Golden clearing rim", "AREA")
        rim_data.energy, rim_data.shape, rim_data.size = 450, "DISK", 1.8
        rim_data.color = (1, 0.67, 0.28)
        rim = bpy.data.objects.new(rim_data.name, rim_data)
        scene.collection.objects.link(rim)
        rim.location = (-2, 1.5, 3)
        rim.rotation_euler = (Vector((0, 0, surface + 0.4)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    rig = camera.Rig(
        {"width": scene.render.resolution_x, "height": scene.render.resolution_y},
        role="reveal",
        target=(0.05, 0, surface + 0.38),
        subject=(2.9, 1.7),
        lens=p.get("lens", 72),
        fstop=p.get("fstop", 2.8),
        yaw=-8,
        pitch=9,
        distance=5.8 if iteration == 2 else 6.6,
    )
    rig.push_in(0.94, at=1, frames=52, intent="glide")
    rig.bake(tl)
    tl.bake()
    scene.frame_set(1)
    bpy.context.view_layer.update()
    product_base = min((product.matrix_world @ v.co).z for v in product.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices)
    stats = {
        "objects": len(scene.objects),
        "polygons": sum(len(o.data.polygons) for o in scene.objects if o.type == "MESH"),
        "seed": seed,
        "iteration": iteration,
        "contactSurfaceZ": surface,
        "productBaseZ": product_base,
        "floorGap": product_base - surface,
        "recipes": [r["objects"] for r in results],
    }
    Path(avc_export.output_path("nature-stats.json")).write_text(json.dumps(stats), encoding="utf8")


main()
