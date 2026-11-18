# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
r"""Build a floating island and plush character under a glass dome.

Glass dome world (muse t03 and t16): a floating island under a thin-film glass dome, the plush inside at a desk,
glassy tiles orbiting just inside the glass. Play it with library block `blender-plate`.

Shot intent (reveal, 3.5 s, 105 frames): from an establishing angle we discover a small world; the camera cranes down and
orbits to the front while pushing in, braking onto the plush as it stops typing and looks up at us (frame LOOK_UP = 64)
with a blink; the tiles rise round it in a seeded stagger; focus racks from the tiles to its face; the hold breathes.

Direction:
- Glass: a real shell (Solidify, so it refracts as glass, not as a solid lens) with a Principled thin film of 180-640 nm
  whose thickness follows a noise, so the rainbow bands read at the rim.
- Character: toy_kit.plush on kit.character's armature rig (the same plush as plush_character.py): typing arms,
  anticipation into the look-up, ears that follow through, a breathing hold.
- Light: kit mood golden-hour without the HDRI: a low warm sun, a blue procedural sky (toy_kit.sky_world) and a warm
  bounce; the sky and bounce lights stay out of glossy and transmission rays, so the glass shows the sky, not softboxes.
- Look: agx-punchy (the light's colour is the subject), filmic grade, motion blur.

view "side" (t03): the reveal above; `push` sets how far the dolly closes in, `ease` overrides its intent (kit.curves
name, default brake). view "overhead" (t16): straight down on the dome floating over water (swell, foam and a shadow
layer), pulling out by `push` (glide) with a slow roll. Timing change: the shot was 64 frames with a power2.in push;
the plate block reads `frameCount`, so the longer shot needs no block change.

Shot keys (plus toy_kit.COMMON): view, push, ease, tiles (count), tileColours, orbitDegrees (over the shot), film
(thin-film thickness range in nm, [min, max]), filmIor (a film far from the glass's 1.52 gives strong colours), plushColours, sky {zenith, horizon, clouds}.
"""

from __future__ import annotations

import math

from mathutils import Vector

import studio_kit as kit
import toy_kit as toy
from kit import anim, camera, character, curves, look, stage
from kit import light as lights

a = toy.args(
    {
        "view": "side",
        "push": 0.45,
        "ease": None,
        "tiles": 6,
        "tileColours": ["#ff6b5a", "#ffc94a", "#4fb7ff", "#7c6cff", "#38d98f", "#ff7ac6"],
        "orbitDegrees": 40.0,
        "film": [180.0, 640.0],
        "filmIor": 1.9,
        "plushColours": {},
        "sky": {"zenith": "#2a62c9", "horizon": "#b9d3f2", "clouds": 0.75},
        "frames": 105,
        "lens": 40.0,
        "fstop": 4.0,
    }
)
overhead = a["view"] == "overhead"
scene = toy.reset(a, look=None)
scene.cycles.transparent_max_bounces = 16
toy.sky_world(**a["sky"], strength=1.5, seed=a["seed"])
# Light mood: golden hour. A low warm sun from behind camera-left rakes the island and lights the dome's rim, where the
# thin film shows; the cool sky does the fill (kit.presets.MOODS["golden-hour"], sky world instead of the HDRI).
mood = lights.mood("golden-hour", target=(0, 0, 0.3), size=1.4, use_world=False, scale={"sky": 1.6, "bounce": 2.2})
for name in ("sky", "bounce"):
    # Fills lift the backlit plush without a white wedge reflected in the dome.
    mood.light(name).visible_glossy = False
    mood.light(name).visible_transmission = False
mood.light("sun").data.energy = 3.4
mood.light("sun").rotation_euler = (math.radians(62), 0, math.radians(-128))

# ---------- island ----------
R = 0.9
profile = [(0.0, -0.32), (0.45, -0.3), (0.75, -0.2), (0.88, -0.08), (R, 0.0), (R - 0.005, 0.02), (0.0, 0.02)]
verts, faces = [], []
segments = 96
for r, z in profile:
    for s in range(segments):
        phi = 2 * math.pi * s / segments
        verts.append((r * math.cos(phi), r * math.sin(phi), z))
for ring in range(len(profile) - 1):
    for s in range(segments):
        a0, a1 = ring * segments + s, ring * segments + (s + 1) % segments
        faces.append((a0, a1, a1 + segments, a0 + segments))
island = toy.mesh_object("island", verts, faces)
toy.recalc_normals(island)
sub = island.modifiers.new("smooth", "SUBSURF")
sub.levels = sub.render_levels = 2
island.data.materials.append(toy.principled("island", "#f4f1ec", roughness=0.55, Subsurface_Weight=0.3, Subsurface_Scale=0.05))

# ---------- dome: a thin glass shell with a thin film ----------
dome = toy.uv_sphere("dome", 0.66, (0, 0, 0.02), segments=96, rings=48)
mesh = dome.data
import bmesh  # noqa: E402

bm = bmesh.new()
bm.from_mesh(mesh)
bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.001], context="VERTS")
bm.to_mesh(mesh)
bm.free()
shell = dome.modifiers.new("shell", "SOLIDIFY")
shell.thickness = 0.008
shell.offset = -1
glass = toy.principled("dome", "#ffffff", roughness=0.0, Transmission_Weight=1.0, IOR=1.52, Specular_IOR_Level=1.0, Thin_Film_IOR=a["filmIor"])
nodes, links = glass.node_tree.nodes, glass.node_tree.links
noise = nodes.new("ShaderNodeTexNoise")
noise.noise_dimensions = "4D"
noise.inputs["Scale"].default_value = 3.2
noise.inputs["Detail"].default_value = 2.5
coord = nodes.new("ShaderNodeTexCoord")
links.new(coord.outputs["Object"], noise.inputs["Vector"])
film = nodes.new("ShaderNodeMapRange")
# Noise Fac lives in about 0.32-0.68: map that span, not 0-1, onto the whole thickness band, or the film stays one
# thin slice of it and the colours stay faint (the old plate's problem).
film.inputs["From Min"].default_value = 0.32
film.inputs["From Max"].default_value = 0.68
film.inputs["To Min"].default_value = a["film"][0]
film.inputs["To Max"].default_value = a["film"][1]
links.new(noise.outputs["Fac"], film.inputs["Value"])
links.new(film.outputs[0], nodes["Principled BSDF"].inputs["Thin Film Thickness"])
dome.data.materials.append(glass)
# Without caustics a glass shell blocks the sun and sky: the inside goes dark. Let light through, keep the look.
dome.visible_shadow = False

# ---------- inside: the plush at a desk, a laptop of two slabs ----------
plush_root, plush_body = toy.plush(height=0.4, colours=a["plushColours"], seed=a["seed"])
rig = character.rig_plush(plush_root, plush_body, 0.4)
plush = rig.armature
plush.location = (0.0, 0.1, 0.02)
wood = toy.principled("desk", "#a8754b", roughness=0.6)
top = toy.rounded_box("desk-top", (0.5, 0.22, 0.025), 0.004)
top.location = (0.0, -0.08, 0.13)
top.data.materials.append(wood)
for x in (-0.2, 0.2):
    leg = toy.rounded_box(f"desk-leg{x}", (0.022, 0.16, 0.115), 0.003)
    leg.location = (x, -0.08, 0.075)
    leg.data.materials.append(wood)
alu = toy.principled("laptop", "#c9ccd2", roughness=0.28, Metallic=1.0)
base = toy.rounded_box("laptop-base", (0.17, 0.11, 0.008), 0.002)
base.location = (0.0, -0.09, 0.147)
base.data.materials.append(alu)
lid = toy.rounded_box("laptop-lid", (0.17, 0.006, 0.085), 0.002)
lid.location = (0.0, -0.145, 0.19)
lid.rotation_euler = (math.radians(-12), 0, 0)
lid.data.materials.append(alu)

# ---------- orbiting tiles: rounded glassy squares with a soft coloured glyph ----------
tiles = []
for i in range(a["tiles"]):
    colour = a["tileColours"][i % len(a["tileColours"])]
    tile = toy.rounded_box(f"tile{i}", (0.11, 0.026, 0.11), 0.02)
    tile.data.materials.append(toy.principled(f"tile{i}", "#ffffff", roughness=0.05, Transmission_Weight=0.85, IOR=1.4, Coat_Weight=1.0))
    glyph = toy.uv_sphere(f"glyph{i}", 0.03, (0, 0, 0), segments=24, rings=12)
    glyph.scale = (1.0, 0.3, 1.0)
    glyph.data.materials.append(toy.emission(f"glyph{i}", colour, 2.0))
    glyph.parent = tile
    tile.visible_shadow = False
    tiles.append(tile)

# ---------- water and cloud shadows for the overhead view ----------
if overhead:
    sea = toy.mesh_object("sea", [(-40, -40, -2.5), (40, -40, -2.5), (40, 40, -2.5), (-40, 40, -2.5)], [(0, 1, 2, 3)], smooth=False)
    water = toy.principled("sea", "#1d5a96", roughness=0.08, Specular_IOR_Level=0.5)
    wn, wl = water.node_tree.nodes, water.node_tree.links
    waves = wn.new("ShaderNodeTexNoise")
    waves.inputs["Scale"].default_value = 1.4
    waves.inputs["Detail"].default_value = 10.0
    wcoord = wn.new("ShaderNodeTexCoord")
    wl.new(wcoord.outputs["Object"], waves.inputs["Vector"])
    bump = wn.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.6
    wl.new(waves.outputs["Fac"], bump.inputs["Height"])
    wl.new(bump.outputs["Normal"], wn["Principled BSDF"].inputs["Normal"])
    # Deep and shallow blue by a larger noise, and pale foam where the fine noise peaks.
    swell = wn.new("ShaderNodeTexNoise")
    swell.inputs["Scale"].default_value = 0.35
    swell.inputs["Detail"].default_value = 3.0
    wl.new(wcoord.outputs["Object"], swell.inputs["Vector"])
    tint = wn.new("ShaderNodeMix")
    tint.data_type = "RGBA"
    tint.inputs["A"].default_value = (*kit.hex_rgb("#0f3f78"), 1)
    tint.inputs["B"].default_value = (*kit.hex_rgb("#3f8fd0"), 1)
    wl.new(swell.outputs["Fac"], tint.inputs["Factor"])
    foam = wn.new("ShaderNodeMapRange")
    foam.inputs["From Min"].default_value = 0.66
    foam.inputs["From Max"].default_value = 0.74
    wl.new(waves.outputs["Fac"], foam.inputs["Value"])
    white = wn.new("ShaderNodeMix")
    white.data_type = "RGBA"
    white.inputs["B"].default_value = (0.85, 0.9, 0.95, 1)
    wl.new(tint.outputs["Result"], white.inputs["A"])
    wl.new(foam.outputs[0], white.inputs["Factor"])
    wl.new(white.outputs["Result"], wn["Principled BSDF"].inputs["Base Color"])
    sea.data.materials.append(water)
    shade = toy.mesh_object("cloud-shadows", [(-40, -40, 8), (40, -40, 8), (40, 40, 8), (-40, 40, 8)], [(0, 1, 2, 3)], smooth=False)
    cm = toy.principled("cloud-shadows", "#ffffff")
    cn, cl = cm.node_tree.nodes, cm.node_tree.links
    out = cn["Material Output"]
    mix = cn.new("ShaderNodeMixShader")
    transparent = cn.new("ShaderNodeBsdfTransparent")
    puff = cn.new("ShaderNodeTexNoise")
    puff.inputs["Scale"].default_value = 0.18
    puff.inputs["Detail"].default_value = 4.0
    pcoord = cn.new("ShaderNodeTexCoord")
    cl.new(pcoord.outputs["Object"], puff.inputs["Vector"])
    edge = cn.new("ShaderNodeMapRange")
    edge.inputs["From Min"].default_value = 0.5
    edge.inputs["From Max"].default_value = 0.62
    cl.new(puff.outputs["Fac"], edge.inputs["Value"])
    cl.new(edge.outputs[0], mix.inputs["Fac"])
    cl.new(transparent.outputs[0], mix.inputs[1])
    cl.new(cn["Principled BSDF"].outputs[0], mix.inputs[2])
    cl.new(mix.outputs[0], out.inputs["Surface"])
    shade.data.materials.append(cm)
    shade.visible_camera = False
    shade.visible_glossy = False

# ---------- camera ----------
F = a["frames"]
pb = rig.pose_bone
LOOK_UP, ENTER = 64, 10
tl = anim.Timeline(range(F))
# Tiles rise from the island into their orbit in a seeded stagger, punch-shaped, then keep circling with a slow bob.
delays = curves.stagger(len(tiles), 4, kind="seeded", seed=a["seed"])


def tile_angle(i: int, f: float) -> float:
    """Evaluate the tile angle for this shot at a block frame."""
    return 2 * math.pi * i / len(tiles) + math.radians(a["orbitDegrees"]) * f / max(1, F - 1) + 0.35


def tile_location(i: int, f: float) -> tuple[float, float, float]:
    """Evaluate the tile location for this shot at a block frame."""
    rise = curves.progress(f, ENTER + delays[i], 14, "punch")
    angle = tile_angle(i, f)
    height = 0.36 + 0.06 * math.sin(angle * 2 + 1.0) + 0.012 * math.sin(f / 30 * 2 * math.pi * 0.6 + i)
    return (0.5 * math.cos(angle), 0.5 * math.sin(angle), curves.mix(0.05, height, rise))


for i, tile in enumerate(tiles):
    tl.add(tile, "location", lambda f, i=i: tile_location(i, f))
    tl.add(tile, "rotation_euler", lambda f, i=i: (0.0, math.radians(curves.follow_through(f, ENTER + delays[i] + 9, 8, damping=5, frequency=2.0)), tile_angle(i, f) + math.pi / 2))
    tl.add(tile, "scale", lambda f, i=i: tuple([max(1e-3, curves.progress(f, ENTER + delays[i], 10, "brake"))] * 3))

# The plush types (arms alternate, small and quick), stops, and looks up at the camera with a blink; ears follow through.
typing = lambda f: 1 - curves.progress(f, LOOK_UP - 6, 6, "brake")  # noqa: E731
tl.add(pb("arm.L"), "rotation_euler", lambda f: (math.radians(-38 + 9 * typing(f) * max(0.0, math.sin(f * 1.9))), 0.0, math.radians(-8)))
tl.add(pb("arm.R"), "rotation_euler", lambda f: (math.radians(-38 + 9 * typing(f) * max(0.0, math.sin(f * 1.9 + 2.1))), 0.0, math.radians(8)))
tl.add(
    pb("head"),
    "rotation_euler",
    lambda f: (
        math.radians(curves.mix(14, -12, curves.anticipate(f, LOOK_UP, wind=4, action=7, amount=0.1, overshoot=0.1))),
        math.radians(-6 * (1 - curves.progress(f, LOOK_UP, 10, "settle"))),
        math.radians(-7 * curves.progress(f, LOOK_UP + 10, 12, "settle")),
    ),
)
tl.add(pb("root"), "scale", lambda f: (curves.volume_scale(curves.breathe(f, 40, 0.02))[0], curves.breathe(f, 40, 0.02), curves.volume_scale(curves.breathe(f, 40, 0.02))[0]))
for side in ("L", "R"):
    tl.add(pb(f"ear.{side}"), "rotation_euler", lambda f: (math.radians(curves.follow_through(f, LOOK_UP + 6, -14, damping=6, frequency=3.0)), 0.0, 0.0))
for eye in rig.eyes():
    tl.add(eye, "scale", lambda f, b=tuple(eye.scale): character.blink_scale(curves.blinks(f, [LOOK_UP + 16, 96]), b))

intent = a["ease"] or ("glide" if overhead else "brake")
if overhead:
    # t16: straight down on the dome over water, pulling out and turning slowly.
    cam = camera.Rig(a, role="establishing", target=(0, 0, 0.0), subject=(2.0, 2.0), lens=a["lens"], fstop=a["fstop"], pitch=89.5, distance=3.2)
    cam.dolly(1 + a["push"], at=0, frames=F - 1, intent=intent)
    cam.roll(0.0, 12.0, at=0, frames=F - 1, intent="glide")
else:
    # t03, a reveal: from an establishing angle the camera cranes down and orbits to the front while pushing in; the move
    # brakes onto the plush as it looks up; focus racks from the tiles to its face; the hold breathes.
    cam = camera.Rig(a, role="reveal", target=(0, 0, 0.26), subject=(1.5, 1.0), lens=a["lens"], fstop=a["fstop"], yaw=-30.0, pitch=26.0, distance=3.1)
    cam.orbit(-30.0, -4.0, at=0, frames=LOOK_UP + 10, intent="glide")
    cam.crane(26.0, 9.0, at=0, frames=LOOK_UP + 10, intent="glide")
    cam.dolly(1 / (1 + a["push"] * 1.8), at=0, frames=LOOK_UP + 14, intent=intent)
    cam.tracks["target"].append(lambda f: (0.0, 0.08 * curves.progress(f, 0, LOOK_UP + 10, "glide"), 0.05 * curves.progress(f, 0, LOOK_UP + 10, "glide")))
    cam.handheld(0.05, seed=a["seed"] + 3)
    face = Vector((0.0, 0.03, 0.29))
    cam.rack((0.42, -0.25, 0.4), face, at=LOOK_UP - 14, frames=16, intent="snap")
cam.bake(tl)
mood.sweep("sky", 40, 80, at=0, frames=F - 1).bake(tl)
look.apply(scene, "agx-punchy")
look.motion_blur(scene, 0.5)
look.grade(scene, "filmic", vignette=0.14)

tl.bake()
stage.report(scene, cam.obj, {"hero": [dome], "support": [rig.mesh]}, frames=[1, LOOK_UP + 1, F])
