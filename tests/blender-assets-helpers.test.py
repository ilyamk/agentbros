# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Offline tests of library path containment and ZIP extraction."""

import importlib.util
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

WORKERS = Path(__file__).resolve().parents[1] / "scripts/workers/blender"
sys.path.insert(0, str(WORKERS))
import avc_assets  # noqa: E402 -- Native module paths are established before these imports.

spec = importlib.util.spec_from_file_location("unpack", WORKERS / "avc_asset_unpack.py")
assert spec is not None
assert spec.loader is not None
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Helpers(unittest.TestCase):
    def test_traversal_and_symlink_rejected(self) -> None:
        for filename, symlink in [("../escape.png", False), ("linked.png", True), ("ASSET.JSON", False)]:
            with tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                archive = base / "bundle.zip"
                with zipfile.ZipFile(archive, "w") as bundle:
                    info = zipfile.ZipInfo(filename)
                    if symlink:
                        info.external_attr = 0o120777 << 16
                    bundle.writestr(info, "bad")
                with self.assertRaises(ValueError):
                    worker.unpack(archive, base / "output")
                self.assertFalse((base / "output").exists())

    def test_extract_only_inert_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with zipfile.ZipFile(base / "bundle.zip", "w") as bundle:
                bundle.writestr("wood/Color.png", "fixture")
                bundle.writestr("script.py", "never execute")
            self.assertEqual(worker.unpack(base / "bundle.zip", base / "out"), ["wood/Color.png"])

    def test_local_file_containment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with patch.object(avc_assets, "library_path", return_value=base):
                (base / "texture.png").write_text("fixture")
                self.assertEqual(avc_assets.local_file("texture.png"), (base / "texture.png").resolve())
                with self.assertRaises(ValueError):
                    avc_assets.local_file("../outside.png")


if __name__ == "__main__":
    unittest.main()
