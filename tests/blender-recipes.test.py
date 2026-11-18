# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Pure recipe contracts, caches and geometry; Blender is deliberately not imported."""

from __future__ import annotations

import math
import os
import sys
import tempfile
import unittest
from itertools import pairwise
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts/workers/blender"))
sys.path.insert(0, str(ROOT / "scripts/blender/recipes"))
from _common import bake, ballistic, cache_hash, snapshot_keys, surface_points, voronoi_cells  # noqa: E402 -- Native module paths are established before these imports.
from _nature import height_at, placements, tree_layout  # noqa: E402 -- Native module paths are established before these imports.
from avc_recipes import catalogue, describe, validate_params  # noqa: E402 -- Native module paths are established before these imports.


class RecipeTests(unittest.TestCase):
    def test_surface_sampling_ignores_evaluated_topology_order(self) -> None:
        vertices = [(0, 0, 0), (2, 0, 0), (2, 2, 0), (0, 2, 0)]
        expected = surface_points(vertices, [[0, 1, 2, 3]], 5, 19)
        for face in ([1, 2, 3, 0], [3, 2, 1, 0], [2, 1, 0, 3]):
            self.assertEqual(expected, surface_points(vertices, [face], 5, 19))
        self.assertEqual(len(expected), 20)
        self.assertTrue(all(0 <= p[0] <= 2 and 0 <= p[1] <= 2 and p[2] == 0 for p in expected))

    def test_surface_sampling_stays_inside_concave_ngon(self) -> None:
        vertices = [(0, 0, 0), (3, 0, 0), (3, 3, 0), (2, 3, 0), (2, 1, 0), (1, 1, 0), (1, 3, 0), (0, 3, 0)]
        points = surface_points(vertices, [list(range(8))], 100, 19)
        self.assertEqual(len(points), 700)
        self.assertTrue(all(not (1 < p[0] < 2 and p[1] > 1) for p in points))
        self.assertEqual(points, surface_points(vertices, [list(reversed(range(8)))], 100, 19))

    def test_nature_masks_and_height(self) -> None:
        a = placements(41, 100, 4, 1)
        self.assertEqual(a, placements(41, 100, 4, 1))
        self.assertNotEqual(a, placements(42, 100, 4, 1))
        self.assertTrue(all(1 <= math.hypot(x, y) <= 4 for x, y, _, _ in a))
        self.assertTrue(set(placements(41, 100, 4, 1, 90)).issubset(set(a)))
        self.assertEqual(height_at(0, 0, 41), 0)
        self.assertEqual(height_at(1, 2, 41), height_at(1, 2, 41))
        self.assertNotEqual(height_at(1, 2, 41), height_at(1, 2, 42))

    def test_tree_layout_is_seeded_and_species_specific(self) -> None:
        a = tree_layout(41, 3.5, "birch")
        self.assertEqual(a, tree_layout(41, 3.5, "birch"))
        self.assertNotEqual(a, tree_layout(42, 3.5, "birch"))
        self.assertNotEqual(a["branches"], tree_layout(41, 3.5, "pine")["branches"])
        self.assertEqual(len(a["leaves"]), 2340)

    def test_catalogue_without_blender(self) -> None:
        self.assertNotIn("bpy", sys.modules)
        metas = catalogue()
        self.assertGreaterEqual(len(metas), 20)
        self.assertEqual(len({m["id"] for m in metas}), len(metas))
        for meta in metas:
            self.assertEqual(set(validate_params(meta, {})), set(meta["params"]))
        self.assertNotIn("bpy", sys.modules)

    def test_catalogue_is_data_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "evil.py"
            file.write_text('"""Intent of a harmless fixture."""\nraise RuntimeError("must not execute")\nMETA={"id":"evil","intent":"Intent of a harmless fixture.","params":{}}', encoding="utf8")
            self.assertEqual(catalogue(directory)[0]["id"], "evil")
            file.write_text('META = dict(id="evil")', encoding="utf8")
            with self.assertRaises(ValueError):
                catalogue(directory)

    def test_validation(self) -> None:
        meta = describe("confetti")
        for values in ({"typo": 1}, {"count": True}, {"count": 2.5}, {"count": 0}, {"count": math.inf}, {"seed": None}, []):
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_params(meta, values)
        with self.assertRaises(ValueError):
            describe("../../escape")

    def test_cache_hash_stable_and_sensitive(self) -> None:
        self.assertEqual(cache_hash("dust-burst", {"seed": 7, "count": 4}), cache_hash("dust-burst", {"count": 4, "seed": 7}))
        self.assertNotEqual(cache_hash("dust-burst", {"seed": 7}), cache_hash("dust-burst", {"seed": 8}))
        self.assertNotEqual(cache_hash("dust-burst", {}, {"fps": 30}), cache_hash("dust-burst", {}, {"fps": 60}))

    def test_cache_ignores_editorial_meta_but_tracks_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"AGENTBROS_REPO_ROOT": directory}):
            recipes = Path(directory) / "scripts/blender/recipes"
            recipes.mkdir(parents=True)
            file = recipes / "dust_burst.py"
            file.write_text('META={"status":"experimental"}\nx=1\n', encoding="utf8")
            first = cache_hash("dust-burst", {})
            file.write_text('META={"status":"ready","cost_hint":2.1}\nx=1\n', encoding="utf8")
            self.assertEqual(first, cache_hash("dust-burst", {}))
            file.write_text('META={"status":"ready"}\nx=2\n', encoding="utf8")
            self.assertNotEqual(first, cache_hash("dust-burst", {}))

    def test_bake_reuses_atomic_complete_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"AGENTBROS_REPO_ROOT": directory}):
            first = bake("dust-burst", {"seed": 8}, lambda: [[1, 2, 3]])
            second = bake("dust-burst", {"seed": 8}, lambda: self.fail("cache was not reused"))
            self.assertFalse(first["reused"])
            self.assertTrue(second["reused"])
            self.assertEqual(first["data"], second["data"])
            self.assertTrue(Path(first["path"]).is_relative_to(Path(directory).resolve() / "blender-arsenal/local/bakes"))
            self.assertFalse(list(Path(first["path"]).parent.glob("*.tmp")))
            with self.assertRaises(ValueError):
                bake("../escape", {}, list)

    def test_failed_bake_not_published(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"AGENTBROS_REPO_ROOT": directory}):

            def fail() -> None:
                error_message = "failed simulation"
                raise RuntimeError(error_message)

            with self.assertRaises(RuntimeError):
                bake("cloth-drape", {}, fail)
            self.assertFalse(list(Path(directory).rglob("bake.json")))

    def test_dust_reproducible_and_grounded(self) -> None:
        a = ballistic(4, 10, 64, 2)
        self.assertEqual(a, ballistic(4, 10, 64, 2))
        self.assertNotEqual(a, ballistic(5, 10, 64, 2))
        self.assertEqual(len(a), 64)
        self.assertTrue(all(len(frame) == 10 for frame in a))
        self.assertTrue(all(p[2] >= 0.03 and all(math.isfinite(v) for v in p) for frame in a for p in frame))
        self.assertGreater(a[20][0][2], a[0][0][2])

    def test_mesh_snapshot_weights_hold_across_shutter(self) -> None:
        def evaluate(keys: list[tuple[int, int]], frame: float) -> float:
            if frame <= keys[0][0]:
                return keys[0][1]
            for (a, va), (b, vb) in pairwise(keys):
                if frame <= b:
                    return va + (vb - va) * (frame - a) / (b - a)
            return keys[-1][1]

        keys = [snapshot_keys(i, 64) for i in range(64)]
        for frame in (0.8, 1, 1.5, 17.3, 63.9, 64, 64.2, 100):
            self.assertAlmostEqual(sum(evaluate(k, frame) for k in keys), 1)
        self.assertEqual(evaluate(keys[-1], 64.2), 1)
        self.assertEqual(evaluate(keys[0], 0.8), 1)

    def test_voronoi_cells_partition_cube(self) -> None:
        cells = voronoi_cells(19, 24)
        self.assertEqual(cells, voronoi_cells(19, 24))
        total = 0
        for vertices, faces, _site in cells:
            self.assertGreaterEqual(len(vertices), 4)
            edges = {}
            for face in faces:
                for a, b in zip(face, face[1:] + face[:1], strict=True):
                    # Clipping rounds cap coordinates; compare positions to 6 decimal places.
                    edge = tuple(sorted((tuple(round(c, 6) for c in vertices[a]), tuple(round(c, 6) for c in vertices[b]))))
                    edges[edge] = edges.get(edge, 0) + 1
                a = vertices[face[0]]
                for i in range(1, len(face) - 1):
                    b, c = vertices[face[i]], vertices[face[i + 1]]
                    total += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
            self.assertTrue(all(n == 2 for n in edges.values()))
        self.assertAlmostEqual(total, 1.6**3, places=5)


if __name__ == "__main__":
    unittest.main()
