"""Verify host-independent transforms used by the trusted Blender renderer."""
# Copyright (C) 2026 ILIA MAKSIMENKA
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "viz_math",
    Path(__file__).resolve().parents[1] / "scripts/blender/viz_math.py",
)
assert SPEC is not None
assert SPEC.loader is not None
MATH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATH)


def test_coordinate_basis() -> None:
    """Right, up and viewer axes retain the approved handedness."""
    assert MATH.to_blender(1, 0, 0) == (1, 0, 0)
    assert MATH.to_blender(0, 1, 0) == (0, 0, 1)
    assert MATH.to_blender(0, 0, 1) == (0, -1, 0)


def test_scene_linear_colour() -> None:
    """Check both sRGB transfer branches against published reference values."""
    assert MATH.linear_colour("#000000") == (0, 0, 0)
    assert MATH.linear_colour("#ffffff") == (1, 1, 1)
    assert MATH.linear_colour("#808080") == pytest.approx((0.2158605,) * 3)
    assert MATH.linear_colour("#0a0a0a") == pytest.approx((0.00303527,) * 3)
