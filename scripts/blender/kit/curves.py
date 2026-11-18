# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Pure motion maths for the Blender craft kit: no `bpy`, so plain python3 tests it against src/motion/timing.ts.

Every function is a pure function of the frame (and a seed where it is noisy): a frame evaluated alone equals the same
frame inside a range. Frames are block frames from 0; Blender frame 1 is block frame 0 (toy_kit convention).

The intent curves are the same as `intentCurves` in src/motion/timing.ts (snap, settle, glide, punch, float, brake), so a
plan that says "brake" means one curve in the browser and in Blender. `tests/blender-kit.test.ts` holds that contract.
"""

from __future__ import annotations

import math
import zlib
from collections.abc import Callable, Iterable, Sequence
from itertools import pairwise
from typing import TypeAlias, TypedDict, TypeVar, overload

T = TypeVar("T")


class Hierarchy(TypedDict):
    """Frame starts for the three visual roles."""

    hero: list[int]
    support: list[int]
    detail: list[int]
    last: int


ScalarCurve: TypeAlias = Callable[[float], float]

MotionValue: TypeAlias = float | Sequence[float]

V = TypeVar("V", bound=MotionValue)
TrackKey: TypeAlias = tuple[float, V] | tuple[float, V, str | ScalarCurve | None]


# ---------- cubic bezier, as Remotion's Easing.bezier (CSS cubic-bezier) ----------

# Control points (x1, y1, x2, y2) of the bezier intents: timing.ts `curves` and `intentCurves`.
BEZIER = {
    "snap": (0.87, 0.0, 0.13, 1.0),  # curves.inOut
    "glide": (0.45, 0.0, 0.55, 1.0),  # curves.drift
    "punch": (0.34, 1.56, 0.64, 1.0),  # curves.overshoot
    "float": (0.37, 0.0, 0.63, 1.0),
    "brake": (0.16, 1.0, 0.3, 1.0),  # curves.expoOut
    "expoIn": (0.7, 0.0, 0.84, 0.0),
    "anticipation": (0.36, 0.0, 0.66, -0.56),
}


def _bez(t: float, a1: float, a2: float) -> float:
    return ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t


def _slope(t: float, a1: float, a2: float) -> float:
    return 3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1


def bezier(x1: float, y1: float, x2: float, y2: float) -> ScalarCurve:  # noqa: C901 -- Keep the ordered validation or native transaction together.
    """CSS cubic-bezier easing: solves x(t) = x by Newton, falling back to bisection, then returns y(t)."""
    if not (0 <= x1 <= 1 and 0 <= x2 <= 1):
        error_message = "bezier x values must be in [0, 1]"
        raise ValueError(error_message)

    def solve(x: float) -> float:
        t = x
        for _ in range(8):
            err = _bez(t, x1, x2) - x
            if abs(err) < 1e-9:
                return t
            d = _slope(t, x1, x2)
            if abs(d) < 1e-6:
                break
            t -= err / d
        lo, hi = 0.0, 1.0
        t = x
        for _ in range(60):
            err = _bez(t, x1, x2) - x
            if abs(err) < 1e-10:
                break
            if err > 0:
                hi = t
            else:
                lo = t
            t = (lo + hi) / 2
        return t

    def curve(x: float) -> float:
        if x <= 0:
            return 0.0
        if x >= 1:
            return 1.0
        return _bez(solve(x), y1, y2)

    return curve


def _settle() -> ScalarCurve:
    """timing.ts settleCurve: a normalised damped spring, one small overshoot (about 4%), no visible ring after."""
    span = 20
    raw = lambda t: 0.0 if t <= 0 else 1 - math.exp(-0.6 * t * span) * math.cos(0.5 * t * span)  # noqa: E731
    end = raw(1)
    return lambda t: 0.0 if t <= 0 else (1.0 if t >= 1 else raw(t) / end)


CURVES = {name: bezier(*points) for name, points in BEZIER.items()}
CURVES["settle"] = _settle()
CURVES["linear"] = lambda t: min(1.0, max(0.0, t))
# The six intents, named by what the move should feel like (timing.ts intentCurves).
INTENTS = ("snap", "settle", "glide", "punch", "float", "brake")


def curve(name: str | ScalarCurve) -> ScalarCurve:
    """Resolve a named intent or an explicit easing callback."""
    if not isinstance(name, str):
        return name
    if name not in CURVES:
        error_message = f"Unknown curve {name}. Known: {', '.join(sorted(CURVES))}"
        raise ValueError(error_message)
    return CURVES[name]


def clamp01(t: float) -> float:
    """Clamp progress to the inclusive unit interval."""
    return min(1.0, max(0.0, t))


@overload
def mix(a: float, b: float, t: float) -> float: ...


@overload
def mix(a: Sequence[float], b: Sequence[float], t: float) -> tuple[float, ...]: ...


@overload
def mix(a: MotionValue, b: MotionValue, t: float) -> MotionValue: ...


def mix(a: MotionValue, b: MotionValue, t: float) -> MotionValue:
    """Interpolate matching scalars or equally sized vectors."""
    if isinstance(a, (int, float)):
        if not isinstance(b, (int, float)):
            error_message = "Cannot interpolate a scalar with a vector"
            raise TypeError(error_message)
        return a + (b - a) * t
    if isinstance(b, (int, float)):
        error_message = "Cannot interpolate a vector with a scalar"
        raise TypeError(error_message)
    return tuple(x + (y - x) * t for x, y in zip(a, b, strict=True))


def progress(frame: float, at: float, frames: float, intent: str | ScalarCurve = "brake") -> float:
    """Eased progress of a window, clamped at both ends (timing.ts progress); overshooting intents may pass 1 inside."""
    if frames <= 0:
        return 1.0 if frame >= at else 0.0
    t = (frame - at) / frames
    if t <= 0:
        return 0.0
    if t >= 1:
        return 1.0
    return curve(intent)(t)


@overload
def track(frame: float, keys: Sequence[TrackKey[float]]) -> float: ...


@overload
def track(frame: float, keys: Sequence[TrackKey[Sequence[float]]]) -> Sequence[float]: ...


@overload
def track(frame: float, keys: Sequence[TrackKey[MotionValue]]) -> MotionValue: ...


def track(frame: float, keys: Sequence[TrackKey[MotionValue]]) -> MotionValue:
    """timing.ts track: keys [(at, value, intent)] ascending; the intent shapes the segment arriving at that key."""
    if not keys:
        error_message = "A track needs at least one key"
        raise ValueError(error_message)
    for (a, *_), (b, *_) in pairwise(keys):
        if b <= a:
            error_message = f"Keys must ascend: {a} then {b}"
            raise ValueError(error_message)
    if frame <= keys[0][0]:
        return keys[0][1]
    for previous, key in pairwise(keys):
        if frame <= key[0]:
            intent = key[2] if len(key) == 3 else None
            intent = intent or "linear"
            return mix(previous[1], key[1], curve(intent)((frame - previous[0]) / (key[0] - previous[0])))
    return keys[-1][1]


# ---------- springs, overlap and follow-through ----------


def follow_through(frame: float, stop: float, amplitude: float = 1.0, damping: float = 6.0, frequency: float = 2.2, fps: float = 30) -> float:
    r"""Return a decaying swing after the parent motion stops.

    timing.ts followThrough: 0 up to `stop`, then a decaying swing whose first peak is `amplitude`, carrying on in
    the direction of travel. Add it to the value that stopped (an ear, a tag, a card's tilt).
    """
    if frame <= stop or amplitude == 0:
        return 0.0
    omega = 2 * math.pi * frequency
    swing = lambda t: math.exp(-damping * t) * math.sin(omega * t)  # noqa: E731
    peak = swing(math.atan(omega / damping) / omega)
    return amplitude * swing((frame - stop) / fps) / peak


def spring_step(seconds: float, overshoot: float = 0.08, rise: float = 0.25) -> float:
    r"""Evaluate the step response of a damped spring.

    Step response of an under-damped spring from rest: 0 at 0 with zero velocity, first reaches 1 after `rise`
    seconds, peaks once at 1 + `overshoot`, rings down. Damping comes from the overshoot (ratio = exp(-z pi / sqrt(1-z^2))).
    """
    if seconds <= 0:
        return 0.0
    if overshoot <= 0:  # critically damped, reaching 0.98 near `rise`
        w = 4.0 / max(1e-6, rise)
        return 1 - math.exp(-w * seconds) * (1 + w * seconds)
    ln = math.log(min(0.99, overshoot))
    zeta = -ln / math.sqrt(math.pi**2 + ln * ln)
    root = math.sqrt(1 - zeta * zeta)
    wd = (math.pi - math.atan2(root, zeta)) / max(1e-6, rise)
    wn = wd / root
    decay = math.exp(-zeta * wn * seconds)
    return 1 - decay * (math.cos(wd * seconds) + zeta / root * math.sin(wd * seconds))


def anticipate(frame: float, at: float, wind: float = 6, action: float = 7, amount: float = 0.12, overshoot: float = 0.08, fps: float = 30) -> float:
    """Anticipation, action, overshoot and settle in one 0..1 move, the backbone of a directed entrance.

    From `at` the value eases back to -`amount` over `wind` frames (the wind-up, float), then a spring carries it to 1,
    first reaching it `action` frames later, passing it once by `overshoot` and settling. Continuous in value and
    velocity at every joint: the wind-up ends at rest, and the spring starts from rest.
    """
    if frame <= at:
        return 0.0
    if frame <= at + wind:
        return -amount * curve("float")((frame - at) / max(1, wind))
    s = spring_step((frame - at - wind) / fps, overshoot, action / fps)
    return -amount + (1 + amount) * s


def jiggle(frame: float, events: Iterable[tuple[float, float]], damping: float = 7.0, frequency: float = 3.0, fps: float = 30) -> float:
    r"""Sum secondary motion from scheduled frame and amplitude events.

    Secondary motion from several hits: the sum of a follow-through per (frame, amplitude) event. Ears, antennae,
    a hanging tag: feed it the frames where the parent stops or lands.
    """
    return sum(follow_through(frame, at, amp, damping, frequency, fps) for at, amp in events)


def delayed(fn: Callable[[float], T], frame: float, frames: float) -> T:
    """Overlap: the same motion as `fn`, `frames` later (a child that trails its parent)."""
    return fn(frame - frames)


@overload
def smoothed(fn: ScalarCurve, frame: float, half_life: float = 3.0, start: int = 0) -> float: ...


@overload
def smoothed(fn: Callable[[float], Sequence[float]], frame: float, half_life: float = 3.0, start: int = 0) -> Sequence[float]: ...


def smoothed(fn: Callable[[float], MotionValue], frame: float, half_life: float = 3.0, start: int = 0) -> MotionValue:
    r"""Evaluate a deterministic scalar or vector follower at a block frame.

    A value that follows `fn` with lag: an exponential follower recomputed from `start` every call, so it stays a
    pure function of the frame. Look-at with lag, a camera that trails its subject.
    """
    if not isinstance(start, int) or isinstance(start, bool):
        error_message = "Smoothing start must be an integer frame"
        raise ValueError(error_message)  # noqa: TRY004 -- The worker uses ValueError for invalid protocol/domain values.
    if frame <= start:
        return fn(start)
    k = 1 - 0.5 ** (1 / max(1e-6, half_life))
    value = fn(start)
    whole = math.floor(frame)
    for f in range(int(start) + 1, whole + 1):
        target = fn(f)
        value = mix(value, target, k)
    if frame > whole:  # a subframe (motion blur) eases on towards the next frame's value
        value = mix(value, mix(value, fn(whole + 1), k), frame - whole)
    return value


# ---------- squash and stretch ----------


def volume_scale(stretch: float) -> tuple[float, float, float]:
    """(sx, sy, sz) with sz = `stretch` and sx * sy * sz = 1: volume-preserving squash (< 1) or stretch (> 1)."""
    stretch = max(0.2, stretch)
    side = 1 / math.sqrt(stretch)
    return (side, side, stretch)


def stretch_from_speed(speed: float, gain: float = 0.004, limit: float = 0.25) -> float:
    """Stretch along the direction of travel from a speed (units per frame): 1 at rest, at most 1 + `limit`."""
    return 1 + min(limit, abs(speed) * gain)


def hop(
    frame: float,
    at: float,
    crouch: float = 7,
    air: float = 13,
    height: float = 0.3,
    squash: float = 0.16,
    stretch: float = 0.14,
    land_squash: float | None = None,
    settle: float = 12,
    fps: float = 30,  # noqa: ARG001 -- Retained named option for compatibility with existing shots.
) -> tuple[float, float]:
    r"""Return hop lift and volume-preserving stretch at a block frame.

    A hop with anticipation, stretch, landing squash and settle. Returns (lift, stretch) at the frame: lift in the
    caller's units (multiples of `height`), stretch for volume_scale().

    crouch: frames of anticipation (squashes down by `squash`); air: frames off the ground on a parabola (gravity, so
    even in time, fastest at take-off and landing, slowest at the apex); stretch peaks with speed; landing squashes by
    `land_squash` (default `squash` * 1.3) then rings back through a damped spring over about `settle` frames.
    """
    land_squash = squash * 1.3 if land_squash is None else land_squash
    take_off, land = at + crouch, at + crouch + air
    if frame <= at:
        return 0.0, 1.0
    if frame <= take_off:
        u = (frame - at) / max(1, crouch)
        return 0.0, 1 - squash * curve("float")(u)
    if frame < land:
        u = (frame - take_off) / air
        lift = height * 4 * u * (1 - u)
        speed = abs(1 - 2 * u)  # share of take-off speed
        flying = 1 + stretch * speed**1.5
        release = clamp01((frame - take_off) / 3)  # the crouch springs out over 3 frames
        return lift, mix(1 - squash, flying, curve("brake")(release))
    # Contact is the deepest squash; it springs back through 1 once and rings down within `settle` frames.
    t = frame - land
    settle = max(4.0, settle)
    ring = math.exp(-t * 2.2 / settle * 1.6) * math.cos(2 * math.pi * t / (settle * 0.9))
    return 0.0, 1 - land_squash * ring


def bounces(frame: float, at: float, count: int = 2, height: float = 0.2, air: float = 10, decay: float = 0.55, squash: float = 0.1, stretch: float = 0.1, fps: float = 30) -> tuple[float, float]:
    r"""Evaluate a sequence of progressively smaller hops.

    A happy bounce: `count` hops in a row, each `decay` times the height and a little shorter, with squash on each
    contact and a settle after the last. Returns (lift, stretch).
    """
    start = at
    lift, s = 0.0, 1.0
    for i in range(count):
        h = height * decay**i
        a = max(5, round(air * (decay**i) ** 0.5))
        crouch = 4 if i == 0 else 0
        end = start + crouch + a
        if frame < end or i == count - 1:
            lift, s = hop(frame, start, crouch=crouch, air=a, height=h, squash=squash, stretch=stretch, settle=10, fps=fps)
            if i > 0 and frame <= start + 2:  # each re-launch springs out of the previous landing's squash
                s = mix(1 - squash * 1.3, s, clamp01((frame - start) / 2))
            return lift, s
        start = end
    return lift, s


def arc(p0: Sequence[float], p1: Sequence[float], lift: float, t: float, up: Sequence[float] = (0.0, 0.0, 1.0)) -> tuple[float, ...]:
    """A point on a quadratic arc from p0 to p1 whose middle rises by `lift` along `up`: motion on arcs, not lines."""
    mid = tuple((a + b) / 2 + u * lift * 2 for a, b, u in zip(p0, p1, up, strict=True))
    return tuple((1 - t) ** 2 * a + 2 * (1 - t) * t * m + t * t * b for a, m, b in zip(p0, mid, p1, strict=True))


def breathe(frame: float, period: float = 48, amount: float = 0.018, phase: float = 0.0) -> float:
    """Breathing for a hold: a stretch around 1 (pass to volume_scale), slow in and out, never a dead hold."""
    return 1 + amount * math.sin(2 * math.pi * (frame / period + phase))


# ---------- character ----------


def blink(frame: float, at: float, close: float = 2, hold: float = 1, open_: float = 4) -> float:
    """Eyelid openness 1 -> 0 -> 1: fast close (expoIn), a hold, slower open (brake). 1 means open."""
    if frame <= at or frame >= at + close + hold + open_:
        return 1.0
    if frame <= at + close:
        return 1 - curve("expoIn")((frame - at) / max(1, close))
    if frame <= at + close + hold:
        return 0.0
    return curve("brake")((frame - at - close - hold) / max(1, open_))


def blinks(frame: float, times: Iterable[float], **kwargs: float) -> float:
    """Return eyelid openness across all scheduled blinks."""
    return min([blink(frame, at, **kwargs) for at in times] or [1.0])


# ---------- seeded noise: no global random, no salted hash ----------


def _hash(seed: object, i: int) -> float:
    """A stable 32-bit hash of (seed, integer) to [0, 1): crc32 of the seed, then an integer mixer (splitmix-like)."""
    x = (zlib.crc32(str(seed).encode("utf8")) ^ (i * 0x9E3779B1)) & 0xFFFFFFFF
    x ^= x >> 16
    x = (x * 0x7FEB352D) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 0x846CA68B) & 0xFFFFFFFF
    x ^= x >> 16
    return x / 4294967296.0


def rand(seed: object, i: int = 0) -> float:
    """Seeded uniform in [0, 1)."""
    return _hash(seed, i)


def noise(x: float, seed: object = 0) -> float:
    """Smooth 1D value noise in [-1, 1] with a quintic fade: continuous value and slope."""
    i = math.floor(x)
    f = x - i
    a, b = _hash(seed, i) * 2 - 1, _hash(seed, i + 1) * 2 - 1
    u = f * f * f * (f * (f * 6 - 15) + 10)
    return a + (b - a) * u


def band_noise(seconds: float, seed: object = 0, low: float = 0.6, high: float = 2.5, partials: int = 5) -> float:
    r"""Evaluate normalised noise from seeded frequencies within a physical band.

    Band-limited noise in about [-1, 1]: a sum of sines at seeded frequencies inside [low, high] Hz with seeded
    phases and 1/f weights. No energy outside the band, so a handheld wobble never buzzes or drifts away.
    """
    if low <= 0 or high < low or partials < 1:
        error_message = "Noise needs positive frequencies and at least one partial"
        raise ValueError(error_message)
    total, weight = 0.0, 0.0
    for k in range(partials):
        f = low * (high / low) ** ((k + _hash(seed, 2 * k) * 0.8) / max(1, partials - 1 + 0.8))
        phase = 2 * math.pi * _hash(seed, 2 * k + 1)
        w = 1 / f
        total += w * math.sin(2 * math.pi * f * seconds + phase)
        weight += w
    return total / weight * math.sqrt(2)


def handheld(
    frame: float, seed: object = 0, fps: float = 30, rotation: float = 0.35, translation: float = 0.004, band: tuple[float, float] = (0.6, 2.5)
) -> tuple[tuple[float, ...], tuple[float, ...]]:
    r"""Return seeded camera rotation in degrees and translation in metres.

    A camera operator's hands: (pitch, yaw, roll) in degrees and (x, y, z) in metres, from band-limited noise. Roll is
    smallest; translation is millimetres. Breathing and arm sway live in 0.5 to 3 Hz, so that is the default band.
    """
    t = frame / fps
    pitch = rotation * band_noise(t, f"{seed}-pitch", *band)
    yaw = rotation * band_noise(t, f"{seed}-yaw", *band)
    roll = rotation * 0.4 * band_noise(t, f"{seed}-roll", *band)
    move = tuple(translation * band_noise(t, f"{seed}-t{axis}", band[0] * 0.7, band[1] * 0.7) for axis in "xyz")
    return (pitch, yaw, roll), move


def flicker(frame: float, seed: object = 0, fps: float = 30, depth: float = 0.25, rate: float = 9.0) -> float:
    """Light flicker multiplier around 1 (seeded): fast value noise with a slow envelope, never below 1 - depth."""
    t = frame / fps
    fast = noise(t * rate, f"{seed}-fast") * 0.6 + noise(t * rate * 2.3, f"{seed}-fine") * 0.4
    slow = 0.5 + 0.5 * noise(t * 0.7, f"{seed}-slow")
    return 1 - depth * clamp01(0.5 + 0.5 * fast) * slow


# ---------- staging ----------


def hierarchy(
    hero: int = 1, support: int = 0, detail: int = 0, at: int = 0, fps: float = 30, hero_step: int = 4, support_gap: int = 10, support_step: int = 5, detail_gap: int = 7, detail_step: int = 3
) -> Hierarchy:
    r"""Schedule role entries in hero, support and detail reading order.

    timing.ts hierarchy: entry frames by role, so a frame builds in reading order (hero alone, support after a
    breath, detail in a quick stagger). Gaps are frames at 30 fps, scaled to `fps`.
    """
    scale = lambda frames: round(frames * fps / 30)  # noqa: E731
    run = lambda count, start, step: [start + i * scale(step) for i in range(max(0, int(count)))]  # noqa: E731
    heroes = run(hero, at, hero_step)
    support_from = (heroes[-1] if heroes else at) + (scale(support_gap) if heroes else 0)
    supports = run(support, support_from, support_step)
    anchor = supports[-1] if supports else (heroes[-1] if heroes else None)
    details = run(detail, at if anchor is None else anchor + scale(detail_gap), detail_step)
    return {"hero": heroes, "support": supports, "detail": details, "last": max([at, *heroes, *supports, *details])}


def stagger(count: int, step: float, kind: str = "index", seed: object = 0, jitter: float = 0.0) -> list[float]:
    """Start delays in frames for `count` items: index, centre (middle first), edges (ends first) or seeded order."""
    middle = (count - 1) / 2
    if kind == "index":
        return [i * step for i in range(count)]
    if kind == "centre":
        return [math.floor(abs(i - middle)) * step for i in range(count)]
    if kind == "edges":
        return [math.floor(middle - abs(i - middle)) * step for i in range(count)]
    if kind == "seeded":
        order = sorted(range(count), key=lambda i: _hash(f"{seed}-order", i))
        return [order.index(i) * step + _hash(f"{seed}-jitter", i) * jitter for i in range(count)]
    error_message = f"Unknown stagger {kind}"
    raise ValueError(error_message)


# ---------- lenses and framing ----------


# Shot roles and their starting points: lens (mm), f-stop, camera height over the subject's centre (in subject heights),
# move and default intent. A choice to argue with, not a rule: see the blender-3d skill's directing guide.
class ShotRole(TypedDict):
    """Optical defaults and move intent for a shot role."""

    lens: float
    fstop: float
    height: float
    move: str
    intent: str
    fill: float


ROLES: dict[str, ShotRole] = {
    "hero": {"lens": 85.0, "fstop": 2.8, "height": -0.15, "move": "push", "intent": "glide", "fill": 0.62},
    "reveal": {"lens": 50.0, "fstop": 4.0, "height": 0.25, "move": "crane", "intent": "glide", "fill": 0.5},
    "detail": {"lens": 100.0, "fstop": 2.0, "height": 0.0, "move": "truck", "intent": "float", "fill": 0.85},
    "establishing": {"lens": 35.0, "fstop": 8.0, "height": 0.6, "move": "orbit", "intent": "glide", "fill": 0.35},
}


def fov(lens: float, sensor: float) -> float:
    """Return the horizontal field of view in radians."""
    return 2 * math.atan(sensor / (2 * lens))


def frame_size(lens: float, distance: float, width: float, height: float, sensor: float = 36.0) -> tuple[float, float]:
    """(width, height) in metres seen at `distance` by a `lens` on a horizontal-fit sensor of `sensor` mm."""
    aspect = width / height
    w = 2 * distance * math.tan(fov(lens, sensor) / 2)
    return w, w / aspect


def fit_distance(lens: float, subject_w: float, subject_h: float, width: float, height: float, fill: float = 0.6, sensor: float = 36.0) -> float:
    """Distance at which a subject_w x subject_h subject fills `fill` of the frame on its tighter axis, any aspect."""
    w, h = frame_size(lens, 1.0, width, height, sensor)
    return max(subject_w / (w * fill), subject_h / (h * fill))


def dof_blur(lens: float, fstop: float, focus: float, distance: float, sensor: float = 36.0, width_px: int = 1920) -> float:
    """Circle of confusion in pixels for a point at `distance` when focused at `focus` (thin lens)."""
    f = lens / 1000
    coc = abs(distance - focus) / distance * f * f / (fstop * (focus - f))
    return coc / (sensor / 1000) * width_px


# Safe frames from src/lib/design-tokens.ts spacing (pixels at 1080 x 1920, 1080 x 1080, 1920 x 1080).
class SafeFrame(TypedDict):
    """Pixel dimensions and protected edge margins."""

    size: tuple[int, int]
    top: int
    bottom: int
    sides: int


SAFE: dict[str, SafeFrame] = {
    "vertical": {"size": (1080, 1920), "top": 200, "bottom": 300, "sides": 60},
    "square": {"size": (1080, 1080), "top": 60, "bottom": 60, "sides": 48},
    "landscape": {"size": (1920, 1080), "top": 60, "bottom": 60, "sides": 60},
}


def safe_rect(fmt: str) -> tuple[float, float, float, float]:
    """The safe area of a format as shares of the frame: (left, top, right, bottom), y down."""
    s = SAFE[fmt]
    w, h = s["size"]
    return (s["sides"] / w, s["top"] / h, 1 - s["sides"] / w, 1 - s["bottom"] / h)


def safe_excess(box: Sequence[float], fmt: str) -> dict[str, float]:
    r"""Measure the box overflow beyond each safe-frame edge.

    How far a box (left, top, right, bottom, shares, y down) pokes past the format's safe area on each edge, as shares
    of the frame; all zero when it sits inside.
    """
    left, top, right, bottom = safe_rect(fmt)
    return {"left": max(0.0, left - box[0]), "top": max(0.0, top - box[1]), "right": max(0.0, box[2] - right), "bottom": max(0.0, box[3] - bottom)}


# ---------- colour ----------


def kelvin_rgb(kelvin: float) -> tuple[float, ...]:
    """Approximate linear-ish RGB of a black body at `kelvin` (Tanner Helland's fit), white-balanced to 6500 K = 1."""
    if kelvin <= 0 or not math.isfinite(kelvin):
        error_message = "Colour temperature must be positive and finite"
        raise ValueError(error_message)

    def raw(k: float) -> list[float]:
        t = k / 100
        r = 255 if t <= 66 else 329.698727446 * (t - 60) ** -0.1332047592
        g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * (t - 60) ** -0.0755148492
        b = 255 if t >= 66 else (0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307)
        return [min(255, max(0, v)) / 255 for v in (r, g, b)]

    c, w = raw(kelvin), raw(6500)
    out = [min(1.0, v / max(1e-6, n)) for v, n in zip(c, w, strict=True)]
    peak = max(out)
    return tuple(v / peak for v in out)
