"""Measurements for multicam sync, angle choice and reframing. Prints one JSON object on stdout.

Usage: multicam.py refine REQUEST.json   GCC-PHAT offset refinement and drift windows on 48 kHz mono WAVs
       multicam.py energy REQUEST.json   RMS level series (dBFS) per WAV
       multicam.py detect REQUEST.json   YuNet faces per sampled frame, HOG people where no face is found

Run through uvx by src/lib/multicam/worker.ts, which pins the packages.
"""

from __future__ import annotations

import json
import sys
import wave
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from collections.abc import Iterable

SILENCE_DBFS = -60.0
BAND_HZ = (60.0, 5000.0)


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """Read a 16-bit mono PCM WAV as floats in [-1, 1]."""
    with wave.open(path, "rb") as handle:
        if handle.getsampwidth() != 2 or handle.getnchannels() != 1:  # noqa: PLR2004
            message = f"{path}: expected 16-bit mono PCM"
            raise ValueError(message)
        rate = handle.getframerate()
        data = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    return data, rate


def gcc_phat(x: np.ndarray, y: np.ndarray, max_lag: int, rate: int) -> tuple[float, float]:
    """Lag k (samples, sub-sample) with x[n] ~ y[n - k], and the peak's ratio to the strongest other peak.

    Whitening is limited to the speech band: above it, clock drift inside the window dephases the bins and buries the peak.
    """
    size = 1 << int(np.ceil(np.log2(len(x) + len(y))))
    spectrum = np.fft.rfft(x, size) * np.conj(np.fft.rfft(y, size))
    spectrum /= np.maximum(np.abs(spectrum), 1e-12)
    frequencies = np.fft.rfftfreq(size, 1 / rate)
    spectrum[(frequencies < BAND_HZ[0]) | (frequencies > BAND_HZ[1])] = 0
    cc = np.fft.irfft(spectrum, size)
    max_lag = min(max_lag, size // 2 - 1)
    window = np.concatenate((cc[-max_lag:], cc[: max_lag + 1]))
    peak = int(np.argmax(window))
    value = window[peak]
    if 0 < peak < len(window) - 1:
        left, right = window[peak - 1], window[peak + 1]
        denominator = left - 2 * value + right
        shift = 0.5 * (left - right) / denominator if denominator != 0 else 0.0
    else:
        shift = 0.0
    guard = 48
    others = np.abs(cc.copy())
    centre = (peak - max_lag) % size
    for index in range(-guard, guard + 1):
        others[(centre + index) % size] = 0
    ratio = min(float(value / max(float(others.max()), 1e-12)), 1000.0)
    return float(peak - max_lag + shift), ratio


def rms_db(samples: np.ndarray) -> float:
    """RMS level in dBFS."""
    return float(20 * np.log10(max(float(np.sqrt(np.mean(samples**2))), 1e-9))) if len(samples) else -180.0


def loudest_windows(data: np.ndarray, rate: int, start: float, end: float, length: float, count: int) -> list[float]:  # noqa: PLR0913, PLR0917 -- Retain the established positional worker/helper interface.
    """Return the starts (s) of up to `count` loudest non-overlapping windows of `length` inside [start, end]."""
    if end - start <= length:
        return [start]
    steps = np.arange(start, end - length + 1e-9, length / 2)
    levels = [rms_db(data[int(t * rate) : int((t + length) * rate)]) for t in steps]
    chosen: list[float] = []
    for index in np.argsort(levels)[::-1]:
        candidate = float(steps[index])
        if all(abs(candidate - other) >= length for other in chosen):
            chosen.append(candidate)
        if len(chosen) == count:
            break
    return sorted(chosen)


def measure_region(ref: np.ndarray, target: np.ndarray, rate: int, region: tuple[float, float], length: float, offset: float, search: float) -> dict[str, float] | None:  # noqa: PLR0913, PLR0917 -- Retain the established positional worker/helper interface.
    """Median of up to three window measurements, so one pause or noise burst cannot decide the offset."""
    found = [m for at in loudest_windows(ref, rate, region[0], region[1], length, 3) if (m := measure(ref, target, rate, at, length, offset, search)) is not None]
    if not found:
        return None
    found.sort(key=lambda m: m["offsetSec"])
    middle = found[len(found) // 2]
    return {"referenceSec": float(np.mean([m["referenceSec"] for m in found])), "offsetSec": middle["offsetSec"], "peakRatio": float(np.median([m["peakRatio"] for m in found]))}


def measure(ref: np.ndarray, target: np.ndarray, rate: int, at: float, length: float, offset: float, search: float) -> dict[str, float] | None:  # noqa: PLR0913, PLR0917 -- Retain the established positional worker/helper interface.
    """GCC-PHAT offset of one window of `length` at reference time `at`, or None when either side is silent or outside."""
    a = round(at * rate)
    b = round((at - offset) * rate)
    n = int(length * rate)
    if a < 0 or b < 0 or a + n > len(ref) or b + n > len(target):
        return None
    x, y = ref[a : a + n], target[b : b + n]
    if rms_db(x) < SILENCE_DBFS or rms_db(y) < SILENCE_DBFS:
        return None
    lag, ratio = gcc_phat(x, y, int(search * rate), rate)
    return {"referenceSec": at + length / 2, "offsetSec": (a - b + lag) / rate, "peakRatio": ratio}


def refine(request: dict[str, Any]) -> dict[str, Any]:
    """Refine a coarse offset at the start of the overlap and measure it again at the end for drift."""
    ref, rate = read_wav(request["reference"])
    target, target_rate = read_wav(request["target"])
    if rate != target_rate:
        message = "reference and target sample rates differ"
        raise ValueError(message)
    coarse = float(request["coarseOffsetSec"])
    length = float(request["windowSec"])
    search = float(request["searchMs"]) / 1000
    overlap_start = max(0.0, coarse)
    overlap_end = min(len(ref) / rate, coarse + len(target) / rate)
    span = overlap_end - overlap_start
    if span <= 0:
        return {"overlap": [overlap_start, overlap_end], "start": None, "end": None}
    window = min(length, span)
    edge = min(span / 2, max(window * 1.5, span * 0.2))
    start = measure_region(ref, target, rate, (overlap_start, overlap_start + edge), window, coarse, search)
    end = None
    if start is not None and span >= float(request["minDriftSpanSec"]):
        wide = max(search, span * float(request["maxDriftPpm"]) * 1e-6)
        end = measure_region(ref, target, rate, (overlap_end - edge, overlap_end), window, start["offsetSec"], wide)
    return {"overlap": [overlap_start, overlap_end], "start": start, "end": end}


def energy(request: dict[str, Any]) -> dict[str, Any]:
    """Mean-square level per hop, in dB, for each WAV."""
    hop = float(request["hopSec"])
    series = []
    for file in request["files"]:
        data, rate = read_wav(file)
        step = int(hop * rate)
        count = len(data) // step
        frames = data[: count * step].reshape(count, step) if count else np.zeros((0, step))
        levels = 10 * np.log10(np.maximum(np.mean(frames**2, axis=1), 1e-18))
        series.append([round(float(v), 2) for v in levels])
    return {"hopSec": hop, "levels": series}


def box(rect: Iterable[int], score: float, size: tuple[int, int]) -> dict[str, float]:
    """Pixel rectangle to a normalised box."""
    x, y, width, height = rect
    return {"x": float(x / size[0]), "y": float(y / size[1]), "w": float(width / size[0]), "h": float(height / size[1]), "score": float(score)}


def detect(request: dict[str, Any]) -> dict[str, Any]:
    """Faces (YuNet) per sampled frame, and HOG people on samples without a face; boxes are normalised."""
    import cv2

    capture = cv2.VideoCapture(request["media"])
    if not capture.isOpened():
        message = f"OpenCV could not open {request['media']}"
        raise RuntimeError(message)
    fps = float(capture.get(cv2.CAP_PROP_FPS)) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = min(1.0, float(request["maxWidth"]) / width)
    small = (max(1, int(width * scale)), max(1, int(height * scale)))
    faces = cv2.FaceDetectorYN.create(request["model"], "", small, float(request["faceScore"]), 0.3, 50)
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(np.asarray(cv2.HOGDescriptor.getDefaultPeopleDetector(), dtype=np.float32))
    every = max(1, round(fps / float(request["sampleFps"])))
    samples = []
    index = 0
    while True:
        ok = capture.grab()
        if not ok:
            break
        if index % every == 0:
            ok, frame = capture.retrieve()
            if not ok:
                break
            image = cv2.resize(frame, small) if scale < 1 else frame
            _, found = faces.detect(image)
            boxes = [box(f[:4], f[14], small) for f in (found if found is not None else [])]
            people = []
            if not boxes:
                rects, weights = hog.detectMultiScale(image, winStride=(8, 8), padding=(8, 8), scale=1.05)
                people = [box(r, w, small) for r, w in zip(rects, np.ravel(weights), strict=False) if float(w) >= float(request["personScore"])]
            samples.append({"frame": index, "faces": boxes, "people": people})
        index += 1
    capture.release()
    return {"width": width, "height": height, "fps": fps, "frameCount": index, "samples": samples}


def main() -> None:
    """Run one operation on a request file."""
    operation, request_file = sys.argv[1], sys.argv[2]
    request = json.loads(Path(request_file).read_text(encoding="utf-8"))
    handlers = {"refine": refine, "energy": energy, "detect": detect}
    if operation not in handlers:
        message = f"unknown operation {operation}"
        raise SystemExit(message)
    sys.stdout.write(json.dumps(handlers[operation](request)))


if __name__ == "__main__":
    main()
