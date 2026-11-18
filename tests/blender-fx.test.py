# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
# ruff: noqa: E402
"""Exercise frame remapping and payload validation with dependency-free stdlib unittest."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts/blender/recipes"), str(ROOT / "scripts/workers/blender")]
from _fluid import remap_frame, valid_receipt
from avc_recipes import validate_generators


class FluidMathsTests(unittest.TestCase):
    """Protect editorial continuity and cache completeness independently of bpy."""

    def test_freeze_continuity_and_order(self) -> None:
        """Keep remapping continuous, monotone and independent of call order."""
        self.assertEqual(remap_frame(18), 18)
        self.assertAlmostEqual(remap_frame(30), 19.44)
        self.assertAlmostEqual(remap_frame(30 + 1e-7), 19.44 + 1e-7)
        values = [remap_frame(f / 10) for f in range(640)]
        self.assertEqual(values, sorted(values))
        self.assertEqual(remap_frame(24), remap_frame(24))
        self.assertAlmostEqual(remap_frame(18 + 1e-7), 18 + 0.12e-7)

    def test_generator_admission(self) -> None:
        """Enforce native build pins, procedural hashes and approval at execution time."""
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"AGENTBROS_REPO_ROOT": temporary}):
            directory = Path(temporary)
            source = directory / "scripts/blender/materials/__init__.py"
            source.parent.mkdir(parents=True)
            source.write_text("fixture = 1\n")
            manifest = json.loads((ROOT / "blender-arsenal/generators.json").read_text())
            procedural = next(entry for entry in manifest["generators"] if entry["id"] == "procedural-materials")
            procedural["install"]["sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
            file = directory / "blender-arsenal/generators.json"
            file.parent.mkdir(parents=True)
            file.write_text(json.dumps(manifest))
            meta = {"requires": {"generators": ["mantaflow", "procedural-materials"]}}
            validate_generators(meta, "5.3.0", "02f0899d78e3")
            with self.assertRaisesRegex(ValueError, "build"):
                validate_generators(meta, "5.3.0", "000000000000")
            with self.assertRaisesRegex(ValueError, "Blender"):
                validate_generators(meta, "5.2.0", "02f0899d78e3")
            source.write_text("fixture = 2\n")
            with self.assertRaisesRegex(ValueError, "SHA256"):
                validate_generators(meta, "5.3.0", "02f0899d78e3")
            procedural["status"] = "proposed"
            file.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "approved generator"):
                validate_generators(meta, "5.3.0", "02f0899d78e3")

    def test_incomplete_and_corrupt_payloads(self) -> None:
        """Reject empty receipts, traversal and changed bytes before reusing simulation output."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            file = directory / "meshes.blend"
            file.write_bytes(b"fixture")
            receipt = {"files": {file.name: hashlib.sha256(file.read_bytes()).hexdigest()}}
            self.assertTrue(valid_receipt(directory, json.loads(json.dumps(receipt))))
            self.assertFalse(valid_receipt(directory, {"files": {}}))
            self.assertFalse(valid_receipt(directory, {"files": {"../meshes.blend": "fake"}}))
            file.write_bytes(b"corrupt")
            self.assertFalse(valid_receipt(directory, receipt))
            file.unlink()
            other = directory / "other.blend"
            other.write_bytes(b"fixture")
            file.symlink_to(other)
            self.assertFalse(valid_receipt(directory, receipt))
            file.unlink()
            self.assertFalse(valid_receipt(directory, receipt))


if __name__ == "__main__":
    unittest.main()
