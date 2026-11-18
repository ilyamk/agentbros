# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Check city planning, OSM units/outlines and frame-order independence without bpy."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts/workers/blender"), str(ROOT / "scripts/blender/recipes")]
from _city import coordinate_key, footprints, height, layout  # noqa: E402 -- Native module paths are established before these imports.
from window_lights import illumination  # noqa: E402 -- Native module paths are established before these imports.


class CityTests(unittest.TestCase):
    """Exercise external tags and stable procedural plans, rather than Blender implementation details."""

    def test_seed_changes_layout_without_intersecting_lots(self) -> None:
        """Keep repeatable street space and a single central landmark."""
        a = layout(31, 5, 58, 148)
        self.assertEqual(a, layout(31, 5, 58, 148))
        self.assertNotEqual(a, layout(32, 5, 58, 148))
        for seed in range(5):
            for blocks in range(1, 7):
                buildings = layout(seed, blocks, 58, 148)
                self.assertEqual(sum(bool(b.get("hero")) for b in buildings), 1)
                for i, left in enumerate(buildings):
                    for right in buildings[i + 1 :]:
                        self.assertTrue(abs(left["x"] - right["x"]) >= (left["w"] + right["w"]) / 2 or abs(left["y"] - right["y"]) >= (left["d"] + right["d"]) / 2)

    def test_cross_runtime_coordinate_ties(self) -> None:
        """Keep the JS fetch cache discoverable for half-microdegree and negative inputs."""
        self.assertEqual(coordinate_key(12.0078125), "12.007813")
        self.assertEqual(coordinate_key(-12.0078125), "-12.007812")
        self.assertEqual(coordinate_key(-0.0000001), "0.000000")

    def test_osm_heights(self) -> None:
        """Prefer height over levels and handle feet, missing and non-finite tags."""
        self.assertEqual(height({"height": "100 ft", "building:levels": "4"}), (30.48, 0))
        self.assertEqual(height({"building:levels": "4", "building:min_level": "1"}), (13.6, 3.4))
        for value in ("garbage", "NaN", "inf", ""):
            self.assertEqual(height({"height": value}), (12, 0))
        self.assertEqual(height({"height": "999999"}), (600, 0))
        self.assertGreater(height({"height": "-1", "min_height": "99"})[0], 99)

    def test_footprint_keeps_concave_outline_and_drops_open_ways(self) -> None:
        """Retain geographic vertices and metres rather than replacing places with boxes."""
        points = [{"lat": x * 0.0001, "lon": y * 0.0001} for x, y in ((0, 0), (0, 2), (1, 1), (2, 2), (2, 0), (0, 0))]
        ways = [{"type": "way", "id": 1, "geometry": points, "tags": {"height": "18m"}}, {"type": "way", "id": 2, "geometry": points[:-1], "tags": {}}]
        buildings = footprints({"elements": ways}, 0, 0)
        self.assertEqual(len(buildings), 1)
        self.assertEqual(len(buildings[0]["points"]), 5)
        self.assertAlmostEqual(max(p[0] for p in buildings[0]["points"]), 22.239016, places=5)
        self.assertEqual(buildings[0]["h"], 18)

    def test_window_switches_are_frame_functions(self) -> None:
        """Jumping backwards or evaluating a frame alone cannot change occupancy."""
        values = {f: illumination(f, 5, 8, 38, 2.8) for f in range(96)}
        for f in (95, 1, 48, 20, 48):
            self.assertEqual(illumination(f, 5, 8, 38, 2.8), values[f])
        self.assertTrue(all(math.isfinite(v) and 0 <= v <= 2.8 for v in values.values()))
        self.assertEqual(illumination(95, 12, 8, 38, 2.8), 0)
        self.assertEqual(illumination(1, 0, 8, 38, 2.8), 0)
        self.assertEqual(illumination(95, 0, 8, 38, 2.8), 2.8)


if __name__ == "__main__":
    unittest.main()
