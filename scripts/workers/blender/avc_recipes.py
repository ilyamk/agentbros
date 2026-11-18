# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
# ruff: noqa: ANN401
"""Discover literal recipe metadata without importing Blender; apply trusted built-in recipes lazily."""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path
from typing import Any

from avc_arsenal import paths, repo_root
from avc_live_protocol import contained


def catalogue(directory: str | None = None) -> list[dict[str, Any]]:
    """Read META and opening intent without executing recipe code."""
    result = []
    for file in sorted(Path(directory or paths()["recipes"]).glob("*.py")):
        if file.name.startswith("_"):
            continue
        tree = ast.parse(file.read_text(encoding="utf8"), filename=str(file))
        assignments = [node for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "META" for t in node.targets)]
        if len(assignments) != 1:
            msg = f"{file.name}: expected one literal META"
            raise ValueError(msg)
        meta = ast.literal_eval(assignments[0].value)
        if meta["id"] != file.stem.replace("_", "-"):
            msg = f"{file.name}: id must match filename"
            raise ValueError(msg)
        doc = ast.get_docstring(tree) or ""
        if not doc.startswith(meta["intent"]):
            msg = f"{file.name}: docstring must open with META intent"
            raise ValueError(msg)
        validate_params(meta, {})
        result.append(meta)
    if len({meta["id"] for meta in result}) != len(result):
        msg = "Duplicate recipe ids"
        raise ValueError(msg)
    return result


def describe(recipe_id: str) -> dict[str, Any]:
    """Resolve an id through the catalogue, never through a user-supplied path."""
    for meta in catalogue():
        if meta["id"] == recipe_id:
            return meta
    msg = f"Unknown recipe: {recipe_id}"
    raise ValueError(msg)


def validate_params(meta: dict[str, Any], params: object) -> dict[str, Any]:
    """Reject unknown keys, booleans masquerading as numbers, infinities and out-of-range values."""
    if not isinstance(params, dict):
        msg = "Recipe params must be an object"
        raise ValueError(msg)  # noqa: TRY004 — all parameter contract errors use ValueError.
    unknown = params.keys() - meta["params"].keys()
    if unknown:
        msg = f"Unknown params: {', '.join(sorted(unknown))}"
        raise ValueError(msg)
    values = {}
    for name, spec in meta["params"].items():
        value = params.get(name, spec["default"])
        kind = spec["type"]
        valid = (
            (kind == "integer" and type(value) is int)
            or (kind == "number" and type(value) in (int, float))
            or (kind == "string" and isinstance(value, str))
            or (kind == "boolean" and type(value) is bool)
        )
        if not valid:
            msg = f"{name}: expected {kind}"
            raise ValueError(msg)
        if (
            kind in ("integer", "number")
            and isinstance(value, (int, float))
            and (not math.isfinite(value) or (spec.get("min") is not None and value < spec["min"]) or (spec.get("max") is not None and value > spec["max"]))
        ):
            msg = f"{name}: outside finite bounds"
            raise ValueError(msg)
        values[name] = value
    return values


def validate_generators(meta: dict[str, Any], blender_version: str, build_hash: str) -> None:
    """Admit only approved, exactly pinned native builds and procedural source bytes."""
    required = meta.get("requires", {}).get("generators", [])
    if not required:
        return
    manifest = json.loads((Path(paths()["root"]) / "generators.json").read_text(encoding="utf8"))
    for generator_id in required:
        generator = next((entry for entry in manifest["generators"] if entry["id"] == generator_id), None)
        if generator is None or generator["status"] != "approved":
            message = f"Recipe requires an approved generator: {generator_id}"
            raise ValueError(message)
        install = generator["install"]
        if install.get("build") and (blender_version != install["version"] or build_hash != install["build"]):
            message = f"Generator {generator_id} requires Blender {install['version']} build {install['build']}"
            raise ValueError(message)
        if install.get("sha256"):
            source = Path(contained(repo_root(), str(Path(repo_root()) / install["source"])))
            if hashlib.sha256(source.read_bytes()).hexdigest() != install["sha256"]:
                message = f"Generator {generator_id} source SHA256 changed; review and update its pin"
                raise ValueError(message)


def apply(recipe_id: str, params: dict[str, Any] | None = None, timeline: Any = None, scene: Any = None) -> dict[str, Any]:
    """Add a recipe to the current scene, without resetting it or creating a stage/camera."""
    import bpy  # Only a real application needs Blender.

    meta = describe(recipe_id)
    values = validate_params(meta, {} if params is None else params)
    validate_generators(meta, bpy.app.version_string, bpy.app.build_hash.decode("ascii"))
    directory = paths()["recipes"]
    if directory not in sys.path:
        sys.path.insert(0, directory)
    kit_parent = str(Path(directory).parent)
    if kit_parent not in sys.path:
        sys.path.insert(0, kit_parent)
    file = Path(directory) / (recipe_id.replace("-", "_") + ".py")
    spec = importlib.util.spec_from_file_location("avc_recipe_" + recipe_id.replace("-", "_"), file)
    if spec is None or spec.loader is None:
        message = "Recipe module could not be loaded"
        raise RuntimeError(message)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    before_objects, before_materials = set(bpy.data.objects), set(bpy.data.materials)
    result = module.apply(scene or bpy.context.scene, values, timeline)
    result["objects"] = [obj.name for obj in bpy.data.objects if obj not in before_objects]
    result["materials"] = [mat.name for mat in bpy.data.materials if mat not in before_materials]
    return result


if __name__ == "__main__":
    print(json.dumps(catalogue()))  # noqa: T201 — the data-only catalogue worker contract.
