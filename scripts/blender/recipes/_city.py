# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Seeded city plans, licensed footprint extrusion and cached Geometry Nodes construction."""

from __future__ import annotations

import hashlib
import json
import math
import random
import time
from pathlib import Path
from typing import Any

from avc_arsenal import paths

from _common import cache_hash, material, mesh

ATTRIBUTION = "© OpenStreetMap contributors, ODbL"
FLOOR = 3.4


def layout(seed: int, blocks: int, spacing: float, hero_height: float) -> list[dict[str, Any]]:
    """Metre-scale lots with a central landmark, a street grid and tapered density."""
    rng = random.Random(seed)
    buildings = []
    for row in range(blocks):
        for col in range(blocks):
            cx, cy = (col - (blocks - 1) / 2) * spacing, (row - (blocks - 1) / 2) * spacing
            for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
                x, y = cx + dx * spacing * 0.19, cy + dy * spacing * 0.19
                central = math.exp(-(x * x + y * y) / (spacing * blocks * 0.35) ** 2)
                floors = int(rng.uniform(3, 10) + central * rng.uniform(6, 22))
                w, d = rng.uniform(12, spacing * 0.31), rng.uniform(12, spacing * 0.31)
                if abs(x) < (w + spacing * 0.4) / 2 + 3 and abs(y) < (d + spacing * 0.34) / 2 + 3:
                    continue
                buildings.append({"id": len(buildings), "x": x, "y": y, "w": w, "d": d, "h": floors * FLOOR, "style": rng.randrange(3)})
    buildings.append({"id": len(buildings), "x": 0.0, "y": 0.0, "w": spacing * 0.4, "d": spacing * 0.34, "h": hero_height, "style": 0, "hero": True})
    return buildings


def height(tags: dict[str, str], fallback: float = 12) -> tuple[float, float]:
    """OSM metres/feet and levels; explicit bounds prevent malformed tags exhausting geometry."""

    def metres(value: str, default: float) -> float:
        try:
            value = value.strip().lower()
            result = float(value[:-2].strip()) * 0.3048 if value.endswith("ft") else float(value.removesuffix("m").strip())
            return result if math.isfinite(result) else default
        except ValueError:
            return default

    top = metres(tags.get("height", ""), metres(tags.get("building:levels", ""), fallback / FLOOR) * FLOOR)
    bottom = metres(tags.get("min_height", ""), metres(tags.get("building:min_level", ""), 0) * FLOOR)
    bottom = max(0, min(bottom, 590))
    return max(bottom + 1, min(600, top)), bottom


def footprints(source: dict[str, Any], lat: float, lon: float) -> list[dict[str, Any]]:
    """Project closed OSM ways, preserving non-rectangular outlines in a local tangent plane."""
    result = []
    for way in source["elements"]:
        geometry = way.get("geometry", [])
        if way.get("type") != "way" or len(geometry) < 4 or geometry[0] != geometry[-1]:
            continue
        points = [(math.radians(p["lon"] - lon) * 6371008.8 * math.cos(math.radians(lat)), math.radians(p["lat"] - lat) * 6371008.8) for p in geometry[:-1]]
        points = list(dict.fromkeys(points))
        if len(points) < 3:
            continue
        area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1], strict=True)) / 2
        if abs(area) < 1:
            continue
        if area < 0:
            points.reverse()
        h, bottom = height(way.get("tags", {}))
        result.append({"id": way["id"], "points": points, "h": h, "bottom": bottom})
    return result


def coordinate_key(value: float) -> str:
    """Match cityCoordinateKey exactly, including negative and half-microdegree ties."""
    rounded = math.floor(value * 1_000_000 + 0.5)
    absolute = abs(rounded)
    return f"{'-' if rounded < 0 else ''}{absolute // 1_000_000}.{absolute % 1_000_000:06d}"


def source_area(lat: float, lon: float, radius: int) -> tuple[dict[str, Any], str]:
    """Read and verify the consented source; never access the network inside Blender."""
    directory = Path(paths()["local"]) / "generated/osm-source" / f"{coordinate_key(lat)}_{coordinate_key(lon)}_{radius}"
    file = directory / "source.json"
    if not file.is_file():
        msg = f'OSM source missing: pnpm blender:city --lat {lat} --lon {lon} --radius {radius} --consent "who/when/why"'
        raise ValueError(msg)
    data = file.read_bytes()
    receipt = json.loads((directory / "asset.json").read_text())
    digest = hashlib.sha256(data).hexdigest()
    if digest != receipt["sha256"] or receipt["attribution"] != ATTRIBUTION:
        msg = "OSM source receipt/hash/attribution mismatch"
        raise ValueError(msg)
    return json.loads(data), digest


def box_data(vertices: list[Any], faces: list[Any], centre: tuple[float, ...], size: tuple[float, ...]) -> None:
    """Append a box to a batched mesh (no thousands of Blender operators)."""
    start = len(vertices)
    x, y, z = centre
    w, d, h = (v / 2 for v in size)
    vertices.extend((x + a * w, y + b * d, z + c * h) for a, b, c in ((-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)))
    faces.extend(tuple(start + i for i in f) for f in ((3, 2, 1, 0), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)))


def instance_bodies(buildings: list[dict[str, Any]], mats: list[Any]) -> list[Any]:
    """Real GN instances: seed-controlled point dimensions drive metre-sized cube primitives."""
    import bpy

    objects = []
    for style, mat in enumerate(mats):
        batch = [b for b in buildings if b["style"] == style]
        obj = mesh(f"City bodies {style}", [(b["x"], b["y"], b["h"] / 2) for b in batch], [])
        obj["avc_city_body"] = True
        obj.data.materials.append(mat)
        dims = obj.data.attributes.new("dimensions", "FLOAT_VECTOR", "POINT")
        for item, building in zip(dims.data, batch, strict=True):
            item.vector = (building["w"], building["d"], building["h"])
        group = bpy.data.node_groups.new("AVC City blocks", "GeometryNodeTree")
        group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
        nodes, links = group.nodes, group.links
        inp, out = nodes.new("NodeGroupInput"), nodes.new("NodeGroupOutput")
        cube = nodes.new("GeometryNodeMeshCube")
        cube.inputs["Size"].default_value = (1, 1, 1)
        shading = nodes.new("GeometryNodeSetMaterial")
        shading.inputs["Material"].default_value = mat
        links.new(cube.outputs["Mesh"], shading.inputs["Geometry"])
        attr = nodes.new("GeometryNodeInputNamedAttribute")
        attr.data_type = "FLOAT_VECTOR"
        attr.inputs["Name"].default_value = "dimensions"
        inst = nodes.new("GeometryNodeInstanceOnPoints")
        links.new(inp.outputs["Geometry"], inst.inputs["Points"])
        links.new(shading.outputs["Geometry"], inst.inputs["Instance"])
        links.new(attr.outputs["Attribute"], inst.inputs["Scale"])
        links.new(inst.outputs["Instances"], out.inputs["Geometry"])
        obj.modifiers.new("AVC City blocks", "NODES").node_group = group
        objects.append(obj)
    return objects


def window_mesh(buildings: list[dict[str, Any]], seed: int) -> Any:
    """Inset panes with stable per-window banks; occupancy has no frame-order state."""
    rng = random.Random(seed)
    vertices, faces, banks = [], [], []
    for b in buildings:
        x, y, w, d, h = (b[k] for k in ("x", "y", "w", "d", "h"))
        for side in range(4):
            length = w if side < 2 else d
            count = max(1, int(length / 2.8))
            for floor in range(max(1, int(h / FLOOR) - 1)):
                z = 2.1 + floor * FLOOR
                for col in range(count):
                    u = -length / 2 + (col + 0.5) * length / count
                    half_w, half_h = min(0.75, length / count * 0.29), 0.85
                    if side < 2:
                        yy = y + (-1 if side == 0 else 1) * (d / 2 + 0.035)
                        pane = [(x + u - half_w, yy, z - half_h), (x + u + half_w, yy, z - half_h), (x + u + half_w, yy, z + half_h), (x + u - half_w, yy, z + half_h)]
                        if side == 1:
                            pane.reverse()
                    else:
                        xx = x + (-1 if side == 2 else 1) * (w / 2 + 0.035)
                        pane = [(xx, y + u - half_w, z - half_h), (xx, y + u + half_w, z - half_h), (xx, y + u + half_w, z + half_h), (xx, y + u - half_w, z + half_h)]
                        if side == 2:
                            pane.reverse()
                    start = len(vertices)
                    vertices.extend(pane)
                    faces.append((start, start + 1, start + 2, start + 3))
                    banks.append(rng.randrange(12) if rng.random() < 0.48 else 12)
    obj = mesh("City window panes", vertices, faces)
    obj["avc_city_windows"] = True
    for bank in range(13):
        warm = bank % 4 != 0
        colour = (0.95, 0.57, 0.23, 1) if warm else (0.44, 0.65, 0.84, 1)
        mat = material(f"City window {bank}", (0.018, 0.032, 0.045, 1), 0.55, 0.23)
        group = next(n.node_tree for n in mat.node_tree.nodes if n.type == "GROUP")
        shader = next(n for n in group.nodes if n.type == "BSDF_PRINCIPLED")
        shader.inputs["Emission Color"].default_value = colour
        mat["avc_window_bank"] = bank
        obj.data.materials.append(mat)
    for polygon, bank in zip(obj.data.polygons, banks, strict=True):
        polygon.material_index = bank
    return obj


def native_geometry(p: dict[str, Any]) -> list[Any]:
    """Skyline, floor bands, roof machinery and road markings in five batched meshes."""
    buildings = layout(p["seed"], p["blocks"], p["spacing"], p["hero_height"])
    mats = [
        material("City blue aluminium", (0.065, 0.11, 0.16, 1), 0.62, 0.28),
        material("City limestone", (0.29, 0.27, 0.23, 1), 0.12, 0.62),
        material("City brick", (0.16, 0.074, 0.046, 1), 0.05, 0.72),
    ]
    objects = instance_bodies(buildings, mats)
    objects.append(window_mesh(buildings, p["seed"]))
    metal = material("City roof and mullions", (0.13, 0.17, 0.2, 1), 0.7, 0.38)
    vertices, faces = [], []
    for b in buildings:
        x, y, w, d, h = (b[k] for k in ("x", "y", "w", "d", "h"))
        box_data(vertices, faces, (x, y, h + 0.6), (w + 0.5, d + 0.5, 1.2))
        box_data(vertices, faces, (x + w * 0.1, y, h + 2), (w * 0.35, d * 0.4, 3))
        for z in range(1, int(h), 10):
            box_data(vertices, faces, (x, y, z), (w + 0.16, d + 0.16, 0.24))
        box_data(vertices, faces, (x, y, 0.5), (w + 1.8, d + 1.8, 1))
    objects.append(mesh("City architectural details", vertices, faces, metal))
    extent = p["spacing"] * (p["blocks"] + 1)
    vertices, faces = [], []
    box_data(vertices, faces, (0, 0, -0.35), (extent * 30, extent * 30, 0.6))
    objects.append(mesh("City asphalt", vertices, faces, material("City asphalt", (0.033, 0.042, 0.05, 1), 0.05, 0.77)))
    vertices, faces = [], []
    for row in range(p["blocks"] + 1):
        v = (row - p["blocks"] / 2) * p["spacing"]
        for t in range(-int(extent / 2), int(extent / 2), 10):
            box_data(vertices, faces, (v, t, 0.015), (0.18, 3.5, 0.025))
            box_data(vertices, faces, (t, v, 0.015), (3.5, 0.18, 0.025))
    objects.append(mesh("City lane markings", vertices, faces, material("City road paint", (0.5, 0.43, 0.25, 1), 0, 0.7)))
    return objects


def osm_geometry(buildings: list[dict[str, Any]]) -> list[Any]:
    """Extrude actual OSM polygons; no invented streets or rooftop shapes on real places."""
    from mathutils import Vector
    from mathutils.geometry import tessellate_polygon

    vertices, faces = [], []
    for b in buildings:
        points, h, bottom = b["points"], b["h"], b["bottom"]
        start, n = len(vertices), len(points)
        vertices.extend((x, y, z) for z in (bottom, h) for x, y in points)
        faces.extend((start + i, start + (i + 1) % n, start + (i + 1) % n + n, start + i + n) for i in range(n))
        vectors = [Vector((x, y, h)) for x, y in points]
        for tri in tessellate_polygon([vectors]):
            indices = [v if isinstance(v, int) else vectors.index(v) for v in tri]
            faces.append(tuple(start + n + i for i in indices))
            faces.append(tuple(start + i for i in reversed(indices)))
    obj = mesh("OSM building footprints", vertices, faces, material("OSM masonry", (0.32, 0.29, 0.25, 1), 0.12, 0.62))
    obj["attribution"] = ATTRIBUTION
    obj["avc_city_body"] = True
    return [obj]


def cached_geometry(tool: str, p: dict[str, Any], build: Any, context: dict[str, Any] | None = None) -> tuple[list[Any], dict[str, Any]]:
    """Publish only a complete .blend + hash receipt, appendable without enabling scripts."""
    import bpy

    started = time.monotonic()
    directory = Path(paths()["local"]) / "generated" / tool / cache_hash(tool, p, context)
    directory.mkdir(parents=True, exist_ok=True)
    file, receipt = directory / "city.blend", directory / "asset.json"
    reused = file.is_file() and receipt.is_file()
    if reused:
        saved = json.loads(receipt.read_text())
        if hashlib.sha256(file.read_bytes()).hexdigest() != saved["sha256"]:
            msg = "City geometry cache hash mismatch"
            raise ValueError(msg)
        with bpy.data.libraries.load(str(file), link=False) as (source, dest):
            dest.collections = [source.collections[0]]
        collection = dest.collections[0]
        bpy.context.scene.collection.children.link(collection)
        objects = list(collection.all_objects)
    else:
        objects = build()
        collection = bpy.data.collections.new("AVC " + tool)
        bpy.context.scene.collection.children.link(collection)
        for obj in objects:
            for parent in list(obj.users_collection):
                parent.objects.unlink(obj)
            collection.objects.link(obj)
        temporary = directory / "city.tmp.blend"
        bpy.data.libraries.write(str(temporary), {collection}, fake_user=True, compress=True)
        temporary.replace(file)
        data = {
            "version": 1,
            "tool": tool,
            "params": p,
            "context": context or {},
            "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            "licence": "ODbL-1.0" if tool == "osm-city" else "CC0-1.0",
            "attribution": ATTRIBUTION if tool == "osm-city" else "Agent Bros. Pictures procedural geometry",
        }
        receipt.write_text(json.dumps(data, sort_keys=True) + "\n")
        (directory / "credits.json").write_text(json.dumps({"licence": data["licence"], "attribution": data["attribution"]}) + "\n")
    return objects, {"path": str(file), "reused": reused, "seconds": time.monotonic() - started}


def stored_material(objects: list[Any], asset_id: str) -> None:
    """Optionally override masonry using a licensed material from the local store."""
    if not asset_id:
        return
    from avc_assets import append

    result = append(asset_id)
    import bpy

    if not isinstance(result, bpy.types.Material):
        msg = "material_asset must resolve to a material"
        raise TypeError(msg)
    for obj in objects:
        if obj.get("avc_city_body"):
            if obj.modifiers:
                for node in obj.modifiers[0].node_group.nodes:
                    if node.bl_idname == "GeometryNodeSetMaterial":
                        node.inputs["Material"].default_value = result
            obj.data.materials.clear()
            obj.data.materials.append(result)
