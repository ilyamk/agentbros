"""Shot transitions in natural footage. Prints one JSON object on stdout.

Usage: footage-shots.py MEDIA ENGINE DEVICE
  ENGINE: transnetv2 or reference (the measured detector in reference-analysis.py)
  DEVICE: torch device for TransNetV2; src/lib/footage/shots.ts always passes cpu

Run through uvx by src/lib/footage/shots.ts, which pins the packages. MEDIA must have a constant frame rate:
every frame index here is the index of a decoded frame, the same as ffmpeg's and Remotion's.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import subprocess
import sys
from importlib import metadata
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator

import cv2
import numpy as np
import scenedetect
from scenedetect import SceneManager, ThresholdDetector, open_video

GREYSCALE_DIMENSIONS = 2
MIN_FADE_FRAMES = 5

SMALL = (128, 72)
GRID = (16, 9)
TRANSNET_SIZE = (48, 27)

PARAMS: dict[str, float] = {
    "singleThreshold": 0.5,
    "allThreshold": 0.5,
    "allMinFrames": 3,
    "refineReach": 3,
    "spikeRatio": 3.0,
    "spikeFloor": 1.0,
    "blackMean": 16.0,
    "blackStd": 6.0,
    "fadeMinRampFrames": 2,
    "fadeStepTolerance": 1.0,
    "fadeReach": 3,
    "thresholdDetectorLevel": 12.0,
    "dissolveMargin": 8,
    "dissolveSearchSec": 1.0,
    "dissolveMinRatio": 1.3,
    "mergeGap": 2,
    "maxTransitionSec": 3.0,
}


def stream(media: str, size: tuple[int, int], flags: str | None) -> Iterator[np.ndarray]:
    """Decoded frames one at a time, so an hour of footage never sits in memory at once."""
    scale = f"scale={size[0]}:{size[1]}" + (f":flags={flags}" if flags else "")
    command = ["ffmpeg", "-v", "error", "-nostdin", "-i", media, "-map", "0:v:0", "-an", "-sn", "-vf", scale, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    frame_bytes = size[0] * size[1] * 3
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:  # noqa: S603 -- Arguments are a literal vector; the worker never invokes a shell.
        if process.stdout is None or process.stderr is None:
            return
        while chunk := process.stdout.read(frame_bytes):
            if len(chunk) < frame_bytes:
                break
            yield np.frombuffer(chunk, np.uint8).reshape(size[1], size[0], 3)
        error = process.stderr.read().decode(errors="replace")
        if process.wait() != 0:
            msg = f"ffmpeg could not decode {media}: {error[-400:]}"
            raise RuntimeError(msg)


class Frames:
    """Per-frame measures of the 128x72 picture; the pixels themselves are not kept."""

    def __init__(self, media: str) -> None:
        """Keep the decoded frame data and transition measurements."""
        luma: list[float] = []
        spread: list[float] = []
        diff: list[float] = [0.0]
        step: list[float] = [0.0]
        previous_gray: np.ndarray | None = None
        previous_grid: np.ndarray | None = None
        for frame in stream(media, SMALL, "area"):
            gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY).astype(np.float32)
            # Composition: coarse enough that texture and grain average out, so a blend shows as a raised plateau of change.
            grid = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_RGB2LAB), GRID, interpolation=cv2.INTER_AREA).astype(np.float32).ravel()
            luma.append(float(gray.mean()))
            spread.append(float(gray.std()))
            if previous_gray is not None and previous_grid is not None:
                diff.append(float(np.abs(gray - previous_gray).mean()))
                step.append(float(np.abs(grid - previous_grid).mean()))
            previous_gray, previous_grid = gray, grid
        if len(luma) < GREYSCALE_DIMENSIONS:
            msg = "Too few decodable frames"
            raise RuntimeError(msg)
        self.count = len(luma)
        self.luma, self.spread, self.diff, self.step = (np.array(values) for values in (luma, spread, diff, step))


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Collect consecutive true samples into half-open ranges."""
    found: list[tuple[int, int]] = []
    for t in np.flatnonzero(mask):
        if found and found[-1][1] == t - 1:
            found[-1] = (found[-1][0], int(t))
        else:
            found.append((int(t), int(t)))
    return found


def transnet_candidates(media: str, frames: Frames, device: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Measure candidate shot changes using TransNetV2."""
    import torch
    from transnetv2_pytorch import TransNetV2

    torch.set_num_threads(max(1, torch.get_num_threads()))
    rgb = np.array(list(stream(media, TRANSNET_SIZE, None)))
    if len(rgb) != frames.count:
        msg = f"Decoders disagree on the frame count: {len(rgb)} at 48x27, {frames.count} at 128x72"
        raise RuntimeError(msg)
    # The package prints device notices on stdout, which carries this worker's JSON.
    with contextlib.redirect_stdout(sys.stderr):
        model = TransNetV2(device=device)
        model.eval()
        with torch.no_grad():
            single, every = model.predict_frames(torch.from_numpy(rgb.copy()).to(model.device), quiet=True)
    single_p = single.numpy().astype(float)
    all_p = every.numpy().astype(float)
    candidates = [
        {"centre": start + int(single_p[start : end + 1].argmax()), "low": start, "high": end, "confidence": float(single_p[start : end + 1].max()), "source": "transnetv2-single"}
        for start, end in runs(single_p > PARAMS["singleThreshold"])
    ]
    # The single-frame head often stays low through a dissolve; the all-frame head marks every frame of it.
    candidates += [
        {"centre": (start + end) // 2, "low": start, "high": end, "confidence": float(all_p[start : end + 1].max()), "source": "transnetv2-all"}
        for start, end in runs(all_p > PARAMS["allThreshold"])
        if end - start + 1 >= PARAMS["allMinFrames"]
    ]
    return candidates, {"engine": "transnetv2", "version": metadata.version("transnetv2-pytorch"), "torch": torch.__version__, "device": str(model.device)}


def reference_candidates(media: str, frames: Frames) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Measure candidate cuts using reference analysis."""
    spec = importlib.util.spec_from_file_location("reference_analysis", Path(__file__).with_name("reference-analysis.py"))
    if spec is None or spec.loader is None:
        msg = "reference-analysis.py is missing"
        raise RuntimeError(msg)
    reference = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reference)
    result = reference.analyse_shots(media)
    if result["frames"] != frames.count:
        msg = f"Decoders disagree on the frame count: OpenCV {result['frames']}, ffmpeg {frames.count}"
        raise RuntimeError(msg)
    fps = result["fps"]
    candidates = []
    for row in result["boundaries"]:
        low, high = round(row["startSec"] * fps), round(row["endSec"] * fps)
        candidates.append({"centre": int(row["frame"]), "low": min(low, row["frame"]), "high": max(high, row["frame"]), "confidence": float(row["confidence"]), "source": f"reference-{row['kind']}"})
    return candidates, {"engine": "reference", "version": result["engine"] + " " + result["version"]}


def fade_candidates(media: str) -> tuple[list[dict[str, Any]], str]:
    """Find candidate transitions through black frames."""
    manager = SceneManager()
    manager.add_detector(ThresholdDetector(threshold=PARAMS["thresholdDetectorLevel"], min_scene_len=1))
    manager.detect_scenes(open_video(media), show_progress=False)
    found = [{"centre": int(start.frame_num), "low": int(start.frame_num), "high": int(start.frame_num), "confidence": 0.9, "source": "threshold"} for start, _ in manager.get_scene_list()[1:]]
    return found, str(scenedetect.__version__)


def black(frames: Frames, t: int) -> bool:
    """Determine whether the sampled frame is black."""
    return bool(frames.luma[t] < PARAMS["blackMean"] and frames.spread[t] < PARAMS["blackStd"])


def fade_span(frames: Frames, low: int, high: int, limit: int) -> tuple[int, int, int] | None:
    """Black hold nearest the candidate, then outwards while brightness keeps falling towards it."""
    reach = int(PARAMS["fadeReach"])
    window = range(max(0, low - reach), min(frames.count, high + reach + 1))
    dark = [t for t in window if black(frames, t)]
    if not dark:
        return None
    darkest = min(dark, key=lambda t: frames.luma[t])
    hold_start = hold_end = darkest
    while hold_start > 0 and black(frames, hold_start - 1):
        hold_start -= 1
    while hold_end + 1 < frames.count and black(frames, hold_end + 1):
        hold_end += 1
    tolerance = PARAMS["fadeStepTolerance"]
    # The fade begins on the first frame darker than the one before it, and ends on the last frame darker than the one after.
    start = hold_start
    while start - 2 >= max(0, hold_start - limit) and frames.luma[start - 2] - frames.luma[start - 1] > tolerance:
        start -= 1
    end = hold_end
    while end + 2 < min(frames.count, hold_end + limit) and frames.luma[end + 2] - frames.luma[end + 1] > tolerance:
        end += 1
    if start <= 1 or end >= frames.count - 2:
        return None
    # Hard cuts into and out of black are cuts, not a fade.
    if max(hold_start - start, end - hold_end) < PARAMS["fadeMinRampFrames"]:
        return None
    return start, end, (hold_start + hold_end) // 2


def spike(frames: Frames, low: int, high: int) -> tuple[int, float]:
    """Determine whether the score is an isolated transition spike."""
    reach = int(PARAMS["refineReach"])
    first, last = max(1, low - reach), min(frames.count - 1, high + reach)
    k = first + int(frames.diff[first : last + 1].argmax())
    around = np.concatenate([frames.diff[max(1, k - 4) : k], frames.diff[k + 1 : k + 5]])
    ratio = float(frames.diff[k] / max(float(np.median(around)) if len(around) else 0.0, PARAMS["spikeFloor"]))
    return k, ratio


def dissolve_span(frames: Frames, low: int, high: int, bounds: tuple[int, int], fps: float) -> tuple[int, int, float] | None:
    """Three-level fit of the composition step: before, during (raised), after."""
    margin = max(int(PARAMS["dissolveMargin"]), round(PARAMS["dissolveSearchSec"] * fps))
    first, last = max(bounds[0], low - margin, 1), min(bounds[1], high + margin, frames.count - 1)
    values = frames.step[first : last + 1]
    count = len(values)
    if count < MIN_FADE_FRAMES:
        return None
    sums = np.concatenate([[0.0], np.cumsum(values)])
    squares = np.concatenate([[0.0], np.cumsum(values * values)])

    def cost(a: int, b: int) -> tuple[float, float]:
        if b <= a:
            return 0.0, 0.0
        total = sums[b] - sums[a]
        return float(squares[b] - squares[a] - total * total / (b - a)), float(total / (b - a))

    best: tuple[float, int, int, float] | None = None
    for a in range(1, count - 2):
        for b in range(a + 2, count):
            left, left_mean = cost(0, a)
            middle, middle_mean = cost(a, b)
            right, right_mean = cost(b, count)
            if middle_mean <= max(left_mean, right_mean):
                continue
            total = left + middle + right
            if best is None or total < best[0]:
                best = (total, a, b, middle_mean / max(left_mean, right_mean, 0.5))
    if best is None:
        return None
    _, a, b, ratio = best
    # The step at t compares t with t - 1, so the last raised step lands on the first unmixed frame.
    return first + a, max(first + a, first + b - 2), ratio


def classify(frames: Frames, candidates: list[dict[str, Any]], fps: float) -> list[dict[str, Any]]:  # noqa: C901 -- Keep the ordered validation or native transaction together.
    """Classify the measured temporal features."""
    limit = int(PARAMS["maxTransitionSec"] * fps)
    found: list[dict[str, Any]] = []

    def taken(start: int, end: int) -> bool:
        gap = int(PARAMS["mergeGap"])
        return any(row["startFrame"] - gap <= end and start <= row["endFrame"] + gap for row in found)

    # Fades first: TransNetV2 often fires twice on one, once fading out and once fading in.
    for row in sorted(candidates, key=lambda item: item["source"] != "threshold"):
        span = fade_span(frames, row["low"], row["high"], limit)
        if span and not taken(span[0], span[1]):
            start, end, centre = span
            found.append(
                {
                    "frame": centre,
                    "type": "fade",
                    "startFrame": start,
                    "endFrame": end,
                    "confidence": round(max(row["confidence"], 0.85), 3),
                    "measures": {"minLuma": round(float(frames.luma[centre]), 2), "sources": row["source"]},
                }
            )

    for row in sorted(candidates, key=lambda item: -item["confidence"]):
        if row["source"] == "threshold":
            continue
        k, ratio = spike(frames, row["low"], row["high"])
        measures: dict[str, Any] = {"spikeRatio": round(ratio, 2), "maxDiff": round(float(frames.diff[k]), 2), "sources": row["source"]}
        if ratio >= PARAMS["spikeRatio"]:
            if not taken(k, k):
                found.append({"frame": k, "type": "cut", "startFrame": k, "endFrame": k, "confidence": round(row["confidence"], 3), "measures": measures})
            continue
        neighbours = sorted([0, frames.count - 1, *[edge for item in found for edge in (item["startFrame"], item["endFrame"])]])
        lower = max(edge for edge in neighbours if edge < row["centre"]) if any(edge < row["centre"] for edge in neighbours) else 0
        upper = min(edge for edge in neighbours if edge > row["centre"]) if any(edge > row["centre"] for edge in neighbours) else frames.count - 1
        span = dissolve_span(frames, row["low"], row["high"], (lower + 1, upper - 1), fps)
        if span and span[2] >= PARAMS["dissolveMinRatio"] and span[1] - span[0] < limit:
            start, end, plateau = span
            if not taken(start, end):
                found.append(
                    {
                        "frame": (start + end + 1) // 2,
                        "type": "dissolve",
                        "startFrame": start,
                        "endFrame": end,
                        "confidence": round(row["confidence"], 3),
                        "measures": {**measures, "plateauRatio": round(plateau, 2)},
                    }
                )
            continue
        # Neither a sharp jump nor a clean blend. The all-frame head alone also rises on slow camera moves, so only a
        # single-frame call survives, as a cut at the largest change with lower confidence: shots that look alike cut softly.
        if row["source"] != "transnetv2-all" and not taken(k, k):
            found.append({"frame": k, "type": "cut", "startFrame": k, "endFrame": k, "confidence": round(row["confidence"] * 0.5, 3), "measures": {**measures, "uncertain": True}})
    return sorted((row for row in found if 0 < row["frame"] < frames.count), key=lambda row: row["frame"])


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    media, engine, device = sys.argv[1], sys.argv[2], sys.argv[3]
    capture = cv2.VideoCapture(media)
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    capture.release()
    frames = Frames(media)
    if engine == "transnetv2":
        candidates, detector = transnet_candidates(media, frames, device)
    elif engine == "reference":
        candidates, detector = reference_candidates(media, frames)
    else:
        msg = f"Unknown engine: {engine}"
        raise SystemExit(msg)
    fades, scenedetect_version = fade_candidates(media)
    transitions = classify(frames, candidates + fades, fps)
    result = {
        **detector,
        "fadeDetector": f"pyscenedetect-threshold {scenedetect_version}",
        "fps": fps,
        "frames": frames.count,
        "params": PARAMS,
        "candidates": len(candidates) + len(fades),
        "transitions": transitions,
    }
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
