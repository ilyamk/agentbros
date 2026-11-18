# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Helpers for scene scripts launched by scripts/blender-run.ts.

The runner puts this folder on sys.path, so a scene script can `import avc_export`.
Bake any simulation before export_camera(): it seeks frames directly.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeAlias

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

if TYPE_CHECKING:
    from collections.abc import Iterable

Params: TypeAlias = dict[str, Any]

_Z_UP_TO_Y_UP = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))


def render_request() -> Params:
    """The runner's request, or an empty dict when the script runs outside blender-run."""
    path = os.environ.get("AGENTBROS_BLENDER_REQUEST")
    if not path:
        return {}
    with Path(path).open(encoding="utf8") as handle:
        return json.load(handle)


def output_path(name: str) -> str:
    """A file beside the rendered frames."""
    directory = render_request().get("output") or str(Path(bpy.data.filepath).parent) or str(Path.cwd())
    return str(Path(directory).joinpath(name))


def frame_range(scene: bpy.types.Scene | None = None) -> tuple[int, int]:
    """Return the runner frame range or the scene defaults."""
    scene = scene or bpy.context.scene
    frames = render_request().get("frames")
    return (frames[0], frames[1]) if frames else (scene.frame_start, scene.frame_end)


def _select_device(scene: bpy.types.Scene, device: str) -> str:
    if device == "cpu":
        scene.cycles.device = "CPU"
        return "CPU"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            preferences.compute_device_type = backend
        except TypeError:
            continue
        preferences.get_devices()
        matching = [item for item in preferences.devices if item.type == backend]
        if matching:
            for item in preferences.devices:
                item.use = item.type == backend
            scene.cycles.device = "GPU"
            return backend
    if device == "gpu":
        error_message = "No Cycles GPU device is available; use --device cpu or auto."
        raise RuntimeError(error_message)
    scene.cycles.device = "CPU"
    return "CPU"


def _set_engine(scene: bpy.types.Scene, engine: str | None) -> None:
    if engine == "cycles":
        scene.render.engine = "CYCLES"
    elif engine == "eevee":
        try:
            scene.render.engine = "BLENDER_EEVEE"
        except TypeError:
            scene.render.engine = "BLENDER_EEVEE_NEXT"


def apply_overrides(scene: bpy.types.Scene | None = None) -> str:
    """Applies the command-line settings. Later calls repeat them, so the command line wins over the script."""
    scene = scene or bpy.context.scene
    request = render_request()
    _set_engine(scene, request.get("engine"))
    if request.get("resolution"):
        scene.render.resolution_x, scene.render.resolution_y = request["resolution"]
        scene.render.resolution_percentage = 100
    if request.get("filmTransparent") is not None:
        scene.render.film_transparent = request["filmTransparent"]
    device = "not-cycles"
    if scene.render.engine == "CYCLES":
        device = _select_device(scene, request.get("device", "auto"))
        if request.get("samples"):
            scene.cycles.samples = request["samples"]
    elif request.get("samples") and hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = request["samples"]
    if device == "CPU":
        scene.render.dither_intensity = 0
        if hasattr(scene.render, "compositor_device"):
            scene.render.compositor_device = "CPU"
        if hasattr(scene.cycles, "denoising_use_gpu"):
            scene.cycles.denoising_use_gpu = False
    return device


def _flat(matrix: Matrix) -> list[float]:
    return [round(value, 7) for row in matrix for value in row]


def _pixels(scene: bpy.types.Scene) -> tuple[int, int]:
    scale = scene.render.resolution_percentage / 100
    return round(scene.render.resolution_x * scale), round(scene.render.resolution_y * scale)


def _anchor(scene: bpy.types.Scene, camera: bpy.types.Object, name: str, depsgraph: bpy.types.Depsgraph) -> Params:
    point = bpy.data.objects[name].evaluated_get(depsgraph).matrix_world.translation
    view = world_to_camera_view(scene, camera, point)
    width, height = _pixels(scene)
    visible = view.z > 0 and 0 <= view.x <= 1 and 0 <= view.y <= 1
    return {"x": round(view.x * width, 3), "y": round((1 - view.y) * height, 3), "depth": round(view.z, 5), "visible": visible}


def _focus_distance(data: bpy.types.Camera, location: Vector, depsgraph: bpy.types.Depsgraph) -> float:
    if data.dof.focus_object is None:
        return round(data.dof.focus_distance, 5)
    target = data.dof.focus_object.evaluated_get(depsgraph).matrix_world.translation
    return round((target - location).length, 5)


def export_camera(path: str | None = None, *, scene: bpy.types.Scene | None = None, camera: bpy.types.Object | None = None, frames: Iterable[int] | None = None, anchors: Iterable[str] = ()) -> str:
    """Writes the camera for each frame to JSON for matching Remotion overlays.

    `projectionMatrix` and `threeMatrixWorld` are row-major; transpose them for three.js, which is Y up and
    column-major. `anchors` names objects to report as top-left pixel positions, for 2D overlays.
    """
    scene = scene or bpy.context.scene
    apply_overrides(scene)
    camera = camera or scene.camera
    if camera is None:
        error_message = "The scene has no active camera."
        raise RuntimeError(error_message)
    first, last = frames or frame_range(scene)
    width, height = _pixels(scene)
    original = scene.frame_current
    records = []
    try:
        for frame in range(first, last + 1):
            scene.frame_set(frame)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            evaluated = camera.evaluated_get(depsgraph)
            world = evaluated.matrix_world.copy()
            projection = evaluated.calc_matrix_camera(depsgraph, x=width, y=height, scale_x=scene.render.pixel_aspect_x, scale_y=scene.render.pixel_aspect_y)
            location, rotation, _ = world.decompose()
            data = evaluated.data
            records.append(
                {
                    "frame": frame,
                    "timeSec": round((frame - first) * scene.render.fps_base / scene.render.fps, 6),
                    "matrixWorld": _flat(world),
                    "threeMatrixWorld": _flat(_Z_UP_TO_Y_UP @ world),
                    "projectionMatrix": _flat(projection),
                    "location": [round(value, 6) for value in location],
                    "quaternionWxyz": [round(value, 7) for value in rotation],
                    "lensMm": round(data.lens, 5),
                    "sensorWidthMm": data.sensor_width,
                    "sensorHeightMm": data.sensor_height,
                    "sensorFit": data.sensor_fit,
                    "fovXDeg": round(math.degrees(2 * math.atan(1 / projection[0][0])), 5),
                    "fovYDeg": round(math.degrees(2 * math.atan(1 / projection[1][1])), 5),
                    "clipStart": data.clip_start,
                    "clipEnd": data.clip_end,
                    "focusDistance": _focus_distance(data, location, depsgraph),
                    "anchors": {name: _anchor(scene, evaluated, name, depsgraph) for name in anchors},
                }
            )
    finally:
        scene.frame_set(original)
    target = path or output_path("camera.json")
    Path(str(Path(os.path.abspath(target)).parent)).mkdir(parents=True, exist_ok=True)  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.
    with Path(target).open("w", encoding="utf8") as handle:
        json.dump(
            {
                "schemaVersion": 1,
                "width": width,
                "height": height,
                "fps": scene.render.fps / scene.render.fps_base,
                "frameStart": first,
                "frameEnd": last,
                "camera": camera.name,
                "matrixOrder": "row-major",
                "frames": records,
            },
            handle,
        )
    return target
