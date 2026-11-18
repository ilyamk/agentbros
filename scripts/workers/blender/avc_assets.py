# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Session-only Blender library access. Never saves preferences or enables autoexec."""

from __future__ import annotations

import hashlib
import inspect
import json
import math
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import bpy

if TYPE_CHECKING:
    import bpy

import avc_arsenal


def library_path() -> Path:
    """Return the shared arsenal library path."""
    return Path(avc_arsenal.paths()["library"])


def local_file(name: str, *, system: bool = False) -> Path:
    """Resolve only files inside the local store, including symlink resolution."""
    if system:
        import bpy

        base = Path(bpy.utils.system_resource("DATAFILES")).resolve()
        file = Path(name).resolve()
        if not file.is_relative_to(base) or not file.is_file():
            msg = "Invalid bundled asset path"
            raise ValueError(msg)
        return file
    base = library_path().resolve()
    file = (base / name).resolve()
    if not file.is_relative_to(base) or not file.is_file():
        msg = f"Missing or escaping library file: {name}"
        raise ValueError(msg)
    return file


def register_library() -> bpy.types.AssetLibrary:
    """Register the local catalogue in this session only, without saving prefs."""
    import bpy

    directory = str(library_path())
    _safe_store()
    library_path().mkdir(parents=True, exist_ok=True)
    libraries = bpy.context.preferences.filepaths.asset_libraries
    existing = next((item for item in libraries if item.path == directory), None)
    return existing if existing is not None else libraries.new(name="Agent Bros. Pictures", directory=directory)


def bundled_assets() -> list[dict[str, str]]:
    """Enumerate actual installed Essentials assets without loading their scripts."""
    import bpy

    base = bpy.utils.system_resource("DATAFILES", path="assets")
    result: list[dict[str, str]] = []
    if not base:
        return result
    for file in sorted(Path(base).rglob("*.blend")):
        with bpy.data.libraries.load(str(file), assets_only=True) as (source, _target):
            for category in ("objects", "collections", "materials", "node_groups", "worlds"):
                for name in getattr(source, category, []):
                    key = f"{file.relative_to(base).as_posix()}:{category}:{name}"
                    result.append({"id": f"essentials:{hashlib.sha256(key.encode()).hexdigest()[:24]}", "name": name, "file": str(file), "category": category})
    return result


def _usage(asset_id: str, script: str | None, project: str | None) -> None:
    project = project or os.environ.get("AGENTBROS_PROJECT_ID")
    if project is not None and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}", project) is None:
        msg = "Invalid project id"
        raise ValueError(msg)
    _safe_store()
    record = {"id": asset_id, "script": script or inspect.stack()[2].filename, "time": datetime.now(UTC).isoformat().replace("+00:00", "Z"), "project": project}
    with (library_path() / "usage.jsonl").open("a", encoding="utf8") as handle:
        handle.write(json.dumps(record) + "\n")


def _load_blend(file: str, category: str, name: str | None, *, link: bool, assets_only: bool = False) -> list[Any]:
    import bpy

    with bpy.data.libraries.load(file, link=link, assets_only=assets_only) as (source, target):
        names = list(getattr(source, category))
        if name is not None:
            if name not in names:
                msg = f"Asset {name!r} not found in {file}: {names}"
                raise ValueError(msg)
            names = [name]
        setattr(target, category, names)
    return [item for item in getattr(target, category) if item is not None]


def _root(objects: list[Any], name: str, normalise_scale: float | None) -> bpy.types.Object:
    import bpy
    from mathutils import Vector

    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    imported = set(objects)
    for obj in objects:
        if obj.name not in bpy.context.scene.objects:
            bpy.context.scene.collection.objects.link(obj)
        if obj.parent not in imported:
            matrix = obj.matrix_world.copy()
            obj.parent = root
            obj.matrix_world = matrix
    bpy.context.view_layer.update()
    if normalise_scale is not None:
        if normalise_scale <= 0:
            msg = "normalise_scale must be positive metres"
            raise ValueError(msg)
        corners = [obj.matrix_world @ Vector(corner) for obj in objects if obj.type == "MESH" for corner in obj.bound_box]
        if corners:
            extent = max(max(v[i] for v in corners) - min(v[i] for v in corners) for i in range(3))
            if extent > 0:
                root.scale *= normalise_scale / extent
    return root


def _material(asset: dict[str, Any], scale: float, *, displacement: bool, normal_strength: float) -> bpy.types.Material:  # noqa: PLR0915
    import bpy

    if not any(file["role"] in {"color", "roughness", "normal-gl", "normal-dx", "metalness"} for file in asset["files"]):
        msg = "No PBR maps in this asset; select a native material by name"
        raise ValueError(msg)
    mat = bpy.data.materials.new(asset["title"])
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = nodes.get("Principled BSDF")
    coordinates = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (scale, scale, scale)
    links.new(coordinates.outputs["UV"], mapping.inputs["Vector"])
    textures: dict[str, Any] = {}
    for file in asset["files"]:
        role = file["role"]
        if role not in {"color", "roughness", "normal-gl", "normal-dx", "metalness", "ao", "displacement"}:
            continue
        texture = nodes.new("ShaderNodeTexImage")
        texture.label = role
        texture.image = bpy.data.images.load(str(local_file(file["path"], system=file.get("system", False))), check_existing=True)
        texture.image.colorspace_settings.name = "sRGB" if role == "color" else "Non-Color"
        links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
        textures.setdefault(role, texture)
    for role, socket in (("color", "Base Color"), ("roughness", "Roughness"), ("metalness", "Metallic")):
        if role in textures:
            links.new(textures[role].outputs["Color"], shader.inputs[socket])
    if "ao" in textures and "color" in textures:
        multiply = nodes.new("ShaderNodeMixRGB")
        multiply.blend_type = "MULTIPLY"
        multiply.inputs[0].default_value = 1
        links.new(textures["color"].outputs["Color"], multiply.inputs[1])
        links.new(textures["ao"].outputs["Color"], multiply.inputs[2])
        links.new(multiply.outputs[0], shader.inputs["Base Color"])
    normal = textures.get("normal-gl") or textures.get("normal-dx")
    if normal is not None:
        output = normal.outputs["Color"]
        if "normal-gl" not in textures:
            separate = nodes.new("ShaderNodeSeparateColor")
            invert = nodes.new("ShaderNodeMath")
            invert.operation = "SUBTRACT"
            invert.inputs[0].default_value = 1
            combine = nodes.new("ShaderNodeCombineColor")
            links.new(output, separate.inputs[0])
            links.new(separate.outputs[1], invert.inputs[1])
            links.new(separate.outputs[0], combine.inputs[0])
            links.new(invert.outputs[0], combine.inputs[1])
            links.new(separate.outputs[2], combine.inputs[2])
            output = combine.outputs[0]
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.inputs["Strength"].default_value = normal_strength
        links.new(output, normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
    if displacement and "displacement" in textures:
        node = nodes.new("ShaderNodeDisplacement")
        links.new(textures["displacement"].outputs["Color"], node.inputs["Height"])
        links.new(node.outputs[0], nodes.get("Material Output").inputs["Displacement"])
    return mat


def append(  # noqa: C901, PLR0912, PLR0915
    asset_id: str,
    *,
    link: bool = False,
    normalise_scale: float | None = None,
    scale: float = 1.0,
    strength: float = 1.0,
    rotation: float = 0.0,
    displacement: bool = False,
    normal_strength: float = 0.5,
    name: str | None = None,
    project: str | None = None,
    script: str | None = None,
) -> bpy.types.ID:
    """Append an indexed asset. HDRI rotation is in degrees; material scale repeats UVs."""
    import bpy

    if link and normalise_scale is not None:
        msg = "normalise_scale is unavailable for linked assets"
        raise ValueError(msg)
    index_file = library_path() / "index.json"
    index = json.loads(index_file.read_text()) if index_file.exists() else {"assets": []}
    if asset_id.startswith("essentials:") and not any(item["id"] == asset_id for item in index["assets"]):
        matches = [item for item in bundled_assets() if item["id"] == asset_id or item["name"] == asset_id.split(":", 1)[1]]
        if len(matches) != 1:
            msg = f"Unknown or ambiguous Essentials asset {asset_id}; inspect bundled_assets()"
            raise ValueError(msg)
        item = matches[0]
        loaded = _load_blend(item["file"], item["category"], item["name"], link=link, assets_only=True)
        if item["category"] == "objects":
            if link:
                collection = bpy.data.collections.new(item["name"])
                for obj in loaded:
                    collection.objects.link(obj)
                result = bpy.data.objects.new(item["name"], None)
                result.instance_type = "COLLECTION"
                result.instance_collection = collection
                bpy.context.scene.collection.objects.link(result)
            else:
                result = _root(loaded, item["name"], normalise_scale)
        elif item["category"] == "collections":
            for collection in loaded:
                bpy.context.scene.collection.children.link(collection)
            result = loaded[0]
        else:
            result = loaded[0]
        # Keep local provenance so credits also work for bundled assets.
        _record_bundled(item)
        _usage(item["id"], script, project)
        return result
    index_file = library_path() / "index.json"
    index = json.loads(index_file.read_text()) if index_file.exists() else {"assets": []}
    matches = [item for item in index["assets"] if item["id"] == asset_id]
    if not matches:
        msg = f'Unknown asset {asset_id}; run pnpm blender:assets --action add --id {asset_id} --consent "who/when/why"'
        raise ValueError(msg)
    asset = matches[0]
    files = asset["files"]
    allowed = asset.get("allowedAssets")
    if allowed is not None:
        category = asset.get("allowedCategory")
        verified_names = [item["name"] for item in asset.get("blenderAssets", []) if item["name"] in allowed and (category is None or item["category"] == category)]
        if name is not None and name not in verified_names:
            msg = f"Asset name is outside the verified licence allowlist: {name}"
            raise ValueError(msg)
        if name is None:
            category = category or {"node-groups": "node_groups", "materials": "materials", "models": "objects", "hdri": "worlds"}.get(asset["kind"])
            names = [item["name"] for item in asset.get("blenderAssets", []) if item["category"] == category and item["name"] in allowed]
            if not names and asset["kind"] == "models":
                names = [item["name"] for item in asset.get("blenderAssets", []) if item["category"] == "collections" and item["name"] in allowed]
            if not names:
                msg = "No licensed compatible datablock in this file"
                raise ValueError(msg)
            name = names[0]
    if asset["kind"] == "textures" and "matcap" in asset.get("tags", []):
        file = files[0]
        result = bpy.data.images.load(str(local_file(file["path"], system=file.get("system", False))), check_existing=True)
    elif asset["kind"] == "fonts":
        file = next(file for file in files if Path(file["path"]).suffix.lower() in {".ttf", ".otf"})
        result = bpy.data.fonts.load(str(local_file(file["path"])))
    elif asset["kind"] in {"materials", "textures", "decals"}:
        blend = next((file for file in files if file["role"] == "blend"), None)
        result = (
            _load_blend(str(local_file(blend["path"], system=blend.get("system", False))), "materials", name, link=link)[0]
            if blend and (name is not None or not any(file["role"] == "color" for file in files))
            else _material(asset, scale, displacement=displacement, normal_strength=normal_strength)
        )
    elif asset["kind"] == "hdri":
        blend = next((file for file in files if file["role"] == "blend"), None)
        if blend:
            world = _load_blend(str(local_file(blend["path"], system=blend.get("system", False))), "worlds", name, link=link)[0]
            bpy.context.scene.world = world
            result = world
        else:
            file = next(file for file in files if file["role"] == "hdri")
            world = bpy.data.worlds.new(asset["title"])
            world.use_nodes = True
            nodes, links = world.node_tree.nodes, world.node_tree.links
            environment = nodes.new("ShaderNodeTexEnvironment")
            environment.image = bpy.data.images.load(str(local_file(file["path"], system=file.get("system", False))), check_existing=True)
            mapping = nodes.new("ShaderNodeMapping")
            coordinates = nodes.new("ShaderNodeTexCoord")
            mapping.inputs["Rotation"].default_value[2] = math.radians(rotation)
            links.new(coordinates.outputs["Generated"], mapping.inputs["Vector"])
            links.new(mapping.outputs["Vector"], environment.inputs["Vector"])
            links.new(environment.outputs["Color"], nodes.get("Background").inputs["Color"])
            nodes.get("Background").inputs["Strength"].default_value = strength
            bpy.context.scene.world = world
            result = world
    elif asset["kind"] == "node-groups":
        file = next(file for file in files if file["role"] == "blend")
        result = _load_blend(str(local_file(file["path"], system=file.get("system", False))), "node_groups", name, link=link, assets_only=True)[0]
    elif asset["kind"] == "models":
        candidates = [file for file in files if file["role"] in {"glb", "model", "blend"}]
        if name and Path(name).suffix.lower() in {".glb", ".gltf", ".fbx", ".obj"}:
            candidates = [file for file in candidates if Path(file["path"]).name == name or file["path"].endswith("/" + name)]
            name = None
        if not candidates:
            msg = "No matching model file in this asset"
            raise ValueError(msg)
        file = candidates[0]
        target = str(local_file(file["path"], system=file.get("system", False)))
        before = set(bpy.data.objects)
        if file["role"] == "blend":
            if link:
                if asset.get("allowedCategory") == "objects":
                    msg = "Linked models require a licensed collection"
                    raise ValueError(msg)
                collections = _load_blend(target, "collections", name, link=True)
                if not collections:
                    msg = "Linked models need a collection in the .blend file"
                    raise ValueError(msg)
                objects = []
                for collection in collections:
                    instance = bpy.data.objects.new(collection.name, None)
                    instance.instance_type = "COLLECTION"
                    instance.instance_collection = collection
                    bpy.context.scene.collection.objects.link(instance)
                    objects.append(instance)
            else:
                with bpy.data.libraries.load(target) as (available, _unused):
                    collection_name = asset.get("allowedCategory") == "collections" or (name is not None and name in available.collections and name not in available.objects)
                objects = [] if collection_name else _load_blend(target, "objects", name, link=False)
                if not objects:
                    collections = _load_blend(target, "collections", name, link=False)
                    for collection in collections:
                        bpy.context.scene.collection.children.link(collection)
                    objects = list({obj for collection in collections for obj in collection.all_objects})
        else:
            suffix = Path(target).suffix.lower()
            if suffix in {".glb", ".gltf"}:
                bpy.ops.import_scene.gltf(filepath=target)
            elif suffix == ".fbx":
                bpy.ops.import_scene.fbx(filepath=target)
            elif suffix == ".obj":
                bpy.ops.wm.obj_import(filepath=target)
            else:
                msg = f"Unsupported model format: {suffix}"
                raise ValueError(msg)
            objects = list(set(bpy.data.objects) - before)
        if not objects:
            msg = f"No objects in {asset_id}"
            raise ValueError(msg)
        result = _root(objects, asset["title"], normalise_scale)
    else:
        msg = f"Asset kind {asset['kind']} cannot be appended"
        raise ValueError(msg)
    _usage(asset_id, script, project)
    return result


def _safe_store() -> None:
    base = Path(avc_arsenal.paths()["root"])
    local = base / "local"
    library = local / "library"
    if base.is_symlink() or local.is_symlink() or library.is_symlink() or any(file.is_symlink() for file in library.rglob("*")):
        msg = "Symlink in arsenal store"
        raise ValueError(msg)


def _record_bundled(item: dict[str, str]) -> None:
    """Write a local receipt pointing to the installed file via a local copy."""
    _safe_store()
    category = item["category"]
    kind = "node-groups" if category == "node_groups" else "materials" if category == "materials" else "hdri" if category == "worlds" else "models"
    directory = library_path() / kind / "essentials" / item["id"].split(":")[1]
    directory.mkdir(parents=True, exist_ok=True)
    target = Path(item["file"])
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    asset = {
        "version": 1,
        "id": item["id"],
        "source": "essentials",
        "kind": kind,
        "title": item["name"],
        "licence": "CC0-1.0",
        "licenceUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "attribution": "Blender bundled Essentials",
        "sourcePage": "https://www.blender.org",
        "files": [{"path": str(target), "role": "blend", "system": True}],
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "fetched": now,
        "consent": {"by": "local session", "date": now, "note": "Bundled asset; no download"},
        "tags": ["essentials"],
    }
    (directory / "asset.json").write_text(json.dumps(asset), encoding="utf8")
