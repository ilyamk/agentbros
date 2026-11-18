# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Entry point for scripts/blender-run.ts: runs the scene script, applies the CLI settings, then renders."""

from __future__ import annotations

import json
import os
import runpy
import sys
import time
from pathlib import Path
from typing import TypeAlias

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(os.path.abspath(__file__)).parent))  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.

from typing import Any  # noqa: E402 -- Native module paths are established before these imports.

import bpy  # noqa: E402 -- Native module paths are established before these imports.

import avc_export  # noqa: E402 -- Native module paths are established before these imports.

Params: TypeAlias = dict[str, Any]


# Dynamic Blender/operator dictionaries are validated by their owning request schemas.


def write_result(request: Params, scene: bpy.types.Scene, device: str, rendered: bool) -> None:
    """Write the render receipt consumed by the owning Node runner."""
    first, last = avc_export.frame_range(scene)
    payload = {
        "blenderVersion": bpy.app.version_string,
        "engine": scene.render.engine,
        "device": device,
        "samples": scene.cycles.samples if scene.render.engine == "CYCLES" else None,
        "width": round(scene.render.resolution_x * scene.render.resolution_percentage / 100),
        "height": round(scene.render.resolution_y * scene.render.resolution_percentage / 100),
        "fps": scene.render.fps / scene.render.fps_base,
        "filmTransparent": scene.render.film_transparent,
        "viewTransform": scene.view_settings.view_transform,
        "look": scene.view_settings.look,
        "motionBlur": scene.render.use_motion_blur,
        "frameStart": first,
        "frameEnd": last,
        "rendered": rendered,
    }
    if "extensions" in request:
        payload["extensions"] = request["extensions"]
    with Path(request["resultFile"]).open("w", encoding="utf8") as handle:
        json.dump(payload, handle)


def configure_output(request: Params, scene: bpy.types.Scene) -> None:
    """Apply the requested render output settings."""
    settings = scene.render.image_settings
    if request["format"] == "exr":
        settings.file_format = "OPEN_EXR"
        settings.color_depth = "16"
        settings.exr_codec = "ZIP"
    else:
        settings.file_format = "PNG"
        settings.color_depth = "8"
        settings.compression = 15
    settings.color_mode = "RGBA" if scene.render.film_transparent or request["format"] == "exr" else "RGB"
    scene.render.use_file_extension = True
    scene.render.use_overwrite = not request.get("resume", False)
    scene.render.use_placeholder = False
    scene.render.filepath = str(Path(request["output"]).joinpath("frame-######"))


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    request = avc_export.render_request()
    if request.get("extensions") is not None:
        import avc_extensions

        expected = request["extensions"]
        enabled = avc_extensions.enable([entry["id"] for entry in expected], {entry["id"]: entry["version"] for entry in expected})
        if [(entry["id"], entry["version"]) for entry in enabled] != [(entry["id"], entry["version"]) for entry in expected]:
            msg = "Enabled extension versions differ from approved pins"
            raise RuntimeError(msg)
        request["extensions"] = enabled
    if request.get("blend"):
        bpy.ops.wm.open_mainfile(filepath=request["blend"], use_scripts=False)
    script = request.get("script")
    if script:
        sys.path.insert(0, str(Path(script).parent))
        runpy.run_path(script, run_name="__main__")
    scene = bpy.context.scene
    if scene.get("avc_required_extensions"):
        import avc_extensions

        avc_extensions.require_render_extensions()
    device = avc_export.apply_overrides(scene)
    if request.get("noRender"):
        write_result(request, scene, device, False)
        return
    if scene.camera is None:
        error_message = "The scene has no active camera."
        raise RuntimeError(error_message)
    first, last = avc_export.frame_range(scene)
    scene.frame_start, scene.frame_end, scene.frame_step = first, last, 1
    configure_output(request, scene)
    started = time.monotonic()

    def report(rendered_scene: bpy.types.Scene, _depsgraph: bpy.types.Depsgraph | None = None) -> None:
        print(f"AGENTBROS_FRAME {rendered_scene.frame_current} {first} {last} {time.monotonic() - started:.1f}", flush=True)  # noqa: T201 -- The owning Node caller consumes this worker output.

    bpy.app.handlers.render_write.append(report)
    bpy.ops.render.render(animation=True, write_still=False)
    write_result(request, scene, device, True)


main()
