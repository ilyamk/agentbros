# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Seeded terrain and planting data shared by nature recipes; no Blender import for maths."""

from __future__ import annotations

import math
import random
from typing import Any


def height_at(x: float, y: float, seed: int, relief: float = 0.3) -> float:
    """Smooth octave displacement with a quiet central clearing, in metres."""
    phase = random.Random(seed).uniform(-math.pi, math.pi)
    envelope = 1 - math.exp(-(x * x + y * y) / 3)
    return relief * envelope * (0.55 * math.sin(x * 0.8 + phase) * math.cos(y * 0.7) + 0.25 * math.sin(x * 2.1 + y * 1.7 + phase) + 0.12 * math.cos(x * 4.2 - y * 3.1))


def placements(seed: int, count: int, radius: float, clearing: float, view_degrees: float = 360) -> list[tuple[float, float, float, float]]:
    """Uniform-area seeded density mask; optional conservative cone around camera +Y."""
    rng = random.Random(seed)
    result = []
    for _ in range(count):
        angle = rng.uniform(-math.pi, math.pi)
        distance = math.sqrt(rng.uniform(clearing**2, radius**2))
        x, y = distance * math.sin(angle), distance * math.cos(angle)
        density = 0.55 + 0.45 * math.sin(x * 1.3 + seed) ** 2
        if rng.random() < density:
            point = (x, y, rng.uniform(0.65, 1.3), rng.uniform(-math.pi, math.pi))
            # Consume candidate RNG values before culling: the cone filters the same planting.
            if distance <= 2 or abs(angle) <= math.radians(view_degrees / 2):
                result.append(point)
    return result


def tree_layout(seed: int, height: float, species: str) -> dict[str, Any]:
    """Cache the branch skeleton and GN leaf points independently of Blender evaluation."""
    rng = random.Random(seed)
    branches, leaves = [], []
    for i in range(26):
        z = height * (0.3 + 0.65 * i / 26)
        angle = i * 2.399 + rng.uniform(-0.4, 0.4)
        reach = height * (0.22 if species != "oak" else 0.34) * (1.2 - z / height)
        if species == "pine":
            reach *= 1.8
        tip = (math.cos(angle) * reach, math.sin(angle) * reach, z + height * 0.15)
        branches.append({"z": z, "tip": tip})
        for _ in range(90):
            t = rng.uniform(0.35, 1.1)
            leaves.append((tip[0] * t + rng.uniform(-0.13, 0.13) * height, tip[1] * t + rng.uniform(-0.13, 0.13) * height, z + height * 0.15 * t + rng.uniform(-0.06, 0.09) * height))
    return {"branches": branches, "leaves": leaves}


def tube(name: str, points: list[tuple[float, float, float]], radii: list[float], mat: Any, sides: int = 7) -> Any:
    """Build a tapered branch or stem without an operator or context dependency."""
    from mathutils import Vector

    from _common import mesh

    vertices, faces = [], []
    for index, (point, radius) in enumerate(zip(points, radii, strict=True)):
        tangent = Vector(points[min(index + 1, len(points) - 1)]) - Vector(points[max(0, index - 1)])
        tangent.normalize()
        axis = tangent.cross(Vector((0, 1, 0)))
        if axis.length < 0.01:
            axis = tangent.cross(Vector((1, 0, 0)))
        axis.normalize()
        other = tangent.cross(axis)
        for j in range(sides):
            v = Vector(point) + radius * (math.cos(j * math.tau / sides) * axis + math.sin(j * math.tau / sides) * other)
            vertices.append(tuple(v))
        if index:
            for j in range(sides):
                a, b = (index - 1) * sides + j, (index - 1) * sides + (j + 1) % sides
                faces.append((a, b, b + sides, a + sides))
    faces.extend([tuple(reversed(range(sides))), tuple(range((len(points) - 1) * sides, len(points) * sides))])
    obj = mesh(name, vertices, faces, mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def foliage_material(name: str, colour: tuple[float, ...]) -> Any:
    """Thin leaves transmit warm backlight and retain a matte upper surface."""
    from _common import material

    mat = material(name, colour, 0, 0.58)
    group = mat.node_tree.nodes.get("Group").node_tree
    shader = next(n for n in group.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Thin Film Thickness"].default_value = 0
    shader.inputs["Subsurface Weight"].default_value = 0.08
    return mat


def leaf_mesh(name: str, length: float, width: float, mat: Any) -> Any:
    """Folded lanceolate leaf with a midrib catching a narrow light edge."""
    from _common import mesh

    return mesh(name, [(0, 0, 0), (-width, length * 0.4, 0.02), (0, length, 0.035), (width, length * 0.4, 0.02), (0, length * 0.45, 0.055)], [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], mat)
