"""Pure colour and coordinate transforms shared by the prepared Blender scene."""
# Copyright (C) 2026 ILIA MAKSIMENKA
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

SRGB_LINEAR_THRESHOLD = 0.04045


def linear_colour(hex_colour: str) -> tuple[float, ...]:
    """Decode canonical sRGB hex channels to scene-linear colour."""
    channels = [int(hex_colour.lstrip("#")[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= SRGB_LINEAR_THRESHOLD else ((c + 0.055) / 1.055) ** 2.4 for c in channels)


def to_blender(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Map X right, Y up, Z viewer into Blender's Z-up scene convention."""
    return x, -z, y
