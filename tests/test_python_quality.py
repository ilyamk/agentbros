# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Exercise motion-domain failures that static analysis cannot rule out."""

from __future__ import annotations

import ast
import importlib.util
import json
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path
from types import ModuleType

import pytest

SPEC = importlib.util.spec_from_file_location("quality_curves", Path(__file__).resolve().parents[1] / "scripts/blender/kit/curves.py")
assert SPEC is not None
assert SPEC.loader is not None
CURVES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CURVES)


def test_vector_interpolation_refuses_silent_truncation() -> None:
    with pytest.raises(ValueError, match="zip"):
        CURVES.mix((1, 2, 3), (4, 5), 0.5)
    with pytest.raises(TypeError):
        CURVES.mix(1, (2, 3), 0.5)
    assert CURVES.mix((0, 2), (2, 4), 0.5) == (1, 3)
    assert CURVES.mix(0, 2, 0.5) == 1


def test_arc_refuses_inconsistent_dimensions() -> None:
    with pytest.raises(ValueError, match="zip"):
        CURVES.arc((0, 0, 0), (1, 1), 1, 0.5)


def test_smoothing_start_is_an_integer_frame() -> None:
    with pytest.raises(ValueError, match="integer"):
        CURVES.smoothed(lambda frame: frame, 0.6, start=0.5)
    assert CURVES.smoothed(lambda frame: frame, 0.5, half_life=1) == pytest.approx(0.25)


def test_motion_domains_fail_with_actionable_errors() -> None:
    with pytest.raises(ValueError, match="Noise"):
        CURVES.band_noise(1, low=0)
    with pytest.raises(ValueError, match="Noise"):
        CURVES.band_noise(1, partials=0)
    with pytest.raises(ValueError, match="temperature"):
        CURVES.kelvin_rgb(0)


def test_blender_helpers_retain_python_311_syntax() -> None:

    root = Path(__file__).resolve().parents[1]
    paths = [*root.joinpath("scripts/blender").rglob("*.py"), *root.joinpath("scripts/workers/blender").rglob("*.py")]
    paths.extend([root / "examples/vork/blender-source.py", root / "tests/fixtures/blender-extension-exercise.py", root / "tests/fixtures/python-quality-blender.py"])
    for path in paths:
        ast.parse(path.read_text(), filename=str(path), feature_version=(3, 11))


def _load(name: str, relative: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / relative)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_live_protocol_rejects_bool_versions_and_trailing_newlines() -> None:

    protocol = _load("quality_protocol", "scripts/workers/blender/avc_live_protocol.py")
    for version, operation in [(True, "inspect"), (1, "inspect\n")]:
        with pytest.raises(protocol.LiveError, match=r"version|op"):
            protocol.parse_request(json.dumps({"v": version, "op": operation, "token": "a" * 32}).encode(), "a" * 32)
    for check in [protocol.check_name, protocol.check_datablock_name]:
        with pytest.raises(protocol.LiveError, match="name"):
            check("valid\n")


def test_resolve_frames_reject_booleans() -> None:
    worker = _load("quality_resolve", "workers/resolve_worker.py")
    with pytest.raises(ValueError, match="integral"):
        worker.integer({"num": 1, "den": True})
    with pytest.raises(ValueError, match="invalid"):
        worker.rational(value=True)


def test_live_vector_guards_reject_non_finite_values(monkeypatch: pytest.MonkeyPatch) -> None:
    directory = Path(__file__).resolve().parents[1] / "scripts/workers/blender"
    monkeypatch.syspath_prepend(str(directory))
    monkeypatch.setitem(sys.modules, "bpy", ModuleType("bpy"))
    mathutils = ModuleType("mathutils")
    mathutils.__dict__["Vector"] = object
    monkeypatch.setitem(sys.modules, "mathutils", mathutils)
    operations = _load("quality_live_ops", "scripts/workers/blender/avc_live_ops.py")
    for value in [float("nan"), float("inf"), -float("inf")]:
        with pytest.raises(operations.LiveError, match="numbers"):
            operations._vector({"location": [value, 0, 0]}, "location")
        with pytest.raises(operations.LiveError, match="numbers"):
            operations._color({"colour": [value, 0, 0]}, "colour")


def test_type_gate_rejects_incorrect_owned_code(tmp_path: Path) -> None:
    checker = shutil.which("ty")
    assert checker is not None
    root = Path(__file__).resolve().parents[1]
    manifest = (root / "pyproject.toml").read_text()
    (tmp_path / "pyproject.toml").write_text(manifest)
    for directory in tomllib.loads(manifest)["tool"]["ty"]["environment"]["extra-paths"]:
        (tmp_path / directory).mkdir(parents=True, exist_ok=True)
    (tmp_path / "probe.py").write_text('def wrong_result() -> int:\n    return "invalid"\n')
    result = subprocess.run(  # noqa: S603 -- Exercise the installed pinned checker with literal arguments.
        [checker, "check", "--project", str(tmp_path), "--python", sys.executable, "--output-format", "concise"],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    assert result.returncode != 0
    assert "invalid-explicit-return" in result.stdout
    assert "probe.py" in result.stdout


def test_resolve_worker_retains_sdk_python_syntax() -> None:
    root = Path(__file__).resolve().parents[1]
    for path in [root / "workers/resolve_worker.py", root / "tests/fixtures/resolve-sdk/Modules/DaVinciResolveScript.py"]:
        ast.parse(path.read_text(), filename=str(path), feature_version=(3, 9))
