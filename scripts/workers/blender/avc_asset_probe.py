# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Read local Blender asset metadata in an isolated, offline factory process."""

import hashlib
import json
import sys
from pathlib import Path

import bpy


def describe(file: Path) -> list[dict[str, str]]:
    """Read asset names, types and catalogues; never run embedded code."""
    assets = []
    requested = {}
    with bpy.data.libraries.load(str(file), assets_only=True) as (source, target):
        for category in ("node_groups", "materials", "worlds", "collections", "objects", "brushes"):
            requested[category] = list(getattr(source, category))
            setattr(target, category, list(requested[category]))
    for category in ("node_groups", "materials", "worlds", "collections", "objects", "brushes"):
        for original_name, item in zip(requested[category], getattr(target, category), strict=True):
            if item is not None:
                data = item.asset_data
                assets.append({"name": original_name, "category": category, "catalogId": data.catalog_id if data else ""})
    return assets


def main() -> None:
    """Write a machine-readable result independently of Blender's stdout."""
    request = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
    if set(request) - {"files", "bundled", "output"}:
        msg = "Unknown probe request keys"
        raise ValueError(msg)
    result = {"blenderVersion": bpy.app.version_string, "files": [], "systemRoot": bpy.utils.system_resource("DATAFILES")}
    base = Path(result["systemRoot"])
    files = [Path(file) for file in request.get("files", [])]
    if request.get("bundled"):
        files = sorted((base / "assets/nodes").glob("*.blend"))
    for file in files:
        result["files"].append({"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "assets": describe(file)})
    if request.get("bundled"):
        for category in ("matcap", "world"):
            for file in sorted((base / "studiolights" / category).glob("*.exr")):
                if file.stem == "brush_thumbnail_preview":
                    continue
                result["files"].append({"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "assets": [{"name": file.stem, "category": category, "catalogId": ""}]})
    Path(request["output"]).write_text(json.dumps(result), encoding="utf8")


if __name__ == "__main__":
    main()
