"""Measured layers of a reference video. Prints one JSON object on stdout.

Usage: reference-analysis.py shots MEDIA
       reference-analysis.py motion MEDIA REQUEST.json
       reference-analysis.py audio MEDIA

Run through uvx by src/lib/reference/worker.ts, which pins the packages.
"""

from __future__ import annotations

import json
import sys
from importlib.metadata import version
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from collections.abc import Callable

SMALL = (128, 72)
GRID = (16, 9)
CHANGE_LEVEL = 20

# Tuned on hand-labelled boundaries of the nine inbox films: see docs/reference-analysis.md.
PARAMS: dict[str, float] = {
    "adaptiveThreshold": 3.0,
    "spikeMinChanged": 0.12,
    "spikeRatio": 3.0,
    "flashMaxReturn": 0.35,
    "shortWindowSec": 0.33,
    "longWindowSec": 1.0,
    "noveltyMin": 4.5,
    "noveltyMadScale": 6.0,
    "prominenceRatio": 0.5,
    "softGuardSec": 0.4,
    "minHardShotSec": 0.1,
    "cutWholeFrame": 0.5,
    "matchSimilarity": 0.65,
    "samePictureSimilarity": 0.9,
    "layoutWeight": 0.6,
    "cutScoreMin": 0.12,
    "sameShotNovelty": 12.0,
    "softMinFrames": 3,
    "wipePurity": 0.88,
    "softMergeGapSec": 0.3,
    "candidateNoveltyMin": 1.5,
    "softMarginSec": 0.25,
    "prominenceReachSec": 2.5,
    "maxTransitionSec": 3.0,
}


def scan(media: str) -> tuple[float, np.ndarray, np.ndarray, np.ndarray]:
    """Decode sampled frames and their timestamps."""
    import cv2

    capture = cv2.VideoCapture(media)
    if not capture.isOpened():
        error_message = f"OpenCV could not open {media}"
        raise RuntimeError(error_message)
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    small: list[np.ndarray] = []
    grid: list[np.ndarray] = []
    times: list[float] = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        times.append(capture.get(cv2.CAP_PROP_POS_MSEC) / 1000)
        reduced = cv2.resize(frame, SMALL, interpolation=cv2.INTER_AREA)
        small.append(cv2.cvtColor(reduced, cv2.COLOR_BGR2GRAY))
        lab = cv2.cvtColor(reduced, cv2.COLOR_BGR2LAB)
        grid.append(cv2.resize(lab, GRID, interpolation=cv2.INTER_AREA).astype(np.float32).ravel())
    capture.release()
    if len(small) < 2:
        error_message = "Too few decodable frames"
        raise RuntimeError(error_message)
    return fps, np.array(small, dtype=np.uint8), np.array(grid), np.array(times)


def changed_fraction(small: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Measure the share of changed pixels between samples."""
    delta = np.abs(small[1:].astype(np.int16) - small[:-1])
    changed = np.concatenate([[0.0], (delta > CHANGE_LEVEL).mean(axis=(1, 2))])
    mean = np.concatenate([[0.0], delta.mean(axis=(1, 2))])
    return changed, mean


def novelty(grid: np.ndarray, window: int) -> np.ndarray:
    """Foote novelty: how much a frame separates two internally coherent runs. Works on hard and gradual changes."""
    count = len(grid)
    out = np.zeros(count)
    step = max(1, window // 6)
    for t in range(1, count):
        before = grid[max(0, t - window) : t : step]
        after = grid[t : min(count, t + window) : step]
        cross = np.abs(before[:, None] - after[None]).mean()
        within = 0.5 * (np.abs(before[:, None] - before[None]).mean() + np.abs(after[:, None] - after[None]).mean())
        out[t] = max(0.0, cross - within)
    return out


def adaptive_cuts(media: str) -> tuple[list[int], str]:
    """Find cuts relative to the local score distribution."""
    import scenedetect
    from scenedetect import AdaptiveDetector, SceneManager, open_video

    manager = SceneManager()
    manager.add_detector(AdaptiveDetector(adaptive_threshold=PARAMS["adaptiveThreshold"]))
    manager.detect_scenes(open_video(media), show_progress=False)
    return [start.frame_num for start, _ in manager.get_scene_list()[1:]], str(scenedetect.__version__)


def spike_cuts(changed: np.ndarray, small: np.ndarray) -> list[int]:
    """One-frame jumps PySceneDetect misses on sparse, near-white or near-black frames."""
    found: list[int] = []
    count = len(changed)
    for t in range(1, count):
        if changed[t] < PARAMS["spikeMinChanged"]:
            continue
        around = np.concatenate([changed[max(1, t - 4) : t], changed[t + 1 : t + 5]])
        if len(around) and changed[t] < PARAMS["spikeRatio"] * max(float(np.median(around)), 0.01):
            continue
        if changed[t] < float(changed[max(1, t - 1) : t + 2].max()):
            continue
        found.append(t)
    return [t for t in found if not is_flash(small, t)]


def is_flash(small: np.ndarray, t: int) -> bool:
    """A frame or two that departs and returns is a flash, not a new shot."""
    if t < 2 or t + 3 >= len(small):
        return False
    jump = np.abs(small[t].astype(np.int16) - small[t - 1]).mean()
    settled = np.abs(small[t + 3].astype(np.int16) - small[t - 1]).mean()
    return bool(jump > 0 and settled < PARAMS["flashMaxReturn"] * jump)


def peaks(curve: np.ndarray, floor: float, spacing: int, reach: int) -> list[int]:
    """Find separated local score peaks."""
    found: list[int] = []
    for t in np.argsort(curve)[::-1]:
        value = curve[t]
        if value < floor:
            break
        if any(abs(int(t) - other) < spacing for other in found):
            continue
        left = curve[max(0, t - reach) : t + 1].min()
        right = curve[t : t + reach + 1].min()
        if value - max(left, right) >= PARAMS["prominenceRatio"] * value:
            found.append(int(t))
    return sorted(found)


def extent(mean: np.ndarray, centre: int, fps: float) -> tuple[int, int]:
    """Grows a gradual change outwards until frame-to-frame activity falls back to its surroundings."""
    limit = int(PARAMS["maxTransitionSec"] * fps / 2)
    smooth = np.convolve(mean, np.ones(3) / 3, mode="same")
    low, high = max(1, centre - limit), min(len(mean) - 1, centre + limit)
    level = max(0.2 * float(smooth[low : high + 1].max()), 0.6)
    start = end = centre
    while start > low and smooth[start - 1] > level:
        start -= 1
    while end < high and smooth[end + 1] > level:
        end += 1
    return start, end


def edge_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Measure edge similarity between adjacent frames."""

    def edges(image: np.ndarray) -> np.ndarray:
        float_image = image.astype(np.float32)
        return np.abs(np.diff(float_image, axis=0))[:, :-1] + np.abs(np.diff(float_image, axis=1))[:-1, :]

    first, second = edges(a).ravel(), edges(b).ravel()
    if first.std() < 1e-3 or second.std() < 1e-3:
        return 0.0
    return float(np.corrcoef(first, second)[0, 1])


def classify_soft(small: np.ndarray, start: int, end: int, fps: float) -> tuple[str, float, dict[str, float]]:  # noqa: PLR0915 -- Ordered native mutations and their validation form one operation.
    """Classify a soft transition from its measured frame sequence."""
    import cv2

    a_index, b_index = max(0, start - 2), min(len(small) - 1, end + 2)
    a = small[a_index].astype(np.float32)
    b = small[b_index].astype(np.float32)
    middle = small[start : end + 1].astype(np.float32)
    span = b - a
    energy = float((span * span).sum())
    frames = len(middle)
    measures: dict[str, float] = {"frames": float(frames)}

    means, stds = middle.mean(axis=(1, 2)), middle.std(axis=(1, 2))
    darkest, brightest = int(means.argmin()), int(means.argmax())
    ends = (float(a.mean()), float(b.mean()))
    if (means[darkest] < 16 and stds[darkest] < 12 and max(ends) > means[darkest] + 15) or (means[brightest] > 240 and stds[brightest] < 12 and min(ends) < means[brightest] - 15):
        return "fade", 0.85, measures

    residual: float | None = None
    rising = alpha_rise = 0.0
    if energy > 0 and frames >= 2:
        flat = span.ravel()
        alphas = np.array([float(((frame - a).ravel() * flat).sum() / energy) for frame in middle])
        fits = a[None] + alphas[:, None, None] * span
        residual = float(np.sqrt(((middle - fits) ** 2).sum(axis=(1, 2)).mean() / energy))
        rising = float((np.diff(alphas) >= -0.02).mean())
        alpha_rise = float(alphas[-1] - alphas[0])
        measures |= {"blendResidual": round(residual, 3), "alphaMonotonic": round(rising, 3)}
        differs = np.abs(span) > CHANGE_LEVEL
        if differs.mean() > 0.02:
            near_a = np.abs(middle - a) < 0.2 * np.abs(span) + 4
            near_b = np.abs(middle - b) < 0.2 * np.abs(span) + 4
            pure = float(((near_a | near_b) & differs).sum() / (differs.sum() * frames))
            taken = (near_b & differs).sum(axis=(1, 2)) / differs.sum()
            xs = np.arange(SMALL[0])
            ys = np.arange(SMALL[1])
            weights = (near_b & differs).astype(np.float32)
            totals = np.maximum(weights.sum(axis=(1, 2)), 1)
            cx = (weights.sum(axis=1) * xs).sum(axis=1) / totals / SMALL[0]
            cy = (weights.sum(axis=2) * ys).sum(axis=1) / totals / SMALL[1]
            sweep = float(max(np.ptp(cx), np.ptp(cy)))
            measures |= {"binaryPurity": round(pure, 3), "centroidSweep": round(sweep, 3)}
            # A wipe leaves almost every pixel exactly A or B, whereas a whip smears them, so this comes before flow.
            if pure > PARAMS["wipePurity"] and sweep > 0.2 and taken[-1] - taken[0] > 0.4:
                return "wipe", round(min(0.95, pure), 2), measures
    flows = [cv2.calcOpticalFlowFarneback(small[t - 1], small[t], np.empty((*small[t].shape, 2), dtype=np.float32), 0.5, 2, 15, 2, 5, 1.1, 0) for t in range(max(1, start), min(len(small), end + 1))]
    if flows:
        vectors = np.array([flow.reshape(-1, 2).mean(axis=0) for flow in flows])
        magnitudes = np.array([float(np.hypot(flow[..., 0], flow[..., 1]).mean()) for flow in flows])
        per_second = magnitudes * fps / SMALL[0]
        coherence = float(np.hypot(*vectors.mean(axis=0)) / max(magnitudes.mean(), 1e-3))
        blur = middle[len(middle) // 2]
        gradient_x, gradient_y = np.abs(np.diff(blur, axis=1)).mean(), np.abs(np.diff(blur, axis=0)).mean()
        anisotropy = float(max(gradient_x, gradient_y) / max(min(gradient_x, gradient_y), 1e-3))
        measures |= {"flowWidthPerSec": round(float(per_second.max()), 3), "flowCoherence": round(coherence, 3), "blurAnisotropy": round(anisotropy, 3)}
        if per_second.max() > 0.5 and coherence > 0.5:
            return "whip", round(min(0.85, 0.4 + coherence / 2), 2), measures
    if residual is not None and residual < 0.25 and rising > 0.75 and alpha_rise > 0.4:
        return "dissolve", round(min(0.95, 1 - residual), 2), measures
    return "continuous", 0.4, measures


def analyse_shots(media: str) -> dict[str, Any]:  # noqa: C901, PLR0912, PLR0915 -- Keep the ordered validation or native transaction together. Each branch validates one supported contract variant. Ordered native mutations and their validation form one operation.
    """Measure shot boundaries and transition evidence."""
    fps, small, grid, times = scan(media)
    count = len(small)
    changed, mean = changed_fraction(small)
    cuts, version = adaptive_cuts(media)
    engines: dict[int, set[str]] = {}
    for t in cuts:
        if 0 < t < count and not is_flash(small, t):
            engines.setdefault(t, set()).add("adaptive")
    for t in spike_cuts(changed, small):
        near = next((other for other in engines if abs(other - t) <= 1), None)
        engines.setdefault(near if near is not None else t, set()).add("spike")

    # An element popping onto a held background also spikes. A cut must change the composition.
    short = novelty(grid, max(2, round(PARAMS["shortWindowSec"] * fps)))
    hard: list[int] = []
    similarity: dict[int, float] = {}
    for t in sorted(engines):
        local = float(short[max(0, t - 2) : t + 3].max())
        similarity[t] = edge_similarity(small[max(0, t - 1)], small[t])
        if local < PARAMS["noveltyMin"] and changed[t] < PARAMS["cutWholeFrame"]:
            continue
        # The same picture at another brightness is a fade or flash under way, not a new shot.
        if similarity[t] > PARAMS["samePictureSimilarity"]:
            continue
        # Little change with the layout still standing is animation inside a shot, unless the colours moved a lot.
        if changed[t] - PARAMS["layoutWeight"] * similarity[t] < PARAMS["cutScoreMin"] and local < PARAMS["sameShotNovelty"]:
            continue
        if hard and (t - hard[-1]) / fps < PARAMS["minHardShotSec"]:
            continue
        hard.append(t)
    strong = [t for t in hard if changed[t] >= PARAMS["cutWholeFrame"] or len(engines[t]) > 1]

    guard = int(PARAMS["softGuardSec"] * fps)
    candidates: list[int] = []
    for window_sec in (PARAMS["shortWindowSec"], PARAMS["longWindowSec"]):
        curve = short if window_sec == PARAMS["shortWindowSec"] else novelty(grid, max(2, round(window_sec * fps)))
        spread = float(np.median(np.abs(curve - np.median(curve))))
        floor = max(PARAMS["noveltyMin"], float(np.median(curve)) + PARAMS["noveltyMadScale"] * spread)
        for t in peaks(curve, floor, guard, round(PARAMS["prominenceReachSec"] * fps)):
            if guard <= t <= count - guard and all(abs(t - other) >= guard for other in [*strong, *candidates]):
                candidates.append(t)

    # A long move shows several novelty peaks: overlapping spans are one transition.
    spans = sorted(span for span in (extent(mean, t, fps) for t in candidates) if span[1] - span[0] + 1 >= PARAMS["softMinFrames"])

    merged: list[tuple[int, int]] = []
    gap = round(PARAMS["softMergeGapSec"] * fps)
    for start, end in spans:
        if merged and start <= merged[-1][1] + gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    margin = int(PARAMS["softMarginSec"] * fps)
    merged = [span for span in merged if all(not (span[0] - 1 <= t <= span[1] + 1) for t in strong)]
    absorbed = [t for t in hard if t not in strong and any(start - margin <= t <= end + margin for start, end in merged)]
    hard = [t for t in hard if t not in absorbed]

    boundaries: list[dict[str, Any]] = []
    for t in hard:
        around = np.concatenate([changed[max(1, t - 3) : t], changed[t + 1 : t + 4]])
        ratio = float(changed[t] / max(float(np.median(around)) if len(around) else 0, 0.01))
        confidence = round(min(0.98, 0.55 + ratio / 40 + (0.15 if len(engines[t]) > 1 else 0)), 2)
        kind = "match" if similarity[t] > PARAMS["matchSimilarity"] else "cut"
        boundaries.append(
            {
                "frame": t,
                "timeSec": float(times[t]),
                "startSec": float(times[t]),
                "endSec": float(times[t]),
                "kind": kind,
                "confidence": 0.45 if kind == "match" else confidence,
                "measures": {
                    "changedFraction": round(float(changed[t]), 3),
                    "edgeSimilarity": round(similarity[t], 3),
                    "novelty": round(float(short[max(0, t - 2) : t + 3].max()), 2),
                    "engines": len(engines[t]),
                },
            }
        )
    for start, end in merged:
        t = (start + end) // 2
        kind, confidence, measures = classify_soft(small, start, end, fps)
        boundaries.append(
            {
                "frame": t,
                "timeSec": float(times[t]),
                "startSec": float(times[start]),
                "endSec": float(times[end]),
                "kind": kind,
                "confidence": confidence,
                "measures": measures,
            }
        )
    boundaries.sort(key=lambda row: row["timeSec"])
    # Below the bar for a shot: text swaps on a flat background and elements added to a held layout look alike here.
    candidates_below = [
        {"timeSec": round(float(times[t]), 3), "novelty": round(float(short[t]), 2)}
        for t in peaks(short, PARAMS["candidateNoveltyMin"], guard, round(PARAMS["prominenceReachSec"] * fps))
        if all(abs(float(times[t]) - row["timeSec"]) > 0.25 and not row["startSec"] <= float(times[t]) <= row["endSec"] for row in boundaries)
    ]
    return {
        "engine": "pyscenedetect-adaptive+spike+novelty",
        "version": version,
        "fps": fps,
        "frames": count,
        "durationSec": float(times[-1] + 1 / fps),
        "params": PARAMS,
        "boundaries": boundaries,
        "candidates": candidates_below,
    }


def camera_estimate(steps: list[tuple[float, float, float, float]]) -> str:  # noqa: PLR0911 -- Each supported contract variant returns its own result.
    """Each step: x and y translation, scale change per second, and what neither explains, in frame widths per second."""
    if not steps:
        return "unknown"
    dx, dy, scale, residual = np.array(steps).T
    # Typical speed of a pixel under this zoom, in the same unit as the others.
    zoom = np.abs(scale).mean() * 0.3
    move = float(np.hypot(dx, dy).mean())
    unexplained = float(residual.mean())
    if move < 0.004 and zoom < 0.004 and unexplained < 0.01:
        return "static"
    if unexplained > max(0.02, 1.5 * (move + zoom)):
        return "complex"
    if zoom > max(0.01, 0.5 * move) and abs(scale.mean()) > 0.6 * np.abs(scale).mean():
        return "zoom"
    flips = float(((np.sign(dx[1:]) != np.sign(dx[:-1])) | (np.sign(dy[1:]) != np.sign(dy[:-1]))).mean()) if len(dx) > 1 else 0.0
    if flips > 0.5 and move < 0.05:
        return "handheld"
    if abs(dx.mean()) > 2 * abs(dy.mean()) and abs(dx.mean()) > 0.5 * move:
        return "pan"
    if abs(dy.mean()) > 2 * abs(dx.mean()) and abs(dy.mean()) > 0.5 * move:
        return "tilt"
    return "complex"


def moves_module() -> Any:  # noqa: ANN401
    """reference-moves.py, loaded by path: the worker runs with -I, so its own directory is not on sys.path."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("reference_moves", Path(__file__).with_name("reference-moves.py"))
    if spec is None or spec.loader is None:
        error_message = "reference-moves.py is missing beside the worker"
        raise RuntimeError(error_message)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STATIC_STD = 3.0


def static_mask(small: np.ndarray, fps: float, cut_frames: list[int]) -> np.ndarray | None:
    """Pixels that never change over the film: a watermark, a logo, a UI overlay. None when nothing, or most of the frame, is still.

    Only across a cut does stillness mean an overlay: inside one shot, the centre of a slow zoom barely changes either.

    After ReelMimic's perception/video.py static_mask (MIT, (c) 2026 ReelMimic contributors).
    """
    import cv2

    stack = small[:: max(1, round(fps / 4))].astype(np.float32)
    if len(stack) < 8 or not cut_frames:
        return None
    still = (stack.std(axis=0) < STATIC_STD).astype(np.uint8)
    share = float(still.mean())
    if share < 0.01 or share > 0.6:
        return None
    return cv2.dilate(still, np.ones((3, 3), np.uint8)) > 0


def frame_steps(small: np.ndarray) -> np.ndarray:
    """Per frame, from the previous one, by dense flow: speed, translation, scale and what they leave, in pixels."""
    import cv2

    height, width = small.shape[1:]
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float32)
    xs -= width / 2
    ys -= height / 2
    radius = (xs * xs + ys * ys).sum()
    steps = np.zeros((len(small), 5))
    for t in range(1, len(small)):
        flow = cv2.calcOpticalFlowFarneback(small[t - 1], small[t], np.empty((*small[t].shape, 2), dtype=np.float32), 0.5, 2, 15, 2, 5, 1.1, 0)
        dx, dy = float(flow[..., 0].mean()), float(flow[..., 1].mean())
        rest_x, rest_y = flow[..., 0] - dx, flow[..., 1] - dy
        scale = float(((rest_x * xs + rest_y * ys).sum()) / radius)
        fit_x, fit_y = rest_x - scale * xs, rest_y - scale * ys
        steps[t] = (float(np.hypot(flow[..., 0], flow[..., 1]).mean()), dx, dy, scale, float(np.hypot(fit_x, fit_y).mean()))
    return steps


def shot_camera(moves: Any, times: np.ndarray, small: np.ndarray, frames: np.ndarray, hold: np.ndarray, mask: np.ndarray | None, in_transition: Callable[[float], bool]) -> dict[str, Any] | None:  # noqa: ANN401, PLR0913, PLR0917 -- Inputs are independent measured layers of the same operation. Retain the established positional worker/helper interface.
    """Integrates the camera over one shot (x and y in frame widths, z log scale, roll in radians) and fits its moves."""
    if len(frames) < 6:
        return None
    usable = None if mask is None else np.where(mask, 0, 255).astype(np.uint8)
    steps = np.zeros((len(frames), 4))
    tracked = 0
    for index in range(1, len(frames)):
        if in_transition(float(times[frames[index]])):
            continue
        *step, ok = moves.camera_step(small[frames[index - 1]], small[frames[index]], usable)
        steps[index] = step
        tracked += ok
    held = hold[frames]
    trajectory = {axis: np.cumsum(moves.spread_over_holds(steps[:, column], held)) for column, axis in enumerate(moves.AXES)}
    try:
        camera = {**moves.describe_shot(times[frames], trajectory), "trackedShare": round(tracked / (len(frames) - 1), 3)}
    except (ValueError, FloatingPointError, np.linalg.LinAlgError):
        return None
    return camera if finite(camera) else None


def finite(value: object) -> bool:
    """JSON has no NaN: a degenerate fit is dropped rather than breaking the layer."""
    if isinstance(value, dict):
        return all(finite(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return all(finite(item) for item in value)
    return not isinstance(value, float) or bool(np.isfinite(value))


def analyse_motion(media: str, request: dict[str, Any]) -> dict[str, Any]:
    """Measure camera motion and cadence inside each shot."""
    moves = moves_module()
    fps, small, _, times = scan(media)
    stride = max(1, round(fps / 15))
    shots: list[dict[str, Any]] = request.get("shots") or [{"id": "s1", "startSec": 0, "endSec": float(times[-1]) + 1 / fps}]
    transitions = [(row["startSec"], row["endSec"]) for row in request.get("transitions", [])]
    height, width = small.shape[1:]
    cut_frames = sorted({int(np.searchsorted(times, shot["startSec"] - 0.5 / fps)) for shot in shots[1:]})
    mask = static_mask(small, fps, cut_frames)
    steps = frame_steps(small)
    diff = np.concatenate([[0.0], np.abs(small[1:].astype(np.int16) - small[:-1]).mean(axis=(1, 2)) / 255])
    hold = moves.held_frames(diff, cut_frames)

    per_second = fps / width
    samples: list[tuple[int, float, float, float, float, float]] = []
    for t in range(stride, len(small), stride):
        window = steps[t - stride + 1 : t + 1].mean(axis=0)
        samples.append((t, window[0] * per_second, window[1] * per_second, window[2] * per_second, window[3] * fps, window[4] * per_second))

    def in_transition(time: float) -> bool:
        return any(a - 0.02 <= time <= b + 0.02 for a, b in transitions)

    curve = [{"timeSec": round(float(times[row[0]]), 3), "energy": round(row[1], 5)} for row in samples]
    report = []
    for shot in shots:
        frames = np.flatnonzero((times >= shot["startSec"] - 0.5 / fps) & (times < shot["endSec"] - 0.5 / fps))
        camera = shot_camera(moves, times, small, frames, hold, mask, in_transition)
        shot_cadence = moves.cadence(diff[frames], hold[frames], [], fps) if len(frames) > 1 else {"movingFrames": 0}
        extra = {**({"camera": camera} if camera else {}), "cadence": shot_cadence}
        inside = [row for row in samples if shot["startSec"] <= times[row[0] - stride] and times[row[0]] < shot["endSec"] and not in_transition(float(times[row[0]]))]
        if not inside:
            report.append({"shotId": shot["id"], "meanEnergy": 0, "peakEnergy": 0, "cameraEstimate": "unknown", **extra})
            continue
        energies = np.array([row[1] for row in inside])
        peak = inside[int(energies.argmax())]
        report.append(
            {
                "shotId": shot["id"],
                "meanEnergy": round(float(energies.mean()), 5),
                "peakEnergy": round(float(energies.max()), 5),
                "peakSec": round(float(times[peak[0]]), 3),
                "cameraEstimate": camera_estimate([row[2:] for row in inside]),
                **extra,
            }
        )

    text_on = []
    for item in request.get("text", []):
        low, high = item["startSec"] - 0.3, item["startSec"] + 0.3
        indices = np.flatnonzero((times >= low) & (times <= high))
        box = item.get("box")
        best = item["startSec"]
        if len(indices) > 1 and box:
            x0, y0 = int(box["x"] * width), int(box["y"] * height)
            x1, y1 = max(x0 + 1, int((box["x"] + box["width"]) * width) + 1), max(y0 + 1, int((box["y"] + box["height"]) * height) + 1)
            region = small[indices[0] : indices[-1] + 1, y0:y1, x0:x1].astype(np.int16)
            change = np.abs(np.diff(region, axis=0)).mean(axis=(1, 2))
            if change.max() > 1.5:
                best = float(times[indices[1 + int(change.argmax())]])
        text_on.append(round(best, 3))
    return {
        "engine": "opencv-farneback",
        "fps": fps,
        "stride": stride,
        "shots": report,
        "curve": curve,
        "textOnSec": text_on,
        "cadence": moves.cadence(diff, hold, cut_frames, fps),
        "staticOverlayShare": round(float(mask.mean()), 3) if mask is not None else 0.0,
    }


def analyse_audio(media: str) -> dict[str, Any]:
    """Measure the reference audio structure."""
    import librosa

    samples, rate = librosa.load(media, sr=22050, mono=True)
    hop = 512
    envelope = librosa.onset.onset_strength(y=samples, sr=rate, hop_length=hop)
    tempo, beats = librosa.beat.beat_track(onset_envelope=envelope, sr=rate, hop_length=hop, units="frames")
    bpm = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beats, sr=rate, hop_length=hop)
    # librosa reports tempo on its frame-lag grid, 3 to 6 BPM apart. The slope of the tracked beats is finer.
    if len(beat_times) >= 8:
        bpm = float(60 / np.polyfit(np.arange(len(beat_times)), beat_times, 1)[0])
    onsets = librosa.onset.onset_detect(onset_envelope=envelope, sr=rate, hop_length=hop, units="time", backtrack=False)

    # Pulse clarity: how strongly the onset envelope repeats at the beat period, against its other lags.
    centred = envelope - envelope.mean()
    autocorrelation = np.correlate(centred, centred, mode="full")[len(centred) - 1 :]
    autocorrelation = autocorrelation / max(float(autocorrelation[0]), 1e-9)
    confidence = 0.0
    if bpm > 0:
        lag = round(60 / bpm * rate / hop)
        if 0 < lag < len(autocorrelation):
            confidence = float(np.clip(autocorrelation[max(1, lag - 1) : lag + 2].max(), 0, 1))
    intervals = np.diff(beat_times)
    regularity = float(1 - min(1, intervals.std() / max(intervals.mean(), 1e-3))) if len(intervals) > 1 else 0.0

    # No bar tracker here: the bar phase with the strongest onsets is an estimate.
    downbeats: list[float] = []
    downbeat_confidence = 0.0
    if len(beats) >= 8:
        strength = envelope[np.minimum(beats, len(envelope) - 1)]
        phases = [float(strength[phase::4].mean()) for phase in range(4)]
        best = int(np.argmax(phases))
        ordered = sorted(phases)
        downbeat_confidence = float(np.clip((ordered[-1] - ordered[-2]) / max(ordered[-1], 1e-6), 0, 1))
        downbeats = [round(float(at), 3) for at in beat_times[best::4]]

    rms = librosa.feature.rms(y=samples, hop_length=hop)[0]
    mfcc = librosa.feature.mfcc(y=samples, sr=rate, hop_length=hop, n_mfcc=13)
    duration = len(samples) / rate
    target = int(np.clip(round(duration / 8), 2, 12))
    bounds = librosa.segment.agglomerative(mfcc, target)
    starts = librosa.frames_to_time(bounds, sr=rate, hop_length=hop).tolist()
    edges = [*starts, duration]
    peak = max(float(rms.max()), 1e-6)
    sections = []
    for index, (start, end) in enumerate(pairwise(edges)):
        if end - start < 0.05:
            continue
        first, last = librosa.time_to_frames([start, end], sr=rate, hop_length=hop)
        level = float(rms[first : max(first + 1, last)].mean() / peak)
        band = "quiet" if level < 0.25 else "medium" if level < 0.6 else "loud"
        sections.append({"startSec": round(start, 3), "endSec": round(end, 3), "label": f"{index + 1}-{band}", "energy": round(level, 3)})
    return {
        "engine": f"librosa-{version('librosa')}",
        "bpm": round(bpm, 2),
        "confidence": round(confidence, 3),
        "beatRegularity": round(regularity, 3),
        "beatsSec": [round(float(at), 3) for at in beat_times],
        "downbeatsSec": downbeats,
        "downbeatConfidence": round(downbeat_confidence, 3),
        "onsetsSec": [round(float(at), 3) for at in onsets],
        "sections": sections,
    }


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    operation, media = sys.argv[1], sys.argv[2]
    if operation == "shots":
        result = analyse_shots(media)
    elif operation == "motion":
        result = analyse_motion(media, json.loads(Path(sys.argv[3]).read_text()))
    elif operation == "audio":
        result = analyse_audio(media)
    else:
        error_message = f"Unknown operation: {operation}"
        raise SystemExit(error_message)
    sys.stdout.write(json.dumps(result, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
