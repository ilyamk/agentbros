"""Camera moves with fitted easing, and animation cadence, for the motion layer of reference-analysis.py.

Loaded by path from reference-analysis.py, never run on its own. Translated from ReelMimic's
.claude/skills/video-clone/scripts/perception/curves.py, camera.py (estimate, photometric_ok) and fingerprint.py
(held_frames, spread_over_holds, cadence).

MIT License

Copyright (c) 2026 ReelMimic contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.optimize import least_squares
from scipy.signal import find_peaks

MIN_TRACKS = 12
FB_MAX_ERR = 1.0
RANSAC_PX = 1.0
MIN_INLIER_RATIO = 0.3
PHOTO_MAX_ERR = 0.06
PHOTO_GAIN = 0.75
LK_WINDOW = (21, 21)
LK_LEVELS = 3
LK_CRITERIA = (3, 30, 0.01)


def camera_step(previous: np.ndarray, current: np.ndarray, mask: np.ndarray | None) -> tuple[float, float, float, float, bool]:
    """Camera motion between two grey frames, in camera terms: x and y in frame widths, log scale, roll in radians.

    Shi-Tomasi corners, pyramidal Lucas-Kanade with a forward-backward check, then a RANSAC similarity about the centre.
    Dense flow underestimated a known 25 % push by a third at this size; tracks measured it within 1 %.
    """
    import cv2

    height, width = current.shape
    points = cv2.goodFeaturesToTrack(previous, maxCorners=400, qualityLevel=0.001, minDistance=3, blockSize=3, mask=mask)
    if points is None or len(points) < MIN_TRACKS:
        return 0.0, 0.0, 0.0, 0.0, False
    forward, status_forward, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, np.empty_like(points), winSize=LK_WINDOW, maxLevel=LK_LEVELS, criteria=LK_CRITERIA)
    back, status_back, _ = cv2.calcOpticalFlowPyrLK(current, previous, forward, np.empty_like(forward), winSize=LK_WINDOW, maxLevel=LK_LEVELS, criteria=LK_CRITERIA)
    good = (status_forward.ravel() == 1) & (status_back.ravel() == 1) & (np.linalg.norm((points - back).reshape(-1, 2), axis=1) < FB_MAX_ERR)
    if good.sum() < MIN_TRACKS:
        return 0.0, 0.0, 0.0, 0.0, False
    centre = np.array([width / 2, height / 2], np.float32)
    before, after = points.reshape(-1, 2)[good] - centre, forward.reshape(-1, 2)[good] - centre
    matrix, inliers = cv2.estimateAffinePartial2D(before, after, method=cv2.RANSAC, ransacReprojThreshold=RANSAC_PX, maxIters=2000, confidence=0.995)
    if matrix is None or inliers is None or inliers.mean() < MIN_INLIER_RATIO or not photometric_ok(previous, current, matrix, centre):
        return 0.0, 0.0, 0.0, 0.0, False
    a, b, tx, ty = matrix[0, 0], matrix[1, 0], matrix[0, 2], matrix[1, 2]
    return float(-tx / width), float(-ty / width), float(np.log(np.hypot(a, b))), float(-np.arctan2(b, a)), True


def photometric_ok(previous: np.ndarray, current: np.ndarray, matrix: np.ndarray, centre: np.ndarray) -> bool:
    """Warping the previous frame by the fit must explain the current one clearly better than standing still."""
    import cv2

    height, width = current.shape
    linear = matrix[:, :2]
    full = np.hstack([linear, (matrix[:, 2] + centre - linear @ centre)[:, None]]).astype(np.float32)
    warped = cv2.warpAffine(previous, full, (width, height), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    inner = (slice(height // 10, height - height // 10), slice(width // 10, width - width // 10))
    warp_error = float(np.asarray(cv2.absdiff(warped[inner], current[inner]), dtype=np.float64).mean()) / 255
    still_error = float(np.asarray(cv2.absdiff(previous[inner], current[inner]), dtype=np.float64).mean()) / 255
    return warp_error <= max(PHOTO_MAX_ERR, PHOTO_GAIN * still_error)


PROGRESS_SAMPLES = 21
Ease = Callable[[np.ndarray], np.ndarray]


def _power(p: float) -> dict[str, Ease]:
    return {
        "in": lambda t: t**p,
        "out": lambda t: 1 - (1 - t) ** p,
        "inOut": lambda t: np.where(t < 0.5, (2 * t) ** p / 2, 1 - (2 * (1 - t)) ** p / 2),
    }


def _named() -> dict[str, Ease]:
    """GSAP's ease formulas, so a fitted name is what a builder types."""
    out: dict[str, Ease] = {"none": lambda t: t}
    for n in (1, 2, 3, 4):
        for kind, ease in _power(n + 1).items():
            out[f"power{n}.{kind}"] = ease
    out.update(
        {
            "sine.in": lambda t: 1 - np.cos(t * np.pi / 2),
            "sine.out": lambda t: np.sin(t * np.pi / 2),
            "sine.inOut": lambda t: -(np.cos(np.pi * t) - 1) / 2,
            "expo.in": lambda t: np.where(t <= 0, 0.0, 2.0 ** (10 * (t - 1))),
            "expo.out": lambda t: np.where(t >= 1, 1.0, 1 - 2.0 ** (-10 * t)),
            "expo.inOut": lambda t: np.where(t < 0.5, 2.0 ** (20 * t - 10) / 2, (2 - 2.0 ** (-20 * t + 10)) / 2),
            "circ.in": lambda t: 1 - np.sqrt(np.clip(1 - t**2, 0, 1)),
            "circ.out": lambda t: np.sqrt(np.clip(1 - (t - 1) ** 2, 0, 1)),
            "back.out": lambda t: 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
            "back.in": lambda t: 2.70158 * t**3 - 1.70158 * t**2,
        }
    )
    return out


NAMED = _named()


def bezier(u: np.ndarray, x1: float, y1: float, x2: float, y2: float) -> np.ndarray:
    """CSS cubic-bezier evaluated at progress u, solving x(s) = u by bisection."""
    u = np.clip(np.asarray(u, float), 0, 1)
    lo, hi = np.zeros_like(u), np.ones_like(u)
    for _ in range(30):
        s = (lo + hi) / 2
        x = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s**2 * x2 + s**3
        lo, hi = np.where(x < u, s, lo), np.where(x < u, hi, s)
    s = (lo + hi) / 2
    return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s**2 * y2 + s**3


BEZIER_STARTS = [(0.25, 0.1, 0.25, 1.0), (0.42, 0.0, 0.58, 1.0), (0.16, 1.0, 0.3, 1.0), (0.34, 1.56, 0.64, 1.0)]


def spring(tau: np.ndarray, omega: float, zeta: float) -> np.ndarray:
    """Unit step response of a damped oscillator tau seconds after it starts."""
    zeta = min(zeta, 0.999)
    tau = np.clip(tau, 0, None)
    damped = omega * np.sqrt(1 - zeta**2)
    return 1 - np.exp(-zeta * omega * tau) * (np.cos(damped * tau) + zeta * omega / damped * np.sin(damped * tau))


def initial_timing(t: np.ndarray, x: np.ndarray) -> tuple[float, float, float, float]:
    """Start, length, amount and offset from where the trajectory crosses 2 % and 98 % of its net travel."""
    offset, amount = float(x[0]), float(x[-1] - x[0])
    progress = (x - offset) / amount
    first = int(np.argmax(progress >= 0.02))
    last = int(np.argmax(progress >= 0.98)) if (progress >= 0.98).any() else len(x) - 1
    dt = float(t[1] - t[0])
    return float(t[first]) - dt, max(2 * dt, float(t[last] - t[first]) / 0.96), amount, offset


def fit_timed(t: np.ndarray, x: np.ndarray, shape: Callable, shape_start: tuple, shape_bounds: tuple[tuple, tuple], start: tuple) -> tuple[np.ndarray, float]:  # noqa: PLR0913, PLR0917 -- Retain the established positional worker/helper interface.
    """Least squares for x(t) = B + A·shape(clip((t - t0)/D, 0, 1)): start, length, amount and curve together."""
    t0, length, amount, offset = start
    span, dt, scale = float(t[-1] - t[0]), float(t[1] - t[0]), abs(amount) or 1.0
    k = len(shape_start)

    def residual(p: np.ndarray) -> np.ndarray:
        u = np.clip((t - p[k]) / p[k + 1], 0, 1)
        return (p[k + 3] + p[k + 2] * shape(u, *p[:k]) - x) / scale

    lower = [*shape_bounds[0], t[0] - span, dt, -np.inf, -np.inf]
    upper = [*shape_bounds[1], t[-1], 2 * span + dt, np.inf, np.inf]
    initial = np.clip([*shape_start, t0, length, amount, offset], np.array(lower) + 1e-9, np.array(upper) - 1e-9)
    result = least_squares(residual, initial, bounds=(lower, upper), x_scale="jac")
    return result.x, float(np.sqrt(np.mean(result.fun**2)))


def fit_named(t: np.ndarray, x: np.ndarray, start: tuple) -> tuple[str, np.ndarray, float]:
    """Fit the nearest GSAP ease.

    A fit that starts inside the shot is preferred when nearly as close: an inOut begun seconds before the cut looks
    like an out ease on screen, and the out ease is what a builder can use.
    """
    fits = [(name, *fit_timed(t, x, lambda u, ease=ease: ease(u), (), ((), ()), start)) for name, ease in NAMED.items()]
    best = min(fits, key=lambda row: row[2])
    inside = [row for row in fits if row[1][0] >= t[0] - 2 * (t[1] - t[0])]
    preferred = min(inside, key=lambda row: row[2]) if inside else best
    return preferred if preferred[2] <= 1.25 * best[2] + 0.002 else best


def fit_bezier(t: np.ndarray, x: np.ndarray, start: tuple) -> tuple[np.ndarray, float]:
    """Fit cubic Bezier controls to the measured progress samples."""
    best: tuple[np.ndarray, float] = (np.asarray([0.0, 0.0, 1.0, 1.0, *start]), float("inf"))
    for shape_start in BEZIER_STARTS:
        params, error = fit_timed(t, x, bezier, shape_start, ((0, -1, 0, -1), (1, 2, 1, 2)), start)
        if error < best[1]:
            best = (params, error)
    return best


def fit_spring(t: np.ndarray, x: np.ndarray, start: tuple) -> tuple[dict[str, float], float]:
    """Fit damped spring parameters to measured motion."""
    t0, length, amount, offset = start
    scale = abs(amount) or 1.0
    best: tuple[dict[str, float], float] = ({}, float("inf"))
    for omega0, zeta0 in [(6.0, 0.9), (10.0, 0.5), (16.0, 0.3)]:
        initial = [np.clip(t0, t[0] - 1 + 1e-6, t[-1] - 1e-6), amount, offset, np.clip(omega0 / max(length, 0.05), 0.6, 199), zeta0]
        result = least_squares(lambda p: (p[2] + p[1] * spring(t - p[0], p[3], p[4]) - x) / scale, initial, bounds=([t[0] - 1, -np.inf, -np.inf, 0.5, 0.05], [t[-1], np.inf, np.inf, 200, 0.999]))
        error = float(np.sqrt(np.mean(result.fun**2)))
        if error < best[1]:
            omega, zeta = float(result.x[3]), float(result.x[4])
            best = ({"omega": omega, "zeta": zeta, "start": float(result.x[0]), "settle": 4 / (zeta * omega), "amount": float(result.x[1]), "offset": float(result.x[2])}, error)
    return best


AXES = ("x", "y", "z", "r")
KIND = {"x": ("move_right", "move_left"), "y": ("move_down", "move_up"), "z": ("push_in", "pull_out"), "r": ("roll_cw", "roll_ccw")}
MIN_AMOUNT = {"x": 0.015, "y": 0.015, "z": 0.015, "r": 0.015}
SHAKE_RATE = 1.5
SNAP_SEC = 2.5 / 24
STILL_SEC, PAD_SEC, MIN_MOVE_SEC = 0.25, 0.125, 0.2


def canonical_progress(t: np.ndarray, x: np.ndarray, lo: float = 0.05, hi: float = 0.95) -> tuple[float, float, np.ndarray]:
    """Times the travel first reaches lo and hi of its net amount, and the curve between them rescaled to 0-1."""
    progress = (x - x[0]) / ((x[-1] - x[0]) or 1.0)

    def cross(level: float) -> float:
        index = int(np.argmax(progress >= level))
        if index == 0:
            return float(t[0])
        if progress[index] == progress[index - 1]:
            return float(t[index])
        return float(np.interp(level, [progress[index - 1], progress[index]], [t[index - 1], t[index]]))

    t5, t95 = cross(lo), cross(hi)
    if t95 <= t5:
        t95 = t5 + float(t[1] - t[0])
    u = np.linspace(0, 1, PROGRESS_SAMPLES)
    return t5, t95, (np.interp(t5 + u * (t95 - t5), t, progress) - lo) / (hi - lo)


def css_bezier(points: list[float]) -> str:
    """Evaluate a CSS cubic Bezier easing curve."""
    return f"cubic-bezier({', '.join(f'{value:g}' for value in points)})"


def describe_move(t: np.ndarray, trajectory: dict[str, np.ndarray]) -> dict[str, Any]:
    """One move: its kind, travel per axis and, on its main axis, the timed ease fit. Trajectories start at 0."""
    amount = {axis: float(trajectory[axis][-1] - trajectory[axis][0]) for axis in AXES}
    swing = {axis: float(np.ptp(trajectory[axis])) for axis in AXES}
    kinds = [KIND[axis][0 if amount[axis] > 0 else 1] for axis in AXES if abs(amount[axis]) >= MIN_AMOUNT[axis]]
    out: dict[str, Any] = {"kind": kinds or ["static"], "amount": {axis: round(amount[axis], 4) for axis in AXES}}
    axis = max(AXES, key=lambda name: swing[name])
    if swing[axis] < MIN_AMOUNT[axis] or len(t) < 6:
        return out
    # Turning back on itself quickly, by a third of its swing, is a shake rather than a move to somewhere.
    turns = sum(len(find_peaks(sign * trajectory[axis], prominence=swing[axis] / 3)[0]) for sign in (1, -1))
    rate = turns / max(1e-6, float(t[-1] - t[0]))
    if (turns >= 2 or abs(amount[axis]) < 0.2 * swing[axis]) and rate >= SHAKE_RATE:
        out["kind"] = [*kinds, "shake"]
        out["shake"] = {"axis": axis, "swing": round(swing[axis], 4)}
        return out
    # Engines tween scale, not its logarithm: the ease is fitted on the scale itself, so "power3.out" means what it says.
    x = np.exp(trajectory[axis]) if axis == "z" else trajectory[axis]
    start = initial_timing(t, x)
    name, named, error_named = fit_named(t, x, start)
    curve, error_bezier = fit_bezier(t, x, tuple(named[-4:]))
    oscillator, error_spring = fit_spring(t, x, tuple(named[-4:]))
    t0, length, travel, offset = (float(value) for value in named[-4:])
    best = min((("gsap", error_named), ("bezier", error_bezier), ("spring", error_spring)), key=lambda row: row[1])[0]
    # A GSAP name, when it fits nearly as well as the best, is easier to read and to tweak.
    pick = "gsap" if error_named <= 1.1 * min(error_named, error_bezier, error_spring) + 0.002 else best
    timing = {"gsap": (t0, length), "bezier": (float(curve[4]), float(curve[5])), "spring": (oscillator.get("start", t0), oscillator.get("settle", length))}
    move_start, move_length = timing[pick]
    fine = np.linspace(t[0], t[-1], 10 * len(t))
    if pick == "gsap":
        modelled = offset + travel * NAMED[name](np.clip((fine - t0) / length, 0, 1))
    elif pick == "bezier":
        modelled = curve[7] + curve[6] * bezier(np.clip((fine - curve[4]) / curve[5], 0, 1), *curve[:4])
    else:
        modelled = oscillator["offset"] + oscillator["amount"] * spring(fine - oscillator["start"], oscillator["omega"], oscillator["zeta"])
    t5, t95, progress = canonical_progress(fine, modelled)
    after = (x[t >= t0] - offset) / travel
    speed = np.abs(np.gradient(x, t))
    end = min(move_start + move_length, float(t[-1]))
    omega, zeta = oscillator.get("omega", 0.0), oscillator.get("zeta", 0.0)
    out.update(
        {
            "axis": axis,
            "snap": t95 - t5 <= SNAP_SEC,
            "startSec": round(max(move_start, float(t[0])), 3),
            "endSec": round(end, 3),
            "durationSec": round(move_length, 3),
            "span90Sec": round(t95 - t5, 3),
            "t5Sec": round(t5, 3),
            "t95Sec": round(t95, 3),
            "holdBeforeSec": round(max(0.0, move_start - float(t[0])), 3),
            "holdAfterSec": round(max(0.0, float(t[-1]) - move_start - move_length), 3),
            "peakSpeed": round(float(speed.max()), 4),
            "cutOff": bool(move_start + move_length > float(t[-1]) + float(t[1] - t[0])),
            "leadInSec": round(max(0.0, float(t[0]) - move_start), 3),
            "ease": {
                "gsap": name,
                "gsapRmse": round(error_named, 4),
                "cubicBezier": [round(float(value), 3) for value in curve[:4]],
                "css": css_bezier([round(float(value), 3) for value in curve[:4]]),
                "bezierRmse": round(error_bezier, 4),
                "spring": {
                    "omega": round(omega, 2),
                    "zeta": round(zeta, 3),
                    "settleSec": round(oscillator.get("settle", 0.0), 3),
                    "remotion": {"mass": 1, "stiffness": round(omega**2, 1), "damping": round(2 * zeta * omega, 2)},
                },
                "springRmse": round(error_spring, 4),
                "best": best,
                "pick": pick,
                "overshoot": round(max(0.0, float(after.max()) - 1) if len(after) else 0.0, 4),
            },
            "progress": [round(float(value), 4) for value in progress],
        }
    )
    return out


def moving_segments(t: np.ndarray, trajectory: dict[str, np.ndarray]) -> list[tuple[int, int]]:
    """Index ranges where the camera moves, split where it stays still for at least STILL_SEC."""
    if len(t) < 4:
        return []
    dt = float(t[1] - t[0])
    min_still, pad, min_length = max(1, round(STILL_SEC / dt)), max(1, round(PAD_SEC / dt)), max(2, round(MIN_MOVE_SEC / dt))
    speed = gaussian_filter1d(np.sqrt(sum(np.gradient(trajectory[axis], t) ** 2 for axis in AXES)), 0.0625 / dt)
    active = speed > max(0.12 * float(speed.max()), 0.02)
    segments, k, n = [], 0, len(t)
    while k < n:
        if not active[k]:
            k += 1
            continue
        e = k
        while e + 1 < n and (active[e + 1] or active[e + 2 : e + 1 + min_still].any()):
            e += 1
        segments.append((max(0, k - pad), min(n - 1, e + pad)))
        k = e + 1
    return [(a, b) for a, b in segments if b - a >= min_length and max(np.ptp(trajectory[axis][a : b + 1]) for axis in AXES) >= min(MIN_AMOUNT.values())]


def describe_shot(t: np.ndarray, trajectory: dict[str, np.ndarray]) -> dict[str, Any]:
    """The shot's camera as a whole plus each separate move; the top-level ease and timing are the biggest move's.

    Travel no move accounts for is a drift: a slow push or pan under the whole shot, its rate taken from outside the moves.
    """
    whole = describe_move(t, trajectory)
    if "axis" not in whole:
        net = {axis: float(whole["amount"][axis]) for axis in AXES if abs(whole["amount"][axis]) >= MIN_AMOUNT[axis]}
        if "shake" in whole["kind"] and net:
            whole["drift"] = {axis: round(value, 4) for axis, value in net.items()}
        return {**whole, "moves": 0 if whole["kind"] == ["static"] else 1}
    moves: list[tuple[dict[str, Any], float]] = []
    for a, b in moving_segments(t, trajectory):
        part = describe_move(t[a : b + 1], {axis: trajectory[axis][a : b + 1] - trajectory[axis][a] for axis in AXES})
        if "axis" in part:
            if a > 0:
                part["leadInSec"] = 0.0
            if b < len(t) - 1:
                part["cutOff"] = False
            moves.append((part, float(t[b] - t[a])))
    total = float(t[-1] - t[0])
    moving = sum(duration for _, duration in moves)
    residual = {axis: float(whole["amount"][axis]) - sum(move["amount"][axis] for move, _ in moves) for axis in AXES}
    drift = {axis: value for axis, value in residual.items() if abs(value) >= MIN_AMOUNT[axis]} if moves and total - moving > 0.25 * total else {}
    if len(moves) <= 1 and not drift:
        return {**whole, "moves": 1}
    rate = {axis: value / max(1e-6, total - moving) for axis, value in drift.items()}
    for move, duration in moves:
        move["amount"] = {axis: round(move["amount"][axis] - rate.get(axis, 0.0) * duration, 4) for axis in AXES}
    parts = [move for move, _ in moves]
    main = max(parts, key=lambda move: abs(move["amount"][move["axis"]]) / MIN_AMOUNT[move["axis"]])
    keys = ("kind", "axis", "startSec", "durationSec", "amount")
    others = [{**{key: move[key] for key in keys}, "ease": move["ease"]["gsap"]} for move in parts if move is not main]
    out = {**main, "kind": whole["kind"], "amount": whole["amount"], "moveAmount": main["amount"], "moves": len(parts), "otherMoves": others}
    if drift:
        out["drift"] = {axis: round(value * total, 4) for axis, value in rate.items()}
    return out


HOLD_DIFF = 0.004
MAX_HOLD = 3


def held_frames(diff: np.ndarray, cut_frames: list[int]) -> np.ndarray:
    """Frames repeating the previous drawing inside motion: runs of at most MAX_HOLD still frames with real change both sides."""
    still = diff < HOLD_DIFF
    moved = ~still
    moved[0] = False
    cuts = set(cut_frames)
    for frame in cuts:
        if 0 <= frame < len(moved):
            moved[frame] = False
    hold, n, k = np.zeros_like(still), len(diff), 1
    while k < n:
        if not still[k] or k in cuts:
            k += 1
            continue
        e = k
        while e + 1 < n and still[e + 1] and e + 1 not in cuts:
            e += 1
        if e - k + 1 <= MAX_HOLD and moved[k - 1] and e + 1 < n and moved[e + 1]:
            hold[k : e + 1] = True
        k = e + 1
    return hold


def spread_over_holds(delta: np.ndarray, hold: np.ndarray) -> np.ndarray:
    """Per-frame motion with each held run sharing the step that ends it; the trajectory itself is unchanged."""
    out, n, k = delta.copy(), len(delta), 1
    while k < n:
        if not hold[k]:
            k += 1
            continue
        e = k
        while e + 1 < n and hold[e + 1]:
            e += 1
        if e + 1 < n:
            out[k : e + 2] = delta[k : e + 2].sum() / (e + 2 - k)
        k = e + 2
    return out


def cadence(diff: np.ndarray, hold: np.ndarray, cut_frames: list[int], fps: float) -> dict[str, Any]:
    """New drawings per second while things move: on ones, on twos, on threes."""
    moving = gaussian_filter1d(diff, 2.0) > 0.008
    for frame in cut_frames:
        if 0 <= frame < len(moving):
            moving[frame] = False
    if moving.sum() < fps / 2:
        return {"movingFrames": int(moving.sum())}
    ratio = float(hold[moving].mean())
    per = 1 / max(1e-6, 1 - ratio)
    label = "on ones" if per < 1.25 else "mixed ones and twos" if per < 1.75 else "on twos" if per < 2.5 else "on threes"
    return {"movingFrames": int(moving.sum()), "heldShare": round(ratio, 3), "framesPerDrawing": round(per, 2), "drawingsPerSecond": round(fps / per, 1), "label": label}
