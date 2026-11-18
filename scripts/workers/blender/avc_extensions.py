# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Enable pinned extensions in the harness's isolated Blender profile."""

from __future__ import annotations

import json
import math
import os
import random
import re
import sys
import time
import tomllib
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

import addon_utils
import bpy
from mathutils import noise

if TYPE_CHECKING:
    from collections.abc import Generator

sys.dont_write_bytecode = True


def _repository() -> Path:
    """Configure the local repository even under factory startup."""
    profile = Path(os.environ["BLENDER_USER_RESOURCES"]).resolve()
    expected = {"BLENDER_USER_CONFIG": "config", "BLENDER_USER_SCRIPTS": "scripts", "BLENDER_USER_EXTENSIONS": "extensions"}
    for key, suffix in expected.items():
        if Path(os.environ[key]).resolve() != profile / suffix:
            msg = f"Non-isolated Blender environment: {key}"
            raise RuntimeError(msg)
    for resource, suffix in (("CONFIG", "config"), ("SCRIPTS", "scripts"), ("EXTENSIONS", "extensions")):
        actual = bpy.utils.user_resource(resource)
        if not actual or Path(actual).resolve() != profile / suffix:
            msg = f"Blender did not honour the isolated {resource} path: {actual}"
            raise RuntimeError(msg)
    directory = profile / "extensions" / "user_default"
    repos = bpy.context.preferences.extensions.repos
    for repo in list(repos):
        if repo.module != "user_default":
            repos.remove(repo)
    repo = next((item for item in repos if item.module == "user_default"), None)
    if repo is None:
        repo = repos.new(name="Harness local", module="user_default", custom_directory=str(directory))
    repo.use_custom_directory = True
    repo.custom_directory = str(directory)
    repo.use_remote_url = False
    repo.enabled = True
    return directory


def _version(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def enable(ids: list[str], expected_versions: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Enable the caller-validated ids, raising on registration or range errors."""
    directory = _repository()
    result = []
    for extension_id in ids:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", extension_id):
            msg = "Invalid extension id"
            raise ValueError(msg)
        with (directory / extension_id / "blender_manifest.toml").open("rb") as handle:
            manifest = tomllib.load(handle)
        if expected_versions is not None and manifest["version"] != expected_versions[extension_id]:
            msg = f"Extension version differs from approved pin: {extension_id}"
            raise RuntimeError(msg)
        version = tuple(bpy.app.version[:3])
        if version < _version(manifest["blender_version_min"]) or (manifest.get("blender_version_max") and version >= _version(manifest["blender_version_max"])):
            msg = f"Extension {extension_id} is incompatible with Blender {bpy.app.version_string}"
            raise RuntimeError(msg)
        module = f"bl_ext.user_default.{extension_id}"
        started = time.perf_counter()
        loaded = addon_utils.enable(module, default_set=True, persistent=True)
        if loaded is None or not addon_utils.check(module)[1]:
            msg = f"Extension failed to enable: {module}"
            raise RuntimeError(msg)
        result.append({"id": extension_id, "version": manifest["version"], "enableMs": round((time.perf_counter() - started) * 1000, 3)})
    return result


def require(extension_id: str, min_version: str) -> None:
    """Require an already enabled extension at the minimum pinned version."""
    module = f"bl_ext.user_default.{extension_id}"
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", extension_id) or not addon_utils.check(module)[1]:
        msg = f"Extension is not enabled: {extension_id}; use blender:run --extensions"
        raise RuntimeError(msg)
    directory = Path(os.environ["BLENDER_USER_EXTENSIONS"]) / "user_default" / extension_id
    with (directory / "blender_manifest.toml").open("rb") as handle:
        actual = tomllib.load(handle)["version"]
    if _version(actual) < _version(min_version):
        msg = f"Extension {extension_id} needs >= {min_version}, installed {actual}"
        raise RuntimeError(msg)


SHAKE_PRESETS = ("INVESTIGATION", "THE_CLOSEUP", "THE_WEDDING", "WALK_TO_THE_STORE", "HANDYCAM_RUN", "OUT_CAR_WINDOW", "BIKE_ON_GRAVEL_2D", "SPACESHIP_SHAKE_2D", "THE_ZEEK_2D")
MAX_SEED = 2**31 - 1
MIN_CELLS = 2
MAX_CELLS = 1000


@contextmanager
def seeded(seed: int) -> Generator[None]:
    """Seed Python and Blender noise for one operation; restore Python RNG state.

    Blender exposes no noise-state getter, so its noise RNG remains advanced.
    Seed every noisy operation explicitly. Zero is forbidden: Blender uses time.
    """
    if isinstance(seed, bool) or not isinstance(seed, int) or not 1 <= seed <= MAX_SEED:
        msg = f"Seed must be an integer from 1 to {MAX_SEED}"
        raise ValueError(msg)
    previous = random.getstate()
    try:
        random.seed(seed)
        noise.seed_set(seed)
        yield
    finally:
        random.setstate(previous)


def camera_shake(camera: bpy.types.Object, preset: str = "THE_CLOSEUP", intensity: float = 0.25) -> bpy.types.PropertyGroup:
    """Add captured shake and persist its render-time dependency without autoexec."""
    require("camera_shakify", "0.5.1")
    if preset not in SHAKE_PRESETS or isinstance(intensity, bool) or not math.isfinite(intensity) or not 0 <= intensity <= 1:
        msg = "Use a known shake preset and finite intensity between zero and one"
        raise ValueError(msg)
    if camera.type != "CAMERA":
        msg = "camera_shake needs a camera object"
        raise ValueError(msg)
    with bpy.context.temp_override(active_object=camera, object=camera, selected_objects=[camera], selected_editable_objects=[camera]):
        result = bpy.ops.object.camera_shake_add()
        if result != {"FINISHED"}:
            msg = "Camera Shakify did not add a shake"
            raise RuntimeError(msg)
        shake = camera.camera_shakes[-1]
        shake.shake_type = preset
        shake.influence = intensity
    required = json.loads(bpy.context.scene.get("avc_required_extensions", "{}"))
    manifest = Path(os.environ["BLENDER_USER_EXTENSIONS"]) / "user_default/camera_shakify/blender_manifest.toml"
    with manifest.open("rb") as handle:
        required["camera_shakify"] = tomllib.load(handle)["version"]
    bpy.context.scene["avc_required_extensions"] = json.dumps(required, sort_keys=True)
    return shake


def require_render_extensions() -> None:
    """Fail clearly when a reopened scene requires an extension not enabled now."""
    for extension_id, version in json.loads(bpy.context.scene.get("avc_required_extensions", "{}")).items():
        require(extension_id, version)
        manifest = Path(os.environ["BLENDER_USER_EXTENSIONS"]) / "user_default" / extension_id / "blender_manifest.toml"
        with manifest.open("rb") as handle:
            actual = tomllib.load(handle)["version"]
        if actual != version:
            msg = f"Saved scene requires {extension_id} {version}, enabled {actual}; rebuild against the new pin"
            raise RuntimeError(msg)


def fracture_object(obj: bpy.types.Object, *, seed: int = 42, cells: int = 8, jitter: float = 0.25) -> list[bpy.types.Object]:
    """Fracture only the selected mesh with both RNGs seeded; no simulation."""
    require("cell_fracture", "0.2.1")
    if obj.type != "MESH" or isinstance(cells, bool) or not isinstance(cells, int) or not MIN_CELLS <= cells <= MAX_CELLS or not math.isfinite(jitter) or not 0 <= jitter <= 1:
        msg = "Fracture needs a mesh, 2..1000 cells and finite jitter in 0..1"
        raise ValueError(msg)
    previous = set(bpy.data.objects)
    with bpy.context.temp_override(active_object=obj, object=obj, selected_objects=[obj], selected_editable_objects=[obj]), seeded(seed):
        result = bpy.ops.object.add_fracture_cell_objects(source={"VERT_OWN"}, source_limit=cells, source_noise=jitter, use_remove_original=False)
        if result != {"FINISHED"}:
            msg = "Cell Fracture did not finish"
            raise RuntimeError(msg)
    return sorted((item for item in bpy.data.objects if item not in previous), key=lambda item: item.name)


def _operators() -> set[str]:
    return {f"{namespace}.{name}" for namespace in dir(bpy.ops) for name in dir(getattr(bpy.ops, namespace))}


def main() -> None:
    """Prepare install-file or enable and measure an isolated trial."""
    _repository()
    extension_id = os.environ.get("AGENTBROS_EXTENSION_SMOKE_ID")
    if extension_id:
        before = _operators()
        groups_before = set(bpy.data.node_groups.keys())
        enabled = enable([extension_id])
        payload = {"enableOk": True, "enabled": enabled, "operators": sorted(_operators() - before), "nodeGroups": sorted(set(bpy.data.node_groups.keys()) - groups_before)}
        Path(os.environ["AGENTBROS_EXTENSION_SMOKE_RESULT"]).write_text(json.dumps(payload), encoding="utf8")


if __name__ == "__main__":
    main()
