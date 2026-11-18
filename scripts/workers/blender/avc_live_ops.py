# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Scene operations of the Blender live session, shared by the live server (avc_live.py) and replay (avc_live_replay.py).

Every change an agent makes is one of the journaled ops below, so the same code rebuilds the scene from the recipe.
No op evaluates caller text as Python, loads a file the caller names, or reaches the network.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import runpy
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeAlias, cast

import bpy
from mathutils import Vector

import avc_live_arsenal as arsenal
from avc_live_protocol import LiveError, check_datablock_name, check_json_value, contained, parse_property_path

HEX_COLOUR_LENGTH = 7
MAX_COLOUR_COMPONENT = 1000
MAX_FRAME = 100000
MAX_VECTOR_COMPONENT = 1e6
MIN_FRAME = -100000
SRGB_LINEAR_THRESHOLD = 0.04045

if TYPE_CHECKING:
    from collections.abc import Iterable

Params: TypeAlias = dict[str, Any]


# Dynamic Blender/operator dictionaries are validated by their owning request schemas.

RECIPE_VERSION = 1
ARSENAL_OPS = ("append-asset", "apply-recipe", "enable-extension")
JOURNALED = ("add", "delete", "material", "set", "run-kit", *ARSENAL_OPS)
# Shared libraries and the device-preparation tool are not shots.
NOT_SHOTS = frozenset({"studio_kit.py", "toy_kit.py", "prepare_devices.py"})
PRIMITIVES = ("cube", "sphere", "ico-sphere", "cylinder", "cone", "plane", "torus", "monkey")
KINDS = (*PRIMITIVES, "empty", "camera", "light")
LIGHT_TYPES = ("AREA", "POINT", "SUN", "SPOT")
ROOT_KINDS = ("object", "material", "camera", "light", "world", "scene", "mesh")
POINTER_COLLECTIONS = {"Object": "objects", "Material": "materials", "World": "worlds", "Camera": "cameras", "Light": "lights"}
FORBIDDEN_STRUCTS = ("Text", "Library", "WindowManager", "Preferences", "Image", "Screen", "Window")
PATH_SUBTYPES = frozenset({"FILE_PATH", "DIR_PATH", "FILE_NAME", "BYTE_STRING"})


def _number(params: Params, key: str, default: float | None = None, low: float = -1e6, high: float = 1e6) -> float | None:
    value = params.get(key, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        error_message = f"{key} must be a number in [{low}, {high}]."
        raise LiveError("INVALID_INPUT", error_message)
    return float(value)


def _vector(params: Params, key: str, default: list[float] | None = None, size: int = 3) -> tuple[float, ...] | None:
    value = params.get(key, default)
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != size or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > MAX_VECTOR_COMPONENT for v in value):
        error_message = f"{key} must be a list of {size} numbers."
        raise LiveError("INVALID_INPUT", error_message)
    return tuple(float(v) for v in value)


def _color(params: Params, key: str, default: str | list[float] | None = None) -> tuple[float, ...] | None:
    """[r, g, b] in linear 0..1, or "#rrggbb" in sRGB, converted to linear like studio_kit.hex_rgb."""
    value = params.get(key, default)
    if value is None:
        return None
    if isinstance(value, str):
        if len(value) != HEX_COLOUR_LENGTH or value[0] != "#" or any(c not in "0123456789abcdefABCDEF" for c in value[1:]):
            error_message = f"{key} must be #rrggbb or [r, g, b]."
            raise LiveError("INVALID_INPUT", error_message)
        srgb = [int(value[i : i + 2], 16) / 255 for i in (1, 3, 5)]
        return tuple(c / 12.92 if c <= SRGB_LINEAR_THRESHOLD else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)
    color = _vector({key: value}, key, size=3)
    if color is None:
        return None
    if any(c < 0 or c > MAX_COLOUR_COMPONENT for c in color):
        error_message = f"{key} components must be in [0, 1000]."
        raise LiveError("INVALID_INPUT", error_message)
    return color


def only(params: Params, allowed: Iterable[str], op: str) -> None:
    """Reject fields outside the operation schema."""
    unknown = sorted(set(params) - set(allowed))
    if unknown:
        error_message = f"Unknown {op} params: {', '.join(unknown)}. Known: {', '.join(sorted(allowed))}."
        raise LiveError("INVALID_INPUT", error_message)


def _object(name: str) -> bpy.types.Object:
    obj = bpy.data.objects.get(name)
    if obj is None:
        error_message = f"No object named {name!r}."
        raise LiveError("NOT_FOUND", error_message)
    return obj


def _aim(obj: bpy.types.Object, target: tuple[float, ...]) -> None:
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def reset_empty() -> None:
    """The empty base: factory settings, no objects, one world named World with a dark grey background."""
    bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
    scene = bpy.context.scene
    world = bpy.data.worlds.new("World")
    if hasattr(world, "use_nodes") and not world.use_nodes:
        world.use_nodes = True
    background = world.node_tree.nodes.get("Background") if world.node_tree else None
    if background:
        background.inputs["Color"].default_value = (0.05, 0.05, 0.05, 1.0)
    scene.world = world
    scene.render.use_stamp_date = False
    scene.render.use_stamp_render_time = False


def open_blend(path: str) -> None:
    """A .blend base. Its scripts never run: the session starts with --disable-autoexec and use_scripts is off."""
    bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)


# ---------- journaled ops ----------


def op_add(params: Params, _context: Params) -> Params:  # noqa: C901, PLR0912, PLR0915 -- Keep the ordered validation or native transaction together. Each branch validates one supported contract variant. Ordered native mutations and their validation form one operation.
    """Create one validated scene primitive or datablock."""
    only(params, ("kind", "name", "location", "rotation_deg", "scale", "target", "material", "smooth", "lens", "light_type", "energy", "color", "size", "active_camera"), "add")
    kind = params.get("kind")
    if kind not in KINDS:
        error_message = f"kind must be one of {', '.join(KINDS)}."
        raise LiveError("INVALID_INPUT", error_message)
    name = check_datablock_name(params.get("name"), "name")
    if bpy.data.objects.get(name) is not None:
        error_message = f"An object named {name!r} exists; pick another name or delete it first."
        raise LiveError("VALIDATION", error_message)
    location = _vector(params, "location", [0, 0, 0])
    scene = bpy.context.scene
    if kind == "camera":
        data = bpy.data.cameras.new(name)
        data.lens = _number(params, "lens", 50, 1, 5000)
    elif kind == "light":
        light_type = params.get("light_type", "AREA")
        if light_type not in LIGHT_TYPES:
            error_message = f"light_type must be one of {', '.join(LIGHT_TYPES)}."
            raise LiveError("INVALID_INPUT", error_message)
        data = bpy.data.lights.new(name, light_type)
        data.energy = _number(params, "energy", 1000 if light_type != "SUN" else 3, 0, 1e7)
        data.color = _color(params, "color", [1, 1, 1])
        size = _number(params, "size", None, 0, 1000)
        if size is not None:
            if light_type == "AREA":
                data.size = size
            elif light_type == "SUN":
                data.angle = math.radians(size)
            else:
                data.shadow_soft_size = size
    elif kind == "empty":
        data = None
    else:
        data = _primitive_mesh(kind, name)
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = location
    rotation = _vector(params, "rotation_deg")
    if rotation is not None:
        obj.rotation_euler = tuple(math.radians(v) for v in rotation)
    target = _vector(params, "target")
    if target is not None:
        _aim(obj, target)
    scale = _vector(params, "scale")
    if scale is not None:
        obj.scale = scale
    if params.get("smooth") and obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    if params.get("material") is not None:
        if obj.type != "MESH":
            error_message = "material applies to mesh objects only."
            raise LiveError("INVALID_INPUT", error_message)
        material = bpy.data.materials.get(check_datablock_name(params["material"], "material"))
        if material is None:
            error_message = f"No material named {params['material']!r}; create it with the material op first."
            raise LiveError("NOT_FOUND", error_message)
        obj.data.materials.append(material)
    if kind == "camera" and (params.get("active_camera", True) or scene.camera is None):
        scene.camera = obj
    return {"object": obj.name, "type": obj.type}


def _primitive_mesh(kind: str, name: str) -> bpy.types.Mesh:
    """Builds the primitive through a temporary operator call, then keeps only its mesh data."""
    builders = {
        "cube": lambda: bpy.ops.mesh.primitive_cube_add(size=2),
        "sphere": lambda: bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=1),
        "ico-sphere": lambda: bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=4, radius=1),
        "cylinder": lambda: bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=1, depth=2),
        "cone": lambda: bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=1, depth=2),
        "plane": lambda: bpy.ops.mesh.primitive_plane_add(size=2),
        "torus": lambda: bpy.ops.mesh.primitive_torus_add(major_radius=1, minor_radius=0.25, major_segments=64, minor_segments=24),
        "monkey": lambda: bpy.ops.mesh.primitive_monkey_add(size=2),
    }
    builders[kind]()
    temporary = bpy.context.object
    mesh = temporary.data
    mesh.name = name
    bpy.data.objects.remove(temporary, do_unlink=True)
    return mesh


def op_delete(params: Params, _context: Params) -> Params:
    """Remove the named scene object."""
    only(params, ("name",), "delete")
    obj = _object(check_datablock_name(params.get("name")))
    bpy.data.objects.remove(obj, do_unlink=True)
    return {"deleted": params["name"]}


def op_material(params: Params, _context: Params) -> Params:  # noqa: C901 -- Keep the ordered validation or native transaction together.
    """Creates or updates a Principled BSDF material and optionally assigns it to mesh objects (first slot)."""
    only(params, ("name", "base_color", "metallic", "roughness", "transmission", "ior", "coat", "emission_color", "emission_strength", "alpha", "assign_to"), "material")
    name = check_datablock_name(params.get("name"))
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if hasattr(material, "use_nodes") and not material.use_nodes:
        material.use_nodes = True
    bsdf = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        error_message = f"Material {name!r} has no Principled BSDF to edit."
        raise LiveError("VALIDATION", error_message)
    sockets = {"metallic": "Metallic", "roughness": "Roughness", "transmission": "Transmission Weight", "ior": "IOR", "coat": "Coat Weight", "emission_strength": "Emission Strength", "alpha": "Alpha"}
    for key, socket in sockets.items():
        value = _number(params, key, None, 0, 1000)
        if value is not None:
            bsdf.inputs[socket].default_value = value
    for key, socket in (("base_color", "Base Color"), ("emission_color", "Emission Color")):
        color = _color(params, key)
        if color is not None:
            bsdf.inputs[socket].default_value = (*color, 1.0)
            if key == "base_color":
                material.diffuse_color = (*color, 1.0)
    assigned = []
    for object_name in params.get("assign_to") or []:
        obj = _object(check_datablock_name(object_name, "assign_to"))
        if obj.type != "MESH":
            error_message = f"{object_name!r} is not a mesh."
            raise LiveError("INVALID_INPUT", error_message)
        if obj.data.materials:
            obj.data.materials[0] = material
        else:
            obj.data.materials.append(material)
        assigned.append(obj.name)
    return {"material": material.name, "assigned": assigned}


def _root(target: object) -> bpy.types.bpy_struct:
    if not isinstance(target, dict):
        error_message = "target must be {kind, name}."
        raise LiveError("INVALID_INPUT", error_message)
    target = cast("Params", target)
    kind = target.get("kind")
    if kind not in ROOT_KINDS:
        error_message = f"target.kind must be one of {', '.join(ROOT_KINDS)}."
        raise LiveError("INVALID_INPUT", error_message)
    if kind == "scene":
        return bpy.context.scene
    if kind == "world" and target.get("name") is None:
        if bpy.context.scene.world is None:
            error_message = "The scene has no world."
            raise LiveError("NOT_FOUND", error_message)
        return bpy.context.scene.world
    collection = {"object": "objects", "material": "materials", "camera": "cameras", "light": "lights", "world": "worlds", "mesh": "meshes"}[kind]
    name = check_datablock_name(target.get("name"), "target.name")
    found = getattr(bpy.data, collection).get(name)
    if found is None:
        error_message = f"No {kind} named {name!r}."
        raise LiveError("NOT_FOUND", error_message)
    return found


def _check_struct(value: bpy.types.bpy_struct, path: str) -> None:
    rna = getattr(value, "bl_rna", None)
    if rna is not None and any(isinstance(value, getattr(bpy.types, name)) for name in FORBIDDEN_STRUCTS):
        error_message = f"{path} reaches a {type(value).__name__}, which the live session does not edit."
        raise LiveError("VALIDATION", error_message)


def _rna_property(owner: bpy.types.bpy_struct, name: str, path: str) -> bpy.types.Property:
    rna = getattr(owner, "bl_rna", None)
    if rna is None or name not in rna.properties:
        error_message = f"{path}: {type(owner).__name__} has no property {name!r}."
        raise LiveError("NOT_FOUND", error_message)
    prop = rna.properties[name]
    if getattr(prop, "subtype", "") in PATH_SUBTYPES:
        error_message = f"{path}: file-path properties cannot be set through the live session."
        raise LiveError("VALIDATION", error_message)
    return prop


def resolve(target: object, path: object) -> tuple[bpy.types.bpy_struct, str, bpy.types.Property]:
    """Walks the parsed path with attribute reads of RNA-declared properties and literal subscripts only."""
    owner = _root(target)
    if not isinstance(path, str):
        error_message = "Property path must be a string."
        raise LiveError("INVALID_INPUT", error_message)
    segments = parse_property_path(path)
    walked = ""
    for kind, key in segments[:-1]:
        walked += f".{key}" if kind == "attr" else f"[{key!r}]"
        if kind == "attr":
            if not isinstance(key, str):
                error_message = "Attribute names must be strings."
                raise LiveError("INVALID_INPUT", error_message)
            _rna_property(owner, key, walked)
            owner = getattr(owner, key)
        else:
            try:
                owner = owner[key]
            except (KeyError, IndexError, TypeError) as error:
                error_message = f"{walked} does not exist."
                raise LiveError("NOT_FOUND", error_message) from error
        if owner is None:
            error_message = f"{walked} is empty."
            raise LiveError("NOT_FOUND", error_message)
        _check_struct(owner, walked)
    name = segments[-1][1]
    if not isinstance(name, str):
        error_message = "Final property must be an attribute name."
        raise LiveError("INVALID_INPUT", error_message)
    prop = _rna_property(owner, name, path)
    return owner, name, prop


def op_set(params: Params, _context: Params) -> Params:  # noqa: C901 -- Keep the ordered validation or native transaction together.
    """Set a validated writable RNA property."""
    only(params, ("target", "path", "value", "frame"), "set")
    owner, name, prop = resolve(params.get("target"), params.get("path"))
    if getattr(prop, "is_readonly", False):
        error_message = f"{params['path']} is read-only."
        raise LiveError("VALIDATION", error_message)
    value = check_json_value(params.get("value"))
    if prop.type == "POINTER":
        collection = POINTER_COLLECTIONS.get(prop.fixed_type.identifier)
        if collection is None:
            error_message = f"{params['path']} points to a {prop.fixed_type.identifier}; only {', '.join(POINTER_COLLECTIONS)} can be assigned by name."
            raise LiveError("VALIDATION", error_message)
        if value is None:
            resolved = None
        else:
            resolved = getattr(bpy.data, collection).get(check_datablock_name(value, "value"))
            if resolved is None:
                error_message = f"No {collection[:-1]} named {value!r}."
                raise LiveError("NOT_FOUND", error_message)
        setattr(owner, name, resolved)
    elif prop.type == "COLLECTION":
        error_message = f"{params['path']} is a collection; address one item with a subscript."
        raise LiveError("VALIDATION", error_message)
    else:
        try:
            setattr(owner, name, tuple(value) if isinstance(value, list) else value)
        except (TypeError, ValueError, AttributeError) as error:
            error_message = f"{params['path']}: {error}"
            raise LiveError("INVALID_INPUT", error_message) from error
    frame = params.get("frame")
    if frame is not None:
        if isinstance(frame, bool) or not isinstance(frame, int) or not MIN_FRAME <= frame <= MAX_FRAME:
            error_message = "frame must be a whole number."
            raise LiveError("INVALID_INPUT", error_message)
        if not owner.keyframe_insert(name, frame=frame):
            error_message = f"{params['path']} cannot be keyframed."
            raise LiveError("VALIDATION", error_message)
    current = getattr(owner, name)
    return {"path": params["path"], "value": _plain(current), "frame": frame}


def _plain(value: Any) -> object:  # noqa: ANN401 -- Forwarded third-party ML/tokenizer values are a dynamic API boundary.
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value if not isinstance(value, float) else round(value, 6)
    if hasattr(value, "name") and hasattr(value, "bl_rna"):
        return value.name
    try:
        return [round(v, 6) if isinstance(v, float) else v for v in value]
    except TypeError:
        return str(value)


def kit_scripts(kit_dir: str) -> list[str]:
    """List the available local kit scene scripts."""
    return sorted(name for name in [entry.name for entry in Path(kit_dir).iterdir()] if name.endswith(".py") and name not in NOT_SHOTS and not name.startswith("_"))


def _forget_kit(kit_dir: str) -> None:
    """Edits to kit files take effect on the next run, and handlers a previous kit added are removed."""
    real = os.path.realpath(kit_dir) + os.sep
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None) or ""
        if name == "avc_export" or os.path.realpath(file).startswith(real):
            del sys.modules[name]
    for handlers in (getattr(bpy.app.handlers, attr) for attr in dir(bpy.app.handlers) if not attr.startswith("_")):
        if not isinstance(handlers, list):
            continue
        for handler in list(handlers):
            code = getattr(handler, "__code__", None)
            if code and os.path.realpath(code.co_filename).startswith(real):
                handlers.remove(handler)


def op_run_kit(params: Params, context: Params) -> Params:
    """Resets to the empty base, then runs one shot script from scripts/blender with a JSON object as its argument."""
    only(params, ("script", "params"), "run-kit")
    kit_dir = context["kitDir"]
    script = params.get("script")
    if not isinstance(script, str) or script not in kit_scripts(kit_dir):
        error_message = f"script must be one of {', '.join(kit_scripts(kit_dir))} (a file name in scripts/blender)."
        raise LiveError("VALIDATION", error_message)
    path = contained(kit_dir, str(Path(kit_dir).joinpath(script)))
    arguments = params.get("params", {})
    if not isinstance(arguments, dict):
        error_message = "params must be a JSON object (a string would be opened as a file)."
        raise LiveError("INVALID_INPUT", error_message)
    arsenal.bind_recipe_code(context)
    reset_empty()
    _forget_kit(kit_dir)
    saved_argv, saved_path = sys.argv, list(sys.path)
    sys.argv = [path, "--", json.dumps(arguments)]
    sys.path.insert(0, kit_dir)
    try:
        runpy.run_path(path, run_name="__main__")
    except SystemExit as error:
        error_message = f"{script} called sys.exit({error.code})."
        raise LiveError("INTERNAL", error_message) from error
    except (ValueError, KeyError, TypeError) as error:
        error_message = f"{script}: {error}"
        raise LiveError("INVALID_INPUT", error_message) from error
    except (RuntimeError, OSError) as error:
        if "public/shared" in str(error):
            error_message = f"{script} needs a shared asset that is not on disk: {error}. Run pnpm assets:sync (sources in public/shared/*/sources.json), then retry."
            raise LiveError("ASSET_MISSING", error_message) from error
        raise
    finally:
        sys.argv, sys.path[:] = saved_argv, saved_path
    return {"script": f"scripts/blender/{script}", "objects": len(bpy.data.objects)}


OPS = {"add": op_add, "delete": op_delete, "material": op_material, "set": op_set, "run-kit": op_run_kit}


def apply(op: str, params: Params, context: Params) -> Params:
    """Dispatch a permitted typed scene operation."""
    if op not in OPS:
        error_message = f"Unknown scene op {op!r}."
        raise LiveError("INVALID_INPUT", error_message)
    return OPS[op](params, context)


def apply_step(step: Params, context: Params) -> Params:
    """Apply one validated replay step to the scene."""
    if step["op"] in ARSENAL_OPS:
        return arsenal.apply_step(step, context)
    return apply(step["op"], step["params"], context)


def validate_recipe(recipe: Params, context: Params) -> None:
    """Check every external dependency before any replay or scene change."""
    if not isinstance(recipe, dict) or recipe.get("version") != RECIPE_VERSION:
        error_message = f"Recipe version must be {RECIPE_VERSION}."
        raise LiveError("INVALID_INPUT", error_message)
    base = recipe.get("base") or {}
    if base.get("kind") == "blend":
        file = contained(context["workspaceRoot"], str(Path(context["workspaceRoot"]).joinpath(base["path"])))
        with Path(file).open("rb") as handle:
            if hashlib.sha256(handle.read()).hexdigest() != base.get("sha256"):
                error_message = "Base .blend changed since the session."
                raise LiveError("VALIDATION", error_message)
    elif base.get("kind") != "empty":
        error_message = "Recipe base must be empty or blend."
        raise LiveError("INVALID_INPUT", error_message)
    for step in recipe.get("ops", []):
        if step["op"] in ARSENAL_OPS:
            arsenal.verify_step(step, context)


def apply_recipe(recipe: Params, context: Params) -> None:
    """Rebuilds a scene from a recipe: the base, then each journaled op in order."""
    validate_recipe(recipe, context)
    base = recipe["base"]
    for step in recipe.get("ops", []):
        if base["kind"] == "blend" and step["op"] == "enable-extension":
            apply_step(step, context)
    if base.get("kind") == "blend":
        file = contained(context["workspaceRoot"], str(Path(context["workspaceRoot"]).joinpath(base["path"])))
        open_blend(file)
    elif base.get("kind") == "empty":
        reset_empty()
    else:
        error_message = "Recipe base must be empty or blend."
        raise LiveError("INVALID_INPUT", error_message)
    for step in recipe.get("ops", []):
        apply_step(step, context)


# ---------- read-only views ----------


def _round(values: Iterable[float], digits: int = 4) -> list[float]:
    return [round(v, digits) for v in values]


def _principled(material: bpy.types.Material) -> bpy.types.Node | None:
    tree = getattr(material, "node_tree", None)
    bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if tree else None
    if bsdf is None:
        return None
    pick = {"base_color": "Base Color", "metallic": "Metallic", "roughness": "Roughness", "transmission": "Transmission Weight", "emission_strength": "Emission Strength"}
    out = {}
    for key, socket in pick.items():
        if socket in bsdf.inputs:
            value = bsdf.inputs[socket].default_value
            out[key] = _round(value[:3]) if hasattr(value, "__len__") else round(value, 4)
    return out


def inspect(limit: int = 200) -> Params:
    """Return a bounded serialisable snapshot of the scene."""
    scene = bpy.context.scene
    render = scene.render
    objects = []
    for obj in list(scene.objects)[:limit]:
        entry = {
            "name": obj.name,
            "type": obj.type,
            "location": _round(obj.location),
            "rotation_deg": _round([math.degrees(v) for v in obj.rotation_euler], 2),
            "scale": _round(obj.scale),
            "dimensions": _round(obj.dimensions),
            "hidden": obj.hide_render,
        }
        if obj.parent:
            entry["parent"] = obj.parent.name
        if obj.type == "MESH":
            entry["materials"] = [m.name for m in obj.data.materials if m]
            entry["vertices"] = len(obj.data.vertices)
        if obj.data is not None:
            entry["data"] = obj.data.name
        if obj.animation_data and obj.animation_data.action:
            entry["animated"] = True
        objects.append(entry)
    cameras = [
        {
            "name": c.name,
            "lens": round(c.lens, 3),
            "dof": c.dof.use_dof,
            "fstop": round(c.dof.aperture_fstop, 3),
            "focus_distance": round(c.dof.focus_distance, 4),
            "clip": [round(c.clip_start, 4), round(c.clip_end, 2)],
        }
        for c in bpy.data.cameras
    ]
    lights = [
        {"name": light.name, "type": light.type, "energy": round(light.energy, 3), "color": _round(light.color), **({"size": round(light.size, 4)} if light.type == "AREA" else {})}
        for light in bpy.data.lights
    ]
    materials = [{"name": m.name, "users": m.users, **({"principled": _principled(m)} if _principled(m) else {})} for m in bpy.data.materials]
    world = scene.world
    background = world.node_tree.nodes.get("Background") if world and world.node_tree else None
    return {
        "scene": {
            "name": scene.name,
            "engine": render.engine,
            "samples": scene.cycles.samples if render.engine == "CYCLES" else None,
            "resolution": [render.resolution_x, render.resolution_y],
            "percentage": render.resolution_percentage,
            "fps": render.fps / render.fps_base,
            "frameStart": scene.frame_start,
            "frameEnd": scene.frame_end,
            "frameCurrent": scene.frame_current,
            "camera": scene.camera.name if scene.camera else None,
            "viewTransform": scene.view_settings.view_transform,
            "look": scene.view_settings.look,
            "exposure": round(scene.view_settings.exposure, 3),
            "filmTransparent": render.film_transparent,
            "world": {"name": world.name, "color": _round(background.inputs["Color"].default_value[:3]), "strength": round(background.inputs["Strength"].default_value, 3)}
            if background
            else (world.name if world else None),
        },
        "objects": objects,
        "objectCount": len(scene.objects),
        "truncated": len(scene.objects) > limit,
        "cameras": cameras,
        "lights": lights,
        "materials": materials,
    }
