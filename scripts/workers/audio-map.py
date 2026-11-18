# ruff: noqa: PLR2004  signal-processing thresholds are tuned numbers read in place, named where they recur
"""Reads a track's beats and dynamics into an audio map. Prints one JSON object on stdout.

Usage: audio-map.py WAV REQUEST.json

REQUEST holds {"imagePath": str | null, "title": str}. Run through uvx by
src/lib/audio-map/analyse.ts, which decodes the source to WAV and pins the packages.

Everything is measured from the signal with no random state, so the same file gives the same map.
gridTrust is judged from onsets against the tracker's grid, never from the evenness of the grid
itself: a beat tracker always returns an even grid, even on a pad with nothing to track.
"""

from __future__ import annotations

import itertools
import json
import sys
from importlib.metadata import version
from pathlib import Path
from typing import Any, SupportsFloat

import librosa
import numpy as np
from scipy import ndimage
from scipy import signal as scipy_signal

RATE = 22050
HOP = 256
N_FFT = 1024
FPS = RATE / HOP
CURVE_HOP = 4
CURVE_STEP = CURVE_HOP / FPS
JUMP_FRAMES = round(0.15 / CURVE_STEP)
MOMENT_MIN_DB = 6.5
QUIET_HOLD_SEC = 1.5
SWING_MIN_ACF = 0.4
REPEAT_SHARE = 0.6
ENDING_SEC = 1.0
LOW_HZ = 150.0
MID_HZ = (200.0, 3000.0)
HIGH_HZ = 5000.0

# Floors in dB below the track's loud level (p95 of short-term level).
SILENCE_REL_DB = -38.0
SILENCE_ABS_DB = -60.0
SILENCE_MIN_SEC = 0.2
LEVEL_HIGH_DB = -3.0
LEVEL_MID_DB = -12.0

# Raw flux, in dB per mel band: below this nothing actually started. Stops a steady pad's noise becoming onsets.
ONSET_ABS_FLOOR = 1.6
ONSET_DELTA = 0.05
ONSET_MIN_GAP_SEC = 0.05

GRID_RELIABLE = {"lift": 0.3, "lock": 0.3, "pulse": 0.3, "coverage": 0.45, "steady": 0.4}
GRID_NONE = {"onsetsPerBeat": 0.5, "coverage": 0.25, "lift": 0.1, "pulse": 0.12, "minOnsets": 8}


def db(values: np.ndarray) -> np.ndarray:
    """Convert amplitudes to decibels, floored at -120 dB."""
    return 20 * np.log10(np.maximum(values, 1e-6))


def to_frames(seconds: float) -> int:
    """Convert seconds to analysis frames."""
    return round(seconds * FPS)


def to_seconds(frame: float) -> float:
    """Convert analysis frames to seconds."""
    return float(frame) / FPS


def clip01(value: float) -> float:
    """Clamp a value to 0..1."""
    return float(np.clip(value, 0, 1))


def rounded(value: SupportsFloat) -> float:
    """Round to milliseconds for the map."""
    return round(float(value), 3)


def band_mask(freqs: np.ndarray, low: float, high: float) -> np.ndarray:
    """Select the STFT bins between two frequencies."""
    return (freqs >= low) & (freqs < high)


class Signal:
    """Short-time features shared by every measurement."""

    def __init__(self, samples: np.ndarray) -> None:
        """Compute every feature once from the mono samples."""
        self.samples = samples
        self.duration = len(samples) / RATE
        self.spectrum = np.abs(librosa.stft(samples, n_fft=N_FFT, hop_length=HOP))
        self.freqs = librosa.fft_frequencies(sr=RATE, n_fft=N_FFT)
        self.count = self.spectrum.shape[1]
        self.power = self.spectrum**2
        self.low = self.power[band_mask(self.freqs, 0, LOW_HZ)].sum(axis=0)
        self.mid = self.power[band_mask(self.freqs, *MID_HZ)].sum(axis=0)
        self.high = self.power[band_mask(self.freqs, HIGH_HZ, RATE)].sum(axis=0)
        self.attack_low = band_attacks(self.low)
        self.attack_mid = band_attacks(self.mid)
        self.attack_high = band_attacks(self.high)
        self.flatness = librosa.feature.spectral_flatness(S=self.spectrum)[0]
        self.rms = librosa.feature.rms(y=samples, frame_length=N_FFT, hop_length=HOP)[0][: self.count]
        self.level = db(self.rms)
        audible = self.level[self.level > SILENCE_ABS_DB]
        self.loud = float(np.percentile(audible, 95)) if audible.size else SILENCE_ABS_DB
        self.silent = self.level < max(self.loud + SILENCE_REL_DB, SILENCE_ABS_DB)
        mel = librosa.feature.melspectrogram(S=self.power, sr=RATE, n_mels=64)
        self.flux = librosa.onset.onset_strength(S=librosa.power_to_db(mel, ref=1.0, top_db=80), sr=RATE, hop_length=HOP)
        harmonic, percussive = librosa.decompose.hpss(self.spectrum, margin=1.5)
        del harmonic
        pmel = librosa.feature.melspectrogram(S=percussive**2, sr=RATE, n_mels=64)
        self.pulse = librosa.onset.onset_strength(S=librosa.power_to_db(pmel, ref=1.0, top_db=80), sr=RATE, hop_length=HOP)


def refine_onset(signal: Signal, seconds: float) -> float:
    """Return where the waveform starts to climb: the spectrum's window sees an attack early and its steepest rise late."""
    width = 128
    step = 16
    first = max(0, round((seconds - 0.05) * RATE))
    last = min(len(signal.samples), round((seconds + 0.06) * RATE))
    if last - first < width * 2:
        return seconds
    energy = np.sqrt(np.convolve(signal.samples[first:last] ** 2, np.ones(width) / width, mode="valid")[::step])
    if energy.size < 3:
        return seconds
    # The largest climb from a low point, so the tail of the hit before does not count as this attack.
    lows = np.minimum.accumulate(energy)
    top = int(np.argmax(energy - lows))
    base = float(lows[top])
    if energy[top] <= base:
        return seconds
    start = int(np.argmin(energy[: top + 1]))
    climbed = start + int(np.argmax(energy[start : top + 1] >= base + 0.25 * (float(energy[top]) - base)))
    return (first + climbed * step + width * 3 // 4) / RATE


def detect_onsets(signal: Signal, flux: np.ndarray | None = None) -> list[dict[str, Any]]:
    """Pick attacks from a flux curve, skipping noise below the absolute floor and silence."""
    flux = signal.flux if flux is None else flux
    peak = float(np.percentile(flux, 99.5))
    if peak < ONSET_ABS_FLOOR:
        return []
    normal = np.minimum(flux / peak, 1.5)
    wait = max(1, to_frames(ONSET_MIN_GAP_SEC))
    frames = librosa.util.peak_pick(normal, pre_max=3, post_max=3, pre_avg=9, post_avg=10, delta=ONSET_DELTA, wait=wait)
    onsets: list[dict[str, Any]] = []
    for raw_frame in frames:
        frame = int(raw_frame)
        if flux[frame] < ONSET_ABS_FLOOR or signal.silent[min(frame + 2, signal.count - 1)]:
            continue
        onsets.append({"frame": frame, "timeSec": refine_onset(signal, to_seconds(frame)), "strength": clip01(normal[frame])})
    return onsets


def band_attacks(band: np.ndarray) -> np.ndarray:
    """Attack of one band, scaled by that band's own strong attacks: a hat is small in the mix but large for its band."""
    root = np.sqrt(band)
    rise = np.maximum(0.0, root - ndimage.uniform_filter1d(root, size=5, origin=2))
    scale = float(np.percentile(rise[rise > 0], 98)) if np.any(rise > 0) else 1.0
    return rise / max(scale, 1e-9)


def classify_drum(signal: Signal, frame: int) -> str:
    """Which band led the attack, then whether what followed decays like a drum or holds like a note or a word."""
    start, stop = max(0, frame - 2), min(signal.count, frame + 4)
    low = float(signal.attack_low[start:stop].max())
    mid = float(signal.attack_mid[start:stop].max())
    high = float(signal.attack_high[start:stop].max())
    flat = float(signal.flatness[frame:stop].mean()) if stop > frame else 0.0
    attack = float(signal.rms[frame:stop].max()) if stop > frame else 0.0
    later = signal.rms[min(signal.count - 1, frame + to_frames(0.12)) : min(signal.count, frame + to_frames(0.2))]
    decays = later.size == 0 or float(later.mean()) < 0.7 * attack
    if max(low, mid, high) < 0.15:
        return "onset"
    if low >= 0.3 and low >= 0.8 * mid:
        return "kick"
    if high >= 0.15 and low < 0.5 * high and mid < 0.75 * high:
        return "hat"
    if mid >= 0.3 and high >= 0.15 and flat >= 0.02 and decays:
        return "snare"
    return "perc" if decays else "onset"


def autocorrelation(curve: np.ndarray) -> np.ndarray:
    """Normalised autocorrelation of a curve, by FFT."""
    centred = curve - curve.mean()
    size = len(centred)
    if size < 4 or not np.any(centred):
        return np.zeros(max(size, 1))
    spectrum = np.fft.rfft(centred, 2 * size)
    full = np.fft.irfft(spectrum * np.conj(spectrum))[:size]
    return full / max(float(full[0]), 1e-9)


def pulse_at(curve: np.ndarray, period: float) -> float:
    """How strongly the envelope repeats at the beat period, or at the bar's half when the beat itself rests."""
    acf = autocorrelation(curve)
    best = 0.0
    for multiple in (1, 2):
        lag = round(period * multiple * FPS)
        if 1 < lag < len(acf) - 2:
            best = max(best, float(acf[lag - 2 : lag + 3].max()))
    return clip01(best)


def fold_beats(signal: Signal, bpm: float, frames: np.ndarray) -> tuple[float, np.ndarray]:
    """Folds a track of beats into the 70 to 180 BPM a person would count."""
    beats = librosa.frames_to_time(frames, sr=RATE, hop_length=HOP)
    if bpm <= 0 or len(beats) < 4:
        return bpm, beats
    if bpm > 180:
        strength = [signal.pulse[np.minimum(frames[phase::2], signal.count - 1)].mean() for phase in range(2)]
        beats = beats[int(np.argmax(strength)) :: 2]
    elif bpm < 70:
        beats = np.sort(np.concatenate([beats, (beats[:-1] + beats[1:]) / 2]))
    if len(beats) >= 8:
        bpm = float(60 / np.polyfit(np.arange(len(beats)), beats, 1)[0])
    return bpm, beats


def tempo_candidates(signal: Signal) -> list[float]:
    """Repeats in the attacks and in the low end, with no pull towards 120. The tracker's prior misses tempi far from it."""
    found: list[float] = []
    low = signal.attack_low
    for curve in (signal.pulse, low):
        acf = autocorrelation(curve)
        first, last = to_frames(60 / 190), min(len(acf) - 2, to_frames(60 / 60))
        if last <= first + 2:
            continue
        lags = [lag for lag in range(first, last) if acf[lag] > acf[lag - 1] and acf[lag] >= acf[lag + 1] and acf[lag] > 0.05]
        lags.sort(key=lambda lag: (-acf[lag], lag))
        found += [60 / to_seconds(lag) for lag in lags[:3]]
    unique: list[float] = []
    for bpm in found:
        if all(abs(bpm - other) / other > 0.03 for other in unique):
            unique.append(bpm)
    return unique


def track_beats(signal: Signal, pulse_onsets: list[dict[str, Any]]) -> tuple[float, np.ndarray, dict[str, Any]]:
    """Run the tracker at its own tempo and at each measured repeat, and keep the grid the attacks agree with most."""
    tempo, frames = librosa.beat.beat_track(onset_envelope=signal.pulse, sr=RATE, hop_length=HOP, units="frames", start_bpm=120.0, tightness=100)
    runs = [fold_beats(signal, float(np.atleast_1d(tempo)[0]), frames)]
    for candidate in tempo_candidates(signal):
        if all(abs(candidate - bpm) / max(bpm, 1e-6) > 0.03 for bpm, _ in runs):
            _, fixed = librosa.beat.beat_track(onset_envelope=signal.pulse, sr=RATE, hop_length=HOP, units="frames", bpm=candidate, tightness=100)
            runs.append(fold_beats(signal, candidate, fixed))
    best: tuple[float, np.ndarray, dict[str, Any]] | None = None
    best_score = -1.0
    for bpm, beats in runs:
        verdict = judge_grid(signal, beats, pulse_onsets)
        score = verdict["lift"] + verdict["lock"] + 0.5 * verdict["pulse"]
        if score > best_score + 1e-6:
            best, best_score = (bpm, beats, verdict), score
    if best is None:
        msg = "no beat-tracker run"
        raise RuntimeError(msg)
    return best


def align_common(beats: np.ndarray, onsets: list[dict[str, Any]]) -> np.ndarray:
    """Shift the whole grid by the median offset of the attacks near its beats."""
    if not len(beats) or not onsets:
        return beats
    times = np.array([item["timeSec"] for item in onsets])
    offsets = []
    for beat in beats:
        index = int(np.argmin(np.abs(times - beat)))
        if abs(times[index] - beat) <= 0.06:
            offsets.append(times[index] - beat)
    return beats + (float(np.median(offsets)) if offsets else 0.0)


def align_beats(beats: np.ndarray, onsets: list[dict[str, Any]]) -> np.ndarray:
    """Move the grid onto the attacks it stands for: first by its common offset, then each beat that has an attack."""
    if not len(beats) or not onsets:
        return beats
    times = np.array([item["timeSec"] for item in onsets])
    shifted = align_common(beats, onsets)
    aligned = shifted.copy()
    for position, beat in enumerate(shifted):
        index = int(np.argmin(np.abs(times - beat)))
        if abs(times[index] - beat) <= 0.02:
            aligned[position] = times[index]
    return np.maximum.accumulate(aligned)


def pulsed_beats(signal: Signal, beats: np.ndarray) -> np.ndarray:
    """Drop the stretches where the tracker ran on over speech or a pad: a track can have a real grid only in part of it."""
    if len(beats) < 8:
        return beats
    period = float(np.median(np.diff(beats)))
    reach = to_frames(2.5)
    frames = (beats * FPS).astype(int)
    heard = np.array([pulse_at(signal.pulse[max(0, frame - reach) : frame + reach], period) >= 0.15 for frame in frames])
    runs = spans(heard, 0.0)
    kept = np.zeros(len(beats), dtype=bool)
    for start, end in runs:
        if end - start >= 8:
            kept[start:end] = True
    return beats[kept] if kept.any() else beats


def judge_grid(signal: Signal, beats: np.ndarray, onsets: list[dict[str, Any]]) -> dict[str, Any]:
    """Compare the grid with what is actually there.

    Each number answers: would this happen with no pulse at all?
    """
    empty = {"lift": 0.0, "lock": 0.0, "pulse": 0.0, "coverage": 0.0, "steady": 0.0, "onsetsPerBeat": 0.0, "onBeatShare": 0.0, "chanceShare": 0.0}
    if len(beats) < 4:
        return {**empty, "trust": "none", "confidence": 0.0}
    period = float(np.median(np.diff(beats)))
    # The envelope sees attacks early, so judge a grid already moved onto them, or a true grid scores as a poor one.
    beats = align_common(beats, onsets)
    audible = beats[~signal.silent[np.minimum((beats * FPS).astype(int), signal.count - 1)]]
    times = np.array([item["timeSec"] for item in onsets]) if onsets else np.zeros(0)
    weights = np.array([item["strength"] ** 2 for item in onsets]) if onsets else np.zeros(0)
    per_beat = len(onsets) / max(len(audible), 1)

    # Share of onset strength on the eighth-note grid, against the share a uniform scatter would land there by chance.
    tolerance = min(0.04, period / 8)
    if times.size:
        eighths = np.sort(np.concatenate([beats, (beats[:-1] + beats[1:]) / 2]))
        nearest = np.abs(times[:, None] - eighths[None, :]).min(axis=1)
        share = float(weights[nearest <= tolerance].sum() / max(float(weights.sum()), 1e-9))
        coverage = float(np.mean(np.abs(audible[:, None] - times[None, :]).min(axis=1) <= 0.05)) if audible.size else 0.0
    else:
        share = 0.0
        coverage = 0.0
    chance = min(0.95, 2 * tolerance / (period / 2))
    lift = max(0.0, (share - chance) / (1 - chance))

    # Do attacks keep one position inside the beat? Scattered attacks cancel out to 0, and any offset or swing still scores.
    lock = 0.0
    if times.size:
        inside = (times >= beats[0]) & (times <= beats[-1])
        if inside.sum() >= 4:
            phase = np.interp(times[inside], beats, np.arange(len(beats)))
            kept = weights[inside]
            lock = max(float(np.abs((kept * np.exp(2j * np.pi * multiple * phase)).sum()) / max(float(kept.sum()), 1e-9)) for multiple in (1, 2, 4))

    pulse = pulse_at(signal.pulse, period)
    # Pulse in each stretch of the track: a grid that holds only in one corner is not a grid for the film.
    size = to_frames(8.0)
    hop = to_frames(4.0)
    windows = [signal.pulse[start : start + size] for start in range(0, max(1, len(signal.pulse) - size + 1), hop)]
    windows = [window for window in windows if window.mean() > 0.05 * max(float(signal.pulse.mean()), 1e-9)]
    steady = float(np.mean([pulse_at(window, period) >= 0.2 for window in windows])) if windows else 0.0

    numbers = {"lift": lift, "lock": lock, "pulse": pulse, "coverage": coverage, "steady": steady, "onsetsPerBeat": per_beat, "onBeatShare": share, "chanceShare": chance}
    if len(onsets) < GRID_NONE["minOnsets"] or per_beat < GRID_NONE["onsetsPerBeat"] or coverage < GRID_NONE["coverage"] or (lift < GRID_NONE["lift"] and pulse < GRID_NONE["pulse"]):
        trust = "none"
    elif all(numbers[key] >= floor for key, floor in GRID_RELIABLE.items()):
        trust = "reliable"
    else:
        trust = "weak"
    confidence = 0.4 * clip01(lift) + 0.3 * clip01(pulse / 0.7) + 0.15 * clip01(coverage) + 0.15 * clip01(steady)
    if trust == "none":
        confidence = min(confidence, 0.2)
    return {**numbers, "trust": trust, "confidence": clip01(confidence)}


def find_downbeats(signal: Signal, beats: np.ndarray) -> tuple[np.ndarray, float]:
    """Return the bar phase (assuming four beats) whose beats carry the most low-end attack."""
    if len(beats) < 8:
        return beats[:0], 0.0
    frames = np.minimum((beats * FPS).astype(int), signal.count - 1)
    low = np.maximum(0, np.diff(np.sqrt(signal.low), prepend=np.sqrt(signal.low[:1])))
    low = low / max(float(low.max()), 1e-9)
    flux = signal.pulse / max(float(signal.pulse.max()), 1e-9)
    score = np.array([max(float(low[max(0, frame - 3) : frame + 4].max()) + 0.5 * float(flux[max(0, frame - 3) : frame + 4].max()), 0.0) for frame in frames])
    phases = [float(score[phase::4].mean()) for phase in range(4)]
    best = int(np.argmax(phases))
    ordered = sorted(phases)
    return beats[best::4], clip01((ordered[-1] - ordered[-2]) / max(ordered[-1], 1e-6))


def metric_of(seconds: float, beats: np.ndarray, downbeats: np.ndarray, trust: str) -> str:
    """Name an event's place on the grid: downbeat, beat, offbeat or off-grid."""
    if trust == "none" or len(beats) < 2:
        return "off-grid"
    index = int(np.clip(np.searchsorted(beats, seconds) - 1, 0, len(beats) - 2))
    period = float(beats[index + 1] - beats[index])
    if seconds < beats[0] - period or seconds > beats[-1] + period:
        return "off-grid"
    position = (seconds - beats[index]) / max(period, 1e-6)
    distance = min(abs(position), abs(position - 1)) * period
    if distance <= min(0.06, period * 0.12):
        anchor = beats[index] if abs(position) <= abs(position - 1) else beats[index + 1]
        if len(downbeats) and float(np.abs(downbeats - anchor).min()) < 1e-6:
            return "downbeat"
        return "beat"
    quarter = abs(position * 4 - round(position * 4)) / 4 * period
    return "offbeat" if quarter <= min(0.035, period * 0.08) else "off-grid"


def spans(mask: np.ndarray, minimum: float) -> list[tuple[int, int]]:
    """Return runs of True frames that last at least `minimum` seconds."""
    labelled, count = ndimage.label(mask)
    found = []
    for index in range(1, count + 1):
        where = np.nonzero(labelled == index)[0]
        if to_seconds(where[-1] + 1 - where[0]) >= minimum:
            found.append((int(where[0]), int(where[-1]) + 1))
    return found


def find_silences(signal: Signal) -> list[tuple[int, int]]:
    """Return silent runs long enough to count."""
    return spans(signal.silent, SILENCE_MIN_SEC)


def level_curve(signal: Signal) -> np.ndarray:
    """Return the smoothed level, decimated to the curve step."""
    return ndimage.uniform_filter1d(signal.level, size=max(1, to_frames(0.1)))[::CURVE_HOP]


def find_risers(signal: Signal) -> list[tuple[float, float]]:
    """Find sustained climbs of level or of the top end, longer than a swell of speech can hold."""
    found: list[tuple[float, float]] = []
    floor = signal.loud - 45
    level = np.maximum(ndimage.uniform_filter1d(signal.level, size=to_frames(0.25)), floor)[::CURVE_HOP]
    high = np.maximum(ndimage.uniform_filter1d(10 * np.log10(np.maximum(signal.high, 1e-10)), size=to_frames(0.25)), -60)[::CURVE_HOP]
    for curve, needed in ((level, 8.0), (high, 10.0)):
        index = 0
        while index < len(curve) - 1:
            top = index
            end = index
            for probe in range(index + 1, len(curve)):
                if curve[probe] > curve[top]:
                    top = probe
                if curve[top] - curve[probe] > 2.0:
                    break
                end = probe
            duration = (top - index) * CURVE_STEP
            climb = curve[top] - curve[index]
            if duration >= 1.2 and climb >= needed:
                steps = np.diff(curve[index : top + 1])
                # A level that sits flat and then jumps is a surge. A riser spreads its climb out.
                reach = max(1, round(0.5 / CURVE_STEP))
                largest = float(np.max(curve[index + reach : top + 1] - curve[index : top + 1 - reach])) if top - index > reach else climb
                if float(np.mean(steps > -0.05)) >= 0.75 and largest <= 0.6 * climb:
                    found.append((index * CURVE_STEP, top * CURVE_STEP))
                    index = top + 1
                    continue
            index = max(index + 1, end if end > index + 4 else index + 1)
    found.sort()
    merged: list[tuple[float, float]] = []
    for start, end in found:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def arrives(signal: Signal, end: float, onsets: list[dict[str, Any]], silences: list[tuple[int, int]]) -> bool:
    """Tell whether a riser resolves in a hit or is cut off; a swell that only crests and falls away leads nowhere."""
    if any(abs(item["timeSec"] - end) <= 0.7 and item["strength"] >= 0.3 for item in onsets):
        return True
    return any(abs(to_seconds(start) - end) <= 0.3 for start, _ in silences) or end >= signal.duration - 0.3


def level_period(curve: np.ndarray) -> int | None:
    """Return the level's own repeat, in curve steps, when it swings with a bar or a phrase; None when it does not."""
    first, last = round(0.8 / CURVE_STEP), round(4.0 / CURVE_STEP)
    acf = autocorrelation(curve)
    if len(acf) <= last + 1:
        return None
    lag = first + int(np.argmax(acf[first:last]))
    return lag if acf[lag] >= SWING_MIN_ACF else None


def find_moments(signal: Signal, silences: list[tuple[int, int]], risers: list[tuple[float, float]], onsets: list[dict[str, Any]]) -> list[dict[str, Any]]:  # noqa: C901, PLR0912, PLR0915  one pass per moment kind keeps the thresholds side by side
    """Lasting changes of level. Upper percentiles ride over the gaps between words and between drum hits."""
    moments: list[dict[str, Any]] = []
    curve = np.maximum(level_curve(signal), signal.loud - 45)
    span = round(1.0 / CURVE_STEP)
    deltas = np.zeros(len(curve))
    for index in range(1, len(curve) - 1):
        before = curve[max(0, index - span) : index]
        after = curve[index : min(len(curve), index + span)]
        if before.size >= 4 and after.size >= 4:
            deltas[index] = np.percentile(after, 80) - np.percentile(before, 80)
    onset_times = np.array([item["timeSec"] for item in onsets]) if onsets else np.zeros(0)
    swing = level_period(curve)

    def repeats(index: int, value: float, signed: np.ndarray) -> bool:
        """Tell whether the level makes this swing again a period earlier and later: then it is texture, not a change.

        Both sides must repeat where the track has them, so a groove that starts here is still a surge.
        """
        if swing is None:
            return False
        reach = max(1, round(0.15 / CURVE_STEP))
        neighbours = [neighbour for neighbour in (index - swing, index + swing) if reach <= neighbour < len(signed) - reach]
        return bool(neighbours) and all(float(signed[neighbour - reach : neighbour + reach + 1].max()) >= REPEAT_SHARE * value for neighbour in neighbours)

    def pick(sign: int, kind: str) -> None:  # noqa: C901  each check is one sentence of why a change is not a moment
        signed = deltas * sign
        order = np.argsort(-signed, kind="stable")
        taken: list[int] = []
        for index in order:
            value = float(signed[index])
            # Above what a slow swell can reach in this window: a point to cut on is a change, not a slope.
            if value < MOMENT_MIN_DB:
                break
            if any(abs(index - other) * CURVE_STEP < 1.5 for other in taken):
                continue
            taken.append(int(index))
            if repeats(int(index), value, signed):
                continue
            # The window peaks late. A surge starts at the first upward crossing of halfway, a drop at the last downward one.
            # Halfway is measured from the loudest of the quiet side, so small ticks before a surge do not count as it.
            first = max(0, index - span)
            last = min(len(curve), index + span)
            quiet = curve[first:index] if sign > 0 else curve[index:last]
            loud = curve[index:last] if sign > 0 else curve[first:index]
            # Ticks in a quiet intro rise and fall by many dB and mean nothing: the loud side has to be properly loud.
            if float(np.percentile(loud, 95)) < signal.loud - 10:
                continue
            halfway = (float(np.percentile(quiet, 95)) + float(np.percentile(loud, 80))) / 2
            above = curve[first:last] >= halfway
            turns = np.nonzero(above[1:] & ~above[:-1])[0] + 1 if sign > 0 else np.nonzero(above[:-1] & ~above[1:])[0]
            if turns.size == 0:
                continue
            crossing = first + int(turns[0] if sign > 0 else turns[-1])
            at = crossing * CURVE_STEP
            # The track's own ending is not a drop: a fall in its last second is the fade or the stop.
            if sign < 0 and at > signal.duration - ENDING_SEC:
                continue
            # Lasting: the quiet side holds for longer than a bar's accent and decay. A level that swings every bar is texture.
            hold = round(QUIET_HOLD_SEC / CURVE_STEP)
            held = curve[max(0, crossing - hold) : crossing] if sign > 0 else curve[crossing : crossing + hold]
            if sign < 0 and crossing + hold > len(curve):
                continue
            if held.size and float(np.percentile(held, 80)) >= halfway:
                continue
            if sign > 0 and onset_times.size:
                # The hit that started it is at or just before the crossing: the one the level jumps at most across.
                near = onset_times[(onset_times >= at - 0.3) & (onset_times <= at + 0.1)]
                if near.size:
                    centres = [round(when / CURVE_STEP) for when in near]
                    jumps = [float(curve[centre : centre + JUMP_FRAMES].mean() - curve[max(0, centre - JUMP_FRAMES) : max(1, centre)].mean()) for centre in centres]
                    at = float(near[int(np.argmax(jumps))])
            moments.append({"timeSec": rounded(at), "kind": kind, "strength": rounded(clip01(value / 16.0))})

    pick(1, "surge")
    pick(-1, "drop")
    # A fade-in at the very start is not a moment. A level that swings every bar is texture: keep the largest swings.
    moments[:] = [moment for moment in moments if not (moment["kind"] == "surge" and moment["timeSec"] < 0.5)]
    moments.sort(key=lambda moment: (-moment["strength"], moment["timeSec"]))
    # A surge and a drop a blink apart describe one dip, and the stronger one names it.
    kept: list[dict[str, Any]] = []
    for moment in moments:
        if all(abs(moment["timeSec"] - other["timeSec"]) >= 0.5 for other in kept):
            kept.append(moment)
    moments[:] = kept[: int(4 + signal.duration / 6)]

    # A hard stop is a drop into silence that takes a moment, not a fade.
    for start, _ in silences:
        if start < to_frames(0.3):
            continue
        before = signal.level[max(0, start - to_frames(0.5)) : start]
        fall = signal.level[max(0, start - to_frames(0.25)) : start]
        if before.size == 0:
            continue
        if float(np.percentile(before, 80)) >= signal.loud - 18 and float(fall.max()) >= signal.loud - 24:
            at = to_seconds(max(0, start - 1))
            moments[:] = [moment for moment in moments if not (moment["kind"] == "drop" and abs(moment["timeSec"] - at) < 1.5)]
            moments.append({"timeSec": rounded(at), "kind": "hard-stop", "strength": rounded(clip01((float(np.percentile(before, 80)) - signal.loud + 24) / 24))})

    for _, end in risers:
        # The climb arrives here even if the full level settles a beat later: that first hit is the moment to cut on.
        for moment in moments:
            if moment["kind"] == "surge" and -0.2 <= moment["timeSec"] - end <= 1.0:
                moment["timeSec"] = rounded(end)
        moments.append({"timeSec": rounded(end), "kind": "riser-end", "strength": 0.7})

    # An impact stands out from the hits around it, so a steady kick never qualifies.
    if onsets:
        flux_at = np.array([signal.flux[item["frame"]] for item in onsets])
        chosen: list[float] = []
        for index in np.argsort(-flux_at, kind="stable"):
            item = onsets[int(index)]
            near = np.abs(onset_times - item["timeSec"]) <= 3.0
            near[int(index)] = False
            around = flux_at[near]
            if around.size and flux_at[index] < 2.2 * float(np.percentile(around, 90)):
                continue
            if signal.level[min(item["frame"] + 2, signal.count - 1)] < signal.loud - 8:
                continue
            start, stop = max(0, item["frame"] - 2), min(signal.count, item["frame"] + 4)
            if max(float(signal.attack_low[start:stop].max()), float(signal.attack_mid[start:stop].max())) < 0.5:
                continue
            if any(abs(item["timeSec"] - at) < 1.5 for at in chosen):
                continue
            if any(abs(item["timeSec"] - moment["timeSec"]) < 0.15 for moment in moments):
                continue
            chosen.append(item["timeSec"])
            moments.append({"timeSec": rounded(item["timeSec"]), "kind": "impact", "strength": rounded(clip01(item["strength"]))})

    moments.sort(key=lambda moment: (moment["timeSec"], moment["kind"]))
    return moments


def novelty_curve(signal: Signal, half_width: float) -> tuple[np.ndarray, int]:
    """Checkerboard novelty over timbre and level, at ten frames a second."""
    step = max(1, round(0.1 * FPS))
    mel = librosa.feature.melspectrogram(S=signal.power, sr=RATE, n_mels=64)
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel), n_mfcc=13)[:, : signal.count]
    features = np.vstack([mfcc[1:], signal.level[None, :]])
    usable = np.abs(features).sum(axis=0) > 0
    if not usable.any():
        return np.zeros(max(1, signal.count // step)), step
    centre = features.mean(axis=1, keepdims=True)
    scale = features.std(axis=1, keepdims=True) + 1e-6
    coarse = ndimage.uniform_filter1d((features - centre) / scale, size=step, axis=1)[:, ::step]
    half = max(2, round(half_width / (step / FPS)))
    size = coarse.shape[1]
    novelty = np.zeros(size)
    for index in range(half, size - half):
        novelty[index] = float(np.linalg.norm(coarse[:, index : index + half].mean(axis=1) - coarse[:, index - half : index].mean(axis=1)))
    return novelty, step


def novelty_boundaries(signal: Signal, half_width: float, spacing: float, limit: int) -> list[float]:
    """Return the strongest timbre changes, at least `spacing` apart."""
    novelty, step = novelty_curve(signal, half_width)
    if not novelty.any():
        return []
    floor = float(np.median(novelty) + 0.75 * np.median(np.abs(novelty - np.median(novelty))))
    frame = step / FPS
    rises = np.r_[False, novelty[1:] >= novelty[:-1]] & np.r_[novelty[:-1] > novelty[1:], False]
    candidates = [int(index) for index in np.nonzero(rises & (novelty > floor))[0]]
    candidates.sort(key=lambda index: (-novelty[index], index))
    chosen: list[int] = []
    for index in candidates:
        if len(chosen) >= limit:
            break
        if all(abs(index - other) * frame >= spacing for other in chosen):
            chosen.append(index)
    return sorted(index * frame for index in chosen)


def tile(boundaries: list[float], duration: float, minimum: float) -> list[tuple[float, float]]:
    """Cut the track at the boundaries, dropping pieces shorter than `minimum`."""
    edges = [0.0]
    for at in sorted(boundaries):
        if at - edges[-1] >= minimum and duration - at >= minimum:
            edges.append(at)
    edges.append(duration)
    return list(itertools.pairwise(edges))


def mean_rms(signal: Signal, start: float, end: float) -> float:
    """Return the mean RMS between two times."""
    first = to_frames(start)
    return float(signal.rms[first : max(first + 1, to_frames(end))].mean())


def find_phrases(signal: Signal, downbeats: np.ndarray, trust: str, silences: list[tuple[int, int]], moments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Four-bar spans only when the grid is real. Otherwise boundaries come from the sound itself, not from the invented grid."""
    duration = signal.duration
    breaks = [to_seconds(frame) for pair in silences for frame in pair]
    breaks += [moment["timeSec"] for moment in moments if moment["kind"] in ("surge", "drop", "hard-stop") and moment["strength"] >= 0.3]
    if trust == "reliable" and len(downbeats) >= 4:
        novelty, step = novelty_curve(signal, 1.0)
        frame = step / FPS

        def novelty_at(at: float) -> float:
            return float(novelty[min(len(novelty) - 1, round(at / frame))])

        # Four bars, unless a slow tempo makes that longer than a viewer holds a phrase.
        bars = 4 if 4 * float(np.median(np.diff(downbeats))) <= 9.0 else 2
        scores = [sum(novelty_at(at) for at in downbeats[start::bars]) / max(1, len(downbeats[start::bars])) for start in range(bars)]
        boundaries = [float(at) for at in downbeats[int(np.argmax(scores)) :: bars]]
        outside = [at for at in novelty_boundaries(signal, 0.75, 1.5, max(1, round(duration / 2.5))) if at < downbeats[0] - 1.0 or at > downbeats[-1] + 2 * (downbeats[1] - downbeats[0])]
        pieces = tile(boundaries + breaks + outside, duration, 0.75)
    else:
        limit = max(1, round(duration / 2.5))
        pieces = tile(novelty_boundaries(signal, 0.75, 1.5, limit) + breaks, duration, 0.75)
    peak = max(max((mean_rms(signal, start, end) for start, end in pieces), default=0.0), 1e-6)
    return [{"startSec": rounded(start), "endSec": rounded(end), "energy": rounded(clip01(mean_rms(signal, start, end) / peak))} for start, end in pieces]


def describe_section(signal: Signal, start: float, end: float, density: float, period: float | None) -> str:
    """Describe a section's sound in a few words."""
    first = to_frames(start)
    last = max(first + 1, to_frames(end))
    low = float(signal.low[first:last].sum())
    mid = float(signal.mid[first:last].sum())
    high = float(signal.high[first:last].sum())
    total = low + mid + high + 1e-12
    tone = "bass-heavy" if low / total > 0.55 else "bright" if high / total > 0.25 else "full" if low / total > 0.25 and mid / total > 0.25 else "mid-forward"
    third = max(1, (last - first) // 3)
    change = float(signal.level[last - third : last].mean() - signal.level[first : first + third].mean())
    shape = "rising" if change > 3 else "falling" if change < -3 else "steady"
    busy = "sparse" if density < 1.5 else "busy" if density >= 5 else "moderate"
    pulse = ""
    if period:
        pulse = ", pulse" if last - first >= to_frames(2 * period) and pulse_at(signal.pulse[first:last], period) >= 0.2 else ", no pulse"
    return f"{tone}, {shape}, {busy}{pulse}"


def find_sections(  # noqa: PLR0913, PLR0917  every input is a measured layer of the same track
    signal: Signal, beats: np.ndarray, downbeats: np.ndarray, trust: str, onsets: list[dict[str, Any]], silences: list[tuple[int, int]], moments: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Split the track into sections by level and timbre, on downbeats when the grid is reliable."""
    duration = signal.duration
    width = float(np.clip(duration / 12, 1.0, 3.0))
    limit = int(np.clip(round(duration / 7), 1, 12))
    boundaries = novelty_boundaries(signal, width, max(2.0, duration / 16), limit)
    moves = sorted(
        (moment for moment in moments if moment["kind"] in ("surge", "drop", "hard-stop", "riser-end") and moment["strength"] >= 0.3), key=lambda moment: (-moment["strength"], moment["timeSec"])
    )
    breaks = [to_seconds(frame) for pair in silences for frame in pair if to_seconds(pair[1] - pair[0]) >= 0.5]
    # A lasting level change or silence is an edge in its own right, and more exact than a smoothed novelty peak.
    # Too close together, the largest change keeps its edge and the smaller one goes.
    shortest = min(2.0, max(1.0, duration / 12))
    exact: list[float] = list(breaks)
    for moment in moves:
        if all(abs(moment["timeSec"] - other) >= shortest for other in exact):
            exact.append(moment["timeSec"])
    boundaries = [at for at in boundaries if all(abs(at - other) > 1.0 for other in exact)] + exact
    if trust == "reliable" and len(beats):
        grid = downbeats if len(downbeats) else beats
        period = float(np.median(np.diff(beats)))
        snapped = []
        for at in boundaries:
            nearest = float(grid[int(np.argmin(np.abs(grid - at)))])
            snapped.append(nearest if abs(nearest - at) <= period / 2 else at)
        boundaries = snapped
    pieces = tile(sorted(set(boundaries)), duration, shortest)
    period_value = float(np.median(np.diff(beats))) if len(beats) >= 4 and trust != "none" else None
    times = np.array([item["timeSec"] for item in onsets]) if onsets else np.zeros(0)
    sections = []
    # Level against the loudest section: drums between their hits read quiet against any single peak.
    loudness = [20 * np.log10(max(mean_rms(signal, start, end), 1e-6)) for start, end in pieces]
    loudest = max(loudness, default=0.0)
    for (start, end), value in zip(pieces, loudness, strict=True):
        relative = value - loudest
        level = "high" if relative >= LEVEL_HIGH_DB else "mid" if relative >= LEVEL_MID_DB else "low"
        density = float(((times >= start) & (times < end)).sum()) / max(end - start, 1e-3)
        sections.append({"startSec": rounded(start), "endSec": rounded(end), "level": level, "density": round(density, 2), "feel": describe_section(signal, start, end, density, period_value)})
    return sections


def energy_curve(signal: Signal) -> list[dict[str, float]]:
    """Each curve reaches 1 at its own peak, so low and high can drive motion when they are quiet in the mix, but a band that is barely there stays near 0."""
    size = max(1, to_frames(0.05))

    def normal(values: np.ndarray, floor: float = 0.0) -> np.ndarray:
        smooth = ndimage.uniform_filter1d(values, size=size)
        # A percentile, so a click at the very start cannot flatten the rest of the curve.
        return np.clip(smooth / max(float(np.percentile(smooth, 99.5)), floor, 1e-9), 0, 1)

    whole = float(np.percentile(np.sqrt(signal.low + signal.mid + signal.high), 99.5))
    rms = normal(signal.rms)
    low = normal(np.sqrt(signal.low), 0.1 * whole)
    high = normal(np.sqrt(signal.high), 0.1 * whole)
    return [{"timeSec": rounded(index / FPS), "rms": rounded(rms[index]), "low": rounded(low[index]), "high": rounded(high[index])} for index in range(0, signal.count, CURVE_HOP)]


# --- Drums, and the grid they prove ---

DRUM_RATE = 44100
DRUM_HOP = 64
DRUM_FPS = DRUM_RATE / DRUM_HOP
DRUM_BANDS = {"kick": (30.0, 140.0), "snare": (180.0, 4000.0), "hat": (7000.0, 16000.0)}
DRUM_GAP_SEC = {"kick": 0.09, "snare": 0.09, "hat": 0.05}
DRUM_RISE_DB = {"kick": 9.0, "snare": 7.0, "hat": 7.0}
BACKBEAT_WEIGHT = 1.5
BAR_KNOWN_CONFIDENCE = 0.2
DRUM_WEIGHT = {"kick": 1.0, "snare": 0.8, "hat": 0.4}
TEMPO_RANGE = (70.0, 180.0)
DRUM_GRID_RELIABLE = {"hits": 12, "lift": 0.5, "coverage": 0.75, "residualSec": 0.01, "beats": 16}


def band_envelope(samples: np.ndarray, low: float, high: float) -> np.ndarray:
    """Band power in dB every DRUM_HOP samples, through a zero-phase filter so the envelope does not lag the hit."""
    sos = scipy_signal.butter(4, [low, min(high, DRUM_RATE / 2 - 100)], btype="bandpass", fs=DRUM_RATE, output="sos")
    banded = scipy_signal.sosfiltfilt(sos, samples)
    # At least a cycle of the band's centre, so a kick's 60 Hz does not ripple into false attacks.
    window = round(max(0.003, 1.5 / np.sqrt(low * high)) * DRUM_RATE)
    power = np.convolve(banded**2, np.ones(window) / window, mode="same")[::DRUM_HOP]
    return 10 * np.log10(np.maximum(power, 1e-12))


def climb_start(samples: np.ndarray, seconds: float) -> float:
    """Where the waveform starts the climb that peaks nearest after `seconds`: the hit's own start, not the window's view of it."""
    width, step = 64, 8
    first = max(0, round((seconds - 0.03) * DRUM_RATE))
    last = min(len(samples), round((seconds + 0.03) * DRUM_RATE))
    if last - first < width * 4:
        return seconds
    energy = np.sqrt(np.convolve(samples[first:last] ** 2, np.ones(width) / width, mode="valid")[::step])
    lows = np.minimum.accumulate(energy)
    top = int(np.argmax(energy - lows))
    base = float(lows[top])
    if energy[top] <= base:
        return seconds
    start = int(np.argmin(energy[: top + 1]))
    climbed = start + int(np.argmax(energy[start : top + 1] >= base + 0.2 * (float(energy[top]) - base)))
    return (first + climbed * step + width // 2) / DRUM_RATE


def band_hits(envelope: np.ndarray, kind: str) -> list[tuple[float, float]]:
    """Peaks of the rise in one band's level: (seconds, rise in dB)."""
    lag = round(0.012 * DRUM_FPS)
    loud = float(np.percentile(envelope, 99))
    floor = loud - 30
    clipped = np.maximum(envelope, floor)
    rise = np.zeros_like(clipped)
    rise[lag:] = clipped[lag:] - clipped[:-lag]
    frames = librosa.util.peak_pick(rise, pre_max=lag, post_max=lag, pre_avg=lag * 4, post_avg=lag, delta=DRUM_RISE_DB[kind] * 0.5, wait=round(DRUM_GAP_SEC[kind] * DRUM_FPS))
    found = []
    for frame in frames:
        peak = float(clipped[frame : frame + round(0.03 * DRUM_FPS)].max())
        if rise[frame] >= DRUM_RISE_DB[kind] and peak >= loud - 24:
            found.append((float(frame - lag / 2) / DRUM_FPS, float(rise[frame])))
    return found


def transcribe_drums(samples: np.ndarray) -> dict[str, list[dict[str, float]]]:
    """Kick, snare and hat hits from band-limited attacks. On a drum stem the bands are clean; on a mix they are a fair guess."""
    envelopes = {kind: band_envelope(samples, *DRUM_BANDS[kind]) for kind in DRUM_BANDS}
    raw = {kind: band_hits(envelopes[kind], kind) for kind in DRUM_BANDS}
    reach = round(0.03 * DRUM_FPS)

    def peak(kind: str, at: float) -> float:
        frame = round(at * DRUM_FPS)
        return float(envelopes[kind][max(0, frame) : frame + reach].max()) - float(np.percentile(envelopes[kind], 99))

    def near(found: list[tuple[float, float]], at: float, distance: float = 0.03) -> bool:
        return any(abs(other - at) <= distance for other, _ in found)

    # A kick's click reaches the snare band, and a snare's noise the hat band. A hit counts only when its band is
    # nearly as loud, against its own loudest hits, as the drum whose spill it might be.
    kept: dict[str, list[tuple[float, float]]] = {"kick": raw["kick"], "snare": [], "hat": []}
    for at, rise in raw["snare"]:
        if not near(raw["kick"], at) or peak("snare", at) >= peak("kick", at) + 3:
            kept["snare"].append((at, rise))
    for at, rise in raw["hat"]:
        if near(kept["snare"], at) or (near(raw["kick"], at) and peak("hat", at) < peak("kick", at) + 3):
            continue
        kept["hat"].append((at, rise))
    hits: dict[str, list[dict[str, float]]] = {}
    for kind, found in kept.items():
        scale = float(np.percentile([rise for _, rise in found], 90)) if found else 1.0
        hits[kind] = [{"timeSec": climb_start(samples, at), "strength": clip01(rise / max(scale, 1e-6))} for at, rise in found]
    return hits


def rayleigh(times: np.ndarray, weights: np.ndarray, periods: np.ndarray) -> np.ndarray:
    """For each period, the weighted mean of the hits' phases as a complex number: length 1 when every hit sits on one grid."""
    total = max(float(weights.sum()), 1e-9)
    return (weights[None, :] * np.exp(2j * np.pi * times[None, :] / periods[:, None])).sum(axis=1) / total


def fit_period(times: np.ndarray, weights: np.ndarray) -> float | None:
    """Return the beat period the hits agree with, both on the beat and on its sixteenths, so a syncopated kick still counts.

    Hits on every beat also sit on every half beat: when the slower grid holds as well, the slower one wins.
    """
    if times.size < 6:
        return None
    bpms = np.arange(TEMPO_RANGE[0], TEMPO_RANGE[1] + 0.01, 0.02)
    periods = 60 / bpms
    score = np.abs(rayleigh(times, weights, periods)) + np.abs(rayleigh(times, weights, periods / 4))
    best = float(bpms[int(np.argmax(score))])
    slower = best / 2
    if slower >= TEMPO_RANGE[0]:
        near = np.abs(bpms - slower) <= 0.3
        if float(score[near].max()) >= 0.97 * float(score.max()):
            best = float(bpms[near][int(np.argmax(score[near]))])
    return 60 / best


def regress_grid(times: np.ndarray, weights: np.ndarray, period: float) -> tuple[float, float, np.ndarray, float]:
    """Least squares through the hits on the sixteenth grid: the average beats each hit's jitter.

    Returns (phase of one sixteenth, beat period, on-grid mask, residual); which sixteenth is the beat is decided later.
    """
    step = period / 4
    phase = float(np.angle(rayleigh(times, weights, np.array([step]))[0])) / (2 * np.pi) * step
    on = np.zeros(times.size, dtype=bool)
    residual = 1.0
    for reach in (0.03, 0.02, 0.015):
        index = np.round((times - phase) / step)
        on = np.abs(times - phase - index * step) <= min(reach, step * 0.3)
        if on.sum() < 4:
            return phase, period, on, residual
        slope, intercept = np.polyfit(index[on], times[on], 1, w=np.sqrt(weights[on]))
        step, phase = float(slope), float(intercept)
        residual = float(np.sqrt(np.average((times[on] - phase - index[on] * step) ** 2, weights=weights[on])))
    return phase, 4 * step, on, residual


def supported_span(times: np.ndarray, phase: float, period: float, on: np.ndarray) -> tuple[int, int]:
    """First and last beat of the stretch where most bars carry hits on the grid."""
    bars = np.unique(np.floor((times[on] - phase) / (4 * period) + 1e-6).astype(int))
    if bars.size == 0:
        return 0, -1
    present = np.zeros(bars[-1] - bars[0] + 1, dtype=bool)
    present[bars - bars[0]] = True
    window = 4
    if present.size < window:
        return int(bars[0]) * 4, int(bars[-1]) * 4 + 3
    dense = np.nonzero(np.convolve(present.astype(float), np.ones(window), mode="valid") >= 3)[0]
    if dense.size == 0:
        return int(bars[0]) * 4, int(bars[-1]) * 4 + 3
    first = int(dense[0]) + int(np.argmax(present[dense[0] : dense[0] + window]))
    last = int(dense[-1]) + window - 1 - int(np.argmax(present[dense[-1] : dense[-1] + window][::-1]))
    return (int(bars[0]) + first) * 4, (int(bars[0]) + last) * 4 + 3


def drum_grid(signal: Signal, hits: dict[str, list[dict[str, float]]], bass: list[dict[str, float]] | None) -> dict[str, Any] | None:
    """Tempo and phase fitted to the drum hits, judged by how tightly they sit on the sixteenths and how many bars they fill."""
    chosen = [(item["timeSec"], DRUM_WEIGHT[kind] * (0.4 + 0.6 * item["strength"]), kind) for kind in ("kick", "snare", "hat") for item in hits[kind]]
    if sum(1 for *_, kind in chosen if kind != "hat") < 6:
        return None
    chosen.sort()
    times = np.array([at for at, *_ in chosen])
    weights = np.array([weight for _, weight, _ in chosen])
    main = np.array([kind != "hat" for *_, kind in chosen])
    period = fit_period(times[main], weights[main])
    if period is None:
        return None
    phase, period, on, residual = regress_grid(times, weights, period)
    duration = signal.duration
    first, last = supported_span(times[main], phase, period, on[main])
    if last - first < 3:
        return None
    position, downbeat_confidence, terms = bar_position(signal, phase, period, hits, bass, (phase + first * period, phase + (last + 1) * period))
    phase += position * period / 4
    first, last = first - 4, last + 4
    beats = phase + np.arange(first, last + 1) * period
    beats = beats[(beats >= 0) & (beats <= duration)]
    span = (times[main & on].min() - period / 2, times[main & on].max() + period / 2)
    beats = beats[(beats >= span[0]) & (beats <= span[1])]
    if len(beats) < 4:
        return None
    inside = main & (times >= beats[0] - period / 2) & (times <= beats[-1] + period / 2)
    tolerance = 0.015
    step = period / 4
    distance = np.abs(times - phase - np.round((times - phase) / step) * step)
    share = float(weights[inside & (distance <= tolerance)].sum() / max(float(weights[inside].sum()), 1e-9))
    chance = min(0.95, 2 * tolerance / step)
    lift = max(0.0, (share - chance) / (1 - chance))
    bar_starts = beats[0] + np.arange(0, len(beats), 4) * period
    hit_times = times[inside & (distance <= tolerance)]
    filled = [int(((hit_times >= start - step / 2) & (hit_times < start + 4 * period - step / 2)).sum()) >= 2 for start in bar_starts]
    coverage = float(np.mean(filled)) if filled else 0.0
    count = int((inside & (distance <= tolerance)).sum())
    numbers = {"hits": count, "lift": lift, "coverage": coverage, "residualSec": residual, "beats": len(beats)}
    if (
        count >= DRUM_GRID_RELIABLE["hits"]
        and lift >= DRUM_GRID_RELIABLE["lift"]
        and coverage >= DRUM_GRID_RELIABLE["coverage"]
        and residual <= DRUM_GRID_RELIABLE["residualSec"]
        and len(beats) >= DRUM_GRID_RELIABLE["beats"]
    ):
        trust = "reliable"
    elif count >= 8 and lift >= 0.3:
        trust = "weak"
    else:
        trust = "none"
    confidence = 0.35 * clip01(lift) + 0.25 * clip01(coverage) + 0.2 * clip01(1 - residual / 0.02) + 0.2 * clip01(count / 32)
    if trust == "none":
        confidence = min(confidence, 0.2)
    downbeats = beats[np.round((beats - phase) / period).astype(int) % 4 == 0]
    return {
        "bpm": 60 / period,
        "periodSec": period,
        "phaseSec": float(phase % period),
        "beats": beats,
        "downbeats": downbeats,
        "downbeatConfidence": downbeat_confidence,
        "terms": terms,
        "trust": trust,
        "confidence": clip01(confidence),
        "numbers": numbers,
    }


def strength_at(times: np.ndarray, strengths: np.ndarray, beats: np.ndarray, reach: float) -> np.ndarray:
    """Return the strongest hit within `reach` of each grid time, or 0."""
    if times.size == 0:
        return np.zeros(len(beats))
    distance = np.abs(beats[:, None] - times[None, :])
    return np.where(distance <= reach, strengths[None, :], 0.0).max(axis=1)


def bar_position(  # noqa: PLR0913, PLR0917  every input is a measured layer of the same track
    signal: Signal, phase: float, period: float, hits: dict[str, list[dict[str, float]]], bass: list[dict[str, float]] | None, span: tuple[float, float]
) -> tuple[int, float, dict[str, list[float]]]:
    """Which of a bar's sixteen sixteenths is its first. Returns (sixteenth, confidence, the evidence for each).

    A section starts on a downbeat, so a lasting jump in level counts most; then the kick on one, the snare on two and
    four, a bass note on one, and hits on the beat rather than between beats.
    """
    step = period / 4
    reach = min(0.03, step * 0.4)
    start = phase + np.ceil((span[0] - phase) / (4 * period)) * 4 * period
    count = max(1, int((span[1] - start) / step))
    grid = start + np.arange(count) * step

    def at(found: list[dict[str, float]] | None) -> np.ndarray:
        if not found:
            return np.zeros(count)
        return strength_at(np.array([item["timeSec"] for item in found]), np.array([item["strength"] for item in found]), grid, reach)

    kick, snare, hat, low_notes = at(hits["kick"]), at(hits["snare"]), at(hits["hat"]), at(bass)
    level = np.maximum(signal.level, signal.loud - 45)
    whole = np.arange(-int(np.ceil(start / step)), int((signal.duration - start) / step) + 1) * step + start
    whole = whole[(whole >= 0) & (whole <= signal.duration)]
    frames = (whole * FPS).astype(int)
    beat = max(2, to_frames(period))
    # Typical level in the beat after against the loud level in the beat before: a section that starts here.
    jumps = np.array(
        [
            float(np.percentile(level[frame : frame + beat], 50) - np.percentile(level[max(0, frame - beat) : frame], 80)) if frame - beat >= 0 and frame + beat <= signal.count else 0.0
            for frame in frames
        ]
    )
    jumps = np.maximum(jumps, 0.0)
    whole_index = np.round((whole - start) / step).astype(int) % 16
    sixteenth = np.arange(count) % 16

    def fold(values: np.ndarray, offset: int, index: np.ndarray = sixteenth) -> float:
        picked = values[index == offset % 16]
        return float(picked.mean()) if picked.size else 0.0

    # Drums usually come in on a downbeat: the first firm kick on the grid votes for its own sixteenth.
    entry = -1
    for item in sorted(hits["kick"], key=lambda hit: hit["timeSec"]):
        offset = (item["timeSec"] - start) / step
        if item["strength"] >= 0.5 and abs(offset - round(offset)) * step <= reach:
            entry = round(offset) % 16
            break
    terms: dict[str, list[float]] = {"change": [], "kick": [], "backbeat": [], "bass": [], "onBeat": [], "entry": [1.0 if c == entry else 0.0 for c in range(16)]}
    for candidate in range(16):
        biggest = max((float(jumps[whole_index == (candidate + offset) % 16].max()) if np.any(whole_index == (candidate + offset) % 16) else 0.0) for offset in range(16))
        mine = float(jumps[whole_index == candidate].max()) if np.any(whole_index == candidate) else 0.0
        terms["change"].append(mine / max(biggest, 6.0))
        terms["kick"].append(fold(kick, candidate) - 0.5 * fold(kick, candidate + 8))
        terms["backbeat"].append(0.5 * (fold(snare, candidate + 4) + fold(snare, candidate + 12)) - 0.5 * (fold(snare, candidate) + fold(snare, candidate + 8)))
        terms["bass"].append(fold(low_notes, candidate) - float(low_notes.mean()))
        beat_hits = sum(fold(kick + snare + 0.5 * hat, candidate + 4 * beat) for beat in range(4)) / 4
        terms["onBeat"].append(beat_hits - float((kick + snare + 0.5 * hat).mean()))
    score = [2.0 * terms["change"][c] + terms["kick"][c] + terms["backbeat"][c] + 0.5 * terms["bass"][c] + 0.5 * terms["onBeat"][c] + terms["entry"][c] for c in range(16)]
    # Snares on beats two and four of some bar vote for the sixteenth that carries the beat, so a backbeat does not
    # end up between beats. The kick and level terms above still lead; this settles near-ties between offsets.
    backbeat_on = [max(terms["backbeat"][c] for c in range(16) if c % 4 == offset) for offset in range(4)]
    terms["beatSixteenth"] = [backbeat_on[c % 4] - float(np.mean(backbeat_on)) for c in range(16)]
    score = [score[c] + BACKBEAT_WEIGHT * terms["beatSixteenth"][c] for c in range(16)]
    best = int(np.argmax(score))
    ordered = sorted(score)
    confidence = clip01((ordered[-1] - ordered[-2]) / max(abs(ordered[-1]), 0.5))
    position = int(round((start - phase) / step) + best) % 16
    return position, confidence, {**terms, "score": score}


def choose_grid(tracker: dict[str, Any], drums: dict[str, Any] | None, *, from_stem: bool) -> str:
    """Choose which reading the map follows.

    A drum stem's reliable fit wins outright. Hits picked out of a full mix are trusted only where the tracker's
    beats sit on them, since a mix's bass can pass for a kick a sixteenth away.
    """
    if drums is None or drums["trust"] == "none":
        return "tracker"
    rank = {"none": 0, "weak": 1, "reliable": 2}
    if from_stem:
        if rank[drums["trust"]] > rank[tracker["trust"]] or (drums["trust"] == tracker["trust"] and drums["confidence"] >= tracker["confidence"]) or drums["trust"] == "reliable":
            return "drums-stem"
        return "tracker"
    beats = tracker["beats"]
    if len(beats) < 4 or abs(drums["bpm"] - tracker["bpm"]) / drums["bpm"] > 0.02:
        return "tracker"
    offsets = (beats - drums["phaseSec"]) / drums["periodSec"]
    agree = float(np.median(np.abs(offsets - np.round(offsets)))) <= 0.125
    return "drums-mix" if agree and rank[drums["trust"]] >= rank[tracker["trust"]] else "tracker"


def brief(result: dict[str, Any], diagnostics: dict[str, Any]) -> str:
    """Summarise the map in a few sentences for an agent."""
    tempo = result["tempo"]
    trust = str(tempo["gridTrust"])
    lines = []
    head = f"{result['durationSec']:.1f} s. "
    if trust == "reliable":
        span = f"{len(result['beatsSec'])} beats from {result['beatsSec'][0]:.2f} to {result['beatsSec'][-1]:.2f} s"
        head += f"{tempo['bpm']:.1f} BPM, grid reliable (confidence {tempo['confidence']:.2f}), {span}. Cut to downbeats and strong hits there; outside that span pace by phrases."
    elif trust == "weak":
        head += f"Tracker says {tempo['bpm']:.1f} BPM but the grid is weak (confidence {tempo['confidence']:.2f}). Pace by phrases, sections and key moments; do not cut to beats."
    else:
        head += "No usable beat grid"
        if diagnostics["trackerBpm"] > 0:
            head += f" (the tracker imposed {diagnostics['trackerBpm']:.0f} BPM, kept out of the map)"
        head += ". Pace by phrases, sections and key moments."
    lines.append(head)
    sections = "; ".join(f"{item['startSec']:.1f}-{item['endSec']:.1f} {item['level']} ({item['feel']})" for item in result["sections"])
    lines.append(f"Sections: {sections}.")
    moments = sorted(result["keyMoments"], key=lambda item: -item["strength"])[:6]
    if moments:
        lines.append("Key moments: " + ", ".join(f"{item['kind']} {item['timeSec']:.2f} s" for item in sorted(moments, key=lambda item: item["timeSec"])) + ".")
    if result["silences"]:
        lines.append("Silences: " + ", ".join(f"{item['startSec']:.2f}-{item['endSec']:.2f}" for item in result["silences"]) + ".")
    if result["risers"]:
        lines.append("Risers: " + ", ".join(f"{item['startSec']:.2f}-{item['endSec']:.2f}" for item in result["risers"]) + ".")
    return " ".join(lines)


def drum_events(onsets: list[dict[str, Any]], kinds: list[str], hits: dict[str, list[dict[str, float]]]) -> list[tuple[float, str, float]]:
    """Name the mix's onsets by the drums stem's hit under them, and add stem hits the mix's onsets missed.

    Only for a stem: on a full mix the band classifier in classify_drum names the onsets better than spill-prone bands.
    """
    named: list[tuple[float, str, float]] = []
    drum = sorted((item["timeSec"], kind, item["strength"]) for kind in ("kick", "snare", "hat") for item in hits[kind])
    times = np.array([at for at, _, _ in drum]) if drum else np.zeros(0)
    used = np.zeros(len(drum), dtype=bool)
    for item, kind in zip(onsets, kinds, strict=True):
        index = int(np.argmin(np.abs(times - item["timeSec"]))) if times.size else -1
        if index >= 0 and abs(times[index] - item["timeSec"]) <= 0.03:
            used[index] = True
            named.append((item["timeSec"], drum[index][1], item["strength"]))
        else:
            named.append((item["timeSec"], "onset" if kind in ("kick", "snare", "hat") else kind, item["strength"]))
    named += [(at, kind, strength) for (at, kind, strength), seen in zip(drum, used, strict=True) if not seen]
    return sorted(named)


def analyse(media: str, request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], np.ndarray]:
    """Measure the track and return the map, its diagnostics and the samples."""
    samples, _ = librosa.load(media, sr=RATE, mono=True)
    if samples.size < RATE // 10:
        msg = "Audio is shorter than 0.1 s"
        raise SystemExit(msg)
    signal = Signal(samples)
    onsets = detect_onsets(signal)
    bpm, beats, verdict = track_beats(signal, detect_onsets(signal, signal.pulse))
    verdict = {**verdict, "bpm": bpm}
    from_stem = bool(request.get("drumsPath"))
    drum_samples, _ = librosa.load(request["drumsPath"] if from_stem else media, sr=DRUM_RATE, mono=True)
    hits = transcribe_drums(drum_samples)
    bass: list[dict[str, float]] | None = None
    if request.get("bassPath"):
        bass_samples, _ = librosa.load(request["bassPath"], sr=DRUM_RATE, mono=True)
        bass = [{"timeSec": climb_start(bass_samples, at), "strength": clip01(rise / 24)} for at, rise in band_hits(band_envelope(bass_samples, 30.0, 300.0), "kick")]
    fitted = drum_grid(signal, hits, bass)
    source = choose_grid({**verdict, "beats": beats}, fitted, from_stem=from_stem)
    silences = find_silences(signal)
    downbeat_confidence = 0.0
    if source != "tracker" and fitted is not None:
        trust, confidence, bpm = str(fitted["trust"]), fitted["confidence"], fitted["bpm"]
        audible = lambda times: times[~signal.silent[np.minimum((times * FPS).astype(int), signal.count - 1)]]  # noqa: E731
        kept, downbeats, downbeat_confidence = audible(fitted["beats"]), audible(fitted["downbeats"]), fitted["downbeatConfidence"]
    else:
        trust, confidence = str(verdict["trust"]), verdict["confidence"]
        if trust == "none":
            kept = beats[:0]
        else:
            kept = pulsed_beats(signal, align_beats(beats, onsets)) if trust == "reliable" else beats
            kept = kept[~signal.silent[np.minimum((kept * FPS).astype(int), signal.count - 1)]]
        downbeats, downbeat_confidence = find_downbeats(signal, kept)
    kinds = [classify_drum(signal, item["frame"]) for item in onsets]
    named = drum_events(onsets, kinds, hits) if from_stem else [(item["timeSec"], kind, item["strength"]) for item, kind in zip(onsets, kinds, strict=True)]
    events = [{"timeSec": rounded(at), "kind": kind, "strength": rounded(strength), "metric": metric_of(at, kept, downbeats, trust)} for at, kind, strength in named]
    risers = [span for span in find_risers(signal) if arrives(signal, span[1], onsets, silences)]
    moments = find_moments(signal, silences, risers, onsets)
    period = float(np.median(np.diff(kept))) if len(kept) > 1 else 0.0
    bars = [{"startSec": rounded(start), "endSec": rounded(min(start + 4 * period, signal.duration))} for start in downbeats] if trust != "none" and period > 0 else []
    candidates = [
        {
            "source": "tracker",
            "trust": verdict["trust"],
            "confidence": rounded(verdict["confidence"]),
            **({"bpm": round(tracker_bpm, 2)} if (tracker_bpm := float(verdict.get("bpm", 0)) or 0) > 0 else {}),
        }
    ]
    if fitted is not None:
        candidates.append(
            {
                "source": "drums-stem" if from_stem else "drums-mix",
                "trust": fitted["trust"],
                "confidence": rounded(fitted["confidence"]),
                "bpm": round(fitted["bpm"], 2),
                "phaseSec": rounded(fitted["phaseSec"]),
            }
        )
    grid = {
        "source": source,
        "confidence": rounded(confidence),
        **({"periodSec": round(period, 5), "phaseSec": rounded(float(kept[0] % period))} if trust != "none" and period > 0 else {}),
        "beatsPerBar": 4,
        "downbeatConfidence": rounded(downbeat_confidence),
        # Below this the bar's start is a guess: downbeats are still listed, but they are not structure.
        "barKnown": trust != "none" and downbeat_confidence >= BAR_KNOWN_CONFIDENCE,
        **({"residualMs": round(fitted["numbers"]["residualSec"] * 1000, 1)} if source != "tracker" and fitted is not None else {}),
        "bars": bars,
        "candidates": candidates,
    }

    def compact(found: list[dict[str, float]]) -> list[dict[str, float]]:
        return [{"timeSec": rounded(item["timeSec"]), "strength": rounded(item["strength"])} for item in found]

    result = {
        "durationSec": rounded(signal.duration),
        "tempo": {"confidence": rounded(confidence), "gridTrust": trust, **({"bpm": round(bpm, 2)} if trust != "none" and bpm > 0 else {})},
        "beatsSec": [rounded(at) for at in kept],
        "downbeatsSec": [rounded(at) for at in downbeats],
        "phrases": find_phrases(signal, downbeats, trust, silences, moments),
        "sections": find_sections(signal, kept, downbeats, trust, onsets, silences, moments),
        "events": events,
        "keyMoments": moments,
        "silences": [{"startSec": rounded(to_seconds(start)), "endSec": rounded(to_seconds(end))} for start, end in silences],
        "risers": [{"startSec": rounded(start), "endSec": rounded(end)} for start, end in risers],
        "energyCurve": energy_curve(signal),
        "grid": grid,
        "drums": {"source": "drums-stem" if from_stem else "mix", **{kind: compact(hits[kind]) for kind in ("kick", "snare", "hat")}, **({"bass": compact(bass)} if bass is not None else {})},
    }
    diagnostics = {
        "engine": f"librosa-{version('librosa')}",
        "trackerBpm": round(float(verdict.get("bpm", 0)), 2),
        "downbeatConfidence": rounded(downbeat_confidence),
        "beatsPerBarAssumed": 4,
        "grid": {key: rounded(value) for key, value in verdict.items() if key not in ("trust", "confidence", "bpm")},
        "gridSource": source,
        **({"drumGrid": {key: rounded(value) for key, value in fitted["numbers"].items()}} if fitted is not None else {}),
    }
    return result, diagnostics, samples


# --- The picture agents read ---

INK = "#0b0b0b"
MUTED = "#52514e"
FAINT = "#c9c8c2"
SURFACE = "#fcfcfb"
LEVEL_FILL = {"low": "#cde2fb", "mid": "#6da7ec", "high": "#1c5cab"}
LEVEL_INK = {"low": INK, "mid": INK, "high": "#ffffff"}
DRUM_ROWS = ["kick", "snare", "hat", "perc", "onset"]
DRUM_COLOUR = {"kick": "#2a78d6", "snare": "#eb6834", "hat": "#1baf7a", "perc": "#eda100", "onset": "#52514e"}
MOMENT_COLOUR = {"surge": "#008300", "drop": "#e34948", "hard-stop": "#e34948", "riser-end": "#6250d6", "impact": "#0b0b0b"}
TRUST_NOTE = {"reliable": ("grid reliable", "#008300"), "weak": ("grid WEAK: do not cut to beats", "#b35c00"), "none": ("NO grid: pace by phrases, sections, key moments", "#c02a2a")}
SECONDS_PER_ROW = 60.0
GRID_SOURCE_LABEL = {"drums-stem": "drums stem", "drums-mix": "drum hits in the mix", "tracker": "beat tracker"}


def draw_row(figure: Any, spec: Any, samples: np.ndarray, map_data: dict[str, Any], start: float, end: float, *, is_last: bool) -> None:  # noqa: ANN401, C901, PLR0912, PLR0913, PLR0915, PLR0917  matplotlib objects are untyped; one panel per block reads better than helpers
    """Draw one row of the map: sections, waveform, energy, grid and hit rows."""
    from matplotlib.ticker import MultipleLocator

    grid = spec.subgridspec(5, 1, height_ratios=[1.1, 2.2, 2.2, 1.0, 2.0], hspace=0.06)
    axes = [figure.add_subplot(grid[index]) for index in range(5)]
    trust = map_data["tempo"]["gridTrust"]
    span = end - start
    major = 1.0 if span <= 40 else 2.0 if span <= 70 else 5.0
    for axis in axes:
        axis.set_xlim(start, end)
        axis.set_facecolor(SURFACE)
        axis.tick_params(axis="y", length=0, labelsize=9, colors=MUTED)
        axis.xaxis.set_major_locator(MultipleLocator(major))
        axis.xaxis.set_minor_locator(MultipleLocator(major / 4 if major >= 2 else 0.25))
        axis.grid(axis="x", which="major", color="#e6e5df", linewidth=0.6)
        axis.set_axisbelow(True)
        for side in ("top", "right", "left"):
            axis.spines[side].set_visible(False)
        axis.spines["bottom"].set_color(FAINT)
        axis.tick_params(axis="x", which="both", labelbottom=False, length=0)
    bottom = axes[-1]
    bottom.tick_params(axis="x", which="major", labelbottom=True, length=4, labelsize=10, colors=INK)
    bottom.tick_params(axis="x", which="minor", length=2, colors=MUTED)
    bottom.set_xlabel("seconds of the track" if is_last else "", fontsize=10, color=MUTED)

    # Sections over phrases
    strip = axes[0]
    strip.set_ylim(0, 2)
    strip.set_yticks([0.5, 1.5], ["phrases", "sections"])
    for item in map_data["sections"]:
        if item["endSec"] <= start or item["startSec"] >= end:
            continue
        left, right = max(item["startSec"], start), min(item["endSec"], end)
        strip.fill_between([left, right], 1.04, 1.96, color=LEVEL_FILL[item["level"]], linewidth=0)
        strip.axvline(item["startSec"], ymin=0.5, ymax=1, color=SURFACE, linewidth=2)
        if (right - left) / span > 0.05:
            strip.text(left + span * 0.003, 1.5, f"{item['level']} {item['startSec']:.1f}", fontsize=9, color=LEVEL_INK[item["level"]], va="center", clip_on=True)
    for item in map_data["phrases"]:
        if item["endSec"] <= start or item["startSec"] >= end:
            continue
        left, right = max(item["startSec"], start), min(item["endSec"], end)
        shade = 0.25 + 0.6 * item["energy"]
        strip.fill_between([left, right], 0.04, 0.96, color=(0.42, 0.65, 0.93, shade), linewidth=0)
        strip.axvline(item["startSec"], ymin=0, ymax=0.5, color=SURFACE, linewidth=2)
        if (right - left) / span > 0.03:
            strip.text(left + span * 0.003, 0.5, f"{item['startSec']:.1f}", fontsize=8, color=INK, va="center", clip_on=True)

    # Waveform: peak envelope, so a loud kick reads as tall and silence as flat.
    wave = axes[1]
    first, last = int(start * RATE), min(len(samples), int(end * RATE))
    bins = 2400
    part = samples[first:last]
    if part.size:
        size = max(1, part.size // bins)
        usable = part[: part.size // size * size].reshape(-1, size)
        times = start + (np.arange(usable.shape[0]) + 0.5) * size / RATE
        wave.fill_between(times, usable.min(axis=1), usable.max(axis=1), color="#7d7c76", linewidth=0)
    peak = max(float(np.abs(samples).max()), 1e-6)
    wave.set_ylim(-peak * 1.05, peak * 1.05)
    wave.set_yticks([0], ["waveform"])
    for item in map_data["silences"]:
        wave.axvspan(item["startSec"], item["endSec"], color="#efeee9", zorder=0)
        if start <= item["startSec"] < end and (item["endSec"] - item["startSec"]) / span > 0.02:
            wave.text((max(item["startSec"], start) + min(item["endSec"], end)) / 2, 0, "silence", ha="center", va="center", fontsize=8, color=MUTED, clip_on=True)
    for item in map_data["risers"]:
        wave.axvspan(item["startSec"], item["endSec"], facecolor="none", edgecolor="#6250d6", hatch="///", linewidth=0, alpha=0.5)
        if start <= item["startSec"] < end:
            wave.text(item["startSec"], peak * 0.98, f" riser {item['startSec']:.1f}-{item['endSec']:.1f}", ha="left", va="top", fontsize=8, color="#6250d6", clip_on=True)

    # Energy, one axis
    energy = axes[2]
    curve = map_data["energyCurve"]
    times = np.array([point["timeSec"] for point in curve])
    visible = (times >= start - 0.1) & (times <= end + 0.1)
    energy.set_ylim(0, 1.05)
    energy.set_yticks([0, 0.5, 1], ["0", "energy 0.5", "1"])
    for key, colour, width in (("low", "#2a78d6", 1.1), ("high", "#eb6834", 1.1), ("rms", INK, 1.8)):
        values = np.array([point[key] for point in curve])
        energy.plot(times[visible], values[visible], color=colour, linewidth=width, label={"rms": "level", "low": "low band", "high": "high band"}[key])
    energy.legend(loc="upper left", ncols=3, fontsize=8, frameon=False, borderaxespad=0.1)

    # Beat grid: faint and unlabelled unless it can be trusted
    beat_axis = axes[3]
    beat_axis.set_ylim(0, 1)
    beat_axis.set_yticks([0.5], ["grid"])
    beats = [at for at in map_data["beatsSec"] if start <= at <= end]
    downbeats = [at for at in map_data["downbeatsSec"] if start <= at <= end]
    if trust == "reliable":
        beat_axis.vlines(beats, 0, 0.45, color=MUTED, linewidth=0.9)
        beat_axis.vlines(downbeats, 0, 0.7, color="#2a78d6", linewidth=2)
        spacing = float(np.median(np.diff(downbeats))) if len(downbeats) > 1 else span
        every = max(1, int(np.ceil(span * 0.028 / max(spacing, 1e-3))))
        for at in downbeats[::every]:
            beat_axis.text(at, 0.74, f"{at:.2f}", fontsize=7.5, color=INK, ha="center", va="bottom", clip_on=True)
    else:
        beat_axis.vlines(beats, 0.3, 0.7, color=FAINT, linewidth=0.5, linestyles="dotted")
        message = "tracker's grid is unproven: not anchors" if trust == "weak" else "no beat grid: the tracker's guess is left out"
        beat_axis.text((start + end) / 2, 0.5, message, fontsize=10, color=TRUST_NOTE[trust][1], ha="center", va="center", backgroundcolor=SURFACE)

    # Events: filled on the grid, hollow off it
    rows = axes[4]
    rows.set_ylim(-0.6, len(DRUM_ROWS) - 0.4)
    rows.set_yticks(range(len(DRUM_ROWS)), DRUM_ROWS[::-1])
    drums = map_data.get("drums")
    beat_times = np.array(map_data["beatsSec"])
    period = float(np.median(np.diff(beat_times))) if beat_times.size > 1 else 0.0

    def on_sixteenth(at: float) -> bool:
        if trust == "none" or period <= 0 or not beat_times[0] - period <= at <= beat_times[-1] + period:
            return False
        step = period / 4
        return abs((at - beat_times[0]) / step - round((at - beat_times[0]) / step)) * step <= 0.02

    for index, kind in enumerate(DRUM_ROWS[::-1]):
        if drums and kind in ("kick", "snare", "hat"):
            # Transcribed hits, filled when they sit on the grid's sixteenths.
            chosen = [item for item in drums[kind] if start <= item["timeSec"] <= end]
            on_grid = [item for item in chosen if on_sixteenth(item["timeSec"])]
            off_grid = [item for item in chosen if not on_sixteenth(item["timeSec"])]
        else:
            chosen = [item for item in map_data["events"] if item["kind"] == kind and start <= item["timeSec"] <= end]
            on_grid = [item for item in chosen if item["metric"] != "off-grid"]
            off_grid = [item for item in chosen if item["metric"] == "off-grid"]
        colour = DRUM_COLOUR[kind]
        rows.scatter([item["timeSec"] for item in on_grid], [index] * len(on_grid), s=[12 + 46 * item["strength"] for item in on_grid], color=colour, linewidths=0)
        rows.scatter([item["timeSec"] for item in off_grid], [index] * len(off_grid), s=[12 + 46 * item["strength"] for item in off_grid], facecolors="none", edgecolors=colour, linewidths=0.9)

    # Key moments cross every panel, labelled once in seconds above the strip.
    levels = [1.04, 1.24, 1.44]
    placed: list[tuple[float, int]] = []
    for item in sorted(map_data["keyMoments"], key=lambda moment: moment["timeSec"]):
        at = item["timeSec"]
        if not start <= at <= end:
            continue
        colour = MOMENT_COLOUR[item["kind"]]
        for axis in axes:
            axis.axvline(at, color=colour, linewidth=0.5 + 1.3 * item["strength"], alpha=0.75, zorder=3)
        used = {level for other, level in placed if at - other < span * 0.075}
        level = next((candidate for candidate in range(len(levels)) if candidate not in used), 0)
        placed.append((at, level))
        strip.text(
            at,
            levels[level],
            f"{item['kind']} {at:.2f}",
            transform=strip.get_xaxis_transform(),
            fontsize=9,
            color=colour,
            ha="right" if at > end - span * 0.04 else "left" if at < start + span * 0.04 else "center",
            va="bottom",
            clip_on=False,
        )


def draw_map(map_data: dict[str, Any], samples: np.ndarray, title: str, target: str) -> None:
    """Draw the map picture, one row per stretch of up to a minute."""
    import matplotlib as mpl

    mpl.use("Agg")
    from matplotlib import pyplot as plt
    from matplotlib.gridspec import GridSpec

    duration = map_data["durationSec"]
    count = max(1, int(np.ceil(duration / SECONDS_PER_ROW - 0.25)))
    count = min(count, 6)
    figure = plt.figure(figsize=(18, 0.9 + 8.2 * count), dpi=100, facecolor=SURFACE)
    tempo = map_data["tempo"]
    note, colour = TRUST_NOTE[tempo["gridTrust"]]
    bpm = ""
    if "bpm" in tempo:
        bpm = f"{tempo['bpm']:.1f} BPM  " if tempo["gridTrust"] == "reliable" else f"tracker's guess {tempo['bpm']:.0f} BPM  "
    figure.text(0.012, 1 - 0.28 / (0.9 + 8.2 * count), f"{title}   {duration:.2f} s   {bpm}confidence {tempo['confidence']:.2f}", fontsize=14, color=INK, weight="bold", va="center")
    grid = map_data.get("grid")
    if grid:
        note = f"{note}  ·  grid from {GRID_SOURCE_LABEL[grid['source']]}"
        if grid.get("residualMs") is not None:
            note += f", hits within {grid['residualMs']:.1f} ms"
    figure.text(0.988, 1 - 0.28 / (0.9 + 8.2 * count), note, fontsize=14, color=colour, weight="bold", va="center", ha="right")
    outer = GridSpec(count, 1, figure=figure, left=0.06, right=0.988, bottom=0.55 / (0.9 + 8.2 * count), top=1 - 0.95 / (0.9 + 8.2 * count), hspace=0.14)
    length = duration / count
    for row in range(count):
        draw_row(figure, outer[row], samples, map_data, row * length, min(duration, (row + 1) * length), is_last=row == count - 1)
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(target, facecolor=SURFACE, metadata={"Software": None})
    plt.close(figure)


def main() -> None:
    """Read the request, analyse, draw and print one JSON line."""
    media = sys.argv[1]
    request = json.loads(Path(sys.argv[2]).read_text())
    result, diagnostics, samples = analyse(media, request)
    text = brief(result, diagnostics)
    if request.get("imagePath"):
        draw_map(result, samples, request.get("title", Path(media).name), request["imagePath"])
    sys.stdout.write(json.dumps({"map": result, "diagnostics": diagnostics, "brief": text}) + "\n")


if __name__ == "__main__":
    main()
