# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Character rig for the toy plush: the metaball body becomes one mesh with an armature, so a performance has overlap.

    rig = character.rig_plush(root, body, height)     # bones: root, body, head, ear.L/R, arm.L/R; features on the head
    rig.pose_bone("head").rotation_euler = ...        # or drive them through a kit.anim.Timeline

Why a rig: one metaball can only move as a whole, so the head cannot lead the body and the ears cannot drag. A mesh with
fixed topology also gets real deformation motion blur in Cycles, which a re-polygonised metaball does not.

Weights are computed from the plush's own proportions (toy_kit.plush): head above the neck with a soft blend, ears and
arms by distance to their centres, body for the rest. Features (eyes, cheeks, smile) ride the head bone, the belly the
body bone; the eyes blink by scaling along the face's vertical.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

import bpy
from mathutils import Vector

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence


def _smooth(edge0: float, edge1: float, x: float) -> float:
    t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


class PlushRig:
    """Control the named bones and facial features of a plush character."""

    def __init__(self, armature: bpy.types.Object, mesh: bpy.types.Object, features: Mapping[str, bpy.types.Object], height: float) -> None:
        """Keep the armature and named character parts for pose control."""
        self.armature = armature
        self.mesh = mesh
        self.features = features
        self.height = height

    def pose_bone(self, name: str) -> bpy.types.PoseBone:
        """Return a named pose bone from the character rig."""
        return self.armature.pose.bones[name]

    def eyes(self) -> list[bpy.types.Object]:
        """Set the character eye openness."""
        return [obj for name, obj in self.features.items() if name.startswith("eye")]


def _to_mesh(body: bpy.types.Object, resolution: float) -> bpy.types.Object:
    """The metaball as a mesh object with the same material, at `resolution` (metres)."""
    ball = body.data
    ball.resolution = resolution
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(body.evaluated_get(depsgraph))
    mesh.name = f"{body.name}-mesh"
    obj = bpy.data.objects.new(body.name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = body.matrix_world.copy()
    for mat in ball.materials:
        mesh.materials.append(mat)
    mesh.shade_smooth()
    bpy.data.objects.remove(body, do_unlink=True)
    return obj


def rig_plush(root: bpy.types.Object, body: bpy.types.Object, height: float, resolution: float | None = None, name: str = "plush") -> PlushRig:
    r"""Convert the plush body to a mesh and build its character rig.

    Converts toy_kit.plush's metaball to a mesh and rigs it. `root` keeps the features; returns a PlushRig whose
    armature object replaces `root` as the thing to move (root is parented to the armature's root bone).
    """
    h = height
    mesh_obj = _to_mesh(body, resolution or 0.0055 * h / 0.3)
    arm_data = bpy.data.armatures.new(f"{name}-rig")
    arm = bpy.data.objects.new(f"{name}-rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    arm.location = root.location.copy()
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    bones = {}

    def bone(label: str, head: Sequence[float], tail: Sequence[float], parent: str | None = None, deform: bool = True) -> bpy.types.EditBone:
        b = arm_data.edit_bones.new(label)
        b.head, b.tail = Vector(head) * 1.0, Vector(tail) * 1.0
        b.use_deform = deform
        if parent:
            b.parent = bones[parent]
        bones[label] = b
        return b

    bone("root", (0, 0, 0), (0, 0, 0.12 * h), deform=False)
    bone("body", (0, 0, 0.04 * h), (0, 0, 0.46 * h), "root")
    bone("head", (0, 0, 0.5 * h), (0, 0, 0.9 * h), "body")
    for side, label in ((-1, "L"), (1, "R")):
        bone(f"ear.{label}", (side * 0.15 * h, 0.02 * h, 0.82 * h), (side * 0.19 * h, 0.02 * h, 0.95 * h), "head")
        bone(f"arm.{label}", (side * 0.2 * h, -0.02 * h, 0.42 * h), (side * 0.3 * h, -0.03 * h, 0.27 * h), "body")
    bpy.ops.object.mode_set(mode="OBJECT")

    # Weights from the plush's proportions (toy_kit.plush): head above a soft neck, ears and arms by distance.
    groups = {label: mesh_obj.vertex_groups.new(name=label) for label in ("body", "head", "ear.L", "ear.R", "arm.L", "arm.R")}
    ear_c = {"L": Vector((-0.17 * h, 0.02 * h, 0.88 * h)), "R": Vector((0.17 * h, 0.02 * h, 0.88 * h))}
    arm_c = {"L": Vector((-0.27 * h, -0.03 * h, 0.33 * h)), "R": Vector((0.27 * h, -0.03 * h, 0.33 * h))}
    world = mesh_obj.matrix_world
    for v in mesh_obj.data.vertices:
        p = world @ v.co - arm.location
        head = _smooth(0.47 * h, 0.6 * h, p.z)
        w = {"head": head}
        for label in ("L", "R"):
            ear = _smooth(0.115 * h, 0.06 * h, (p - ear_c[label]).length) * _smooth(0.78 * h, 0.83 * h, p.z)
            arm_w = _smooth(0.13 * h, 0.06 * h, (p - arm_c[label]).length) * _smooth(0.17 * h, 0.23 * h, abs(p.x))
            w[f"ear.{label}"] = ear
            w[f"arm.{label}"] = arm_w
        w["head"] = max(0.0, head - w["ear.L"] - w["ear.R"])
        w["body"] = max(0.0, 1.0 - w["head"] - w["ear.L"] - w["ear.R"] - w["arm.L"] - w["arm.R"])
        total = sum(w.values()) or 1.0
        for label, value in w.items():
            if value > 1e-4:
                groups[label].add([v.index], value / total, "REPLACE")
    mod = mesh_obj.modifiers.new("rig", "ARMATURE")
    mod.object = arm
    mod.use_deform_preserve_volume = True
    mesh_obj.parent = arm
    mesh_obj.matrix_parent_inverse = arm.matrix_world.inverted()

    # Features ride bones: face on the head, belly on the body.
    features = {}
    for child in list(root.children):
        label = child.name[len(name) + 1 :] if child.name.startswith(f"{name}-") else child.name
        bone_name = "body" if label.startswith("belly") else "head"
        matrix = child.matrix_world.copy()
        child.parent = arm
        child.parent_type = "BONE"
        child.parent_bone = bone_name
        bpy.context.view_layer.update()
        child.matrix_world = matrix
        features[label] = child
    root.parent = arm
    root.parent_type = "BONE"
    root.parent_bone = "root"
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    return PlushRig(arm, mesh_obj, features, h)


def blink_scale(openness: float, base: Sequence[float]) -> tuple[float, float, float]:
    """Eye scale for a blink: squeezes the eye along its local Y (the face's vertical) to a line, keeps its width."""
    return (base[0], base[1] * max(0.08, openness), base[2])


def look_angles(source: Sequence[float], target: Sequence[float]) -> tuple[float, float]:
    """(yaw, pitch) in degrees for a head at `source` facing -Y to look at `target`."""
    d = Vector(target) - Vector(source)
    yaw = math.degrees(math.atan2(d.x, -d.y))
    pitch = math.degrees(math.atan2(d.z, math.hypot(d.x, d.y)))
    return yaw, pitch
