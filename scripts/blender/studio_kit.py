# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
r"""Studio kit for photoreal device shots, shared by the shot scripts in this folder.

Run a shot through the runner, never Blender directly:

    pnpm exec tsx scripts/blender-run.ts --script scripts/blender/hero_turntable.py \
      --output out/qa/hero --frames 1-60 --samples 24 --resolution 1920x1080 --film-transparent \
      --script-args '["{\"device\": \"phone\", \"look\": \"dark\"}"]'

The first script argument is a JSON object or a path to a .json file. Every shot reads the common
keys below plus its own; unknown keys are an error so a typo does not silently fall back.

Scene convention: metres, Z up, the device's screen faces -Y, the camera looks along +Y.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeAlias, overload

import avc_export
import bpy
from mathutils import Matrix, Vector

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

Params: TypeAlias = dict[str, Any]


# Dynamic Blender/operator dictionaries are validated by their owning request schemas.

ROOT = os.path.abspath(str(Path(str(Path(__file__).parent)).joinpath("..", "..")))  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.
SHARED = str(Path(ROOT).joinpath("public", "shared"))

# Normalised GLBs made by prepare_devices.py: real size in metres, screen named "screen" with 0..1 UVs.
DEVICES = {
    "phone": str(Path(SHARED).joinpath("3d", "phone.glb")),
    "laptop": str(Path(SHARED).joinpath("3d", "laptop.glb")),
    "tablet": str(Path(SHARED).joinpath("3d", "tablet.glb")),
}
HDRIS = {
    "studio": "studio_small_09_2k.hdr",
    "softbox": "studio_small_08_2k.hdr",
    "warm": "brown_photostudio_02_2k.hdr",
    "loft": "photo_studio_loft_hall_2k.hdr",
}

COMMON = {
    "device": "phone",
    # "dark" | "light" | "none" (transparent ground: pair with --film-transparent)
    "look": "dark",
    "backdrop": None,
    "hdri": "studio",
    "hdriStrength": 0.8,
    "hdriRotation": 0.0,
    # "softbox" | "rim" | "bright"
    "lights": "softbox",
    "screen": None,
    "screenFps": 30,
    "screenBrightness": 1.0,
    "frames": 60,
    "fps": 30,
    "lens": 85.0,
    "fstop": 2.8,
    "seed": 0,
}

LOOKS = {
    "dark": {"backdrop": (0.0025, 0.0025, 0.003), "roughness": 0.85, "specular": 0.08, "exposure": 0.0, "look": "AgX - Medium High Contrast"},
    "light": {"backdrop": (0.62, 0.62, 0.64), "roughness": 0.6, "specular": 0.3, "exposure": 0.0, "look": "AgX - Base Contrast"},
    "none": {"backdrop": None, "roughness": 0.5, "specular": 0.5, "exposure": 0.0, "look": "AgX - Medium High Contrast"},
}


def args(defaults: Params) -> Params:
    """Merges the JSON argument over COMMON and the shot's defaults."""
    return parse_args(COMMON, defaults)


def parse_args(common: Params, defaults: Params) -> Params:
    """Merges the JSON argument over `common` and the shot's defaults; unknown keys are an error."""
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    given = {}
    if argv:
        raw = argv[0]
        if raw.strip().startswith("{"):
            given = json.loads(raw)
        else:
            with Path(raw).open(encoding="utf8") as handle:
                given = json.load(handle)
    merged = {**common, **defaults}
    unknown = sorted(set(given) - set(merged))
    if unknown:
        error_message = f"Unknown shot arguments: {', '.join(unknown)}. Known: {', '.join(sorted(merged))}"
        raise ValueError(error_message)
    merged.update(given)
    return merged


@overload
def hex_rgb(value: str | Sequence[float]) -> Sequence[float]: ...


@overload
def hex_rgb(value: None) -> None: ...


def hex_rgb(value: str | Sequence[float] | None) -> Sequence[float] | None:
    """Convert a hexadecimal colour to linear RGB, preserving supplied components."""
    if value is None or not isinstance(value, str):
        return value
    value = value.lstrip("#")
    srgb = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)


def reset(a: Params) -> bpy.types.Scene:
    """Empty scene, Cycles with OIDN, AgX. The runner's --samples and --resolution override these."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.03
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 10
    scene.cycles.glossy_bounces = 6
    scene.cycles.transmission_bounces = 8
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.cycles.seed = a["seed"]
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    scene.render.fps = a["fps"]
    scene.frame_start, scene.frame_end = 1, a["frames"]
    look: Params = dict(LOOKS[a["look"]])
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = look["look"]
    scene.view_settings.exposure = look["exposure"]
    scene.render.use_stamp = False
    scene.render.film_transparent = a["look"] == "none"
    return scene


def ease(obj: bpy.types.Object, path: str | None = None) -> None:
    """Smooth ease-in-out on every keyframe of the object (Bezier, auto-clamped)."""
    if not obj.animation_data or not obj.animation_data.action:
        return
    action = obj.animation_data.action
    curves = []
    if hasattr(action, "fcurves"):
        curves = list(action.fcurves)
    else:  # Blender 5 layered actions
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    curves.extend(bag.fcurves)
    for curve in curves:
        if path and curve.data_path != path:
            continue
        for point in curve.keyframe_points:
            point.interpolation = "BEZIER"
            point.handle_left_type = point.handle_right_type = "AUTO_CLAMPED"


def key(obj: bpy.types.Object, frame: float, **values: float | Sequence[float] | bool) -> None:
    """Insert a keyframe on the specified property."""
    for name, value in values.items():
        setattr(obj, name, value)
        obj.keyframe_insert(name, frame=frame)


# ---------- devices ----------


def import_device(kind_or_path: str, name: str = "device") -> tuple[bpy.types.Object, bpy.types.Object | None, list[bpy.types.Object]]:
    """Imports a normalised device GLB under an empty `name`; returns (root, screen or None, meshes)."""
    path = DEVICES.get(kind_or_path, kind_or_path)
    if not Path(path).is_absolute():
        path = str(Path(ROOT).joinpath(path))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    added = [obj for obj in bpy.data.objects if obj not in before]
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    for obj in added:
        if obj.parent is None:
            obj.parent = root
    screen = next((obj for obj in added if obj.name.split(".")[0] == "screen"), None)
    meshes = [obj for obj in added if obj.type == "MESH"]
    return root, screen, meshes


def screen_size(screen: bpy.types.Object) -> tuple[float, float]:
    """Return the device screen dimensions in metres."""
    corners = screen_corners(screen, local=True)
    return (corners[1] - corners[0]).length, (corners[3] - corners[0]).length


def screen_corners(screen: bpy.types.Object, local: bool = False) -> list[Vector]:
    """Top-left, top-right, bottom-right, bottom-left from the UV rectangle prepare_devices.py wrote."""
    mesh = screen.data
    uv = mesh.uv_layers.active.data
    targets = {"tl": (0, 1), "tr": (1, 1), "br": (1, 0), "bl": (0, 0)}
    # Solve the affine map uv -> position from three well-spread loops, then evaluate the corners.
    loops = list(mesh.loops)
    samples = []
    for tu, tv in targets.values():
        loop = min(loops, key=lambda candidate: (uv[candidate.index].uv[0] - tu) ** 2 + (uv[candidate.index].uv[1] - tv) ** 2)
        samples.append((Vector(uv[loop.index].uv), Vector(mesh.vertices[loop.vertex_index].co)))
    (u0, p0), (u1, p1), (_, _), (u3, p3) = samples
    du, dv = u1 - u0, u3 - u0
    det = du.x * dv.y - du.y * dv.x
    if abs(det) < 1e-9:
        error_message = "Screen UVs are degenerate; re-run prepare_devices.py"
        raise RuntimeError(error_message)
    inv = Matrix(((dv.y / det, -dv.x / det), (-du.y / det, du.x / det)))
    eu_ev = [(p1 - p0), (p3 - p0)]

    def at(u: float, v: float) -> Vector:
        d = Vector((u, v)) - u0
        a, b = inv @ d
        return p0 + eu_ev[0] * a + eu_ev[1] * b

    points = [at(*targets[n]) for n in ("tl", "tr", "br", "bl")]
    return points if local else [screen.matrix_world @ p for p in points]


def corner_anchors(screen: bpy.types.Object, prefix: str = "screen") -> list[str]:
    """Empties at the screen's four corners, parented to it, for avc_export.export_camera(anchors=...)."""
    names = []
    for label, point in zip(("tl", "tr", "br", "bl"), screen_corners(screen, local=True), strict=True):
        empty = bpy.data.objects.new(f"{prefix}_{label}", None)
        bpy.context.scene.collection.objects.link(empty)
        empty.parent = screen
        empty.location = point
        names.append(empty.name)
    return names


def set_screen(screen: bpy.types.Object, source: str, a: Params, fit: str = "contain") -> bpy.types.Material:
    """Replaces the screen material: emissive image (or PNG sequence folder) under glossy glass.

    `source` is a PNG/JPG file, a folder of numbered frames, or None for a dark glass screen.
    """
    mat = bpy.data.materials.new("screen-ui")
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1)
    bsdf.inputs["Roughness"].default_value = 0.035
    bsdf.inputs["Coat Weight"].default_value = 0.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.22
    if source:
        path = source if Path(source).is_absolute() else str(Path(ROOT).joinpath(source))
        tex = nodes.new("ShaderNodeTexImage")
        tex.extension = "CLIP"
        tex.interpolation = "Cubic"
        if Path(path).is_dir():
            files = sorted(f for f in [entry.name for entry in Path(path).iterdir()] if f.lower().endswith((".png", ".jpg", ".jpeg")))
            if not files:
                error_message = f"No frames in {path}"
                raise RuntimeError(error_message)
            image = bpy.data.images.load(str(Path(path).joinpath(files[0])))
            pixels = tuple(image.size)
            image.source = "SEQUENCE"
            tex.image = image
            user = tex.image_user
            user.frame_duration = len(files)
            user.frame_start = 1
            digits = re.findall(r"\d+", Path(files[0]).stem)
            user.frame_offset = int(digits[-1]) - 1 if digits else 0
            user.use_auto_refresh = True
            user.use_cyclic = False
        else:
            image = bpy.data.images.load(path)
            pixels = tuple(image.size)
            tex.image = image
        image.colorspace_settings.name = "sRGB"
        width, height = screen_size(screen)
        screen_aspect = width / height
        image_aspect = pixels[0] / max(1, pixels[1])
        mapping = nodes.new("ShaderNodeMapping")
        coord = nodes.new("ShaderNodeTexCoord")
        su = sv = 1.0
        if (image_aspect > screen_aspect) == (fit == "cover"):
            su = screen_aspect / image_aspect
        else:
            sv = image_aspect / screen_aspect
        mapping.inputs["Scale"].default_value = (su, sv, 1)
        mapping.inputs["Location"].default_value = (0.5 * (1 - su), 0.5 * (1 - sv), 0)
        links.new(coord.outputs["UV"], mapping.inputs["Vector"])
        links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
        links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.6 * a["screenBrightness"]
    screen.data.materials.clear()
    screen.data.materials.append(mat)
    return mat


def world_bounds(objects: Iterable[bpy.types.Object]) -> tuple[Vector, Vector]:
    """Measure the evaluated device bounds in world coordinates."""
    points = [obj.matrix_world @ Vector(c) for obj in objects if obj.type == "MESH" for c in obj.bound_box]
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


# ---------- studio ----------


def material(name: str, colour: Sequence[float], roughness: float = 0.5, metallic: float = 0.0, specular: float = 0.5) -> bpy.types.Material:
    """Build a Principled material with the requested surface properties."""
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Specular IOR Level"].default_value = specular
    bsdf.inputs["Base Color"].default_value = (*colour, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def sweep(a: Params, floor_z: float, size: float) -> bpy.types.Object:
    """A cyclorama: floor curving up into a back wall, so there is no horizon line.

    With look "none" the floor becomes a small shadow catcher and the wall is dropped.
    """
    look: Params = dict(LOOKS[a["look"]])
    colour = hex_rgb(a["backdrop"]) or look["backdrop"]
    radius = size * 2.5
    verts, faces = [], []
    profile = []
    back = size * 4
    for i in range(24):
        t = i / 23 * (math.pi / 2)
        profile.append((back - radius + math.sin(t) * radius, radius - math.cos(t) * radius))
    profile.insert(0, (-size * 8, 0.0))
    profile.append((back, size * 10))
    width = size * 14
    for y, z in profile:
        verts.extend([(-width, y, z + floor_z), (width, y, z + floor_z)])
    faces = [(i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2) for i in range(len(profile) - 1)]
    mesh = bpy.data.meshes.new("sweep")
    mesh.from_pydata(verts, [], faces)
    mesh.shade_smooth()
    obj = bpy.data.objects.new("sweep", mesh)
    bpy.context.scene.collection.objects.link(obj)
    if colour is None:
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.ops.mesh.primitive_circle_add(vertices=64, radius=size * 1.6, fill_type="NGON", location=(0, 0, floor_z))
        catcher = bpy.context.active_object
        catcher.name = "shadow-catcher"
        catcher.is_shadow_catcher = True
        return catcher
    obj.data.materials.append(material("backdrop", colour, roughness=look["roughness"], specular=look["specular"]))
    return obj


def hdri(a: Params) -> None:
    """Configure the requested HDRI environment."""
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    background = nodes["Background"]
    name = HDRIS.get(a["hdri"], a["hdri"])
    if not name:
        background.inputs["Color"].default_value = (0.01, 0.01, 0.012, 1)
        return
    path = name if Path(name).is_absolute() else str(Path(SHARED).joinpath("hdri", name))
    env = nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(path)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value = (0, 0, math.radians(a["hdriRotation"]))
    coord = nodes.new("ShaderNodeTexCoord")
    links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    links.new(env.outputs["Color"], background.inputs["Color"])
    background.inputs["Strength"].default_value = a["hdriStrength"]


def area(
    name: str, power: float, size: float, location: Sequence[float], target: Sequence[float] = (0, 0, 0), colour: Sequence[float] = (1, 1, 1), ratio: float = 0.35, spread: float = 180
) -> bpy.types.Object:
    """Create and aim an area light."""
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.color = power, colour
    data.shape = "RECTANGLE"
    data.size, data.size_y = size, size * ratio
    data.spread = math.radians(spread)
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    bpy.context.scene.collection.objects.link(obj)
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj


def strips(k: float, s: float) -> None:
    """Tall, narrow softboxes either side and a little behind: the crisp edge lines on metal frames."""
    for side in (-1, 1):
        data = bpy.data.lights.new(f"strip{side}", "AREA")
        data.shape = "RECTANGLE"
        data.size, data.size_y = 0.08 * s * 6, 2.2 * s * 6
        data.energy = 40 * k
        data.spread = math.radians(40)
        obj = bpy.data.objects.new(f"strip{side}", data)
        obj.location = (side * 1.3 * s * 6, 0.5 * s * 6, 0.2 * s * 6)
        bpy.context.scene.collection.objects.link(obj)
        direction = Vector((0, 0, 0)) - obj.location
        direction.z = 0
        obj.rotation_euler = direction.to_track_quat("-Z", "Z").to_euler()


def light_rig(a: Params, size: float) -> None:
    """Three presets scaled to the subject's size (metres). Power scales with distance squared."""
    s = size
    k = (s / 0.16) ** 2
    preset = a["lights"]
    if preset == "softbox":
        area("key", 90 * k, 1.6 * s * 6, (-2.6 * s * 6, -2.0 * s * 6, 1.5 * s * 6), colour=(1.0, 0.96, 0.91), ratio=0.5)
        area("rim", 140 * k, 1.2 * s * 6, (2.4 * s * 6, 2.0 * s * 6, 1.0 * s * 6), colour=(0.86, 0.91, 1.0), ratio=0.18, spread=60)
        area("top", 45 * k, 2.4 * s * 6, (0, -0.4 * s * 6, 3.2 * s * 6), ratio=0.6)
        strips(k, s)
    elif preset == "rim":
        area("rim-left", 160 * k, 1.6 * s * 6, (-2.2 * s * 6, 1.8 * s * 6, 0.6 * s * 6), colour=(0.9, 0.94, 1.0), ratio=0.12, spread=50)
        area("rim-right", 160 * k, 1.6 * s * 6, (2.2 * s * 6, 1.8 * s * 6, 0.6 * s * 6), colour=(1.0, 0.95, 0.9), ratio=0.12, spread=50)
        area("top", 30 * k, 2.0 * s * 6, (0, 0.2 * s * 6, 3.0 * s * 6), ratio=0.5)
        strips(k, s)
    elif preset == "bright":
        area("key", 70 * k, 2.4 * s * 6, (-2.0 * s * 6, -2.4 * s * 6, 2.0 * s * 6), ratio=0.8)
        area("fill", 40 * k, 2.4 * s * 6, (2.4 * s * 6, -2.0 * s * 6, 1.2 * s * 6), ratio=0.8)
        area("top", 60 * k, 3.0 * s * 6, (0, 0, 3.4 * s * 6), ratio=0.8)
        area("rim", 70 * k, 1.2 * s * 6, (0, 2.6 * s * 6, 1.2 * s * 6), ratio=0.2, spread=70)
    else:
        error_message = f"Unknown lights preset {preset}"
        raise ValueError(error_message)


def camera(a: Params, target: Sequence[float], distance: float, height: float = 0.0, yaw: float = 0.0) -> tuple[bpy.types.Object, bpy.types.Object]:
    """An `a["lens"]` camera looking at `target` from -Y, DoF focused on a focus empty at the target."""
    data = bpy.data.cameras.new("camera")
    data.lens = a["lens"]
    data.sensor_width = 36
    data.clip_start = 0.01
    data.clip_end = 200
    focus = bpy.data.objects.new("focus", None)
    bpy.context.scene.collection.objects.link(focus)
    focus.location = target
    data.dof.use_dof = a["fstop"] > 0
    data.dof.focus_object = focus
    data.dof.aperture_fstop = max(0.5, a["fstop"] or 2.8)
    data.dof.aperture_blades = 9
    cam = bpy.data.objects.new("camera", data)
    bpy.context.scene.collection.objects.link(cam)
    place_camera(cam, target, distance, height, yaw)
    bpy.context.scene.camera = cam
    return cam, focus


def place_camera(cam: bpy.types.Object, target: Sequence[float], distance: float, height: float = 0.0, yaw: float = 0.0) -> None:
    """Position and aim the scene camera."""
    target = Vector(target)
    cam.location = target + Vector((math.sin(math.radians(yaw)) * distance, -math.cos(math.radians(yaw)) * distance, height))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()


def fit_distance(a: Params, width: float, height: float) -> float:
    """Camera distance at which a width x height subject fills about 70% of the frame."""
    scene = bpy.context.scene
    aspect = scene.render.resolution_x / scene.render.resolution_y
    sensor = 36.0
    fov_x = 2 * math.atan(sensor / (2 * a["lens"]))
    fov_y = 2 * math.atan(sensor / aspect / (2 * a["lens"])) if aspect >= 1 else 2 * math.atan(sensor / (2 * a["lens"]))
    if aspect < 1:
        fov_x = 2 * math.atan(sensor * aspect / (2 * a["lens"]))
    by_w = width / (2 * math.tan(fov_x / 2) * 0.7)
    by_h = height / (2 * math.tan(fov_y / 2) * 0.7)
    return max(by_w, by_h)


def finish(anchors: Iterable[str] = ()) -> None:
    """Exports camera.json (with anchor pixels) when run through blender-run."""
    if avc_export.render_request():
        avc_export.export_camera(anchors=list(anchors))
