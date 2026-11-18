# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Scene script for blender:run that rebuilds a live-session recipe (`pnpm blender:live --action export`).

    pnpm blender:run --script scripts/workers/blender/avc_live_replay.py \
      --script-args '["public/projects/<id>/assets/blender/<name>.live.json"]' --output out/<id>/<name> --frames 1-1

The recipe holds the base (empty or a .blend with its sha256) and the journaled ops; the same
avc_live_ops code the live session ran applies them, so the replayed scene matches the session.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(os.path.abspath(__file__)).parent))  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.

import avc_live_ops as ops

CODE_ROOT = os.path.abspath(str(Path(str(Path(os.path.abspath(__file__)).parent)).joinpath("..", "..", "..")))  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) != 1:
        error_message = "avc_live_replay.py takes one argument: the recipe .json path."
        raise SystemExit(error_message)
    with Path(argv[0]).open(encoding="utf8") as handle:
        recipe = json.load(handle)
    workspace = str(Path.cwd())
    os.environ["AGENTBROS_REPO_ROOT"] = workspace
    base = recipe.get("base") or {}
    if base.get("kind") == "blend":
        path = str(Path(workspace).joinpath(base["path"]))
        with Path(path).open("rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        if digest != base.get("sha256"):
            error_message = f"{base['path']} changed since the session (sha256 {digest}, recipe {base.get('sha256')})."
            raise SystemExit(error_message)
    ops.apply_recipe(
        recipe,
        {
            "kitDir": str(Path(CODE_ROOT).joinpath("scripts", "blender")),
            "workspaceRoot": workspace,
            "extensionsProfile": os.path.realpath(os.environ.get("BLENDER_USER_RESOURCES", "")) == str(Path(workspace).joinpath("blender-arsenal", "local", "blender-user")),
        },
    )


main()
