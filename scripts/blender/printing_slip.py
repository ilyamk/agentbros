# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
r"""Build a printed paper slip that unrolls from a curled top edge.

Printing slip (polymarket printing-slip): a paper sheet with a torn bottom edge unrolls from a curl on black while
its rows print, the sheet tilting and drifting back under a moving light. Blender plate for library block
`printing-slip` (prop `plate`).

The keys and defaults are the block's (PrintingSlip.tsx, three-plan.ts), so its row cues land on the plate: the unroll
is power3.out over `frames` from `at`, a row shows once the unroll passes it, the curl is `curlPoint` (flat to the
unrolled length, then wrapped backwards round a roll of 0.07 sheet widths). Here the paper is real: a thin solid
(Solidify) with a fibre bump and some subsurface, a torn edge from a seeded profile, the text as geometry bent with
the paper, and an area light sweeping across for the sheen. The text uses Blender's built-in font.

Shot intent (proof, 2.8 s, 84 frames): the viewer reads the rows as they print and lands on the total. The paper is white
(#f7f6f2 under a neutral 5600 K key, agx-base, no lift) and the ink matte and large enough to read at playback size
(labels 0.06, values 0.068 sheet widths; a glossy ink washed out to grey). The camera (detail role, the block's
32-degree field) follows the print line with an operator's lag, racks focus with it, and pushes in on a glide once the
unroll is done, so the shot ends on the total; when the unroll stops the hanging sheet swings on and settles. Light: kit
mood low-key, the key raking from -112 to -58 degrees for the paper's sheen, a cold rim on the torn edge; tactile grade.
Timing change: the shot was 60 frames; the unroll, row cues, tilt and drift keep the block's keys.

Geometry is placed per frame by a frame_change_pre handler from the frame alone (no state carried between frames).

Shot keys (plus toy_kit.COMMON): title, subtitle, rows [{label, value}], paper, ink, background, at, unrollFrames
(the block's `frames`), header, tilt {fromX, toX, fromY, toY}, driftBack, tear (depth of the torn edge, sheet widths).
`frames` is the shot length, as in COMMON.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Euler, Matrix, Vector

import studio_kit as kit
import studio_kit as studio
import toy_kit as toy
from kit import anim, camera, curves, look, stage
from kit import light as lights

a = toy.args(
    {
        "title": "Order summary",
        "subtitle": "Printed the moment it ships",
        "rows": [
            {"label": "Studio plan", "value": "$240"},
            {"label": "Extra seats x3", "value": "$90"},
            {"label": "Render hours", "value": "$64"},
            {"label": "Storage", "value": "$12"},
            {"label": "Support", "value": "$0"},
            {"label": "Discount", "value": "-$40"},
            {"label": "Tax", "value": "$31"},
            {"label": "Total", "value": "$397"},
        ],
        "paper": "#f7f6f2",
        "ink": "#111111",
        "background": "#050505",
        "at": 2,
        "unrollFrames": 29,
        "header": 0.2,
        "tilt": {"fromX": -18, "toX": -24, "fromY": 16, "toY": 24},
        "driftBack": 0.35,
        "tear": 0.035,
        "push": 0.55,
        "exposure": 1.15,
        "frames": 84,
    }
)
scene = toy.reset(a, look="AgX - Medium High Contrast")
toy.world_colour(a["background"], 0.0)

W = 1.6
rows = a["rows"]
L = W * (0.9 + len(rows) * 0.17)
RADIUS = W * 0.07
COLS, SEGS = 48, 220


def unroll_at(frame: float) -> float:
    """Evaluate the unroll at for this shot at a block frame."""
    return toy.progress(frame, a["at"], a["unrollFrames"], "power3.out")


def rows_shown(unroll: float) -> int:
    """Evaluate the rows shown for this shot at a block frame."""
    return max(0, min(len(rows), math.floor(unroll * len(rows) + 1e-9)))


def curl(v: float, flat: float) -> tuple[float, float, float, float]:
    """three-plan.ts curlPoint: (y down negative, z back negative) and the front normal (ny, nz)."""
    if v <= flat:
        return -v, 0.0, 0.0, 1.0
    angle = min((v - flat) / RADIUS, math.pi * 1.85)
    return -flat - RADIUS * math.sin(angle), -RADIUS * (1 - math.cos(angle)), -math.sin(angle), math.cos(angle)


def to_world(x: float, v: float, flat: float, lift: float = 0.0) -> tuple[float, float, float]:
    """Sheet coordinates (x across, v down from the top) to the slip's local Blender space (top at z = L / 2)."""
    y, z, ny, nz = curl(v, flat)
    y += ny * lift
    z += nz * lift
    return (x, -z, L / 2 + y)


# ---------- the sheet: a grid whose last row follows a seeded torn profile ----------
rng = toy.seeded(a["seed"], "tear")
tear = []
for i in range(COLS + 1):
    jag = rng.random() * 0.6 + (0.4 if i % 2 else 0.0)
    tear.append(a["tear"] * W * jag)
sheet_uv = []
faces = []
for j in range(SEGS + 1):
    for i in range(COLS + 1):
        x = -W / 2 + W * i / COLS
        v = L * j / SEGS
        if j == SEGS:
            v = L - tear[i]
        elif v > L - a["tear"] * W:
            v = min(v, L - tear[i])
        sheet_uv.append((x, v))
for j in range(SEGS):
    for i in range(COLS):
        k = j * (COLS + 1) + i
        faces.append((k, k + 1, k + COLS + 2, k + COLS + 1))
sheet = toy.mesh_object("slip", [to_world(x, v, L) for x, v in sheet_uv], faces)
paper_thickness = 0.0025
solid = sheet.modifiers.new("paper", "SOLIDIFY")
solid.thickness = paper_thickness
solid.offset = 1  # faces point away from the camera: the thickness goes behind the print
paper = toy.principled("paper", a["paper"], roughness=0.62, Subsurface_Weight=0.12, Subsurface_Scale=0.01, Sheen_Weight=0.15)
pn, pl = paper.node_tree.nodes, paper.node_tree.links
fibre = pn.new("ShaderNodeTexNoise")
fibre.inputs["Scale"].default_value = 180.0
fibre.inputs["Detail"].default_value = 6.0
coord = pn.new("ShaderNodeTexCoord")
pl.new(coord.outputs["Object"], fibre.inputs["Vector"])
bump = pn.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.08
pl.new(fibre.outputs["Fac"], bump.inputs["Height"])
pl.new(bump.outputs["Normal"], pn["Principled BSDF"].inputs["Normal"])
sheet.data.materials.append(paper)

# ---------- the print: text meshes in sheet coordinates, bent with the paper ----------
# Matte ink (a thermal print is not glossy): a glossy ink catches the key and washes out to grey.
ink = toy.principled("ink", a["ink"], roughness=0.82, Specular_IOR_Level=0.2)


def text_mesh(name: str, body: str, size: float, x: float, v: float, align: str = "LEFT", weight: float = 0.0) -> bpy.types.Object:
    """Text laid on the sheet with its baseline-middle at (x, v); returns (object, flat vertex coordinates)."""
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = body
    curve.size = size
    curve.align_x = align
    curve.align_y = "CENTER"
    curve.offset = weight
    holder = toy.link(bpy.data.objects.new(name, curve))
    bpy.context.view_layer.update()
    mesh = bpy.data.meshes.new_from_object(holder.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(holder)
    obj = toy.link(bpy.data.objects.new(name, mesh))
    obj.data.materials.append(ink)
    flat = [(x + vert.co.x, v - vert.co.y) for vert in mesh.vertices]
    return obj, flat


m = W * 0.09
header_v = L * a["header"]
prints = []
title, flat = text_mesh("title", a["title"], W * 0.075, -W / 2 + m, header_v * 0.32 + W * 0.04, weight=0.0015)
prints.append((title, flat, None))
sub, flat = text_mesh("subtitle", a["subtitle"], W * 0.042, -W / 2 + m, header_v * 0.32 + W * 0.115)
prints.append((sub, flat, None))
sub.data.materials[0] = toy.principled("ink-soft", a["ink"], roughness=0.82, Specular_IOR_Level=0.2)
sub.data.materials[0].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*toy.mix(kit.hex_rgb(a["ink"]), kit.hex_rgb(a["paper"]), 0.12), 1)
row_h = (L - header_v - a["tear"] * W * 2) / len(rows)
for index, row in enumerate(rows):
    v = header_v + row_h * (index + 0.5)
    label, flat = text_mesh(f"row{index}-label", row["label"], W * 0.06, -W / 2 + m, v)
    label.data.materials[0] = sub.data.materials[0]
    prints.append((label, flat, index))
    value, flat = text_mesh(f"row{index}-value", row["value"], W * 0.068, W / 2 - m, v, align="RIGHT", weight=0.0012)
    prints.append((value, flat, index))

pivot = toy.empty("slip-pivot")
pivot.rotation_mode = "ZXY"
for obj in [sheet] + [p[0] for p in prints]:
    obj.parent = pivot


def place(scene_: bpy.types.Scene, *_: object) -> None:
    """frame_change_pre: every vertex of the paper and the print from the frame alone."""
    frame = scene_.frame_current_final - 1  # subframes too, so the paper gets deformation blur
    unroll = unroll_at(frame)
    flat = L * (a["header"] + (1 - a["header"]) * unroll)
    coords = [c for x, v in sheet_uv for c in to_world(x, v, flat)]
    sheet.data.vertices.foreach_set("co", coords)
    sheet.data.update()
    shown = rows_shown(unroll)
    for obj, flat_coords, row in prints:
        coords = [c for x, v in flat_coords for c in to_world(x, v, flat, lift=0.0008)]
        obj.data.vertices.foreach_set("co", coords)
        obj.data.update()
        obj.hide_render = row is not None and row >= shown


bpy.app.handlers.frame_change_pre.append(place)

# ---------- motion: the block's tilt and drift, plus the paper's own follow-through ----------
F = a["frames"]
DONE = a["at"] + a["unrollFrames"]


def pivot_pose(f: float) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Evaluate the pivot pose for this shot at a block frame."""
    t = toy.EASES["power2.inOut"](curves.clamp01(f / max(1, F - 1)))  # the block's tilt and drift
    tilt = a["tilt"]
    # When the unroll stops, the hanging sheet swings on a little (follow-through) and settles.
    swing = curves.follow_through(f, DONE, 2.6, damping=4.5, frequency=1.6)
    rot = (math.radians(toy.mix(tilt["fromX"], tilt["toX"], t) + swing), 0.0, math.radians(toy.mix(tilt["fromY"], tilt["toY"], t) + 0.4 * swing))
    return rot, (0.0, a["driftBack"] * W * t, 0.0)


def print_line(f: float) -> Vector:
    """World position of the row being printed (where the eye goes), from the frame alone."""
    unroll = unroll_at(f)
    flat = L * (a["header"] + (1 - a["header"]) * unroll)
    v = max(L * a["header"] * 0.5, flat - L * 0.06)
    rot, loc = pivot_pose(f)
    matrix = Matrix.Translation(loc) @ Euler(rot, "ZXY").to_matrix().to_4x4()
    return matrix @ Vector(to_world(0.0, v, flat))


tl = anim.Timeline(range(F))
tl.add(pivot, "rotation_euler", lambda f: pivot_pose(f)[0])
tl.add(pivot, "location", lambda f: pivot_pose(f)[1])

# ---------- camera: follows the print with an operator's lag, then pushes in to land on the total ----------
# The block's 32-degree vertical field on a 36 mm horizontal sensor; distance frames the whole slip as the block does.
tan = math.tan(math.radians(16))
aspect = a["width"] / a["height"]
lens = 18 / aspect / tan if aspect >= 1 else 18 / tan
distance = max(L * 1.12 / (2 * tan), W * 2.4 / (2 * tan * aspect))
cam = camera.Rig(a, role="detail", target=(0, 0, 0), subject=(W, L), lens=lens, fstop=a["fstop"] or 2.0, pitch=0.0, distance=distance)
cam.follow(lambda f: (0.0, 0.0, 0.3 * print_line(f).z), half_life=5.0)
cam.dolly(a["push"], at=DONE - 6, frames=F - DONE, intent="glide")
cam.handheld(0.05, seed=a["seed"] + 11)
cam.rack(print_line, print_line, at=0, frames=1)
cam.bake(tl)

# ---------- light: low-key, a raking key that travels across the paper (the sheen), a cold rim on the torn edge ----------
mood = lights.mood("low-key", target=(0, 0, 0), size=W, use_world=False, exposure=5.0, scale={"fill": 2.0})
mood.light("key").data.temperature = 5600  # paper reads white under a neutral key; the cold rim stays
mood.sweep("key", -112, -58, at=0, frames=F - 1, intent="glide")
mood.bake(tl)
look.apply(scene, "agx-base", exposure=a["exposure"])
look.motion_blur(scene, 0.5)
look.grade(scene, "tactile", vignette=0.2, lift=0.0, warmth=0.02)

tl.bake()
place(scene)
stage.report(scene, cam.obj, {"hero": [sheet]}, frames=[DONE + 1, F])
studio.finish()
