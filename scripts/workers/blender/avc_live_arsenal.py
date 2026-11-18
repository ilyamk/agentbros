# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
# ruff: noqa: ANN401
"""Typed local arsenal operations and replay pins; never fetches or installs files."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, NoReturn

import avc_arsenal
import avc_recipes
from avc_live_protocol import LiveError, check_datablock_name, contained

VECTOR_SIZE = 3
MAX_NUMBER = 1e6
MAX_LIMIT = 100


def _fail(code: str, message: str) -> NoReturn:
    raise LiveError(code, message)


def _read(file: str | Path, default: Any) -> Any:
    file = Path(contained(avc_arsenal.repo_root(), str(file)))
    return json.loads(file.read_text(encoding="utf8")) if file.exists() else default


def _hash(file: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(file).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _only(params: dict[str, Any], keys: tuple[str, ...]) -> None:
    if set(params) - set(keys):
        _fail("INVALID_INPUT", "Unknown params: " + ", ".join(sorted(set(params) - set(keys))))


def _asset(asset_id: Any) -> dict[str, Any]:
    if not isinstance(asset_id, str):
        _fail("INVALID_INPUT", "id must be a local asset id.")
    index = _read(avc_arsenal.paths()["library_index"], {"assets": []})
    for item in index["assets"]:
        if item["id"] == asset_id:
            return item
    _fail("ASSET_MISSING", f'Unknown local asset {asset_id}; run pnpm blender:assets --action add --id {asset_id} --consent "who/when/why"')


def asset_pin(asset: dict[str, Any]) -> dict[str, Any]:
    """Pin the receipt and actual files so replay rejects replaced payloads."""
    import avc_assets

    files = [{"path": file["path"], "sha256": _hash(avc_assets.local_file(file["path"], system=file.get("system", False)))} for file in asset["files"]]
    metadata = {key: value for key, value in asset.items() if key not in {"fetched", "consent", "preview"}}
    return {"sha256": asset["sha256"], "metadataSha256": hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest(), "files": files}


def _tree_hash(directory: Path) -> str:
    digest = hashlib.sha256()

    def visit(folder: Path) -> None:
        for file in sorted(folder.iterdir()):
            if file.is_symlink():
                _fail("VALIDATION", "Symlink in installed extension")
            if file.is_dir():
                visit(file)
            else:
                digest.update(str(file.relative_to(directory)).encode())
                digest.update(b"\0")
                digest.update(file.read_bytes())

    visit(directory)
    return digest.hexdigest()


def installed_extensions() -> list[dict[str, Any]]:
    """Return approved installs whose version, archive and unpacked tree match."""
    paths = avc_arsenal.paths()
    pins = _read(paths["extensions_manifest"], {"extensions": []})["extensions"]
    receipts = _read(Path(paths["blender_user"]) / "installed.json", {"extensions": []})["extensions"]
    result = []
    for entry in pins:
        if entry["status"] != "approved":
            continue
        receipt = next((item for item in receipts if item["id"] == entry["id"]), None)
        directory = Path(contained(paths["blender_user"], str(Path(paths["blender_user"]) / "extensions/user_default" / entry["id"])))
        if receipt and directory.is_dir() and receipt["version"] == entry["version"] and receipt["sha256"] == entry["archive"]["sha256"] and _tree_hash(directory) == receipt["treeSha256"]:
            result.append({"id": entry["id"], "version": entry["version"], "sha256": receipt["sha256"]})
    return result


def recipe_code_hash() -> str:
    """Fingerprint the trusted graph which Blender may cache as Python modules."""
    parent = Path(avc_arsenal.paths()["recipes"]).parent
    files = sorted((parent / "recipes").glob("*.py")) + sorted((parent / "kit").glob("*.py")) + sorted((parent / "materials").glob("*.py"))
    return hashlib.sha256(b"".join(file.name.encode() + file.read_bytes() for file in files)).hexdigest()


def bind_recipe_code(context: dict[str, Any]) -> None:
    """Keep the first loaded source identity, including failed import/application attempts."""
    digest = recipe_code_hash()
    if context.get("recipeCodeSha256", digest) != digest:
        _fail("VALIDATION", "Recipe/kit code changed after loading; restart the live session before applying recipes.")
    context["recipeCodeSha256"] = digest


def prepare_step(op: str, params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:  # noqa: C901, PLR0912
    """Validate before mutation and pin actual payloads, defaults and trusted recipe code."""
    step: dict[str, Any] = {"op": op, "params": dict(params)}
    if op == "append-asset":
        _only(params, ("id", "kind", "name", "scale", "location", "material_scale", "target"))
        asset = _asset(params.get("id"))
        if "kind" in params and params["kind"] != asset["kind"]:
            _fail("INVALID_INPUT", f"Asset kind is {asset['kind']}")
        for key in ("name", "target"):
            if key in params:
                check_datablock_name(params[key], key)
        for key in ("scale", "material_scale"):
            if key in params and (type(params[key]) not in (int, float) or not 0 < params[key] <= MAX_NUMBER):
                _fail("INVALID_INPUT", f"{key} must be positive and finite.")
        if "location" in params and (
            not isinstance(params["location"], list) or len(params["location"]) != VECTOR_SIZE or any(type(v) not in (int, float) or not -MAX_NUMBER <= v <= MAX_NUMBER for v in params["location"])
        ):
            _fail("INVALID_INPUT", "location must contain three finite numbers.")
        if any(key in params for key in ("location", "scale")) and asset["kind"] != "models":
            _fail("INVALID_INPUT", "location and scale apply to models; use material_scale for UV repetition.")
        if "material_scale" in params and asset["kind"] not in ("materials", "textures", "decals"):
            _fail("INVALID_INPUT", "material_scale applies to materials.")
        if "target" in params and asset["kind"] not in ("materials", "textures", "decals"):
            _fail("INVALID_INPUT", "target assigns a material to a mesh.")
        step["params"]["kind"] = asset["kind"]
        step["pin"] = asset_pin(asset)
    elif op == "apply-recipe":
        _only(params, ("id", "params"))
        contained(avc_arsenal.repo_root(), avc_arsenal.paths()["bakes"])
        recipe_id, arguments = params.get("id"), params.get("params")
        if not isinstance(recipe_id, str) or not isinstance(arguments, dict):
            _fail("INVALID_INPUT", "apply-recipe requires a string id and params object.")
        if recipe_id == "molecule":
            _fail("INVALID_INPUT", "molecule requires a pinned external structure; use blender:recipe render, not live replay.")
        try:
            meta = avc_recipes.describe(recipe_id)
            step["params"]["params"] = avc_recipes.validate_params(meta, arguments)
        except (ValueError, TypeError) as error:
            code = "INVALID_INPUT"
            raise LiveError(code, str(error)) from error
        step["pin"] = {"sha256": recipe_code_hash()}
        if context.get("recipeCodeSha256", step["pin"]["sha256"]) != step["pin"]["sha256"]:
            _fail("VALIDATION", "Recipe/kit code changed after loading; restart the live session before applying recipes.")
    elif op == "enable-extension":
        _only(params, ("id",))
        extension = next((item for item in installed_extensions() if item["id"] == params.get("id")), None)
        if not extension:
            _fail("VALIDATION", "Extension must be approved and installed without drift; use pnpm blender:ext list.")
        if not context.get("extensionsProfile") or Path(os.environ.get("BLENDER_USER_RESOURCES", "")).resolve() != Path(avc_arsenal.paths()["blender_user"]).resolve():
            _fail("VALIDATION", "Start this session with --extensions <id|approved> to use the isolated extension profile.")
        step["pin"] = {"sha256": extension["sha256"], "version": extension["version"]}
    return step


def append_asset(params: dict[str, Any], context: dict[str, Any], append: Any = None) -> dict[str, Any]:
    """Append an indexed local asset and optionally place or assign it."""
    import bpy

    import avc_assets

    target = bpy.data.objects.get(params.get("target", ""))
    if "target" in params and (target is None or target.type != "MESH"):
        _fail("INVALID_INPUT", "target must name an existing mesh.")
    before = set(bpy.data.objects)
    result: Any = (append or avc_assets.append)(
        params["id"], name=params.get("name"), scale=params.get("material_scale", 1), project=context.get("project"), script="blender:live", normalise_scale=params.get("scale")
    )
    if "location" in params:
        result.location = params["location"]
    if target is not None:
        if not isinstance(result, bpy.types.Material):
            _fail("INVALID_INPUT", "This asset did not return a material.")
        if target.data.materials:
            target.data.materials[0] = result
        else:
            target.data.materials.append(result)
    return {"id": params["id"], "kind": params["kind"], "datablock": result.name, "objects": sorted(obj.name for obj in set(bpy.data.objects) - before)}


def verify_step(step: dict[str, Any], context: dict[str, Any]) -> None:
    """Refuse a missing pin or changed source before replay mutates the scene."""
    op, params = step["op"], step["params"]
    try:
        actual = prepare_step(op, params, context)
    except (OSError, ValueError) as error:
        code = "VALIDATION"
        raise LiveError(code, f"{op} {params.get('id')} cannot verify pinned files; replay refuses drift: {error}") from error
    if step.get("pin") != actual.get("pin"):
        _fail("VALIDATION", f"{op} {params.get('id')} changed since the session; replay refuses drift.")


def apply_step(step: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    """Verify a pinned journal step before calling trusted arsenal helpers."""
    verify_step(step, context)
    op, params = step["op"], step["params"]
    if op == "append-asset":
        return append_asset(params, context)
    if op == "apply-recipe":
        context["recipeCodeSha256"] = step["pin"]["sha256"]
        return avc_recipes.apply(params["id"], params["params"])
    if op == "enable-extension":
        import addon_utils

        import avc_extensions

        if addon_utils.check(f"bl_ext.user_default.{params['id']}")[1]:
            return {"extensions": [{"id": params["id"], "version": step["pin"]["version"], "enableMs": 0.0}]}
        return {"extensions": avc_extensions.enable([params["id"]], {params["id"]: step["pin"]["version"]})}
    _fail("INVALID_INPUT", f"Unknown arsenal op {op}")


def arsenal(params: dict[str, Any]) -> dict[str, Any]:
    """Inspect existing inventory only: no journal entry, usage log or preference writes."""
    _only(params, ("kind", "filter", "limit"))
    kind, query, limit = params.get("kind"), params.get("filter", ""), params.get("limit", 10)
    if (kind is not None and kind not in avc_arsenal.ASSET_KINDS) or not isinstance(query, str) or type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        _fail("INVALID_INPUT", "Use a valid kind, string filter and limit from 1 to 100.")
    paths = avc_arsenal.paths()
    assets = _read(paths["library_index"], {"assets": []})["assets"]
    available, missing = [], []
    import avc_assets

    for asset in assets:
        try:
            for file in asset["files"]:
                avc_assets.local_file(file["path"], system=file.get("system", False))
            available.append(asset)
        except ValueError:
            missing.append(asset["id"])
    ids = {item["id"] for item in available}
    groups = {}
    for group in avc_arsenal.ASSET_KINDS:
        if kind is None or kind == group:
            matches = sorted(item["id"] for item in available if item["kind"] == group and query.lower() in (item["id"] + " " + item["title"]).lower())
            groups[group] = {"count": len(matches), "ids": matches[:limit]}
    recipes = [
        {"id": meta["id"], "title": meta["title"], "status": meta.get("status", "built-in"), "params": meta["params"], "needsBake": meta["needs_bake"]}
        for meta in avc_recipes.catalogue()
        if query.lower() in (meta["id"] + " " + meta["title"]).lower()
    ]
    collections = []
    for file in sorted(Path(paths["collections"]).glob("*.json")):
        collection = _read(file, {})
        if query.lower() in collection["name"].lower():
            collections.append({"name": collection["name"], "present": [item for item in collection["items"] if item in ids], "missing": [item for item in collection["items"] if item not in ids]})
    extensions = [item for item in installed_extensions() if query.lower() in item["id"].lower()]
    return {"assets": groups, "missingAssets": missing[:limit], "recipes": recipes, "extensions": extensions, "collections": collections}
