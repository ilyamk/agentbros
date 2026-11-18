"""Measures sound effects for the SFX index. Prints one JSON object on stdout.

Usage: sfx-index.py REQUEST.json

REQUEST holds {"files": [absolute paths]}. Run through uvx by src/lib/audio/sfx-index.ts, which pins
the packages. Each file is decoded by ffmpeg to 44.1 kHz mono float. Every value is measured from the
signal with no random state, so the same file gives the same entry.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any, overload

import numpy as np
import pyloudnorm

RATE = 44100
ENV_HOP = 220  # 5 ms
N_FFT = 2048
SPEC_HOP = 512
FLOOR_DB = -90.0
ONSET_REL_DB = -30.0
TAIL_REL_DB = -40.0
LOW_HZ = 250.0
HIGH_HZ = 4000.0


def decode(path: str) -> np.ndarray:
    """Decode the input audio into the worker sample format."""
    raw = subprocess.run(  # noqa: S603 -- Arguments are a literal vector; the worker never invokes a shell.
        ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],  # noqa: S607 -- Fixed local media tool resolved through the caller environment.
        capture_output=True,
        check=True,
        timeout=120,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


@overload
def db(value: np.ndarray) -> np.ndarray: ...


@overload
def db(value: float) -> float: ...


def db(value: np.ndarray | float) -> np.ndarray | float:
    """Convert amplitude to decibels with a finite floor."""
    return 20 * np.log10(np.maximum(value, 10 ** (FLOOR_DB / 20)))


def envelope(signal: np.ndarray) -> np.ndarray:
    """Measure the short-window amplitude envelope."""
    frames = max(1, math.ceil(len(signal) / ENV_HOP))
    padded = np.zeros(frames * ENV_HOP)
    padded[: len(signal)] = signal
    return np.sqrt(np.mean(padded.reshape(frames, ENV_HOP) ** 2, axis=1))


def spectrum(signal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Measure spectral energy and centroid features."""
    if len(signal) < N_FFT:
        signal = np.pad(signal, (0, N_FFT - len(signal)))
    count = 1 + (len(signal) - N_FFT) // SPEC_HOP
    index = np.arange(N_FFT)[None, :] + SPEC_HOP * np.arange(count)[:, None]
    power = np.abs(np.fft.rfft(signal[index] * np.hanning(N_FFT), axis=1)) ** 2
    return power, np.fft.rfftfreq(N_FFT, 1 / RATE)


def loudness(signal: np.ndarray) -> float | None:
    """Measure integrated loudness for a sufficiently long signal."""
    meter = pyloudnorm.Meter(RATE)
    padded = np.pad(signal, (0, max(0, int(0.5 * RATE) - len(signal))))
    value = meter.integrated_loudness(padded)
    return None if not math.isfinite(value) else round(float(value), 1)


def count_onsets(env_db: np.ndarray, peak_db: float) -> int:
    """Count separated onset peaks in the envelope."""
    rise = np.diff(env_db, prepend=env_db[0])
    hits = np.where((rise > 6) & (env_db > peak_db - 30))[0]
    count, last = 0, -100
    for hit in hits:
        if hit - last > 16:  # 80 ms
            count += 1
        last = hit
    return count


def classify(m: dict[str, Any]) -> str:
    """Classify the measured temporal features."""
    if m["attackSec"] <= 0.03 and m["peakFraction"] <= 0.35:
        return "texture" if m["onsetCount"] >= 4 and m["durationSec"] > 1.5 else "impulse"
    if m["peakFraction"] >= 0.6 and m["attackSec"] >= 0.3 * m["activeSec"]:
        return "swell"
    if 0.15 <= m["peakFraction"] < 0.6 and m["attackSec"] >= 0.04 and m["nearPeakShare"] < 0.6:
        return "sweep"
    if m["nearPeakShare"] >= 0.5:
        return "texture" if m["onsetCount"] >= 4 else "sustain"
    if 0.15 <= m["peakFraction"] < 0.6:
        return "sweep"
    return "texture" if m["onsetCount"] >= 4 else "impulse"


def measure(path: str) -> dict[str, Any]:
    """Measure the temporal, spectral and loudness features of one sound."""
    signal = decode(path)
    duration = len(signal) / RATE
    if len(signal) == 0 or float(np.max(np.abs(signal))) == 0.0:
        return {"durationSec": round(duration, 4), "silent": True}
    env = envelope(signal)
    env_db = db(env)
    hop_sec = ENV_HOP / RATE
    peak_index = int(np.argmax(env))
    peak_env_db = float(env_db[peak_index])
    onset_index = int(np.argmax(env_db >= peak_env_db + ONSET_REL_DB))
    above_tail = np.where(env_db >= peak_env_db + TAIL_REL_DB)[0]
    end_index = int(above_tail[-1]) + 1
    active = env_db[onset_index:end_index]
    peak_time = (peak_index + 0.5) * hop_sec
    attack = max(0.0, (peak_index - onset_index) * hop_sec)
    active_sec = max(hop_sec, (end_index - onset_index) * hop_sec)

    rise = np.diff(env_db[max(0, onset_index - 1) : peak_index + 2])
    steepest = float(np.max(rise)) if len(rise) else peak_env_db - FLOOR_DB
    sharpness = min(1.0, max(0.0, steepest / 24.0))  # dB per 5 ms: 24 dB in one hop is a hard click

    power, freqs = spectrum(signal)
    frame_energy = power.sum(axis=1)
    weights = frame_energy / max(frame_energy.sum(), 1e-20)
    centroids = (power * freqs[None, :]).sum(axis=1) / np.maximum(frame_energy, 1e-20)
    centroid = float((centroids * weights).sum())
    loud = frame_energy >= frame_energy.max() * 1e-3
    trend = 0.0
    if loud.sum() >= 4:
        t = np.linspace(0, 1, len(centroids))[loud]
        c = np.log2(np.maximum(centroids[loud], 20))
        w = weights[loud]
        t_mean = (t * w).sum() / w.sum()
        c_mean = (c * w).sum() / w.sum()
        trend = float(((t - t_mean) * (c - c_mean) * w).sum() / max(((t - t_mean) ** 2 * w).sum(), 1e-9))
    trajectory = "rising" if trend > 0.5 else "falling" if trend < -0.5 else "flat"
    total = max(float(power.sum()), 1e-20)
    low = float(power[:, freqs < LOW_HZ].sum()) / total
    high = float(power[:, freqs >= HIGH_HZ].sum()) / total

    measured: dict[str, Any] = {
        "durationSec": round(duration, 4),
        "onsetSec": round(onset_index * hop_sec, 4),
        "attackSec": round(attack, 4),
        "peakSec": round(peak_time, 4),
        "peakFraction": round(peak_time / duration, 3),
        "tailSec": round(max(0.0, (end_index - peak_index - 1) * hop_sec), 4),
        "activeSec": round(active_sec, 4),
        "integratedLufs": loudness(signal),
        "samplePeakDb": round(float(db(float(np.max(np.abs(signal))))), 2),
        "crestDb": round(float(db(float(np.max(np.abs(signal))))) - float(db(float(np.sqrt(np.mean(signal**2))))), 1),
        "centroidHz": round(centroid),
        "centroidTrend": round(trend, 2),
        "centroidTrajectory": trajectory,
        "bands": {"low": round(low, 3), "mid": round(1 - low - high, 3), "high": round(high, 3)},
        "transientSharpness": round(sharpness, 3),
        "nearPeakShare": round(float(np.mean(active >= peak_env_db - 6)), 3),
        "onsetCount": count_onsets(env_db, peak_env_db),
    }
    measured["dynamics"] = classify(measured)
    return measured


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    request = json.loads(Path(sys.argv[1]).read_text())
    results: dict[str, Any] = {}
    for path in request["files"]:
        try:
            results[path] = measure(path)
        except Exception as error:  # noqa: BLE001 - one bad file must not sink the index
            results[path] = {"error": str(error)[:300]}
    json.dump({"engine": f"numpy {np.__version__}, pyloudnorm", "results": results}, sys.stdout)


if __name__ == "__main__":
    main()
