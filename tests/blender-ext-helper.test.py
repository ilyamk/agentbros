# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Exercise the extension helper without a Blender process or candidate execution."""

import importlib.util
import json
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True


class Repositories(list[SimpleNamespace]):
    """Minimal Blender repository collection."""

    def new(self, **kwargs: str) -> SimpleNamespace:
        repo = SimpleNamespace(**kwargs)
        self.append(repo)
        return repo


class ExtensionHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.profile = Path(self.temporary.name).resolve()
        self.directory = self.profile / "extensions/user_default/avc_fixture"
        self.directory.mkdir(parents=True)
        self.manifest = self.directory / "blender_manifest.toml"
        self.manifest.write_text('version = "1.0.0"\nblender_version_min = "4.2.0"\n', encoding="utf8")
        self.loaded = []
        self.seeds = []
        self.repositories = Repositories([SimpleNamespace(module="remote_repo")])
        self.ops = SimpleNamespace(avc=SimpleNamespace())
        self.bpy = SimpleNamespace(
            context=SimpleNamespace(preferences=SimpleNamespace(extensions=SimpleNamespace(repos=self.repositories))),
            app=SimpleNamespace(version=(5, 2, 3), version_string="5.2.3"),
            ops=self.ops,
            utils=SimpleNamespace(user_resource=lambda resource: os.environ["BLENDER_USER_" + resource]),
            data=SimpleNamespace(node_groups={}),
        )
        self.addons = SimpleNamespace(enable=self.enable, check=lambda module: (False, module in self.loaded))
        environment = {
            "BLENDER_USER_RESOURCES": str(self.profile),
            "BLENDER_USER_CONFIG": str(self.profile / "config"),
            "BLENDER_USER_SCRIPTS": str(self.profile / "scripts"),
            "BLENDER_USER_EXTENSIONS": str(self.profile / "extensions"),
        }
        self.environment = patch.dict(os.environ, environment, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        modules = patch.dict(sys.modules, {"bpy": self.bpy, "addon_utils": self.addons, "mathutils": SimpleNamespace(noise=SimpleNamespace(seed_set=self.seeds.append))})
        modules.start()
        self.addCleanup(modules.stop)
        source = Path(__file__).resolve().parents[1] / "scripts/workers/blender/avc_extensions.py"
        spec = importlib.util.spec_from_file_location("fixture_avc_extensions", source)
        assert spec is not None
        assert spec.loader is not None
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)

    def enable(self, module: str, *, default_set: bool, persistent: bool) -> SimpleNamespace:
        self.assertTrue(default_set)
        self.assertTrue(persistent)
        self.loaded.append(module)
        self.ops.avc.fixture = lambda: None
        return SimpleNamespace()

    def test_enable_configures_only_local_repository_and_reports_version(self) -> None:
        result = self.helper.enable(["avc_fixture"], {"avc_fixture": "1.0.0"})
        self.assertEqual(result[0]["version"], "1.0.0")
        self.assertGreaterEqual(result[0]["enableMs"], 0)
        self.assertEqual([repo.module for repo in self.repositories], ["user_default"])
        self.assertFalse(self.repositories[0].use_remote_url)
        self.assertEqual(self.repositories[0].custom_directory, str(self.profile / "extensions/user_default"))

    def test_pin_and_blender_range_are_checked_before_registration(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "differs from approved"):
            self.helper.enable(["avc_fixture"], {"avc_fixture": "2.0.0"})
        self.manifest.write_text('version = "1.0.0"\nblender_version_min = "6.0.0"\n', encoding="utf8")
        with self.assertRaisesRegex(RuntimeError, "incompatible"):
            self.helper.enable(["avc_fixture"])
        self.assertEqual(self.loaded, [])

    def test_require_checks_enabled_state_and_minimum_version(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "not enabled"):
            self.helper.require("avc_fixture", "1.0.0")
        self.helper.enable(["avc_fixture"])
        self.helper.require("avc_fixture", "1.0.0")
        with self.assertRaisesRegex(RuntimeError, "needs >="):
            self.helper.require("avc_fixture", "1.1.0")

    def test_profile_mismatch_is_rejected_before_registration(self) -> None:
        os.environ["BLENDER_USER_CONFIG"] = str(self.profile.parent / "other-profile")
        with self.assertRaisesRegex(RuntimeError, "Non-isolated"):
            self.helper.enable(["avc_fixture"])
        self.assertEqual(self.loaded, [])

    def test_trial_smoke_records_added_operators_and_enable_timing(self) -> None:
        output = self.profile / "smoke.json"
        os.environ["AGENTBROS_EXTENSION_SMOKE_ID"] = "avc_fixture"
        os.environ["AGENTBROS_EXTENSION_SMOKE_RESULT"] = str(output)
        self.helper.main()
        report = json.loads(output.read_text(encoding="utf8"))
        self.assertTrue(report["enableOk"])
        self.assertIn("avc.fixture", report["operators"])
        self.assertEqual(report["nodeGroups"], [])

    def test_seeded_is_repeatable_and_restores_python_rng_even_on_error(self) -> None:
        original = random.getstate()
        with self.helper.seeded(42):
            first = [random.random() for _ in range(4)]  # noqa: S311 -- Exercise seeded animation RNG restoration.
        self.assertEqual(random.getstate(), original)
        with self.helper.seeded(42):
            self.assertEqual([random.random() for _ in range(4)], first)  # noqa: S311 -- Exercise seeded animation RNG restoration.
        with self.assertRaisesRegex(RuntimeError, "test"), self.helper.seeded(19):
            error_message = "test"
            raise RuntimeError(error_message)
        self.assertEqual(random.getstate(), original)
        self.assertEqual(self.seeds, [42, 42, 19])

    def test_seeded_rejects_time_seed_zero_and_invalid_seeds(self) -> None:
        for seed in (0, -1, True, 1.5, 2**31):
            with self.assertRaises(ValueError), self.helper.seeded(seed):
                self.fail("invalid seed admitted")
        self.assertEqual(self.seeds, [])

    def test_camera_wrapper_rejects_unknown_presets_and_invalid_intensity(self) -> None:
        with patch.object(self.helper, "require"):
            for preset, intensity in (("TYPO", 0.3), ("THE_CLOSEUP", float("nan")), ("THE_CLOSEUP", 1.1), ("THE_CLOSEUP", True)):
                with self.assertRaises(ValueError):
                    self.helper.camera_shake(SimpleNamespace(type="CAMERA"), preset, intensity)

    def test_saved_shake_dependency_requires_the_enabled_render_addon(self) -> None:
        self.bpy.context.scene = {"avc_required_extensions": '{"camera_shakify":"0.5.1"}'}
        with self.assertRaisesRegex(RuntimeError, "not enabled"):
            self.helper.require_render_extensions()

    def test_saved_scene_requires_exact_creation_version(self) -> None:
        self.helper.enable(["avc_fixture"])
        self.bpy.context.scene = {"avc_required_extensions": '{"avc_fixture":"0.9.0"}'}
        with self.assertRaisesRegex(RuntimeError, "rebuild against the new pin"):
            self.helper.require_render_extensions()


if __name__ == "__main__":
    unittest.main()
