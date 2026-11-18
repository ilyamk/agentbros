# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Glossy orb character (ace t05), the Blender plate for library block `shaded-orb` (mode "glossy", prop `plate`).

Shot intent (hook or reveal, 3.2 s): a coated orb springs up out of the ground, shifts colour, opens its eyes, floods with
a second colour, then lives: it glances left and right, blinks, does a small hop and lands looking at the camera.

Timing contract: the block's ACE_ORB windows are kept exactly (grow from `at` for `grow` frames, sine.out; shift; eyes;
flood), so the block's cues land on the plate. Everything after the flood (block frame at + 23) is new performance, and
the overshoot of the growth rides on top of the contract's scale (a squash-and-stretch that settles), not instead of it.

Direction:
- Contact: the orb sits on the ground and grows from its contact point; a shadow catcher puts its real contact shadow on
  the ground, composited over exactly `ground` (kit.look.grade background) under the Standard view, so the plate's ground
  equals the block's ground hex. The old plate floated with no shadow.
- Eyes read as eyes: the block's tall white pills, matte (no coat, no gloss) and sitting proud of the surface, so they
  cannot be mistaken for the coat's highlights; the HDRI is turned so its softboxes reflect away from the eyes. They
  open with a stretch, look by sliding over the sphere, and blink.
- Motion: stretch while growing and a squash that rings out on arrival (volume kept); glances lead, the body follows two
  frames late; a hop with anticipation, stretch, landing squash and settle.
- Camera: 60 mm hero, a touch above, pushing in on a glide and tilting with the hop a few frames late.
- Light: kit mood "high-key" (bright commercial, 1.25:1) with the studio HDRI in the coat.

Shot keys (plus toy_kit.COMMON): ground, at, size (diameter as a share of the frame's shorter side at the start), colour,
shiftTo, flood ("" for none), eyes, timing {grow, shiftAt, shift, eyesAt, eyes, floodAt, flood}, hdri, hdriRotation, push.
"""

from __future__ import annotations

import math

from mathutils import Vector

import studio_kit as studio
import toy_kit as toy
from kit import anim, camera, curves, look, stage
from kit import light as lights

ACE_ORB = {"grow": 11, "shiftAt": 11, "shift": 4, "eyesAt": 16, "eyes": 3, "floodAt": 20, "flood": 3}

a = toy.args(
    {
        "ground": "#f4f4f2",
        "at": 6,
        "size": 0.4,
        "colour": "#86f2d9",
        "shiftTo": "#5fe3f4",
        "flood": "#38d98f",
        "eyes": True,
        "timing": {},
        "hdri": "studio",
        "hdriRotation": 140.0,
        "push": 0.86,
        "frames": 96,
        "lens": 60.0,
    }
)
t = {**ACE_ORB, **a["timing"]}
scene = toy.reset(a, view="Standard", look=None)
scene.render.film_transparent = True
F = a["frames"]
R = 0.3

# ---------- the orb: coated sphere, colour shift and bottom-up flood (as before) ----------
orb = toy.uv_sphere("orb", R, segments=96, rings=48)
mat = toy.principled("orb", a["colour"], roughness=0.2, Coat_Weight=1.0, Coat_Roughness=0.07, Subsurface_Weight=0.12, Specular_IOR_Level=0.55)
nodes, links = mat.node_tree.nodes, mat.node_tree.links
bsdf = nodes["Principled BSDF"]
body = nodes.new("ShaderNodeMix")
body.data_type = "RGBA"
body.inputs["A"].default_value = (*studio.hex_rgb(a["colour"]), 1)
body.inputs["B"].default_value = (*studio.hex_rgb(a["shiftTo"]), 1)
coord = nodes.new("ShaderNodeTexCoord")
sep = nodes.new("ShaderNodeSeparateXYZ")
links.new(coord.outputs["Object"], sep.inputs[0])
level = nodes.new("ShaderNodeValue")
edge = nodes.new("ShaderNodeMapRange")
edge.interpolation_type = "SMOOTHSTEP"
links.new(sep.outputs["Z"], edge.inputs["Value"])
links.new(level.outputs[0], edge.inputs["From Min"])
plus = nodes.new("ShaderNodeMath")
plus.operation = "ADD"
plus.inputs[1].default_value = R * 0.04
links.new(level.outputs[0], plus.inputs[0])
links.new(plus.outputs[0], edge.inputs["From Max"])
edge.inputs["To Min"].default_value = 1.0
edge.inputs["To Max"].default_value = 0.0
flooded = nodes.new("ShaderNodeMix")
flooded.data_type = "RGBA"
links.new(body.outputs["Result"], flooded.inputs["A"])
flooded.inputs["B"].default_value = (*studio.hex_rgb(a["flood"] or a["shiftTo"]), 1)
links.new(edge.outputs[0], flooded.inputs["Factor"])
links.new(flooded.outputs["Result"], bsdf.inputs["Base Color"])
orb.data.materials.append(mat)

# ---------- eyes: the block's tall white pills, matte, proud of the surface, on a pivot at the centre ----------
gaze = toy.empty("gaze")
gaze.parent = orb
eyes = []
if a["eyes"]:
    white = toy.principled("eye", "#ffffff", roughness=0.55, Specular_IOR_Level=0.2, Emission_Color=(1, 1, 1, 1), Emission_Strength=0.18)
    for side in (-1, 1):
        x, z = side * 0.24 * R, 0.23 * R
        normal = Vector((x, -math.sqrt(R * R - x * x - z * z), z)).normalized()
        eye = toy.uv_sphere(f"eye{side}", 1.0, tuple(normal * R * 0.992), segments=32, rings=16)
        # Local Y along the surface normal (the pill's thickness), Z up the face; the block's 6-degree lean.
        eye.rotation_euler = normal.to_track_quat("Y", "Z").to_euler()
        eye.rotation_euler.rotate_axis("Y", math.radians(side * 6))
        eye.scale = (0.066 * R, 0.02 * R, 0.2 * R)
        eye.data.materials.append(white)
        eye.parent = gaze
        eyes.append(eye)

# ---------- ground: shadow catcher over the exact ground colour ----------
catcher = toy.mesh_object("ground", [(-20, -20, 0), (20, -20, 0), (20, 20, 0), (-20, 20, 0)], [(0, 1, 2, 3)], smooth=False)
catcher.is_shadow_catcher = True

# ---------- performance ----------
AT = a["at"]
GROWN = AT + t["grow"]
FLOODED = AT + t["floodAt"] + t["flood"]
LOOK_L, LOOK_R, BLINK, HOP = FLOODED + 4, FLOODED + 17, FLOODED + 30, FLOODED + 36
HOP_CROUCH, HOP_AIR = 6, 12
LAND = HOP + HOP_CROUCH + HOP_AIR


def window(f: float, start: float, frames: float) -> float:
    """Evaluate the window for this shot at a block frame."""
    return 1.0 if frames <= 0 else curves.clamp01((f - AT - start) / frames)


def state(f: float) -> dict[str, float]:
    """The block's contract (three-plan.ts orbState)."""
    return {
        "scale": 1.0 if t["grow"] <= 0 else math.sin(math.pi / 2 * window(f, 0, t["grow"])),
        "shift": -(math.cos(math.pi * window(f, t["shiftAt"], t["shift"])) - 1) / 2,  # sine.inOut
        "eyes": window(f, t["eyesAt"], t["eyes"]),
        "flood": 1 - (1 - window(f, t["floodAt"], t["flood"])) ** 2,
    }


def hop(f: float) -> tuple[float, float]:
    """Evaluate the hop for this shot at a block frame."""
    return curves.hop(f, HOP, crouch=HOP_CROUCH, air=HOP_AIR, height=0.32 * R, squash=0.12, stretch=0.14, settle=12)


def stretch(f: float) -> float:
    """Evaluate the stretch for this shot at a block frame."""
    growing = window(f, 0, t["grow"])
    shoot = 0.1 * (1 - growing) if 0 < growing < 1 else 0.0
    arrive = curves.follow_through(f, GROWN, -0.11, damping=6.5, frequency=2.7)
    return (1 + shoot + arrive) * hop(f)[1] * curves.breathe(f, period=46, amount=0.01)


def orb_scale(f: float) -> tuple[float, float, float]:
    """Evaluate the orb scale for this shot at a block frame."""
    s = max(1e-4, state(f)["scale"])
    sx, sy, sz = curves.volume_scale(stretch(f))
    return (s * sx, s * sy, s * sz)


def orb_location(f: float) -> tuple[float, float, float]:
    """Evaluate the orb location for this shot at a block frame."""
    s = max(1e-4, state(f)["scale"])
    return (0.0, 0.0, R * s * curves.volume_scale(stretch(f))[2] + hop(f)[0])


def glance(f: float) -> float:
    """Eye yaw over the sphere (degrees): left, right, back to camera for the hop."""
    return curves.track(f, [(LOOK_L, 0.0), (LOOK_L + 5, -22.0, "brake"), (LOOK_R, -22.0), (LOOK_R + 4, 20.0, "snap"), (HOP - 2, 20.0), (HOP + 4, 0.0, "settle")])


def gaze_rotation(f: float) -> tuple[float, float, float]:
    """Evaluate the gaze rotation for this shot at a block frame."""
    up = 6.0 * curves.progress(f, HOP + HOP_CROUCH, HOP_AIR // 2, "brake") * (1 - curves.progress(f, LAND, 8, "glide"))
    return (math.radians(up), 0.0, math.radians(glance(f)))


def body_yaw(f: float) -> float:
    """Evaluate the body yaw for this shot at a block frame."""
    return math.radians(0.3 * curves.delayed(glance, f, 2))


def eye_scale(f: float, base: tuple[float, float, float]) -> tuple[float, float, float]:
    """Evaluate the eye scale for this shot at a block frame."""
    opened = curves.progress(f, AT + t["eyesAt"], max(1, t["eyes"]), "punch") if t["eyes"] else 1.0
    lid = curves.blinks(f, [BLINK, LAND + 8])
    return (base[0], base[1], base[2] * max(0.02, opened * lid))


tl = anim.Timeline(range(F))
tl.add(orb, "scale", orb_scale)
tl.add(orb, "location", orb_location)
tl.add(orb, "rotation_euler", lambda f: (0.0, 0.0, body_yaw(f)))
tl.add(orb, "hide_render", lambda f: state(f)["scale"] <= 0)
tl.add(gaze, "rotation_euler", gaze_rotation)
tl.add(body.inputs["Factor"], "default_value", lambda f: state(f)["shift"])
tl.add(level.outputs[0], "default_value", lambda f: -R * 1.06 + (state(f)["flood"] if a["flood"] else 0.0) * R * 2.12)
for eye in eyes:
    base = tuple(eye.scale)
    tl.add(eye, "scale", lambda f, b=base: eye_scale(f, b))
    tl.add(eye, "hide_render", lambda f: state(f)["eyes"] <= 0)

# ---------- camera, light, look ----------
cam = camera.Rig(a, role="hero", target=(0, 0, R * 0.95), subject=(2 * R, 2 * R), lens=a["lens"], fstop=0.0, pitch=7.0, fill=a["size"])
cam.push_in(a["push"], at=0, frames=F - 1, intent="glide")
cam.crane(5.0, 9.0, at=0, frames=F - 1, intent="glide")
cam.follow(lambda f: (0.0, 0.0, hop(f)[0] * 0.3), half_life=4.0)
cam.bake(tl)
mood = lights.mood("high-key", target=(0, 0, R), size=2 * R, exposure=2.3, only=("key", "fill", "top"), camera_yaw=-22.0, hdri_rotation=a["hdriRotation"], world_strength=0.32)
# The fill only lifts the shade side: no second shadow across the ground. The key sits high camera-left, so its
# highlight lands on the upper left of the coat, away from the eyes.
mood.light("fill").data.use_shadow = False
# The HDRI is for the coat's reflections only: no light or shadow from it on the ground.
scene.world.cycles_visibility.diffuse = False
scene.world.cycles_visibility.transmission = False
look.apply(scene, "standard")
look.motion_blur(scene, 0.5)
look.grade(scene, "clean", background=a["ground"], vignette=0.0, bloom=0.0)

tl.bake()
stage.report(scene, cam.obj, {"hero": [orb]}, floor_z=0.0, contact=[orb], frames=[GROWN + 1, LAND + 1, F])
studio.finish()
