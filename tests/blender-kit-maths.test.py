# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
r"""Check the pure motion mathematics shared by Blender and TypeScript.

Pure-Python properties of the Blender craft kit's motion maths (scripts/blender/kit/curves.py). Run by
tests/blender-kit.test.ts, which also compares the shared curves with src/motion/timing.ts.
"""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "blender"))
from kit import curves as c


class Curves(unittest.TestCase):
    def test_intents_start_at_0_end_at_1(self) -> None:
        for name in c.INTENTS:
            fn = c.curve(name)
            self.assertEqual(fn(0), 0.0, name)
            self.assertEqual(fn(1), 1.0, name)

    def test_punch_and_settle_pass_the_target_once(self) -> None:
        punch = max(c.curve("punch")(i / 200) for i in range(201))
        settle = max(c.curve("settle")(i / 200) for i in range(201))
        self.assertGreater(punch, 1.05)
        self.assertLess(punch, 1.15)
        self.assertGreater(settle, 1.02)
        self.assertLess(settle, 1.06)

    def test_track_holds_ends_and_eases_segments(self) -> None:
        keys = [(0, 0.0), (10, 1.0, "brake"), (20, 3.0, "snap")]
        self.assertEqual(c.track(-5, keys), 0.0)
        self.assertEqual(c.track(25, keys), 3.0)
        self.assertGreater(c.track(5, keys), 0.5)  # brake front-loads
        self.assertAlmostEqual(c.track(15, keys), 2.0, places=6)  # snap is symmetric
        with self.assertRaises(ValueError):
            c.track(0, [(0, 0), (0, 1)])


class Springs(unittest.TestCase):
    def test_spring_step_rises_on_time_and_overshoots_as_asked(self) -> None:
        rise = 0.25
        self.assertAlmostEqual(c.spring_step(rise, 0.08, rise), 1.0, places=6)
        peak = max(c.spring_step(i / 600, 0.08, rise) for i in range(600))
        self.assertAlmostEqual(peak, 1.08, places=3)
        self.assertAlmostEqual(c.spring_step(3.0, 0.08, rise), 1.0, places=3)
        self.assertEqual(c.spring_step(0, 0.08, rise), 0.0)

    def test_anticipation_winds_back_then_lands_with_overshoot(self) -> None:
        values = [c.anticipate(f, 10, wind=6, action=7, amount=0.12, overshoot=0.08) for f in range(80)]
        self.assertEqual(values[10], 0.0)
        self.assertAlmostEqual(min(values), -0.12, places=6)
        self.assertGreater(max(values), 1.05)
        self.assertAlmostEqual(values[-1], 1.0, places=2)
        # Continuous: no jump above the move's own speed at the wind-up / action joint.
        self.assertLess(abs(values[17] - values[16]), 0.2)

    def test_follow_through_peaks_at_amplitude(self) -> None:
        peak = max(c.follow_through(f / 10, 0, amplitude=5) for f in range(1, 300))
        self.assertAlmostEqual(peak, 5.0, delta=0.05)
        self.assertEqual(c.follow_through(0, 0, amplitude=5), 0.0)

    def test_smoothed_lags_and_converges(self) -> None:
        step = lambda f: 0.0 if f < 10 else 1.0  # noqa: E731
        self.assertLess(c.smoothed(step, 12, half_life=3), 0.6)
        self.assertGreater(c.smoothed(step, 60, half_life=3), 0.999)
        # A frame alone equals the same frame in a run.
        self.assertEqual(c.smoothed(step, 20, half_life=3), [c.smoothed(step, f, half_life=3) for f in range(30)][20])


class SquashAndStretch(unittest.TestCase):
    def test_volume_is_preserved(self) -> None:
        for s in (0.6, 0.84, 1.0, 1.2, 1.4):
            sx, sy, sz = c.volume_scale(s)
            self.assertAlmostEqual(sx * sy * sz, 1.0, places=9)

    def test_hop_crouches_flies_lands_and_settles(self) -> None:
        frames = [c.hop(f, 10, crouch=7, air=13, height=0.3) for f in range(70)]
        lifts = [lift for lift, _ in frames]
        stretch = [s for _, s in frames]
        self.assertEqual(lifts[10], 0.0)
        self.assertLess(stretch[17], 0.9)  # crouched before take-off
        apex = max(range(70), key=lambda f: lifts[f])
        self.assertAlmostEqual(lifts[apex], 0.3, delta=0.01)
        self.assertGreater(max(stretch[18:30]), 1.08)  # stretched in flight
        self.assertLess(stretch[30], 0.85)  # squashed on contact
        self.assertAlmostEqual(stretch[-1], 1.0, delta=0.01)  # settled
        self.assertTrue(all(lift >= 0 for lift in lifts))

    def test_bounces_get_smaller(self) -> None:
        lifts = [c.bounces(f, 0, count=3, height=0.2)[0] for f in range(80)]
        self.assertAlmostEqual(max(lifts), 0.2, delta=0.01)
        self.assertGreater(max(lifts[25:]), 0.0)
        self.assertLess(max(lifts[25:]), 0.15)


class Noise(unittest.TestCase):
    def test_seeded_noise_is_stable_and_bounded(self) -> None:
        a = [c.noise(i * 0.37, "s") for i in range(200)]
        self.assertEqual(a, [c.noise(i * 0.37, "s") for i in range(200)])
        self.assertNotEqual(a, [c.noise(i * 0.37, "t") for i in range(200)])
        self.assertTrue(all(-1 <= v <= 1 for v in a))
        self.assertEqual(c.rand("x", 3), c.rand("x", 3))

    def test_handheld_stays_in_its_band(self) -> None:
        """Energy below 0.4 Hz or above 4 Hz is near zero: a DFT over 20 s at 30 fps."""
        n, fps = 600, 30
        samples = [c.band_noise(i / fps, "cam", 0.6, 2.5) for i in range(n)]

        def power(freq: float) -> float:
            re = sum(v * math.cos(2 * math.pi * freq * i / fps) for i, v in enumerate(samples))
            im = sum(v * math.sin(2 * math.pi * freq * i / fps) for i, v in enumerate(samples))
            return (re * re + im * im) / n

        inside = max(power(f / 20) for f in range(12, 51))
        outside = max(power(f / 20) for f in list(range(1, 6)) + list(range(90, 200, 5)))
        self.assertGreater(inside, outside * 20)
        (pitch, yaw, roll), move = c.handheld(17, seed=3)
        self.assertLess(max(abs(pitch), abs(yaw), abs(roll)), 1.0)
        self.assertLess(max(abs(v) for v in move), 0.01)

    def test_flicker_stays_in_depth(self) -> None:
        values = [c.flicker(f, seed=2, depth=0.3) for f in range(300)]
        self.assertGreaterEqual(min(values), 0.7 - 1e-9)
        self.assertLessEqual(max(values), 1.0)


class Character(unittest.TestCase):
    def test_blink_closes_fast_and_opens_slower(self) -> None:
        lids = [c.blink(f, 10, close=2, hold=1, open_=4) for f in range(20)]
        self.assertEqual(lids[10], 1.0)
        self.assertEqual(lids[12], 0.0)
        self.assertEqual(lids[13], 0.0)
        self.assertEqual(lids[17], 1.0)
        self.assertGreater(lids[15], 0.5)  # brake: most of the opening early


class Framing(unittest.TestCase):
    def test_fit_distance_frames_the_subject(self) -> None:
        d = c.fit_distance(50, 0.3, 0.3, 1920, 1080, fill=0.5)
        _w, h = c.frame_size(50, d, 1920, 1080)
        self.assertAlmostEqual(0.3 / h, 0.5, places=6)
        dv = c.fit_distance(50, 0.3, 0.3, 1080, 1920, fill=0.5)
        wv, _ = c.frame_size(50, dv, 1080, 1920)
        self.assertAlmostEqual(0.3 / wv, 0.5, places=6)

    def test_safe_rect_matches_tokens(self) -> None:
        _left, top, _right, bottom = c.safe_rect("vertical")
        self.assertAlmostEqual(top, 200 / 1920)
        self.assertAlmostEqual(bottom, 1 - 300 / 1920)
        self.assertEqual(c.safe_excess((0.1, 0.2, 0.9, 0.8), "vertical"), {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0})
        self.assertGreater(c.safe_excess((0.0, 0.0, 1.0, 1.0), "vertical")["bottom"], 0.1)

    def test_kelvin(self) -> None:
        warm, cool = c.kelvin_rgb(3200), c.kelvin_rgb(9000)
        self.assertGreater(warm[0], warm[2])
        self.assertGreater(cool[2], cool[0])
        self.assertEqual(max(c.kelvin_rgb(6500)), 1.0)


if __name__ == "__main__":
    unittest.main()
