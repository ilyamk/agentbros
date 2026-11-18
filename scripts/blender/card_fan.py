# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
r"""Build a fanned stack of brushed-metal cards on a pale table.

Fanned stack (flex t06): a dozen brushed-metal cards on a pale table fan out about one corner like a deck, under a
specular sweep, with shallow depth of field. Blender plate for library block `depth-card-flythrough` (mode "fan",
prop `plate`).

The fan keys and defaults are the block's (FAN_DEFAULTS, fanAngles in three-plan.ts): copy i rests at spread * i /
(copies - 1) and starts delay * i frames after the first, sine.inOut, every copy landing on frame at + fanFrames. The
cards are real solids (rounded outline, bevelled edge, 0.76 mm thick) with an anisotropic brushed finish whose grain
comes from a stretched noise; an original card face (a chip and two engraved lines), no brand.

Shot intent (reveal, 3 s, 90 frames): one card becomes a fan. The contract angles are kept exactly; on top of them each
card has weight: it lifts a hair off the one below while it travels and swings on a little when it stops (follow-
through growing with its place in the fan), so the fan reads as cards sliding, not a deck rotating as one. The camera
(detail role) starts low and cranes up to the block's `angle` as the fan opens, arcs from -28 to 10 degrees round it
and closes in by 6%; focus racks from the stack's front corner to the far edge as the fan lands. Light: kit mood
soft-product plus a 6500 K strip light travelling across the brushed metal (the glint), agx view, clean grade, motion
blur. Timing change: the shot was 60 frames; the fan still lands on `at + fanFrames`, and the rest is the settle.

Shot keys (plus toy_kit.COMMON): copies, spread (degrees), fanFrames, delay, at, colour, ground, chip (colour; "" for
none), sweep (true moves a strip light across), angle (camera elevation, degrees).
"""

from __future__ import annotations

import math

import bmesh
import bpy
from mathutils import Vector

import studio_kit as kit
import toy_kit as toy
from kit import anim, camera, curves, look, stage
from kit import light as lights

a = toy.args(
    {
        "copies": 12,
        "spread": 70.0,
        "fanFrames": 53,
        "delay": 2.0,
        "at": 0,
        "colour": "#1f6a45",
        "ground": "#e9e7e2",
        "chip": "#c9a65a",
        "sweep": True,
        "angle": 52.0,
        "lens": 60.0,
        "fstop": 2.2,
        "frames": 90,
    }
)
scene = toy.reset(a, look=None)
kit.hdri({"hdri": "softbox", "hdriStrength": 0.45, "hdriRotation": 0.0})

CW, CH, T, R = 0.0856, 0.054, 0.00076, 0.0032


def card_mesh(name: str) -> bpy.types.Object:
    """Rounded-rectangle prism with its pivot (bottom-left corner) at the origin, lying in XY."""
    outline = []
    for cx, cy, start in ((CW - R, R, -90), (CW - R, CH - R, 0), (R, CH - R, 90), (R, R, 180)):
        for k in range(9):
            t = math.radians(start + 90 * k / 8)
            outline.append((cx + R * math.cos(t), cy + R * math.sin(t)))
    bm = bmesh.new()
    bottom = [bm.verts.new((x, y, 0.0)) for x, y in outline]
    top = [bm.verts.new((x, y, T)) for x, y in outline]
    bm.faces.new(list(reversed(bottom)))
    bm.faces.new(top)
    n = len(outline)
    for i in range(n):
        bm.faces.new((bottom[i], bottom[(i + 1) % n], top[(i + 1) % n], top[i]))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = toy.link(bpy.data.objects.new(name, mesh))
    bevel = obj.modifiers.new("edge", "BEVEL")
    bevel.width = T * 0.35
    bevel.segments = 2
    bevel.limit_method = "ANGLE"
    return obj


def brushed(name: str, colour: tuple[float, ...]) -> bpy.types.Material:
    """Evaluate the brushed for this shot at a block frame."""
    mat = toy.principled(name, colour, roughness=0.3, Metallic=1.0, Anisotropic=0.85, Coat_Weight=0.4, Coat_Roughness=0.08)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    coord = nodes.new("ShaderNodeTexCoord")
    stretch = nodes.new("ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = (40.0, 4000.0, 40.0)
    links.new(coord.outputs["Object"], stretch.inputs["Vector"])
    grain = nodes.new("ShaderNodeTexNoise")
    grain.inputs["Detail"].default_value = 8.0
    links.new(stretch.outputs["Vector"], grain.inputs["Vector"])
    rough = nodes.new("ShaderNodeMapRange")
    rough.inputs["To Min"].default_value = 0.2
    rough.inputs["To Max"].default_value = 0.42
    links.new(grain.outputs["Fac"], rough.inputs["Value"])
    links.new(rough.outputs[0], nodes["Principled BSDF"].inputs["Roughness"])
    tangent = nodes.new("ShaderNodeTangent")
    tangent.direction_type = "RADIAL"
    tangent.axis = "Y"
    links.new(tangent.outputs[0], nodes["Principled BSDF"].inputs["Tangent"])
    return mat


metal = brushed("card", a["colour"])
chip = toy.principled("chip", a["chip"], roughness=0.25, Metallic=1.0) if a["chip"] else None
engrave = toy.principled("engrave", a["colour"], roughness=0.55, Metallic=0.6)
pivots = []
for i in range(a["copies"]):
    pivot = toy.empty(f"fan{i}", (0, 0, i * (T + 0.00035)))
    card = card_mesh(f"card{i}")
    card.data.materials.append(metal)
    card.parent = pivot
    if chip:
        c = toy.rounded_box(f"chip{i}", (0.011, 0.0085, 0.0002), 0.0008, segments=2)
        c.location = (0.012 + 0.0055, CH * 0.52, T + 0.0001)
        c.data.materials.append(chip)
        c.parent = pivot
    for k, width in enumerate((0.034, 0.022)):
        line = toy.rounded_box(f"line{i}-{k}", (width, 0.0016, 0.00008), 0.0003, segments=1)
        line.location = (0.012 + width / 2, CH * 0.22 - k * 0.0045, T + 0.00004)
        line.data.materials.append(engrave)
        line.parent = pivot
    pivots.append(pivot)

# Table: a large pale plane under the stack.
table = toy.mesh_object("table", [(-1, -1, -0.0002), (1, -1, -0.0002), (1, 1, -0.0002), (-1, 1, -0.0002)], [(0, 1, 2, 3)], smooth=False)
table.data.materials.append(toy.principled("table", a["ground"], roughness=0.7))
toy.world_colour(a["ground"], 0.3)

# ---------- motion: the block's fan, plus weight ----------
F = a["frames"]


def fan_angles(frame: float) -> list[float]:
    """three-plan.ts fanAngles: the contract."""
    copies, spread, frames, delay = a["copies"], a["spread"], a["fanFrames"], a["delay"]
    window = max(1.0, frames - delay * (copies - 1))
    out = []
    for i in range(copies):
        target = 0.0 if copies <= 1 else spread * i / (copies - 1)
        out.append(target * toy.EASES["sine.inOut"](toy.clamp01((frame - a["at"] - delay * i) / window)))
    return out


def card_pose(i: int, f: float) -> tuple[float, float]:
    r"""Return the card angle and its settling motion at a block frame.

    Contract angle, plus each card's own follow-through when it stops (a metal card has weight), and a lift: the card
    rises a hair off the one below while it travels, so the fan reads as cards sliding, not a deck rotating as one.
    """
    copies, delay = a["copies"], a["delay"]
    window = max(1.0, a["fanFrames"] - delay * (copies - 1))
    start, stop = a["at"] + delay * i, a["at"] + delay * i + window
    travel = curves.clamp01((f - start) / window)
    swing = curves.follow_through(f, stop, 1.4 * (i / max(1, copies - 1)), damping=7, frequency=2.6)
    lift = 0.0006 * math.sin(math.pi * travel)
    return fan_angles(f)[i] + swing, lift


tl = anim.Timeline(range(F))
for i, pivot in enumerate(pivots):
    base_z = pivot.location.z
    tl.add(pivot, "rotation_euler", lambda f, i=i: (0.0, 0.0, math.radians(card_pose(i, f)[0])))
    tl.add(pivot, "location", lambda f, i=i, z=base_z: (0.0, 0.0, z + card_pose(i, f)[1]))

# ---------- camera: a low three-quarter cranes up to the block's angle and arcs round the opening fan ----------
centre = Vector((CW * 0.35, CH * 0.9, 0.004))
cam = camera.Rig(a, role="detail", target=tuple(centre), subject=(0.16, 0.12), lens=a["lens"], fstop=a["fstop"], yaw=-28.0, pitch=a["angle"] - 30.0, distance=0.36)
cam.crane(a["angle"] - 30.0, a["angle"], at=0, frames=a["fanFrames"] + 10, intent="glide")
cam.orbit(-28.0, 10.0, at=0, frames=F - 1, intent="glide")
cam.dolly(0.94, at=0, frames=F - 1, intent="glide")
cam.handheld(0.04, seed=a["seed"] + 5)
# Focus starts on the stack's front corner and racks to the far edge of the opened fan as it lands.
cam.rack((CW * 0.6, CH * 0.2, 0.004), (CW * 0.1, CH * 1.3, 0.004), at=a["fanFrames"] - 18, frames=20, intent="snap")
cam.bake(tl)

# ---------- light: soft product, a strip light glinting across the brushed metal as the fan opens ----------
mood = lights.mood("soft-product", target=tuple(centre), size=0.1, camera_yaw=0.0, use_world=False, exposure=6.0, scale={"rim": 1.4})
strip = kit.area("strip", 5.0, 0.5, (-0.3, 0.05, 0.25), target=tuple(centre), ratio=0.06)
strip.data.use_temperature = True
strip.data.temperature = 6500


def strip_location(f: float) -> tuple[float, float, float]:
    """Evaluate the strip location for this shot at a block frame."""
    t = curves.progress(f, 8, F - 16, "glide") if a["sweep"] else 0.0
    return (curves.mix(-0.35, 0.45, t), 0.05, 0.25)


tl.add(strip, "location", strip_location)
tl.add(strip, "rotation_euler", lambda f: tuple((centre - Vector(strip_location(f))).to_track_quat("-Z", "Y").to_euler()))
look.apply(scene, "agx")
look.motion_blur(scene, 0.5)
look.grade(scene, "clean")

tl.bake()
stage.report(scene, cam.obj, {"hero": [p.children[0] for p in pivots]}, floor_z=0.0, contact=[pivots[0].children[0]], frames=[1, a["fanFrames"] + 1, F])
