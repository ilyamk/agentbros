# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Reveal a skyline's identity as dusk office lights lead the eye to a rooftop wordmark.

Function: establishing reveal. A drone arcs across the street grid, eases towards a taller
landmark, then settles as the sign reaches full brightness. Metres, 48 mm, warm setting sun
against a cool dusk world, restrained atmospheric depth and bloom. No simulation or network.
Keys: seed (31), frames (96), variant (a|b), logo (AVC), blocks (5).
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import avc_export
import bpy
from avc_recipes import apply

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "recipes"))
from _city import box_data
from _common import material, mesh
from kit import anim, camera, curves, light, look
from window_lights import animate


def main() -> None:
    """Build the directed shot; avc_run owns rendering and profile isolation."""
    argv = sys.argv[sys.argv.index("--") + 1 :]
    raw = json.loads(argv[0]) if argv else {}
    if not isinstance(raw, dict) or raw.keys() - {"seed", "frames", "variant", "logo", "blocks"}:
        msg = "Unknown city shot keys"
        raise ValueError(msg)
    p = {"seed": 31, "frames": 96, "variant": "b", "logo": "AVC", "blocks": 5, **raw}
    if type(p["frames"]) is not int or not 3 <= p["frames"] <= 300 or p["variant"] not in {"a", "b"} or not isinstance(p["logo"], str) or len(p["logo"]) > 12:
        msg = "Invalid city frames/variant/logo"
        raise ValueError(msg)
    scene = bpy.context.scene
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene.frame_start, scene.frame_end = 1, p["frames"]
    scene.render.fps = 30
    scene.render.resolution_x, scene.render.resolution_y = avc_export.render_request().get("resolution") or (480, 270)
    scene.render.resolution_percentage = 100
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 8
    scene.cycles.seed = p["seed"]
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 5
    scene.cycles.volume_bounces = 0
    scene.render.use_persistent_data = True
    look.apply(scene, "agx", exposure=0.4)
    look.motion_blur(scene, 0.3)
    look.grade(scene, "clean", bloom=0.12, threshold=1.3, vignette=0.12)
    background = light.world(strength=0.22, colour="#8297bc")
    sky = scene.world.node_tree.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING" if "MULTIPLE_SCATTERING" in sky.bl_rna.properties["sky_type"].enum_items else "NISHITA"
    sky.sun_elevation, sky.sun_rotation = math.radians(-2), math.radians(125)
    sky.sun_disc = False
    sky.air_density = 1.2
    if hasattr(sky, "aerosol_density"):
        sky.aerosol_density = 3.0
    else:
        sky.dust_density = 3.0
    scene.world.node_tree.links.new(sky.outputs["Color"], background.inputs["Color"])
    duration = p["frames"] - 1
    tl = anim.Timeline(range(-2, p["frames"] + 2))
    height = 148 if p["variant"] == "a" else 150
    city = apply("procedural-city", {"seed": p["seed"], "blocks": p["blocks"], "hero_height": height}, timeline=tl)
    for name in city["objects"]:
        obj = bpy.data.objects[name]
        if obj.get("avc_city_windows"):
            animate(obj, {"start": duration * 0.08, "duration": duration * 0.58, "strength": 0.95}, tl)
    lights = light.mood("golden-hour", size=180, target=(0, 0, 50), camera_yaw=22, exposure=2.8, use_world=False, only=["sun", "sky"])
    lights.bake(tl)
    # Bounded local haze avoids an infinite world volume and stays reusable offline.
    verts, faces = [], []
    box_data(verts, faces, (0, 180, 125), (1100, 1100, 350))
    haze = mesh("Dusk atmospheric depth", verts, faces)
    fog = bpy.data.materials.new("Dusk haze")
    fog.use_nodes = True
    fog.node_tree.nodes.clear()
    volume = fog.node_tree.nodes.new("ShaderNodeVolumePrincipled")
    volume.inputs["Density"].default_value = 0.00065 if p["variant"] == "a" else 0.00035
    volume.inputs["Color"].default_value = (0.42, 0.52, 0.7, 1)
    volume.inputs["Anisotropy"].default_value = 0.25
    output = fog.node_tree.nodes.new("ShaderNodeOutputMaterial")
    fog.node_tree.links.new(volume.outputs["Volume"], output.inputs["Volume"])
    haze.data.materials.append(fog)
    # Low-rise surroundings carry the skyline into depth instead of ending at a studio floor.
    import random

    rng = random.Random(p["seed"] + 901)
    verts, faces = [], []
    for row in range(16):
        for col in range(34):
            x, y = (col - 16.5) * 42, 230 + row * 44
            h = rng.uniform(8, 52)
            box_data(verts, faces, (x, y, h / 2), (rng.uniform(16, 28), rng.uniform(18, 30), h))
    mesh("Distant residential skyline", verts, faces, material("Distant masonry", (0.11, 0.12, 0.15, 1), 0.12, 0.65))
    verts, faces = [], []
    box_data(verts, faces, (0, -10.12, height - 8.8), (23, 0.18, 11))
    mesh("Landmark sign backing", verts, faces, material("Landmark sign backing", (0.018, 0.025, 0.035, 1), 0.3, 0.4))
    # Real geometry sign, attached to the landmark's front face; no screen stand-in.
    text = bpy.data.curves.new("Landmark rooftop wordmark", "FONT")
    text.body, text.align_x, text.size, text.extrude, text.bevel_depth = p["logo"], "CENTER", 8.5, 0.12, 0.035
    sign = bpy.data.objects.new("Landmark identity", text)
    scene.collection.objects.link(sign)
    sign.location, sign.rotation_euler = (0, -10.2, height - 12), (math.pi / 2, 0, 0)
    sign_mat = material("Landmark sign", (0.97, 0.73, 0.4, 1), 0.15, 0.3)
    text.materials.append(sign_mat)
    group = next(n.node_tree for n in sign_mat.node_tree.nodes if n.type == "GROUP")
    shader = next(n for n in group.nodes if n.type == "BSDF_PRINCIPLED")
    tl.add(shader.inputs["Emission Strength"], "default_value", lambda f: 4 * curves.progress(f, duration * 0.55, duration * 0.2, "brake"), combine="set")
    wide = p["variant"] == "a"
    rig = camera.Rig(
        {"width": scene.render.resolution_x, "height": scene.render.resolution_y},
        role="establishing",
        target=(0, 0, 68 if wide else 70),
        subject=(300, 180),
        lens=48,
        fstop=0,
        distance=580 if wide else 590,
        yaw=25,
        pitch=25 if wide else 16,
    )
    rig.obj.data.clip_end = 50000
    rig.orbit(30, 12, at=0, frames=duration * 0.86, intent="glide")
    rig.dolly(0.88, at=0, frames=duration * 0.88, intent="brake")
    rig.crane(25 if p["variant"] == "a" else 16, 18 if p["variant"] == "a" else 12, at=0, frames=duration * 0.85, intent="glide")
    rig.bake(tl)
    tl.bake()
    scene.frame_set(1)
    data = {
        "intent": (__doc__ or "").splitlines()[0],
        "params": p,
        "city": city,
        "camera": {"lens": 48, "role": "establishing", "motion": "arc and eased drone approach; final 12% hold"},
        "render": {"samples": 8, "denoise": True, "seed": p["seed"]},
    }
    Path(avc_export.output_path("city-shot.json")).write_text(json.dumps(data, indent=2))


main()
