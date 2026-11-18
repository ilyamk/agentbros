# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Shared seeded mathematics, cache ownership and Blender construction for directed recipes."""

from __future__ import annotations

import ast
import bisect
import hashlib
import json
import math
import os
import random
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from avc_arsenal import paths

if TYPE_CHECKING:
    from collections.abc import Callable


def triangulate(polygon: list[tuple[float, ...]]) -> list[tuple[Any, Any, Any]]:
    """Ear-clip a canonical planar polygon, including concave source n-gons."""
    normal = [sum((a[(k + 1) % 3] - b[(k + 1) % 3]) * (a[(k + 2) % 3] + b[(k + 2) % 3]) for a, b in zip(polygon, polygon[1:] + polygon[:1], strict=True)) for k in range(3)]
    axis = max(range(3), key=lambda k: abs(normal[k]))
    axes = [k for k in range(3) if k != axis]
    points = [(p[axes[0]], p[axes[1]]) for p in polygon]

    def cross(a: Any, b: Any, c: Any) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    winding = 1 if sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1], strict=True)) >= 0 else -1
    remaining, triangles = list(range(len(polygon))), []
    while len(remaining) > 3:
        for i, b in enumerate(remaining):
            a, c = remaining[i - 1], remaining[(i + 1) % len(remaining)]
            if winding * cross(points[a], points[b], points[c]) <= 1e-12:
                continue
            if any(all(winding * cross(points[x], points[y], points[p]) >= -1e-12 for x, y in ((a, b), (b, c), (c, a))) for p in remaining if p not in (a, b, c)):
                continue
            triangles.append((polygon[a], polygon[b], polygon[c]))
            remaining.pop(i)
            break
        else:
            msg = "Surface polygon must be simple, planar and non-degenerate"
            raise ValueError(msg)
    if len(remaining) == 3:
        triangles.append(tuple(polygon[i] for i in remaining))
    return triangles


def surface_points(vertices: list[Any], faces: list[Any], density: float, seed: int) -> list[tuple[float, ...]]:
    """Sample by area after canonicalising topology; evaluated Blender face order can vary between processes."""
    triangles = []
    for face in faces:
        polygon = [tuple(round(float(c), 7) for c in vertices[index]) for index in face]
        first = polygon.index(min(polygon))
        polygon = polygon[first:] + polygon[:first]
        polygon = min(polygon, polygon[:1] + list(reversed(polygon[1:])))
        for triangle in triangulate(polygon):
            a, b, c = sorted(triangle)
            u, v = [b[k] - a[k] for k in range(3)], [c[k] - a[k] for k in range(3)]
            cross = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
            area = math.sqrt(sum(x * x for x in cross)) / 2
            if area > 1e-12:
                triangles.append(((a, b, c), area))
    triangles.sort()
    cumulative, area = [], 0.0
    for _, size in triangles:
        area += size
        cumulative.append(area)
    rng = random.Random(seed)
    points = []
    for _ in range(int(area * density)):
        (a, b, c), _ = triangles[bisect.bisect_left(cumulative, rng.random() * area)]
        u, v = math.sqrt(rng.random()), rng.random()
        points.append(tuple((1 - u) * a[k] + u * (1 - v) * b[k] + u * v * c[k] for k in range(3)))
    return points


def cache_hash(recipe_id: str, params: dict[str, Any], context: dict[str, Any] | None = None) -> str:
    """Include code and dependencies as well as parameters: edits cannot reuse stale simulations."""
    files = sorted(Path(paths()["recipes"]).glob("*.py")) + sorted((Path(paths()["recipes"]).parent / "kit").glob("*.py"))
    sources = []
    for file in files:
        tree = ast.parse(file.read_text(encoding="utf8"))
        tree.body = [
            node
            for node in tree.body
            if not (
                (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "META" for t in node.targets))
                or (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str))
            )
        ]
        sources.append(file.name.encode() + ast.dump(tree, include_attributes=False).encode())
    code = hashlib.sha256(b"".join(sources)).hexdigest()
    payload = {"recipe": recipe_id, "params": params, "context": context or {}, "code": code, "version": 1}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def bake(recipe_id: str, params: dict[str, Any], build: Callable[[], Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    """Atomically cache fixed-seed simulation/trajectory data, publishing only complete results."""
    if not recipe_id or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in recipe_id):
        msg = "Invalid bake recipe id"
        raise ValueError(msg)
    started = time.monotonic()
    root = Path(paths()["bakes"]).resolve()
    directory = root / recipe_id / cache_hash(recipe_id, params, context)
    if not directory.resolve().is_relative_to(root):
        msg = "Bake path escapes arsenal"
        raise ValueError(msg)
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / "bake.json"
    reused = file.exists()
    if reused:
        data = json.loads(file.read_text(encoding="utf8"))
    else:
        data = build()
        temporary = directory / f"bake-{os.getpid()}.tmp"
        try:
            temporary.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False), encoding="utf8")
            temporary.replace(file)
        finally:
            temporary.unlink(missing_ok=True)
    return {"path": str(file), "reused": reused, "seconds": time.monotonic() - started, "data": data}


def ballistic(seed: int, count: int, frames: int, spread: float) -> list[list[list[float]]]:
    """Fixed-seed dust positions in metres, with drag and gravity; independent of evaluation order."""
    rng = random.Random(seed)
    velocities = [(rng.uniform(-spread, spread), rng.uniform(-spread, spread), rng.uniform(1.6, 4.0)) for _ in range(count)]
    return [
        [[vx * (1 - math.exp(-2 * t)) / 2, vy * (1 - math.exp(-2 * t)) / 2, max(0.03, 0.06 + vz * t - 2.4 * t * t)] for vx, vy, vz in velocities] for t in (max(0, f - 8) / 30 for f in range(frames))
    ]


def voronoi_cells(seed: int, count: int) -> list[tuple[list[tuple[float, ...]], list[list[int]], tuple[float, ...]]]:
    """Clip a cube by the perpendicular bisectors of seeded sites; genuine convex Voronoi pieces."""
    rng = random.Random(seed)
    sites = [(rng.uniform(-0.7, 0.7), rng.uniform(-0.7, 0.7), rng.uniform(0.1, 1.5)) for _ in range(count)]

    def dot(a: Any, b: Any) -> float:
        return sum(x * y for x, y in zip(a, b, strict=True))

    box = [(-0.8, -0.8, 0), (0.8, -0.8, 0), (0.8, 0.8, 0), (-0.8, 0.8, 0), (-0.8, -0.8, 1.6), (0.8, -0.8, 1.6), (0.8, 0.8, 1.6), (-0.8, 0.8, 1.6)]
    faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
    cells = []
    for site in sites:
        polygons = [[box[i] for i in face] for face in faces]
        for other in sites:
            if other == site:
                continue
            normal = tuple(b - a for a, b in zip(site, other, strict=True))
            distance = (dot(other, other) - dot(site, site)) / 2
            clipped, cap = [], []
            for polygon in polygons:
                points = []
                for a, b in zip(polygon, polygon[1:] + polygon[:1], strict=True):
                    da, db = dot(normal, a) - distance, dot(normal, b) - distance
                    if da <= 1e-8:
                        points.append(a)
                    if (da < 0) != (db < 0):
                        t = da / (da - db)
                        point = tuple(x + t * (y - x) for x, y in zip(a, b, strict=True))
                        points.append(point)
                        cap.append(point)
                if len(points) >= 3:
                    clipped.append(points)
            unique = list({tuple(round(x, 8) for x in p): p for p in cap}.values())
            if len(unique) >= 3:
                centre = tuple(sum(p[i] for p in unique) / len(unique) for i in range(3))
                length = math.sqrt(dot(normal, normal))
                n = tuple(x / length for x in normal)
                ref = (1, 0, 0) if abs(n[0]) < 0.9 else (0, 1, 0)
                u = (n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0])
                v = (n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0])
                unique.sort(key=lambda p: math.atan2(dot(tuple(p[i] - centre[i] for i in range(3)), v), dot(tuple(p[i] - centre[i] for i in range(3)), u)))
                clipped.append(unique)
            polygons = clipped
        polygons = [[tuple(round(x, 7) for x in p) for p in polygon] for polygon in polygons]
        polygons = [list(dict.fromkeys(polygon)) for polygon in polygons]
        polygons = [polygon for polygon in polygons if len(polygon) >= 3]
        vertices = list(dict.fromkeys(p for polygon in polygons for p in polygon))
        indices = [[vertices.index(p) for p in polygon] for polygon in polygons]
        cells.append((vertices, indices, site))
    return cells


def material(name: str, colour: tuple[float, ...] = (0.025, 0.32, 0.28, 1), metallic: float = 0.65, roughness: float = 0.26, emission: float = 0) -> Any:
    """Create a named shader group with subtle roughness variation."""
    import bpy

    mat = bpy.data.materials.new("AVC " + name)
    mat.diffuse_color = colour
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    group = bpy.data.node_groups.new("AVC " + name, "ShaderNodeTree")
    group.interface.new_socket(name="Shader", in_out="OUTPUT", socket_type="NodeSocketShader")
    out = group.nodes.new("NodeGroupOutput")
    bsdf = group.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = colour
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Emission Color"].default_value = colour
    bsdf.inputs["Emission Strength"].default_value = emission
    noise = group.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 45
    ramp = group.nodes.new("ShaderNodeMapRange")
    ramp.inputs["To Min"].default_value = max(0.02, roughness - 0.08)
    ramp.inputs["To Max"].default_value = roughness + 0.08
    group.links.new(noise.outputs["Fac"], ramp.inputs["Value"])
    group.links.new(ramp.outputs["Result"], bsdf.inputs["Roughness"])
    group.links.new(bsdf.outputs["BSDF"], out.inputs["Shader"])
    nodes.clear()
    wrapper = nodes.new("ShaderNodeGroup")
    wrapper.node_tree = group
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(wrapper.outputs["Shader"], output.inputs["Surface"])
    return mat


def mesh(name: str, vertices: Any, faces: Any, mat: Any = None) -> Any:
    """Link one mesh to the current scene."""
    import bpy

    data = bpy.data.meshes.new("AVC " + name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(data.name, data)
    bpy.context.scene.collection.objects.link(obj)
    if mat:
        data.materials.append(mat)
    return obj


def orb(name: str, location: tuple[float, ...] = (0, 0, 0.8), radius: float = 0.8, mat: Any = None) -> Any:
    """Smooth default subject, resting on the floor."""
    import bpy

    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = "AVC " + name
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.data.materials.append(mat or material(name))
    return obj


def target(params: dict[str, Any], name: str) -> Any:
    """Resolve an optional scene object; a misspelled supplied name is an error."""
    import bpy

    if params.get("object"):
        obj = bpy.data.objects.get(params["object"])
        if obj is None or obj.type != "MESH":
            msg = "object must name an existing mesh"
            raise ValueError(msg)
        return obj
    return orb(name)


def timeline_for(scene: Any, timeline: Any) -> tuple[Any, bool]:
    """Respect an external timeline, otherwise key the whole scene plus shutter guards."""
    from kit.anim import Timeline

    return (timeline, False) if timeline is not None else (Timeline(range(scene.frame_start - 2, scene.frame_end + 2)), True)


def finish(objects: list[Any], materials: list[Any], timeline: Any, owned: bool, cached: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return datablock names and cache evidence; never reset unrelated scene content."""
    if owned:
        timeline.bake()
    return {"objects": [o.name for o in objects], "materials": [m.name for m in materials], "bake": {k: v for k, v in cached.items() if k != "data"} if cached else None}


def snapshot_keys(index: int, count: int, first: int = 1) -> list[tuple[int, int]]:
    """Hold endpoint snapshots across the shutter; interpolate neighbouring snapshots inside the range."""
    keys = [(first + index, 1)]
    if index > 0:
        keys.insert(0, (first + index - 1, 0))
    if index < count - 1:
        keys.append((first + index + 1, 0))
    return keys


def animate_mesh(obj: Any, positions: list[Any], first: int = 1) -> None:
    """Baked mesh snapshots interpolate by frame, including subframes for motion blur."""
    obj.shape_key_add(name="Basis")
    for index, vertices in enumerate(positions):
        key = obj.shape_key_add(name=f"frame-{first + index}")
        for point, co in zip(key.data, vertices, strict=True):
            point.co = co
        for frame, value in snapshot_keys(index, len(positions), first):
            key.value = value
            key.keyframe_insert("value", frame=frame)
    from kit.anim import fcurves_of

    for curve in fcurves_of(obj.data.shape_keys):
        curve.extrapolation = "CONSTANT"
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"


def bloom(scene: Any, name: str, strength: float) -> None:
    """Insert owned glare before the active output, preserving legacy and Blender 5 shot composites."""
    import bpy

    modern = bpy.app.version >= (5, 0, 0)
    if modern:
        from kit import look

        tree = scene.compositing_node_group
        if tree is None:
            tree = look.grade(scene, "clean", bloom=0)
        output = next((n for n in tree.nodes if n.type == "GROUP_OUTPUT" and n.is_active_output), None)
    else:
        scene.use_nodes = True
        tree = scene.node_tree
        output = next((n for n in tree.nodes if n.type == "COMPOSITE"), None)
    if output is None or not output.inputs[0].links:
        msg = "Recipe bloom requires a linked active compositor output"
        raise ValueError(msg)
    source = output.inputs[0].links[0].from_socket
    glare = tree.nodes.new("CompositorNodeGlare")
    glare.name = "AVC " + name
    if modern:
        glare.inputs["Type"].default_value = "Bloom"
        glare.inputs["Quality"].default_value = "High"
        glare.inputs["Threshold"].default_value = 1
        glare.inputs["Strength"].default_value = strength
        glare.inputs["Size"].default_value = 0.6
    else:
        glare.glare_type, glare.quality, glare.threshold = "FOG_GLOW", "HIGH", 1
        glare.mix, glare.size = strength - 1, 9
    tree.links.new(source, glare.inputs["Image"])
    tree.links.new(glare.outputs["Image"], output.inputs[0])
