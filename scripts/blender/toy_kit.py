# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
r"""Share geometry, surfaces and frame-driven animation across stylised shots.

Toy kit: the shared pieces of the stylised shots (glossy orb, plush character, glass dome, printing slip, card fan,
device array). The device studio lives in studio_kit.py; this file adds what those shots need beyond it.

Determinism: every animated value is a pure function of the frame. `per_frame` evaluates a Python function at each
integer frame and writes linear keys, so a single frame renders the same alone as inside a range, and the eases below
are the GSAP curves the browser blocks use (src/motion/library/three/three-plan.ts). Seeds are fixed per shot.

Run a shot only through the runner (scripts/blender/AGENTS.md):

    pnpm blender:run --script scripts/blender/glossy_orb.py --output out/qa/orb --frames 1-60 --samples 16 \
      --resolution 960x540 --encode h264
"""

from __future__ import annotations

import math
import random
from typing import TYPE_CHECKING, Any, TypeAlias

import bmesh
import bpy
from mathutils import Vector

import studio_kit as kit
from kit import curves

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Sequence

Params: TypeAlias = dict[str, Any]


# Dynamic Blender/operator dictionaries are validated by their owning request schemas.

# Keys every toy shot accepts, in addition to its own.
COMMON = {"frames": 60, "fps": 30, "seed": 0, "lens": 50.0, "fstop": 0.0, "width": 1920, "height": 1080}


def args(defaults: Params) -> Params:
    r"""Merge shot settings and apply the runner resolution to camera framing.

    Shot keys over COMMON; the runner's --resolution, when given, sets width and height, so framing follows the
    aspect actually rendered (vertical and square included).
    """
    a = kit.parse_args(COMMON, defaults)
    a["width"], a["height"] = requested_size((a["width"], a["height"]))
    return a


def requested_size(default: tuple[int, int]) -> tuple[int, int]:
    """Use the runner resolution when present, otherwise the supplied dimensions."""
    request = kit.avc_export.render_request()
    size = request.get("resolution") if request else None
    return tuple(size) if size else default


# ---------- eases (GSAP names, input clamped to 0..1) ----------


def clamp01(t: float) -> float:
    """Clamp progress to the inclusive unit interval."""
    return min(1.0, max(0.0, t))


EASES = {
    "linear": lambda t: t,
    "power1.out": lambda t: 1 - (1 - t) ** 2,
    "power2.in": lambda t: t**3,
    "power2.out": lambda t: 1 - (1 - t) ** 3,
    "power2.inOut": lambda t: 4 * t**3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2,
    "power3.out": lambda t: 1 - (1 - t) ** 4,
    "sine.out": lambda t: math.sin(t * math.pi / 2),
    "sine.inOut": lambda t: -(math.cos(math.pi * t) - 1) / 2,
    "expo.out": lambda t: 1.0 if t >= 1 else 1 - 2 ** (-10 * t),
    "circ.out": lambda t: math.sqrt(1 - (t - 1) ** 2),
}


def progress(frame: float, at: float, frames: float, ease: str = "linear") -> float:
    """Eased 0..1 progress of a move that starts at `at` (0-based block frame) and lasts `frames`."""
    if frames <= 0:
        return 1.0 if frame >= at else 0.0
    return EASES[ease](clamp01((frame - at) / frames))


mix = curves.mix


# ---------- scene ----------


def reset(a: Params, view: str = "AgX", look: str | None = "AgX - Base Contrast", samples: int = 32) -> bpy.types.Scene:
    """Empty scene, Cycles with denoise, fixed seed. Blender frame 1 is block frame 0."""
    for collection in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.curves, bpy.data.metaballs):
        for block in list(collection):
            collection.remove(block)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.03
    scene.cycles.use_denoising = True
    scene.cycles.seed = a["seed"]
    scene.cycles.use_animated_seed = False
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 12
    scene.cycles.glossy_bounces = 6
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.render.resolution_x, scene.render.resolution_y = a["width"], a["height"]
    scene.render.resolution_percentage = 100
    scene.render.fps = a["fps"]
    scene.frame_start, scene.frame_end = 1, a["frames"]
    scene.view_settings.view_transform = view
    if look:
        scene.view_settings.look = look
    scene.render.use_stamp = False
    scene.render.film_transparent = False
    scene.render.use_lock_interface = True
    return scene


def per_frame(a: Params, fn: Callable[[int], Iterable[tuple[bpy.types.bpy_struct, str]]]) -> None:
    """Calls fn(block_frame) for every frame and keys what it sets: fn returns [(datablock, path)] to key."""
    for frame in range(a["frames"]):
        for owner, path in fn(frame):
            owner.keyframe_insert(path, frame=frame + 1)
    linear_all()


def linear_all() -> None:
    """Linear interpolation on every key in the file: values between integer frames are never used, keys sit on each."""
    actions = list(bpy.data.actions)
    for action in actions:
        curves = list(action.fcurves) if hasattr(action, "fcurves") else []
        if not curves:
            for layer in getattr(action, "layers", []):
                for strip in layer.strips:
                    for bag in strip.channelbags:
                        curves.extend(bag.fcurves)
        for curve in curves:
            for point in curve.keyframe_points:
                point.interpolation = "LINEAR"


def link(obj: bpy.types.Object) -> bpy.types.Object:
    """Link an object into the active scene collection."""
    bpy.context.scene.collection.objects.link(obj)
    return obj


def empty(name: str, location: Sequence[float] = (0, 0, 0)) -> bpy.types.Object:
    """Create a named empty object."""
    obj = link(bpy.data.objects.new(name, None))
    obj.location = location
    return obj


def mesh_object(name: str, verts: Sequence[Sequence[float]], faces: Sequence[Sequence[int]], smooth: bool = True) -> bpy.types.Object:
    """Create a mesh object from vertices and faces."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    if smooth:
        mesh.shade_smooth()
    return link(bpy.data.objects.new(name, mesh))


def recalc_normals(obj: bpy.types.Object) -> None:
    """Outward normals on a mesh built from a profile, whatever the winding."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()


def uv_sphere(name: str, radius: float, location: tuple[float, ...] = (0, 0, 0), segments: int = 64, rings: int = 32) -> bpy.types.Object:
    """Create a UV sphere with the requested material."""
    verts, faces = [], []
    for r in range(1, rings):
        theta = math.pi * r / rings
        for s in range(segments):
            phi = 2 * math.pi * s / segments
            verts.append((radius * math.sin(theta) * math.cos(phi), radius * math.sin(theta) * math.sin(phi), radius * math.cos(theta)))
    top, bottom = len(verts), len(verts) + 1
    verts += [(0, 0, radius), (0, 0, -radius)]
    for r in range(rings - 2):
        for s in range(segments):
            a0, a1 = r * segments + s, r * segments + (s + 1) % segments
            b0, b1 = a0 + segments, a1 + segments
            faces.append((a0, a1, b1, b0))
    for s in range(segments):
        faces.append((top, (s + 1) % segments, s))
        last = (rings - 2) * segments
        faces.append((bottom, last + s, last + (s + 1) % segments))
    obj = mesh_object(name, verts, faces)
    recalc_normals(obj)
    obj.location = location
    return obj


def rounded_box(name: str, size: Sequence[float], bevel: float, segments: int = 4) -> bpy.types.Object:
    """A box of `size` (x, y, z) with bevelled edges (modifier), centred on its origin."""
    x, y, z = (v / 2 for v in size)
    verts = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z), (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    obj = mesh_object(name, verts, faces, smooth=False)
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = bevel
    mod.segments = segments
    mod.limit_method = "NONE"
    obj.data.shade_smooth()
    return obj


def hide_from_rays(obj: bpy.types.Object) -> None:
    """Seen by the camera only: no reflection, refraction, shadow or bounce light."""
    obj.visible_glossy = False
    obj.visible_diffuse = False
    obj.visible_transmission = False
    obj.visible_shadow = False
    obj.visible_volume_scatter = False


def flat_ground(colour: str | Sequence[float], camera_obj: bpy.types.Object, distance: float = 40.0) -> bpy.types.Object:
    """An emissive card that fills the frame behind everything in exactly `colour` (use with view "Standard")."""
    mat = bpy.data.materials.new("ground")
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (*kit.hex_rgb(colour), 1)
    emit.inputs["Strength"].default_value = 1.0
    links.new(emit.outputs[0], out.inputs["Surface"])
    size = distance * 4
    card = mesh_object("ground", [(-size, 0, -size), (size, 0, -size), (size, 0, size), (-size, 0, size)], [(0, 1, 2, 3)], smooth=False)
    card.data.materials.append(mat)
    card.parent = camera_obj
    card.location = (0, 0, -distance)
    card.rotation_euler = (math.radians(90), 0, 0)
    hide_from_rays(card)
    return card


def world_colour(colour: str | Sequence[float], strength: float = 1.0) -> bpy.types.World:
    """Set the world background colour and strength."""
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (*kit.hex_rgb(colour), 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = strength
    return world


def sky_world(zenith: str = "#5d8fd6", horizon: str = "#e9f1fb", clouds: float = 0.55, strength: float = 1.0, seed: int = 0) -> bpy.types.World:
    """A blue-to-white gradient sky with soft procedural cumulus (noise thresholded by height). No image files."""
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    background = nodes["Background"]
    coord = nodes.new("ShaderNodeTexCoord")
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coord.outputs["Generated"], sep.inputs[0])
    ramp = nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = -0.05
    ramp.inputs["From Max"].default_value = 0.6
    links.new(sep.outputs["Z"], ramp.inputs["Value"])
    grad = nodes.new("ShaderNodeMix")
    grad.data_type = "RGBA"
    grad.inputs["A"].default_value = (*kit.hex_rgb(horizon), 1)
    grad.inputs["B"].default_value = (*kit.hex_rgb(zenith), 1)
    links.new(ramp.outputs[0], grad.inputs["Factor"])
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 8.0
    noise.inputs["Roughness"].default_value = 0.62
    noise.noise_dimensions = "4D"
    noise.inputs["W"].default_value = seed * 1.7
    links.new(coord.outputs["Generated"], noise.inputs["Vector"])
    cloud = nodes.new("ShaderNodeMapRange")
    cloud.inputs["From Min"].default_value = 0.56
    cloud.inputs["From Max"].default_value = 0.7
    links.new(noise.outputs["Fac"], cloud.inputs["Value"])
    amount = nodes.new("ShaderNodeMath")
    amount.operation = "MULTIPLY"
    amount.inputs[1].default_value = clouds
    links.new(cloud.outputs[0], amount.inputs[0])
    sky = nodes.new("ShaderNodeMix")
    sky.data_type = "RGBA"
    sky.inputs["B"].default_value = (1.0, 1.0, 1.0, 1)
    links.new(amount.outputs[0], sky.inputs["Factor"])
    links.new(grad.outputs["Result"], sky.inputs["A"])
    links.new(sky.outputs["Result"], background.inputs["Color"])
    background.inputs["Strength"].default_value = strength
    return world


def sun(direction_deg: tuple[float, ...] = (50, 0, 30), strength: float = 3.0, colour: tuple[float, ...] = (1.0, 0.96, 0.9), angle: float = 8.0) -> bpy.types.Object:
    """Create a directional sun light."""
    data = bpy.data.lights.new("sun", "SUN")
    data.energy = strength
    data.color = colour
    data.angle = math.radians(angle)
    obj = link(bpy.data.objects.new("sun", data))
    obj.rotation_euler = tuple(math.radians(v) for v in direction_deg)
    return obj


def look_at(obj: bpy.types.Object, target: Sequence[float]) -> None:
    """Aim the object towards a world-space target."""
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def camera(a: Params, location: Sequence[float], target: Sequence[float], lens: float | None = None, ortho: float | None = None) -> bpy.types.Object:
    """Create and aim the scene camera."""
    data = bpy.data.cameras.new("camera")
    data.lens = lens or a["lens"]
    data.sensor_width = 36
    data.clip_start = 0.005
    data.clip_end = 500
    if ortho:
        data.type = "ORTHO"
        data.ortho_scale = ortho
    if a.get("fstop"):
        focus = empty("focus", target)
        data.dof.use_dof = True
        data.dof.focus_object = focus
        data.dof.aperture_fstop = a["fstop"]
        data.dof.aperture_blades = 9
    cam = link(bpy.data.objects.new("camera", data))
    cam.location = location
    look_at(cam, target)
    bpy.context.scene.camera = cam
    return cam


# ---------- materials ----------


def principled(name: str, colour: str | Sequence[float], roughness: float = 0.5, **inputs: float | Sequence[float]) -> bpy.types.Material:
    """A Principled BSDF material. Keyword inputs use the socket names with spaces as underscores."""
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*kit.hex_rgb(colour), 1)
    bsdf.inputs["Roughness"].default_value = roughness
    for key, value in inputs.items():
        bsdf.inputs[key.replace("_", " ")].default_value = value
    return mat


def fabric(name: str, colour: str | Sequence[float], fuzz: float = 0.0015, seed: int = 0, scale: float = 1.0) -> bpy.types.Material:
    """Felt or plush fabric: deep sheen at grazing angles, soft subsurface, fine fibre bump (noise and Voronoi)."""
    mat = principled(name, colour, roughness=0.92, Sheen_Weight=1.0, Sheen_Roughness=0.45, Subsurface_Weight=0.25, Specular_IOR_Level=0.18)
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    lighter = tuple(min(1.0, 0.35 + v * 1.6) for v in kit.hex_rgb(colour))
    bsdf.inputs["Sheen Tint"].default_value = (*lighter, 1)
    bsdf.inputs["Subsurface Radius"].default_value = (0.9, 0.5, 0.35)
    bsdf.inputs["Subsurface Scale"].default_value = 0.02
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    coord = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 420.0 * scale
    noise.inputs["Detail"].default_value = 4.0
    noise.noise_dimensions = "4D"
    noise.inputs["W"].default_value = seed
    voronoi = nodes.new("ShaderNodeTexVoronoi")
    voronoi.inputs["Scale"].default_value = 160.0 * scale
    voronoi.feature = "DISTANCE_TO_EDGE"
    links.new(coord.outputs["Object"], noise.inputs["Vector"])
    links.new(coord.outputs["Object"], voronoi.inputs["Vector"])
    add = nodes.new("ShaderNodeMath")
    add.operation = "ADD"
    links.new(noise.outputs["Fac"], add.inputs[0])
    links.new(voronoi.outputs["Distance"], add.inputs[1])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.6
    bump.inputs["Distance"].default_value = fuzz
    links.new(add.outputs[0], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def emission(name: str, colour: str | Sequence[float], strength: float = 1.0) -> bpy.types.Material:
    """Create an emissive material."""
    mat = bpy.data.materials.new(name)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (*kit.hex_rgb(colour), 1)
    emit.inputs["Strength"].default_value = strength
    links.new(emit.outputs[0], out.inputs["Surface"])
    return mat


# ---------- plush character (original design) ----------

PLUSH = {
    # A round-eared pear of soft fabric with button eyes and a stitched smile. Our own design: no hair, no limbs that
    # reach a desk, nothing taken from any reference character.
    "colour": "#6fa67f",
    "belly": "#e8d6b4",
    "eyes": "#141414",
    "cheeks": "#f0a7a0",
}


# Metaball surface radius over element radius at threshold 0.3 and stiffness 2 (measured in Blender 5.2).
META_SURFACE = 0.685


def plush(name: str = "plush", height: float = 0.3, colours: dict[str, str] | None = None, seed: int = 0) -> tuple[bpy.types.Object, bpy.types.Object]:
    """Builds the plush under an empty `name` whose origin sits on the floor, centred; returns (root, body).

    Metaballs fuse a wide pear body, a head, two round ears, stub arms and feet into one soft surface; the face looks
    along -Y. Sizes below are surface radii in heights; features are placed on the head's sphere.
    """
    c = {**PLUSH, **(colours or {})}
    root = empty(name)
    h = height
    ball = bpy.data.metaballs.new(f"{name}-fabric")
    ball.resolution = 0.008 * h / 0.3
    ball.render_resolution = 0.004 * h / 0.3
    ball.threshold = 0.3
    head_c, head_r = (0.0, 0.0, 0.66 * h), 0.25 * h
    shapes = [
        # (type, centre, surface radius, axis scale for ellipsoids)
        ("ELLIPSOID", (0, 0, 0.28 * h), 0.27 * h, (1.12, 0.95, 1.0)),  # body, a wide pear
        ("BALL", head_c, head_r, None),  # head
        ("BALL", (-0.17 * h, 0.02 * h, 0.88 * h), 0.075 * h, None),  # round ears
        ("BALL", (0.17 * h, 0.02 * h, 0.88 * h), 0.075 * h, None),
        ("ELLIPSOID", (-0.27 * h, -0.03 * h, 0.33 * h), 0.08 * h, (0.75, 0.75, 1.25)),  # stub arms
        ("ELLIPSOID", (0.27 * h, -0.03 * h, 0.33 * h), 0.08 * h, (0.75, 0.75, 1.25)),
        ("ELLIPSOID", (-0.11 * h, -0.07 * h, 0.06 * h), 0.08 * h, (1.0, 1.25, 0.65)),  # feet
        ("ELLIPSOID", (0.11 * h, -0.07 * h, 0.06 * h), 0.08 * h, (1.0, 1.25, 0.65)),
    ]
    for kind, location, surface, size in shapes:
        element = ball.elements.new()
        element.type = kind
        element.co = location
        element.radius = surface / META_SURFACE
        element.stiffness = 2.0
        if size:
            element.size_x, element.size_y, element.size_z = size
    body = link(bpy.data.objects.new(f"{name}-body", ball))
    body.parent = root
    body.data.materials.append(fabric(f"{name}-fabric", c["colour"], seed=seed))

    def on_head(x: float, z: float, lift: float = 0.0) -> tuple[Vector, Vector]:
        """A point on the front of the head sphere at height z and side x, `lift` out along the normal."""
        dx, dz = x, z - head_c[2]
        y = -math.sqrt(max(0.0, (head_r * 1.02) ** 2 - dx * dx - dz * dz))
        normal = Vector((dx, y, dz)).normalized()
        return Vector((dx, y, z)) + normal * lift, normal

    def patch(label: str, location: Vector, normal: Vector, radius: float, flat: float, mat: bpy.types.Material) -> bpy.types.Object:
        obj = uv_sphere(f"{name}-{label}", radius, tuple(location), segments=32, rings=16)
        obj.scale = (1.0, 1.0, flat)
        obj.rotation_euler = normal.to_track_quat("Z", "Y").to_euler()
        obj.data.materials.append(mat)
        obj.parent = root
        return obj

    # Belly patch on the body's front.
    belly_at = Vector((0.0, -0.27 * h * 0.95 * 0.98, 0.26 * h))
    patch("belly", belly_at, Vector((0, -1, 0.1)).normalized(), 0.115 * h, 0.22, fabric(f"{name}-belly", c["belly"], seed=seed + 1))
    button = principled(f"{name}-button", c["eyes"], roughness=0.22, Coat_Weight=0.5, Coat_Roughness=0.08, Specular_IOR_Level=0.3)
    cheek = fabric(f"{name}-cheek", c["cheeks"], seed=seed + 2)
    glint = emission(f"{name}-glint", "#ffffff", 2.2)
    for side in (-1, 1):
        at, normal = on_head(side * 0.085 * h, 0.69 * h)
        eye = patch(f"eye{side}", at, normal, 0.034 * h, 0.5, button)
        # A painted catchlight high on the camera's left of each eye: the eye reads as an eye even in shadow, and a
        # blink (eye scale along its local Y) closes it with the eye.
        dot = uv_sphere(f"{name}-glint{side}", 0.0085 * h, (0, 0, 0), segments=16, rings=8)
        dot.data.materials.append(glint)
        dot.parent = eye
        r = 0.034 * h
        dot.location = (-0.32 * r, 0.38 * r, 0.9 * r)
        dot.scale = (1.0, 1.0, 0.35)
        hide_from_rays(dot)
        at, normal = on_head(side * 0.145 * h, 0.61 * h)
        patch(f"cheek{side}", at, normal, 0.035 * h, 0.18, cheek)
    curve = bpy.data.curves.new(f"{name}-smile", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = 0.005 * h
    curve.bevel_resolution = 2
    spline = curve.splines.new("POLY")
    spline.points.add(8)
    for i, point in enumerate(spline.points):
        u = i / 8
        at, _ = on_head((u - 0.5) * 0.09 * h, 0.605 * h - 0.022 * h * math.sin(math.pi * u), lift=0.002 * h)
        point.co = (*at, 1)
    smile = link(bpy.data.objects.new(f"{name}-smile", curve))
    smile.data.materials.append(principled(f"{name}-thread", "#3a2626", roughness=0.8))
    smile.parent = root
    return root, body


def squash(frame: float, period: float = 36, amount: float = 0.045, phase: float = 0.0) -> tuple[float, float, float]:
    """Volume-preserving breath for the plush: (sx, sy, sz) with sx * sy * sz = 1."""
    s = amount * math.sin(2 * math.pi * (frame / period + phase))
    z = 1 - s
    side = 1 / math.sqrt(z)
    return (side, side, z)


def seeded(seed: int | str, label: str) -> random.Random:
    """Return a deterministic random generator for this seed."""
    return random.Random(f"{seed}-{label}")
