# ruff: noqa: PLR2004  signal-processing thresholds are tuned numbers read in place, named where they recur
"""The music's form on top of an audio map: bars, phrases, sections, fills, risers, breaks and the ending.

Pure functions of the samples, the finished map and optional Demucs stems, run after audio-map.py on the same
decoded audio: audio-structure.py <media> <request.json>. The picture is audio-map.py's own, with structure lanes added.
"""

from __future__ import annotations

import importlib.util
import inspect
import itertools
import json
import sys
from pathlib import Path
from typing import Any

import librosa
import numpy as np

RATE = 22050
HOP = RATE // 10
FPS = RATE / HOP
LABEL_COLOUR = {"intro": "#cde2fb", "build": "#f6c58f", "drop": "#e34948", "break": "#d9d8d2", "outro": "#9ec3ef"}
LABEL_INK = {"intro": "#0b0b0b", "build": "#0b0b0b", "drop": "#ffffff", "break": "#0b0b0b", "outro": "#0b0b0b"}
BREAK_COLOUR = {"silence": "#52514e", "stop": "#c02a2a", "drum-dropout": "#8a8983", "bass-dropout": "#b8b7b0"}
FILL_COLOUR = "#eb6834"
# A riser climbs in absolute terms, a third of an octave in brightness or 3 dB in level, whatever the cue's own range.
RISER_MIN_OCTAVES = 0.35
RISER_MIN_DB = 3.0
# Nothing structural (phrase start, riser, fill, drop) in the last second before a hard stop or a fade: that is the ending.
END_GUARD_SEC = 1.0
BAR_KNOWN_CONFIDENCE = 0.2
RISER_COLOUR = "#6250d6"


def r3(value: float) -> float:
    """Round to the millisecond."""
    return round(float(value), 3)


def unit(values: np.ndarray, low: float = 5, high: float = 98) -> np.ndarray:
    """Scales to 0-1 between two percentiles, so one spike does not flatten the rest."""
    bottom, top = np.percentile(values, [low, high])
    return np.clip((values - bottom) / max(top - bottom, 1e-9), 0, 1)


def level_db(samples: np.ndarray, count: int) -> np.ndarray:
    """Return the RMS level in dB at ten frames a second."""
    rms = librosa.feature.rms(y=samples, frame_length=2048, hop_length=HOP, center=True)[0]
    return fit(librosa.amplitude_to_db(rms + 1e-9, ref=1.0), count)


def fit(values: np.ndarray, count: int) -> np.ndarray:
    """Trim or pad a curve to `count` frames."""
    return values[:count] if values.size >= count else np.pad(values, (0, count - values.size), mode="edge")


def load_stem(path: str | None, count: int) -> np.ndarray | None:
    """Return a stem's level in dB, or None when there is no stem."""
    if not path or not Path(path).exists():
        return None
    samples, _ = librosa.load(path, sr=RATE, mono=True)
    return level_db(samples, count)


class Features:
    """Ten frames a second: level, brightness, drums, bass, timbre."""

    def __init__(self, samples: np.ndarray, drums_path: str | None, bass_path: str | None) -> None:
        """Measure every curve once; stems when given, HPSS and a low band of the mix otherwise."""
        self.duration = samples.size / RATE
        self.count = max(1, int(np.ceil(samples.size / HOP)))
        self.times = np.arange(self.count) / FPS
        self.db = level_db(samples, self.count)
        self.energy = unit(self.db, 2, 99)
        stft = np.abs(librosa.stft(samples, n_fft=4096, hop_length=HOP))
        freqs = librosa.fft_frequencies(sr=RATE, n_fft=4096)
        centroid = librosa.feature.spectral_centroid(S=stft, freq=freqs)[0]
        self.centroid = fit(np.log2(np.maximum(centroid, 50.0)), self.count)
        self.mfcc = fit(librosa.feature.mfcc(S=librosa.power_to_db(librosa.feature.melspectrogram(S=stft**2, sr=RATE)), n_mfcc=13).T, self.count) if stft.size else np.zeros((self.count, 13))
        drums_db = load_stem(drums_path, self.count)
        bass_db = load_stem(bass_path, self.count)
        self.from_stems = drums_db is not None and bass_db is not None
        if drums_db is None:
            percussive = librosa.decompose.hpss(stft, margin=2.0)[1]
            drums_db = fit(librosa.amplitude_to_db(np.sqrt((percussive**2).mean(axis=0)) + 1e-9), self.count)
        if bass_db is None:
            low = stft[freqs < 150].sum(axis=0) if (freqs < 150).any() else np.zeros(stft.shape[1])
            bass_db = fit(librosa.amplitude_to_db(low + 1e-9), self.count)
        self.drums = unit(drums_db, 2, 97)
        self.bass = unit(bass_db, 2, 97)
        self.silent = self.db < max(float(self.db.max()) - 50.0, -80.0)

    def index(self, seconds: float) -> int:
        """Return the frame of a time, clamped to the track."""
        return int(np.clip(round(seconds * FPS), 0, self.count - 1))

    def mean(self, values: np.ndarray, start: float, end: float) -> float:
        """Return a curve's mean over a span of seconds."""
        first, last = self.index(start), max(self.index(start) + 1, self.index(end))
        return float(values[first:last].mean(axis=0).mean()) if values.ndim == 1 else 0.0


def drum_times(map_data: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Return drum hit times and strengths: transcribed hits, or the map's drum events."""
    drums = map_data.get("drums")
    hits = [item for kind in ("kick", "snare", "hat") for item in drums.get(kind, [])] if drums else [item for item in map_data.get("events", []) if item["kind"] in ("kick", "snare", "hat", "perc")]
    hits.sort(key=lambda item: item["timeSec"])
    return np.array([item["timeSec"] for item in hits]), np.array([item["strength"] for item in hits])


def bar_starts(map_data: dict[str, Any], duration: float) -> tuple[np.ndarray, float | None]:
    """Downbeats, carried at the bar's period across an intro or outro the drums leave out when the grid is reliable."""
    downbeats = np.array(map_data.get("downbeatsSec", []), dtype=float)
    trust = map_data["tempo"]["gridTrust"]
    if trust == "none" or downbeats.size < 3:
        return np.array([]), None
    bar = float(np.median(np.diff(downbeats)))
    if bar <= 0.4:
        return np.array([]), None
    if trust == "reliable":
        before = np.arange(downbeats[0] - bar, -bar * 0.25, -bar)[::-1]
        after = np.arange(downbeats[-1] + bar, duration - bar * 0.5, bar)
        downbeats = np.concatenate([before[before >= -bar * 0.25], downbeats, after])
    return np.clip(downbeats, 0, None), bar


def bar_rows(features: Features, starts: np.ndarray, bar: float, hits: tuple[np.ndarray, np.ndarray]) -> tuple[list[dict[str, Any]], np.ndarray]:
    """Return each bar's measures, and a standardised feature matrix for novelty."""
    times, _ = hits
    rows, vectors = [], []
    for start in starts:
        end = min(start + bar, features.duration)
        first, last = features.index(start), max(features.index(start) + 1, features.index(end))
        density = float(((times >= start) & (times < end)).sum() / max(end - start, 1e-3))
        rows.append(
            {
                "startSec": r3(start),
                "endSec": r3(end),
                "energy": r3(features.energy[first:last].mean()),
                "density": r3(density),
                "drums": r3(features.drums[first:last].mean()),
                "bass": r3(features.bass[first:last].mean()),
            }
        )
        vectors.append(
            np.concatenate(
                [
                    [features.energy[first:last].mean() * 3, features.drums[first:last].mean() * 2, features.bass[first:last].mean() * 2, features.centroid[first:last].mean(), density],
                    features.mfcc[first:last].mean(axis=0),
                ]
            )
        )
    matrix = np.array(vectors)
    if matrix.size:
        matrix = (matrix - matrix.mean(axis=0)) / (matrix.std(axis=0) + 1e-6)
    return rows, matrix


def bar_novelty(matrix: np.ndarray) -> np.ndarray:
    """At each bar line: how unlike the bars before are the bars after, over one, two and four bars."""
    count = len(matrix)
    novelty = np.zeros(count)
    for index in range(1, count):
        scores = []
        for width in (1, 2, 4):
            before, after = matrix[max(0, index - width) : index], matrix[index : min(count, index + width)]
            if len(before) and len(after):
                scores.append(np.linalg.norm(before.mean(axis=0) - after.mean(axis=0)) * (min(len(before), len(after)) / width) ** 0.5)
        novelty[index] = float(np.mean(scores)) if scores else 0.0
    top = np.percentile(novelty[1:], 95) if count > 2 else 1.0
    return np.clip(novelty / max(top, 1e-6), 0, 1)


def phrase_origin(novelty: np.ndarray, every: int, among: list[int] | None = None) -> int:
    """Which bar the phrase lines run from: the offset whose bar lines carry the most change."""
    candidates = among if among is not None else list(range(every))
    scores = [
        float(novelty[[index for index in range(len(novelty)) if index >= 1 and (index - offset) % every == 0]].mean())
        if any(index >= 1 and (index - offset) % every == 0 for index in range(len(novelty)))
        else 0.0
        for offset in candidates
    ]
    return candidates[int(np.argmax(scores))] if scores else 0


def frame_novelty(features: Features, half_width: float = 2.0) -> np.ndarray:
    """Checkerboard novelty over timbre and level, for a track with no bars."""
    stacked = np.column_stack([features.energy * 3, features.drums * 2, features.bass * 2, features.centroid, features.mfcc])
    stacked = (stacked - stacked.mean(axis=0)) / (stacked.std(axis=0) + 1e-6)
    width = max(2, int(half_width * FPS))
    novelty = np.zeros(features.count)
    for index in range(width, features.count - width):
        novelty[index] = np.linalg.norm(stacked[index - width : index].mean(axis=0) - stacked[index : index + width].mean(axis=0))
    return unit(novelty, 50, 99)


def find_fill(boundary: float, beat: float, hits: tuple[np.ndarray, np.ndarray], typical: float) -> dict[str, Any] | None:
    """Drum hits per beat over the bar before a boundary, against the track's usual rate."""
    times, strengths = hits
    if beat <= 0 or times.size < 8:
        return None
    start = None
    peak = 0.0
    for back in range(1, 5):
        left, right = boundary - back * beat - beat * 0.08, boundary - (back - 1) * beat - beat * 0.08
        inside = (times >= left) & (times < right)
        rate = float(strengths[inside].sum())
        if rate >= max(typical * 1.6, typical + 0.8):
            start, peak = left, max(peak, rate)
        else:
            break
    if start is None:
        return None
    return {"startSec": r3(max(0, start)), "endSec": r3(boundary), "boundarySec": r3(boundary), "strength": r3(min(1.0, (peak / max(typical, 0.25) - 1) / 2.5))}


def find_riser(features: Features, boundary: float, spans: list[float], known: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Brightness or level that climbs steadily into the boundary, over one to four bars."""
    best: dict[str, Any] | None = None
    audible = ~features.silent if (~features.silent).any() else np.ones(features.count, dtype=bool)
    centroid_spread = float(np.std(features.centroid[audible])) + 1e-6
    # A trailing second, so the swing between kick and hat does not hide a climb and the drop does not leak back into it.
    kernel = np.ones(int(FPS)) / int(FPS)
    smooth_centroid = np.convolve(features.centroid, kernel)[: features.count]
    smooth_db = np.convolve(features.db, kernel)[: features.count]
    for span in spans:
        first, last = features.index(boundary - span), features.index(boundary) - 1
        if last - first < 6:
            continue
        x = features.times[first:last]
        rises: list[str] = []
        score = 0.0
        for name, values, spread, least in (
            ("centroid", smooth_centroid[first:last], centroid_spread, RISER_MIN_OCTAVES),
            ("energy", smooth_db[first:last], float(np.std(features.db[audible])) + 1e-6, RISER_MIN_DB),
        ):
            slope, intercept = np.polyfit(x, values, 1)
            fit_r = float(np.corrcoef(x, values)[0, 1]) if np.std(values) > 1e-9 else 0.0
            climb = slope * span / spread
            # The rise must be large in itself and stand above the wobble around its own line, not only above a quiet track's spread.
            rise = slope * span
            wobble = float(np.std(values - (slope * x + intercept)))
            if climb >= 0.7 and fit_r >= 0.6 and rise >= least and rise >= 3 * wobble:
                rises.append(name)
                score = max(score, min(1.0, climb / 2.5) * fit_r)
        if rises and (best is None or score > best["strength"]):
            best = {"startSec": r3(max(0, boundary - span)), "endSec": r3(boundary), "boundarySec": r3(boundary), "strength": r3(score), "rises": rises}
    for item in known:
        if abs(item["endSec"] - boundary) <= 0.5 and (best is None or best["strength"] < 0.5):
            best = {"startSec": r3(item["startSec"]), "endSec": r3(boundary), "boundarySec": r3(boundary), "strength": 0.6, "rises": ["energy"]}
    return best


def thin(found: list[dict[str, Any]], spacing: float) -> list[dict[str, Any]]:
    """Keep the strongest of any events closer than `spacing`: a short cue cannot carry a riser every two seconds."""
    kept: list[dict[str, Any]] = []
    for item in sorted(found, key=lambda event: -event["strength"]):
        if all(abs(item["boundarySec"] - other["boundarySec"]) >= spacing for other in kept):
            kept.append(item)
    return sorted(kept, key=lambda event: event["boundarySec"])


def merge_close(boundaries: list[dict[str, Any]], gap: float) -> list[dict[str, Any]]:
    """Merge boundaries closer than `gap` into the one with the most novelty."""
    merged: list[dict[str, Any]] = []
    for item in sorted(boundaries, key=lambda boundary: boundary["sec"]):
        if merged and item["sec"] - merged[-1]["sec"] < gap:
            if item["novelty"] > merged[-1]["novelty"]:
                merged[-1] = item
            continue
        merged.append(item)
    return merged


def find_breaks(features: Features, beat: float, last_sound: float) -> list[dict[str, Any]]:
    """Silence, a stop of everything, or the drums or bass dropping out where they had been playing."""
    found: list[dict[str, Any]] = []
    minimum = max(0.35, beat * 0.9 if beat else 0.5)

    def runs(mask: np.ndarray) -> list[tuple[int, int]]:
        edges = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(int), [0]])))
        return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2], strict=True) if (b - a) / FPS >= minimum]

    def played_before(values: np.ndarray, first: int) -> bool:
        window = values[max(0, first - int(2 * FPS)) : first]
        return window.size >= FPS and float(window.mean()) > 0.45

    end = features.index(last_sound)
    quiet = features.energy < 0.08
    for first, last in runs(quiet[:end]):
        if first == 0:
            continue
        span = (last - first) / FPS
        found.append(
            {
                "startSec": r3(first / FPS),
                "endSec": r3(last / FPS),
                "kind": "stop" if span <= max(beat * 4, 1.0) and played_before(features.energy, first) else "silence",
                "strength": r3(min(1.0, 0.5 + span / 4)),
            }
        )
    for name, values, shortest in (("drum-dropout", features.drums, minimum * 2), ("bass-dropout", features.bass, max(minimum * 4, 1.5))):
        for first, last in runs((values < 0.15)[:end] & ~quiet[:end]):
            if (last - first) / FPS < shortest:
                continue
            if first == 0 or not played_before(values, first) or any(item["startSec"] <= first / FPS < item["endSec"] for item in found):
                continue
            found.append(
                {
                    "startSec": r3(first / FPS),
                    "endSec": r3(last / FPS),
                    "kind": name,
                    "strength": r3(min(1.0, float(values[max(0, first - int(2 * FPS)) : first].mean()) - float(values[first:last].mean()))),
                }
            )
    return sorted(found, key=lambda item: item["startSec"])


def find_ending(features: Features, downbeats: np.ndarray) -> dict[str, Any]:
    """Where the sound ends, and whether it is cut off or fades: a hard stop falls 30 dB within 0.4 s."""
    audible = np.flatnonzero(~features.silent)
    last = int(audible[-1]) if audible.size else features.count - 1
    floor = float(features.db[last])
    body = float(np.percentile(features.db[: last + 1], 60))
    loud = np.flatnonzero(features.db[: last + 1] >= body - 6)
    drop_off = int(loud[-1]) if loud.size else last
    after = np.flatnonzero(features.db[drop_off : last + 1] <= body - 30)
    fall = (after[0] / FPS) if after.size else (last - drop_off) / FPS
    hard = fall <= 0.4 or (last - drop_off) / FPS <= 0.4 or (floor < body - 30 and (last - drop_off) / FPS <= 1.2 and fall <= 0.6)
    drop_sec = drop_off / FPS
    final = downbeats[downbeats <= drop_sec + 0.15] if downbeats.size else downbeats
    return {
        "kind": "hard-stop" if hard else "fade",
        "lastSoundSec": r3((last + 1) / FPS),
        "fadeSec": r3(0 if hard else (last - drop_off) / FPS),
        **({"finalDownbeatSec": r3(final[-1])} if final.size else {}),
    }


def label_sections(sections: list[dict[str, Any]], ending: dict[str, Any], risers: list[dict[str, Any]], moments: list[dict[str, Any]]) -> None:
    """Name each section intro, build, drop, break or outro, with a confidence and the reason.

    Labels follow intensity, half level and half drum density, each against the cue's fullest section: a section with the
    most hits is not the quietest-sounding one, so neither reading alone may name it. The reason quotes both numbers.
    """
    top_energy = max((item["energy"] for item in sections), default=1.0) or 1.0
    top_density = max((item["density"] for item in sections), default=1.0) or 1.0
    for item in sections:
        item["intensity"] = 0.5 * item["energy"] / top_energy + 0.5 * item["density"] / top_density
    intensities = np.array([item["intensity"] for item in sections])
    top = float(intensities.max()) if intensities.size else 1.0
    for index, item in enumerate(sections):
        previous = sections[index - 1] if index else None
        following = sections[index + 1] if index + 1 < len(sections) else None
        jump = item["intensity"] - (previous["intensity"] if previous else item["intensity"])
        surge = any(moment["kind"] in ("surge", "drop", "riser-end", "impact") and abs(moment["timeSec"] - item["startSec"]) <= 0.4 for moment in moments)
        risen = any(abs(riser["boundarySec"] - item["endSec"]) <= 0.3 for riser in risers)
        fuller_next = following is not None and following["intensity"] > item["intensity"] + 0.05
        if index == 0 and len(sections) > 1 and (item["intensity"] < (following or item)["intensity"] - 0.08 or item["drums"] < 0.35):
            label, confidence, why = "intro", 0.8, "opens quieter or without drums"
        elif following is None and index > 0 and (jump < -0.08 or item["drums"] < 0.35 or (ending["kind"] == "fade" and item["endSec"] - item["startSec"] <= 0.3 * ending["lastSoundSec"])):
            label, confidence, why = "outro", 0.75, "last section, falling or fading"
        elif previous and (item["drums"] < 0.3 or jump < -0.15) and item["intensity"] < top - 0.12:
            label, confidence, why = "break", 0.75, "drums or level fall away after a fuller section"
        elif item["intensity"] >= top - 0.06 or (jump >= 0.12 and item["drums"] >= 0.45) or (surge and jump >= 0.05):
            label, confidence, why = "drop", 0.8 if jump >= 0.12 or surge else 0.6, "among the fullest sections" if jump < 0.12 else "arrives with a jump in intensity"
        elif fuller_next:
            label, confidence, why = "build", 0.7 if risen else 0.55, "rises into a fuller section" if risen else "the next section is fuller"
        else:
            louder = item["intensity"] >= float(np.median(intensities))
            label, confidence, why = ("drop" if louder else "build"), 0.35, "steady groove; nearest label by intensity"
        level_rank = sorted((other["energy"] for other in sections), reverse=True).index(item["energy"]) + 1
        density_rank = sorted((other["density"] for other in sections), reverse=True).index(item["density"]) + 1
        reason = f"{why} (level {item['energy']:.2f}, #{level_rank} of {len(sections)}; density {item['density']:.1f}/s, #{density_rank})"
        if abs(level_rank - density_rank) >= max(2, len(sections) // 2):
            reason += "; level and density disagree, the label weighs both"
        item.update({"label": label, "confidence": r3(confidence), "reason": reason, "intensity": r3(item["intensity"])})


def analyse_structure(samples: np.ndarray, rate: int, map_data: dict[str, Any], drums_path: str | None = None, bass_path: str | None = None) -> dict[str, Any]:  # noqa: C901, PLR0912, PLR0915  one pass from bars to sections reads better than helpers passing half the state
    """Read the form from the samples and the finished map: bars, phrases, sections, fills, risers, breaks and ending."""
    if rate != RATE:
        samples = librosa.resample(samples, orig_sr=rate, target_sr=RATE)
    features = Features(samples, drums_path, bass_path)
    hits = drum_times(map_data)
    starts, bar = bar_starts(map_data, features.duration)
    beats = np.array(map_data.get("beatsSec", []), dtype=float)
    beat = bar / 4 if bar else (float(np.median(np.diff(beats))) if beats.size > 2 else 0.0)
    ending = find_ending(features, np.array(map_data.get("downbeatsSec", []), dtype=float) if not starts.size else starts)
    grid = map_data.get("grid") or {}
    bar_known = bool(grid.get("barKnown", bar is not None))
    # Phrases are still counted in bars; a guessed bar line only lowers how much each phrase start is trusted.
    bar_trust = 0.5 + 0.5 * min(1.0, float(grid.get("downbeatConfidence", BAR_KNOWN_CONFIDENCE)) / BAR_KNOWN_CONFIDENCE) if bar else 1.0
    known_risers = map_data.get("risers", [])
    moments = map_data.get("keyMoments", [])

    bars: list[dict[str, Any]] = []
    boundaries: list[dict[str, Any]] = []
    if bar is not None and starts.size >= 4:
        rows, matrix = bar_rows(features, starts, bar, hits)
        novelty = bar_novelty(matrix)
        for row, value in zip(rows, novelty, strict=True):
            row["novelty"] = r3(value)
        bars = rows
        origin4 = phrase_origin(novelty, 4)
        origin8 = phrase_origin(novelty, 8, [origin4, origin4 + 4])
        origin16 = phrase_origin(novelty, 16, [origin8, origin8 + 8])
        for index in range(1, len(rows)):
            regular = (index - origin4) % 4 == 0
            if not regular and (novelty[index] < 0.85 or min(abs(index - origin4 - 4 * round((index - origin4) / 4)), 4) < 2):
                continue
            level = 16 if (index - origin16) % 16 == 0 else 8 if (index - origin8) % 8 == 0 else 4 if regular else 0
            boundaries.append({"bar": index, "sec": starts[index], "level": level, "novelty": float(novelty[index])})
    else:
        novelty_curve = frame_novelty(features)
        spacing = int(3 * FPS)
        peaks = [
            index
            for index in range(1, features.count - 1)
            if novelty_curve[index] >= 0.5 and novelty_curve[index] > novelty_curve[index - 1] and novelty_curve[index] == novelty_curve[max(0, index - spacing) : index + spacing].max()
        ]
        boundaries = [{"bar": None, "sec": index / FPS, "level": 0, "novelty": float(novelty_curve[index])} for index in peaks]

    end_guard = ending["lastSoundSec"] - ending["fadeSec"] - END_GUARD_SEC
    boundaries = merge_close([item for item in boundaries if item["sec"] < end_guard], bar / 2 if bar else 1.0)
    typical = 0.0
    times, strengths = hits
    if beat > 0 and times.size:
        counts = [float(strengths[(times >= at) & (times < at + beat)].sum()) for at in np.arange(times[0], times[-1], beat)]
        typical = float(np.median(counts)) if counts else 0.0
    found_fills = [fill for item in boundaries if (fill := find_fill(item["sec"], beat, hits, typical))]
    found_risers = [riser for item in boundaries if (riser := find_riser(features, item["sec"], [bar, 2 * bar, 4 * bar] if bar else [2.0, 4.0, 8.0], known_risers))]
    # Scaled to the cue: at most one riser or fill per four bars (six seconds without a grid), and a sixth of the cue.
    spacing = max(4 * bar if bar else 6.0, features.duration / 6)
    fills, risers = thin(found_fills, spacing), thin(found_risers, spacing)
    for item in boundaries:
        fill = next((event for event in fills if abs(event["boundarySec"] - item["sec"]) < 0.01), None)
        riser = next((event for event in risers if abs(event["boundarySec"] - item["sec"]) < 0.01), None)
        before, after = features.mean(features.energy, item["sec"] - (bar or 2), item["sec"]), features.mean(features.energy, item["sec"], item["sec"] + (bar or 2))
        jump = abs(after - before)
        prior = {16: 0.2, 8: 0.12, 4: 0.04, 0: 0.0}[item["level"]]
        item["confidence"] = min(1.0, 0.45 * item["novelty"] + prior + 0.15 * (fill is not None) + 0.15 * (riser is not None) + 0.6 * jump)
        item["jump"] = after - before

    edges = [0.0] + [item["sec"] for item in boundaries] + [features.duration]
    phrases = []
    for index, (start, end) in enumerate(itertools.pairwise(edges)):
        if end - start < 0.05:
            continue
        head = boundaries[index - 1] if index else None
        phrase = {
            "startSec": r3(start),
            "endSec": r3(end),
            "bars": round((end - start) / bar) if bar else 0,
            "level": head["level"] if head else (16 if bar else 0),
            "confidence": r3(head["confidence"] * bar_trust if head else 1.0),
        }
        if head and head["bar"] is not None:
            phrase["startBar"] = int(head["bar"])
        phrases.append(phrase)

    minimum = 4 * bar if bar else 4.0
    ranked = sorted(boundaries, key=lambda item: -(item["confidence"] + 0.1 * (item["level"] >= 8)))
    chosen: list[float] = []
    limit = max(1, int(features.duration / max(minimum, 6.0)))
    for item in ranked:
        if item["confidence"] < 0.42 or len(chosen) >= limit:
            break
        if all(abs(item["sec"] - other) >= minimum - 1e-3 for other in chosen) and item["sec"] >= minimum * 0.5 and features.duration - item["sec"] >= minimum * 0.5:
            chosen.append(item["sec"])
    cuts = [0.0, *sorted(chosen), min(features.duration, ending["lastSoundSec"] if ending["kind"] == "hard-stop" else features.duration)]
    sections = []
    for start, end in itertools.pairwise(cuts):
        if end - start < 0.2:
            continue
        inside = (times >= start) & (times < end)
        sections.append(
            {
                "startSec": r3(start),
                "endSec": r3(end),
                "energy": r3(features.mean(features.energy, start, end)),
                "density": r3(inside.sum() / max(end - start, 1e-3)),
                "drums": r3(features.mean(features.drums, start, end)),
                "bass": r3(features.mean(features.bass, start, end)),
            }
        )
    label_sections(sections, ending, risers, [moment for moment in moments if moment["timeSec"] < end_guard])
    breaks = find_breaks(features, beat, ending["lastSoundSec"])
    return {
        "source": "stems" if features.from_stems else "mix",
        "barKnown": bar_known,
        **({"barSec": r3(bar)} if bar else {}),
        "bars": bars,
        "phrases": phrases,
        "sections": sections,
        "fills": fills,
        "risers": risers,
        "breaks": breaks,
        "ending": ending,
    }


def structure_brief(structure: dict[str, Any]) -> str:
    """Summarise the form in a few lines for the map's brief."""
    form = " | ".join(f"{item['label']} {item['startSec']:.1f}" for item in structure["sections"])
    lines = [f"Form: {form}."]
    strong = [item for item in structure["phrases"] if item["confidence"] >= 0.5 and item["startSec"] > 0][:12]
    if strong:
        # Each listed start counts its bars to the next listed start (or the end), so the numbers add up as read.
        ends = [item["startSec"] for item in strong[1:]] + [structure["phrases"][-1]["endSec"]]
        bar = structure.get("barSec")

        def label(item: dict[str, Any], end: float) -> str:
            if not bar:
                return f"{item['startSec']:.2f}"
            line = f", on a {item['level']}-bar line" if item["level"] else ", off the phrase lines"
            return f"{item['startSec']:.2f} ({round((end - item['startSec']) / bar)} bars{line})"

        lines.append("Phrase starts: " + ", ".join(label(item, end) for item, end in zip(strong, ends, strict=True)) + ".")
    lines.extend(f"{name.capitalize()} into: " + ", ".join(f"{item['boundarySec']:.2f}" for item in structure[name]) + "." for name in ("fills", "risers") if structure[name])
    if structure["breaks"]:
        lines.append("Breaks: " + ", ".join(f"{item['kind']} {item['startSec']:.2f}-{item['endSec']:.2f}" for item in structure["breaks"]) + ".")
    ending = structure["ending"]
    lines.append(f"Ends with a {ending['kind']} at {ending['lastSoundSec']:.2f}" + (f", final downbeat {ending['finalDownbeatSec']:.2f}" if "finalDownbeatSec" in ending else "") + ".")
    return " ".join(lines)


def draw_structure(axes: list[Any], structure: dict[str, Any], start: float, end: float) -> None:  # noqa: C901  one loop per lane
    """Add two lanes above the map's sections and phrases: the form, and the phrase lines with fills, risers and breaks."""
    strip = axes[0]
    strip.set_ylim(0, 4)
    strip.set_yticks([0.5, 1.5, 2.5, 3.5], ["phrases", "sections", "form", "lines"])
    span = end - start
    for item in structure["sections"]:
        if item["endSec"] <= start or item["startSec"] >= end:
            continue
        left, right = max(item["startSec"], start), min(item["endSec"], end)
        strip.fill_between([left, right], 2.04, 2.96, color=LABEL_COLOUR[item["label"]], linewidth=0)
        strip.axvline(item["startSec"], ymin=0.5, ymax=0.75, color="#fcfcfb", linewidth=2)
        if (right - left) / span > 0.03:
            strip.text(left + span * 0.003, 2.5, f"{item['label']} {item['startSec']:.1f}", fontsize=9, color=LABEL_INK[item["label"]], va="center", weight="bold", clip_on=True)
    for item in structure["breaks"]:
        if item["endSec"] > start and item["startSec"] < end:
            strip.fill_between([max(item["startSec"], start), min(item["endSec"], end)], 3.04, 3.5, color=BREAK_COLOUR[item["kind"]], linewidth=0, alpha=0.8)
            axes[1].axvspan(item["startSec"], item["endSec"], color=BREAK_COLOUR[item["kind"]], alpha=0.12, zorder=0)
    for item in structure["risers"]:
        if item["endSec"] > start and item["startSec"] < end:
            strip.fill([item["startSec"], item["endSec"], item["endSec"]], [3.05, 3.05, 3.95], color=RISER_COLOUR, alpha=0.45, linewidth=0)
    for item in structure["fills"]:
        if item["endSec"] > start and item["startSec"] < end:
            strip.fill_between([item["startSec"], item["endSec"]], 3.5, 3.95, color=FILL_COLOUR, linewidth=0)
    for item in structure["phrases"]:
        if not start <= item["startSec"] <= end or item["startSec"] == 0:
            continue
        height = {16: 1.0, 8: 0.75, 4: 0.5, 0: 0.6}[item["level"]]
        strip.vlines(item["startSec"], 3.0, 3.0 + 0.95 * height, color="#0b0b0b", linewidth=0.6 + 1.6 * item["confidence"])
        if item["confidence"] >= 0.5:
            strip.text(item["startSec"], 3.0 + 0.95 * height, f"{item['level'] or ''}", fontsize=7, color="#0b0b0b", ha="center", va="bottom", clip_on=True)


def draw_with_structure(map_data: dict[str, Any], media: str, title: str, target: str) -> None:
    """Draws the map with audio-map.py's own picture, adding the structure lanes to each row's strip."""
    spec = importlib.util.spec_from_file_location("audio_map_worker", Path(__file__).with_name("audio-map.py"))
    if spec is None or spec.loader is None:
        msg = "audio-map.py not found beside audio-structure.py"
        raise SystemExit(msg)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    original = worker.draw_row

    signature = inspect.signature(original)

    def draw_row(*args: Any, **kwargs: Any) -> None:  # noqa: ANN401  forwards whatever audio-map.py's draw_row takes
        before = len(args[0].axes)
        original(*args, **kwargs)
        bound = signature.bind(*args, **kwargs).arguments
        draw_structure(bound["figure"].axes[before:], bound["map_data"]["structure"], bound["start"], bound["end"])

    worker.__dict__["draw_row"] = draw_row
    samples, _ = librosa.load(media, sr=worker.RATE, mono=True)
    worker.draw_map({**map_data, "durationSec": map_data["source"]["durationSec"]}, samples, title, target)


def main() -> None:
    """<media> <request.json>: request has mapPath and optionally drumsPath, bassPath, imagePath, title."""
    media = sys.argv[1]
    request = json.loads(Path(sys.argv[2]).read_text())
    map_data = json.loads(Path(request["mapPath"]).read_text())
    samples, rate = librosa.load(media, sr=RATE, mono=True)
    structure = analyse_structure(samples, int(rate), map_data, request.get("drumsPath"), request.get("bassPath"))
    if request.get("imagePath"):
        draw_with_structure({**map_data, "structure": structure}, media, request.get("title", Path(media).name), request["imagePath"])
    sys.stdout.write(json.dumps({"structure": structure, "brief": structure_brief(structure)}) + "\n")


if __name__ == "__main__":
    main()
