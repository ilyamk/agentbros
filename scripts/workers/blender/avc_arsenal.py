# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Paths of the Blender arsenal, the Python twin of src/lib/blender-arsenal/paths.ts.

Tracked manifests sit in blender-arsenal/; fetched and generated material in the
git-ignored blender-arsenal/local/. The repository root is AGENTBROS_REPO_ROOT when set,
otherwise found from this file (scripts/workers/blender/ is three levels down).
"""

import os
from pathlib import Path

ASSET_KINDS = ("models", "materials", "hdri", "textures", "node-groups", "fonts", "decals")


def repo_root() -> str:
    """Locate the repository root for native asset integration."""
    env = os.environ.get("AGENTBROS_REPO_ROOT")
    if env:
        return os.path.abspath(env)  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.
    return os.path.abspath(str(Path(str(Path(__file__).parent)).joinpath("..", "..", "..")))  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.


def paths(root: str | None = None) -> dict[str, str]:
    """Resolve the repository paths used by the arsenal."""
    root = root or repo_root()
    base = str(Path(root).joinpath("blender-arsenal"))
    local = str(Path(base).joinpath("local"))
    library = str(Path(local).joinpath("library"))
    return {
        "root": base,
        "extensions_manifest": str(Path(base).joinpath("extensions.json")),
        "libraries_manifest": str(Path(base).joinpath("libraries.json")),
        "collections": str(Path(base).joinpath("collections")),
        "recipes": str(Path(root).joinpath("scripts", "blender", "recipes")),
        "local": local,
        "blender_user": str(Path(local).joinpath("blender-user")),
        "downloads": str(Path(local).joinpath("downloads")),
        "library": library,
        "library_index": str(Path(library).joinpath("index.json")),
        "library_catalog": str(Path(library).joinpath("blender_assets.cats.txt")),
        "bakes": str(Path(local).joinpath("bakes")),
        "trials": str(Path(local).joinpath("trials")),
    }
