# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
r"""Build and animate an original plush character on a warm paper sweep.

Plush character: an original soft toy (toy_kit.plush) with a performance, on a warm paper sweep. Play it with library
block `blender-plate`.

Shot intent (hook, 3.5 s): the toy is caught looking away, notices the camera, hops towards it, lands with weight and
says hello with a tilt and a blink, then a small happy bounce and a living hold that loops.

Direction, by kit piece:
- Performance (kit.character rig, kit.curves): idle breathing; the head turns first (anticipation and overshoot) and the
  body follows four frames later (overlap); a crouch (anticipation), a hop on a true parabola with stretch, a landing
  squash that rings out (settle), ears that drag on take-off and flop on landing (follow-through), arms that lift late,
  a head tilt to camera, two blinks, a two-hop happy bounce, breathing to the last frame. Volume is kept in every squash.
- Camera (kit.camera.Rig, role hero): 75 mm, f/2.2, slightly low; opens with focus 30 cm behind the toy and pulls onto it
  as it wakes; a slow glide push-in and orbit to the front over the shot, tilting with the hop a few frames late, and a
  whisper of handheld so the hold breathes.
- Light (kit.light "soft-product", warm key): a 2.2:1 key-to-fill ratio with a cool rim, the rim sweeping a little.
- Look: AgX medium-high contrast, motion blur at a 180-degree shutter, the "clean" grade with a little warmth.

Timing: blender-plate has no timing contract of its own (its `land` cue is the plate's last frame), so the shot is 105
frames. Cue frames for type: notice 14, take-off 30, land 44, hello 56, bounce 74.

Shot keys (plus toy_kit.COMMON): colours (keys of toy_kit.PLUSH), tall (metres), backdrop, mood (kit.presets.MOODS),
grade, handheld (degrees), push (dolly factor), hop (height in toy heights).
"""

from __future__ import annotations

import math

import studio_kit as studio
import toy_kit as toy
from kit import anim, camera, character, curves, look, stage
from kit import light as lights

a = toy.args({"colours": {}, "tall": 0.3, "backdrop": "#e6d8c6", "mood": "soft-product", "grade": "clean", "handheld": 0.06, "push": 0.84, "hop": 0.32, "frames": 105, "lens": 75.0, "fstop": 2.2})
scene = toy.reset(a, look=None)
h = a["tall"]
F = a["frames"]

# ---------- set and character ----------
stage.sweep(a["backdrop"], size=h * 1.3, roughness=0.62)
root, body = toy.plush(height=h, colours=a["colours"], seed=a["seed"])
rig = character.rig_plush(root, body, h)
arm = rig.armature
stage.rest_on(arm, [rig.mesh], 0.0)
base_z = arm.location.z
eyes = rig.eyes()
eye_scale = {eye.name: tuple(eye.scale) for eye in eyes}

# ---------- performance (block frames) ----------
NOTICE, HOP, CROUCH, AIR = 14, 22, 8, 14
TAKE_OFF, LAND = HOP + CROUCH, HOP + CROUCH + AIR
HELLO, BOUNCE = 56, 74
travel = 0.2 * h  # towards the camera, over the flight


def hop(f: float) -> tuple[float, float]:
    """Evaluate the hop for this shot at a block frame."""
    lift, s = curves.hop(f, HOP, crouch=CROUCH, air=AIR, height=a["hop"] * h, squash=0.15, stretch=0.16, settle=13)
    blift, bs = curves.bounces(f, BOUNCE, count=2, height=0.075 * h, air=8, squash=0.08, stretch=0.07)
    return lift + blift, s * bs


def airborne(f: float) -> float:
    """Evaluate the airborne for this shot at a block frame."""
    return 1.0 if TAKE_OFF < f < LAND else 0.0


def forward(f: float) -> float:
    """Evaluate the forward for this shot at a block frame."""
    return -travel * curves.progress(f, TAKE_OFF, AIR, "linear")


def vertical_speed(f: float) -> float:
    """Evaluate the vertical speed for this shot at a block frame."""
    return (hop(f + 0.5)[0] - hop(f - 0.5)[0]) / h


def body_location(f: float) -> tuple[float, float, float]:
    """Evaluate the body location for this shot at a block frame."""
    lift, _ = hop(f)
    return (0.0, forward(f), base_z + lift)


def body_yaw(f: float) -> float:
    # The body follows the head's turn four frames late, carried round during the flight (overlap).
    """Evaluate the body yaw for this shot at a block frame."""
    return -14.0 * (1 - curves.progress(f, NOTICE + 4, LAND - NOTICE - 4, "glide"))


def squash(f: float) -> float:
    """Evaluate the squash for this shot at a block frame."""
    _, s = hop(f)
    return s * curves.breathe(f, period=42, amount=0.012)


def lean(f: float) -> float:
    """Body pitch (degrees, + towards camera): into the crouch, back in the climb, forward on the landing, settling."""
    crouch = (1 - hop(f)[1]) / 0.15 if f <= TAKE_OFF else 0.0
    return 9 * crouch * (1 if f <= TAKE_OFF else 0) - 5 * airborne(f) * (1 - curves.progress(f, TAKE_OFF, AIR, "float")) + curves.follow_through(f, LAND, 7, damping=7, frequency=2.4)


def head_yaw(f: float) -> float:
    r"""Turn the head towards the camera ahead of the body.

    Relative to the body: looking off to screen left, then the head snaps to camera first (anticipation, overshoot)
    and holds there while the body, still turned, catches up under it.
    """
    turn = curves.anticipate(f, NOTICE - 1, wind=3, action=6, amount=0.07, overshoot=0.12)
    return -28 * (1 - turn) - body_yaw(f) * turn


def head_nod(f: float) -> float:
    """Evaluate the head nod for this shot at a block frame."""
    crouch = (1 - hop(f)[1]) / 0.15 if f <= TAKE_OFF else 0.0
    return 6 * crouch - 7 * airborne(f) + curves.follow_through(f, LAND, 10, damping=6.5, frequency=2.6) + 2.5 * math.sin(f / 30 * 2 * math.pi * 0.45)


def head_tilt(f: float) -> float:
    """Evaluate the head tilt for this shot at a block frame."""
    hello = 13 * curves.progress(f, HELLO, 12, "settle")
    return hello + curves.follow_through(f, BOUNCE + 9, -4, damping=6, frequency=2.2)


def ear_flop(f: float, side: str) -> float:
    """Ears drag behind the vertical speed (two frames late) and ring on each landing."""
    drag = -60 * curves.delayed(vertical_speed, f, 2)
    ring = curves.jiggle(f, [(TAKE_OFF + 1, -10), (LAND, 18), (BOUNCE + 12, 9), (BOUNCE + 20, 6)], damping=6, frequency=3.2)
    idle = 2.5 * curves.noise(f / 30 * 1.3, f"ear{side}")
    return drag + ring + idle


def arm_lift(f: float, _side: str) -> float:
    """Evaluate the arm lift for this shot at a block frame."""
    late = curves.delayed(airborne, f, 2)
    wave = 22 * curves.progress(f, BOUNCE - 2, 6, "brake") * (1 - curves.progress(f, BOUNCE + 22, 10, "glide"))
    return 32 * late + wave + curves.jiggle(f, [(LAND + 2, -14), (BOUNCE + 12, -6)], damping=7, frequency=3.0)


tl = anim.Timeline(range(F))
pb = rig.pose_bone
tl.add(arm, "location", body_location)
tl.add(arm, "rotation_euler", lambda f: (0.0, 0.0, math.radians(body_yaw(f))))
# Bone axes: Y runs along the bone (world up for root, body, head), so a squash scales Y and keeps volume in X and Z.
tl.add(pb("root"), "scale", lambda f: (curves.volume_scale(squash(f))[0], squash(f), curves.volume_scale(squash(f))[0]))
tl.add(pb("body"), "rotation_euler", lambda f: (math.radians(lean(f)), 0.0, 0.0))
tl.add(pb("head"), "rotation_euler", lambda f: (math.radians(head_nod(f)), math.radians(head_yaw(f)), math.radians(-head_tilt(f))))
for side, sign in (("L", -1), ("R", 1)):
    tl.add(pb(f"ear.{side}"), "rotation_euler", lambda f, s=side, g=sign: (math.radians(ear_flop(f, s)), 0.0, math.radians(g * 0.4 * ear_flop(f, s))))
    tl.add(pb(f"arm.{side}"), "rotation_euler", lambda f, s=side, g=sign: (math.radians(-0.35 * arm_lift(f, s)), 0.0, math.radians(g * arm_lift(f, s))))
for eye in eyes:
    tl.add(eye, "scale", lambda f, base=eye_scale[eye.name]: character.blink_scale(curves.blinks(f, [8, 63, 92]), base))

# ---------- camera ----------
cam = camera.Rig(a, role="hero", target=(0, 0, 0.47 * h), subject=(0.7 * h, 1.15 * h), lens=a["lens"], fstop=a["fstop"], yaw=11.0, fill=0.7)
cam.orbit(11.0, 3.0, at=0, frames=F - 1, intent="glide")
cam.push_in(a["push"], at=0, frames=F - 1, intent="glide", pull_from=0.3, pull_frames=16)
cam.follow(lambda f: (0.0, forward(f) * 0.6, hop(f)[0] * 0.35), half_life=4.0)
cam.handheld(a["handheld"], seed=a["seed"] + 7)
cam.bake(tl)

# ---------- light and look ----------
mood = lights.mood(a["mood"], target=(0, 0, 0.45 * h), size=h, camera_yaw=8.0, world_strength=0.14, scale={"rim": 1.7, "fill": 0.7, "top": 0.6})
mood.sweep("rim", 145, 165, at=0, frames=F - 1, intent="glide").bake(tl)
look.apply(scene, "agx")
look.motion_blur(scene, 0.5)
look.grade(scene, a["grade"], warmth=0.03)

tl.bake()
stage.report(scene, cam.obj, {"hero": [rig.mesh]}, floor_z=0.0, contact=[rig.mesh], frames=[1, LAND + 1, HELLO + 8, F])
studio.finish()
