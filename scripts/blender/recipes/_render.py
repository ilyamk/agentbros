# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Build a recipe proof stage through the existing blender:run worker, never a second render backend."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import avc_export
import bpy
from avc_recipes import apply, describe
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from kit import anim, camera, curves, light, look

from _common import material, orb

Params = dict[str, Any]

PROOF_SHOTS: dict[str, Params] = {
    "abstract-field": {
        "subject": (4.25, 3.3),
        "target": (0, 0, 0.32),
        "pitch": 50,
        "yaw": 24,
        "lens": 65,
        "mood": "soft-product",
        "world": 0.08,
        "scale": {"fill": 0.25, "rim": 1.3},
        "floor": "#1e282c",
    },
    "caustics-glass": {
        "subject": (3.5, 2.25),
        "target": (0, 0, 0.88),
        "pitch": 12,
        "yaw": -12,
        "lens": 85,
        "mood": "rim-hero",
        "world": 0.005,
        "fstop": 11,
        "scale": {"key": 0.035, "rim-left": 0.09, "rim-right": 0.035, "top": 0.01},
        "floor": "#292c2e",
    },
    "cloth-drape": {
        "subject": (4.1, 2.4),
        "target": (0, 0, 0.85),
        "pitch": 20,
        "yaw": -15,
        "lens": 70,
        "mood": "soft-product",
        "world": 0.08,
        "scale": {"key": 0.65, "fill": 0.2, "rim": 0.75, "top": 0.5},
        "floor": "#22272c",
    },
    "confetti": {"subject": (4.4, 2.8), "target": (0, 0, 1), "pitch": 18, "yaw": 12, "lens": 65, "mood": "soft-product", "world": 0.1, "scale": {"fill": 0.4, "rim": 1.3}, "floor": "#232d32"},
    "dissolve": {
        "subject": (3.4, 2.35),
        "target": (0, 0, 0.8),
        "pitch": 14,
        "yaw": -12,
        "lens": 85,
        "mood": "rim-hero",
        "world": 0.04,
        "scale": {"key": 0.65, "rim-left": 1.2, "rim-right": 0.6, "top": 0.3},
        "floor": "#19232a",
    },
    "dust-burst": {"subject": (3.8, 2.5), "target": (0, 0, 0.85), "pitch": 18, "yaw": 15, "lens": 65, "mood": "golden-hour", "world": 0.05, "scale": {"sun": 0.35, "bounce": 0.7}, "floor": "#282421"},
    "grow-in": {"subject": (3.4, 2.35), "target": (0, 0, 0.8), "pitch": 12, "yaw": -15, "lens": 80, "mood": "soft-product", "world": 0.1, "scale": {"fill": 0.35, "rim": 1.2}, "floor": "#263036"},
    "light-sweep": {
        "subject": (3.4, 2.35),
        "target": (0, 0, 0.8),
        "pitch": 12,
        "yaw": -18,
        "lens": 85,
        "mood": "rim-hero",
        "world": 0.02,
        "scale": {"key": 0.1, "rim-left": 0.8, "rim-right": 0.35, "top": 0.1},
        "floor": "#151d23",
    },
    "liquid-splash": {
        "subject": (3.8, 2.4),
        "target": (0, 0, 0.62),
        "pitch": 30,
        "yaw": -8,
        "lens": 70,
        "mood": "rim-hero",
        "world": 0.07,
        "scale": {"key": 1.1, "rim-left": 0.8, "rim-right": 1.1},
        "floor": "#202b30",
    },
    "neon-glow": {
        "subject": (3.5, 2.6),
        "target": (0, 0, 1.1),
        "pitch": 8,
        "yaw": -8,
        "lens": 70,
        "mood": "neon-night",
        "world": 0.01,
        "scale": {"key": 0.2, "fill": 0.2, "rim": 0.45},
        "floor": "#0b1118",
    },
    "ribbon-trail": {"subject": (3.4, 2.6), "target": (0, 0, 1.05), "pitch": 18, "yaw": 32, "lens": 80, "mood": "low-key", "world": 0.08, "scale": {"key": 1.1}, "floor": "#1d2126"},
    "scatter-surface": {
        "subject": (3.4, 2.4),
        "target": (0, 0, 0.85),
        "pitch": 16,
        "yaw": -10,
        "lens": 85,
        "mood": "soft-product",
        "world": 0.08,
        "scale": {"fill": 0.25, "rim": 1.2, "top": 0.4},
        "floor": "#2a3034",
    },
    "shatter": {"subject": (4.1, 2.4), "target": (0, 0, 0.8), "pitch": 23, "yaw": 18, "lens": 70, "mood": "low-key", "world": 0.06, "scale": {"key": 1.1}, "floor": "#262b2e"},
    "smoke-wisp": {
        "subject": (2.8, 2.8),
        "target": (0, 0, 1.2),
        "pitch": 8,
        "yaw": -10,
        "lens": 70,
        "mood": "rim-hero",
        "world": 0.015,
        "scale": {"key": 0.3, "rim-left": 1.2, "rim-right": 0.75, "top": 0.2},
        "floor": "#171e25",
    },
    "studio-floor": {"subject": (3.8, 2.5), "target": (0, 0, 0.8), "pitch": 14, "yaw": -12, "lens": 80, "mood": "soft-product", "world": 0.15, "scale": {"fill": 0.4}, "floor": "#202930"},
    "text-3d": {"subject": (3.8, 2.1), "target": (0, 0, 0.65), "pitch": 10, "yaw": -12, "lens": 85, "mood": "soft-product", "world": 0.1, "scale": {"fill": 0.3, "rim": 1.2}, "floor": "#262b30"},
}


def city_rig(scene: Any, timeline: Any, recipe_id: str, frames: int) -> Any:
    """Frame metre-scale city recipes without the small product stage."""
    aspect = {"width": scene.render.resolution_x, "height": scene.render.resolution_y}
    if recipe_id == "window-lights":
        rig = camera.Rig(aspect, role="establishing", target=(0, 0, 11), subject=(26, 24), lens=60, fstop=0, yaw=18, pitch=12, fill=0.78)
    elif recipe_id == "osm-city":
        bpy.context.view_layer.update()
        points = [obj.matrix_world @ Vector(p) for obj in scene.objects if obj.get("avc_city_body") for p in obj.bound_box]
        low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
        high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
        size = high - low
        rig = camera.Rig(aspect, role="establishing", target=tuple((low + high) / 2), subject=(size.x + size.y * 0.4, size.z + size.y * 0.5), lens=42, fstop=0, yaw=20, pitch=30, fill=0.78)
        rig.obj.data.clip_end = max(3000, rig.distance0 * 3)
    else:
        rig = camera.Rig(aspect, role="establishing", target=(0, 0, 45), subject=(400, 200), lens=42, fstop=0, yaw=20, pitch=25, distance=700)
        rig.obj.data.clip_end = 3000
    rig.orbit(20, 12, at=0, frames=frames - 8, intent="glide")
    rig.bake(timeline)
    light.mood("golden-hour", size=180, target=(0, 0, 40), use_world=False, exposure=3, only=["sun", "sky"]).bake(timeline)
    return rig


def main() -> None:  # noqa: PLR0912 — recipe-specific proof framing, staging and environment baselines.
    """Prepare the scene and leave all frame rendering to avc_run.py."""
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) != 1:
        msg = "Expected one recipe request JSON object"
        raise ValueError(msg)
    request = json.loads(args[0])
    if not isinstance(request, dict) or request.keys() - {"id", "params", "bare", "emptyStage"}:
        msg = "Unknown recipe request keys"
        raise ValueError(msg)
    meta = describe(request["id"])
    fx_default: Params = {
        "subject": (4.8, 3.6),
        "target": (0, 0, 1.5),
        "pitch": 10,
        "yaw": -12,
        "lens": 70,
        "mood": "rim-hero",
        "world": 0.025,
        "scale": {"key": 0.7, "fill": 0.3, "rim-left": 1.5, "rim-right": 1.2},
        "floor": "#172027",
        "fstop": 8,
    }
    shot = PROOF_SHOTS.get(request["id"]) or (fx_default if request["id"] in {"liquid-pour", "product-splash", "smoke-plume", "molecule", "pattern-surface"} else None)
    scene = bpy.context.scene
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene.frame_start, scene.frame_end = 1, meta["frames_hint"]
    scene.render.fps = 30
    scene.render.resolution_x, scene.render.resolution_y = avc_export.render_request().get("resolution") or (640, 360)
    scene.render.resolution_percentage = 100
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.cycles.seed = 19
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    # Persistent shader data leaves one RGB level of frame-order drift on the dissolve boundary.
    scene.render.use_persistent_data = request["id"] != "dissolve"
    look.apply(scene, "agx-contrast")
    look.motion_blur(scene, 0.35)
    light.world(strength=shot["world"] if shot else 0.12, colour="#899da8")
    tl = anim.Timeline(range(-1, 66))
    city = request["id"] in {"procedural-city", "osm-city", "window-lights"}
    if not request.get("bare") and not city:
        if shot is None:
            if request["id"] not in {"studio-floor", "terrain"}:
                apply("studio-floor", {"colour": "#26301a"} if request["id"] == "sky-atmosphere" else {}, timeline=tl)
            if request["id"] != "sky-atmosphere":
                light.mood("soft-product", size=2, target=(0, 0, 0.9), use_world=False, scale={"fill": 0.65}).bake(tl)
        else:
            if request["id"] != "studio-floor":
                apply("studio-floor", {"colour": shot["floor"]}, timeline=tl)
            light.mood(shot["mood"], size=2, target=shot["target"], camera_yaw=shot["yaw"], use_world=False, scale=shot["scale"]).bake(tl)
    if request["id"] == "sky-atmosphere":
        for x in (-1.8, 0, 2.2):
            trees = apply("tree", {"height": 3 + x * 0.2, "seed": 41 + round(x * 2)}, timeline=tl)
            bpy.data.objects[trees["objects"][0]].location.x = x
    original_world = scene.world
    if shot is None:
        framing: dict[str, Any] = {
            "tree": {"target": (0, 0, 1.9), "subject": (8.5, 5.2)},
            "terrain": {"target": (0, 0, 0), "subject": (10, 6)},
            "sky-atmosphere": {"target": (0, 0, 1.4), "subject": (8.5, 4.8)},
        }.get(request["id"], {"target": (0, 0, 1.0), "subject": (4.8, 2.8)})
        rig = camera.Rig({"width": scene.render.resolution_x, "height": scene.render.resolution_y}, role="reveal", **framing, lens=60, fstop=0, yaw=12, pitch=16, fill=0.82)
    else:
        rig = camera.Rig(
            {"width": scene.render.resolution_x, "height": scene.render.resolution_y},
            role="hero",
            target=shot["target"],
            subject=shot["subject"],
            lens=shot["lens"],
            fstop=shot.get("fstop", 5.6),
            yaw=shot["yaw"],
            pitch=shot["pitch"],
            fill=0.86,
        )
    rig.bake(tl)
    result = apply(request["id"], request.get("params", {}), timeline=tl)
    if request["id"] == "dust-burst":
        bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.34, depth=0.12)
        impactor = bpy.context.object
        impactor.name = "AVC Proof impactor"
        impactor.data.materials.append(material("Impactor", (0.018, 0.024, 0.03, 1), 0.75, 0.26))
        bevel = impactor.modifiers.new("Machined edge", "BEVEL")
        bevel.width, bevel.segments = 0.018, 3
        tl.add(impactor, "location", lambda f: (0, 0, 0.06 + 1.15 * (1 - curves.progress(f, 0, 8, "glide")) + 0.08 * max(0, curves.follow_through(f, 8, damping=10, frequency=3))))
        result["objects"].append(impactor.name)
    if request["id"] == "neon-glow":
        mount_mat = material("Neon mount", (0.012, 0.017, 0.022, 1), 0.65, 0.32)
        for name, radius, depth, z in (("Neon base", 0.4, 0.09, 0.045), ("Neon post", 0.018, 0.04, 0.11)):
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=radius, depth=depth, location=(0, 0.14, z))
            mount = bpy.context.object
            mount.name = "AVC " + name
            mount.data.materials.append(mount_mat)
            bevel = mount.modifiers.new("Soft edge", "BEVEL")
            bevel.width, bevel.segments = min(depth / 3, 0.02), 3
            result["objects"].append(mount.name)
    if request["id"] == "ribbon-trail" and not request.get("params", {}).get("object"):
        marker = orb("Ribbon path marker", radius=0.075, mat=material("Path marker", (0.6, 0.23, 0.055, 1), 0.8, 0.2))

        def marker_position(f: float) -> tuple[float, ...]:
            u = curves.progress(f, 2, 50, "glide")
            t = u * math.tau * 0.8
            return (1.1 * math.cos(t), 0.55 * math.sin(t), 0.2 + 1.8 * u)

        tl.add(marker, "location", marker_position)
        result["objects"].append(marker.name)
    if request["id"] == "studio-floor":
        subject = orb("Floor contact proof", (0, 0, 0.8), mat=material("Floor proof satin", (0.24, 0.3, 0.32, 1), 0.4, 0.3))
        result["objects"].append(subject.name)
    if city:
        rig = city_rig(scene, tl, request["id"], meta["frames_hint"])
    tl.bake()
    middle = (scene.frame_end + scene.frame_start) // 2
    scene.frame_set(middle)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    polygons = 0
    for instance in depsgraph.object_instances:
        obj = instance.object
        if obj.hide_render:
            continue
        if obj.type in {"MESH", "CURVE", "FONT"}:
            evaluated = obj.evaluated_get(depsgraph)
            mesh = evaluated.to_mesh()
            polygons += len(mesh.polygons)
            evaluated.to_mesh_clear()
    instances = sum(1 for instance in depsgraph.object_instances if instance.is_instance)
    stats = {
        "recipe": request["id"],
        "objects": len(scene.objects),
        "polygons": polygons,
        "instances": instances,
        "result": result,
    }
    Path(avc_export.output_path("recipe-stats.json")).write_text(json.dumps(stats), encoding="utf8")
    # Project a floor-only patch in front of the grounded hero; comparison is against the identical empty stage.
    patch = ((-0.6, -0.65, 0.001), (0.6, -0.9, 0.001))
    if request["id"] == "caustics-glass":
        # A refracted front patch can brighten; the hard key casts its contact shadow behind/right.
        patch = ((0.8, 0.7, 0.001), (1.3, 1.1, 0.001))
    contact = [world_to_camera_view(scene, rig.obj, Vector(p)) for p in patch]
    width, height = scene.render.resolution_x, scene.render.resolution_y
    x0, x1 = sorted(round(p.x * width) for p in contact)
    y0, y1 = sorted(round((1 - p.y) * height) for p in contact)
    region = {"x": max(0, x0), "y": max(0, y0), "width": max(1, x1 - x0), "height": max(2, y1 - y0)}
    Path(avc_export.output_path("contact-region.json")).write_text(json.dumps(region), encoding="utf8")
    if request.get("emptyStage"):
        if request["id"] == "sky-atmosphere":
            scene.world = original_world
        for name in result["objects"]:
            obj = bpy.data.objects[name]
            if (obj.type != "LIGHT" or request["id"] == "sky-atmosphere") and (not obj.get("avc_floor") or request["id"] == "terrain"):
                obj.hide_render = True
    scene.frame_set(scene.frame_start)


main()
